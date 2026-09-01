import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    artifactRoot,
    assertExactKeys,
    isNonEmptyString,
    packageRoot,
    parseCanonicalJson,
    portablePath
} from "./project.mjs";

const repositoryRoot = resolve(packageRoot, "../..");

/**
 * Live substrate evidence is produced outside the hermetic closure — the
 * Cloudflare lane deploys the harness to the real account and archives its
 * run manifest and phase reports. This checker binds that committed evidence
 * to the exact current tree: the manifest must be clean, its phase reports
 * must hash-match, every scenario must have passed in the phase that executed
 * it, and every fingerprinted source must be byte-identical to the file the
 * lane exercised.
 *
 * That last demand is the one the tree cannot always meet on its own, because
 * only the operator can re-run the lane. Which verdict a drifted fingerprint
 * earns is therefore read off the conformance ledger rather than assumed: while
 * any row still claims `verified` from this archive, drift is that claim going
 * false and fails closed exactly as before; once every row citing the archive
 * has retreated below `verified`, the drift is a re-run this tree is waiting
 * for and is reported as pending. Nothing here re-pins a fingerprint, and
 * nothing here promotes a row: the retreat is the refusal, and the ledger and
 * the final conformance stage are what enforce it.
 */
export function validateLiveEvidence(root = resolve(artifactRoot, "conformance/live-evidence")) {
    const manifest = readJson(resolve(root, "run.json"), "Live evidence manifest");
    assertExactKeys(
        manifest,
        [
            "edition",
            "commit",
            "dirtySources",
            "accountId",
            "worker",
            "bucket",
            "url",
            "deployments",
            "sourceFingerprints",
            "reports"
        ],
        "Live evidence manifest"
    );
    if (manifest.edition !== "1.0.0") throw new TypeError("Unsupported live evidence edition");
    if (!/^[a-f0-9]{40}$/u.test(manifest.commit)) {
        throw new TypeError("Live evidence commit must be a full git commit");
    }
    if (manifest.dirtySources !== false) {
        throw new TypeError("Live evidence was produced from dirty sources");
    }
    for (const field of ["accountId", "worker", "bucket", "url"]) {
        if (!isNonEmptyString(manifest[field])) {
            throw new TypeError(`Live evidence manifest needs ${field}`);
        }
    }
    // The lane walks the published rollback window: base, next, back to base, and next
    // again, one deployment and one phase report each.
    if (!Array.isArray(manifest.deployments) || manifest.deployments.length !== 4) {
        throw new TypeError("Live evidence requires exactly four deployments");
    }
    const versions = manifest.deployments.map((deployment) => {
        assertExactKeys(
            deployment,
            ["url", "release", "versionId", "at"],
            "Live evidence deployment"
        );
        if (!isNonEmptyString(deployment.versionId)) {
            throw new TypeError("Live evidence deployment needs a version ID");
        }
        return deployment.versionId;
    });
    if (new Set(versions).size !== versions.length) {
        throw new TypeError("Live evidence phases must each span a distinct worker version");
    }
    if (
        JSON.stringify(manifest.deployments.map((deployment) => deployment.release)) !==
        JSON.stringify(["base", "next", "base", "next"])
    ) {
        throw new TypeError("Live evidence deployments must walk base, next, base, next");
    }

    const fingerprints = Object.entries(manifest.sourceFingerprints);
    if (fingerprints.length === 0) {
        throw new TypeError("Live evidence must fingerprint its exercised sources");
    }
    // Read lazily and only once: the steady state after a re-run is that nothing has
    // drifted, and that state owes no fragment read at all.
    let claims;
    const pendingSources = [];
    for (const [path, digest] of fingerprints) {
        let bytes;
        try {
            bytes = readFileSync(resolve(repositoryRoot, path));
        } catch {
            throw new TypeError(`Live evidence fingerprints a missing source: ${path}`);
        }
        if (sha256(bytes) === digest) continue;
        claims ??= liveSubstrateClaims(resolve(root, ".."));
        if (claims.verified.length > 0) {
            throw new TypeError(`Live evidence is stale for ${path}; re-run the live lane`);
        }
        pendingSources.push(path);
    }

    const reportNames = Object.keys(manifest.reports).sort();
    if (
        JSON.stringify(reportNames) !==
        JSON.stringify([
            "phase-1.vitest.json",
            "phase-2.vitest.json",
            "phase-3.vitest.json",
            "phase-4.vitest.json"
        ])
    ) {
        throw new TypeError("Live evidence requires exactly the four phase reports");
    }
    const passed = new Set();
    const skipped = new Set();
    for (const name of reportNames) {
        const bytes = readFileSync(resolve(root, name));
        if (sha256(bytes) !== manifest.reports[name]) {
            throw new TypeError(`Live evidence report digest differs: ${name}`);
        }
        const report = parseCanonicalJson(
            new TextDecoder().decode(bytes),
            portablePath(resolve(root, name))
        );
        if (report.numTotalTests === 0 || report.numFailedTests !== 0) {
            throw new TypeError(`Live evidence phase did not pass cleanly: ${name}`);
        }
        for (const result of report.testResults ?? []) {
            const marker = result.name.slice(result.name.indexOf("/packages/") + 1);
            const testPath = `cloudflare/${marker.slice("packages/agent-core-cloudflare/".length)}`;
            for (const assertion of result.assertionResults ?? []) {
                const selector = `${testPath}#${assertion.fullName}`;
                if (assertion.status === "passed") passed.add(selector);
                else if (["pending", "skipped", "todo"].includes(assertion.status)) {
                    skipped.add(selector);
                } else {
                    throw new TypeError(`Live evidence assertion failed: ${assertion.fullName}`);
                }
            }
        }
    }
    // A phase legitimately skips the other phase's scenarios; a scenario skipped by
    // every phase never executed and must not be citable.
    for (const selector of skipped) {
        if (!passed.has(selector)) {
            throw new TypeError(`Live evidence scenario never executed: ${selector}`);
        }
    }
    if (passed.size === 0) throw new TypeError("Live evidence contains no executed scenarios");
    return {
        manifest,
        selectors: passed,
        pending: {
            sources: pendingSources,
            requirements: claims === undefined ? [] : claims.awaiting
        }
    };
}

export function liveEvidenceSelectors(conformanceRoot) {
    return validateLiveEvidence(
        conformanceRoot === undefined
            ? undefined
            : resolve(conformanceRoot, "conformance/live-evidence")
    ).selectors;
}

/**
 * Which conformance rows rest on this archive, split by whether they still claim it. The
 * fragments the index names are the only source: a list of "the live rows" kept anywhere
 * else would drift from the ledger the moment a row moved, and this partition is worth
 * nothing unless it moves with the ledger. Shape is the ledger's business — a row is
 * counted here only through the invariant it names and the status it carries.
 */
function liveSubstrateClaims(conformanceRoot) {
    const index = readJson(resolve(conformanceRoot, "index.json"), "Conformance index");
    const verified = [];
    const awaiting = [];
    for (const name of [index.seed, ...index.fragments, ...(index.pendingFragments ?? [])]) {
        if (!isNonEmptyString(name)) {
            throw new TypeError("Conformance index names an unreadable fragment");
        }
        const fragment = readJson(resolve(conformanceRoot, name), `Conformance fragment ${name}`);
        for (const requirement of fragment.requirements) {
            if (!requirement.checkerInvariants.includes("ACQ-LIVE")) continue;
            (requirement.status === "verified" ? verified : awaiting).push(requirement.id);
        }
    }
    return { verified: verified.sort(), awaiting: awaiting.sort() };
}

function readJson(path, name) {
    let source;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        throw new TypeError(`${name} is missing or unreadable: ${error.message}`);
    }
    return parseCanonicalJson(source, portablePath(path));
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
