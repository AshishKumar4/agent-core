import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { artifactRoot, packageRoot } from "./project.mjs";

const repositoryRoot = resolve(packageRoot, "../..");

/**
 * Live substrate evidence is produced outside the hermetic closure — the
 * Cloudflare lane deploys the harness to the real account and archives its
 * run manifest and phase reports. This checker binds that committed evidence
 * to the exact current tree: the manifest must be clean, its phase reports
 * must hash-match, every fingerprinted source must be byte-identical to the
 * file the lane exercised, and every scenario must have passed in the phase
 * that executed it. Any drift fails closed until the lane is re-run.
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
        if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
            throw new TypeError(`Live evidence manifest needs ${field}`);
        }
    }
    if (!Array.isArray(manifest.deployments) || manifest.deployments.length !== 2) {
        throw new TypeError("Live evidence requires exactly two deployments");
    }
    const versions = manifest.deployments.map((deployment) => {
        assertExactKeys(deployment, ["url", "versionId", "at"], "Live evidence deployment");
        if (typeof deployment.versionId !== "string" || deployment.versionId.length === 0) {
            throw new TypeError("Live evidence deployment needs a version ID");
        }
        return deployment.versionId;
    });
    if (versions[0] === versions[1]) {
        throw new TypeError("Live evidence phases must span two distinct worker versions");
    }

    const fingerprints = Object.entries(manifest.sourceFingerprints);
    if (fingerprints.length === 0) {
        throw new TypeError("Live evidence must fingerprint its exercised sources");
    }
    for (const [path, digest] of fingerprints) {
        let bytes;
        try {
            bytes = readFileSync(resolve(repositoryRoot, path));
        } catch {
            throw new TypeError(`Live evidence fingerprints a missing source: ${path}`);
        }
        if (sha256(bytes) !== digest) {
            throw new TypeError(`Live evidence is stale for ${path}; re-run the live lane`);
        }
    }

    const reportNames = Object.keys(manifest.reports).sort();
    if (JSON.stringify(reportNames) !== JSON.stringify(["phase-1.vitest.json", "phase-2.vitest.json"])) {
        throw new TypeError("Live evidence requires exactly the two phase reports");
    }
    const passed = new Set();
    const skipped = new Set();
    for (const name of reportNames) {
        const bytes = readFileSync(resolve(root, name));
        if (sha256(bytes) !== manifest.reports[name]) {
            throw new TypeError(`Live evidence report digest differs: ${name}`);
        }
        const report = JSON.parse(new TextDecoder().decode(bytes));
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
    return { manifest, selectors: passed };
}

export function liveEvidenceSelectors(conformanceRoot) {
    return validateLiveEvidence(
        conformanceRoot === undefined
            ? undefined
            : resolve(conformanceRoot, "conformance/live-evidence")
    ).selectors;
}

function readJson(path, name) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new TypeError(`${name} is missing or unreadable: ${error.message}`);
    }
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, keys, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    const actual = Object.keys(value).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${name} has unexpected fields: ${actual.join(", ")}`);
    }
}

