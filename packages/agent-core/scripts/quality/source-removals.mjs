import { resolve } from "node:path";
import {
    artifactRoot,
    assertExactKeys,
    assertString,
    assertUniqueStrings,
    readCanonicalJson,
    sha256
} from "./project.mjs";
import { executedTestSelectors, requirePassingTests } from "./evidence.mjs";
import { loadOwnership, ownersForPath } from "./ownership.mjs";
import { normalizeResolutions } from "./request-archive.mjs";

const hashPattern = /^[a-f0-9]{64}$/u;

export async function approvedSourceRemovals(seed, currentCoverage, stage = "building") {
    const integrationRoot = resolve(artifactRoot, "integration");
    const [document, bom, dispositions, resolutions, transitionIndex, ownership, executed] =
        await Promise.all([
            readCanonicalJson(resolve(artifactRoot, "quality/source-removal-approvals.json")),
            readCanonicalJson(resolve(integrationRoot, "bom.json")),
            readCanonicalJson(resolve(integrationRoot, "dispositions.json")),
            readCanonicalJson(resolve(integrationRoot, "resolutions.json")),
            readCanonicalJson(resolve(integrationRoot, "transitions/index.json")),
            loadOwnership(),
            executedTestSelectors()
        ]);
    const transitions = await Promise.all(
        transitionIndex.manifests.map((name) =>
            readCanonicalJson(resolve(integrationRoot, "transitions", name))
        )
    );
    return validateSourceRemovalApprovals(document, {
        seed,
        currentCoverage,
        patterns: ownership.patterns,
        executed,
        bom,
        dispositions,
        resolutions,
        transitions,
        stage
    });
}

export function validateSourceRemovalApprovals(document, context) {
    assertExactKeys(document, ["edition", "approvals"], "Source-removal approvals");
    if (document.edition !== "2.0.0") {
        throw new TypeError("Unsupported source-removal approval edition");
    }
    if (!Array.isArray(document.approvals)) {
        throw new TypeError("Source-removal approvals must be an array");
    }

    const removals = new Set();
    const digests = new Set();
    const tests = new Set();
    for (const approval of document.approvals) {
        validateApprovalShape(approval);
        if (removals.has(approval.path)) {
            throw new TypeError(`Duplicate source-removal approval: ${approval.path}`);
        }
        if (digests.has(approval.digest)) {
            throw new TypeError(`Duplicate source-removal digest: ${approval.digest}`);
        }
        if (sourceRemovalDigest(approval) !== approval.digest) {
            throw new TypeError(`Source-removal approval digest is stale: ${approval.path}`);
        }

        const baseline = context.seed.files[approval.path];
        if (baseline === undefined) {
            throw new TypeError(`Source-removal approval is not a baseline file: ${approval.path}`);
        }
        if (
            approval.original.baseCommit !== context.seed.baseCommit ||
            approval.original.sha256 !== baseline.sha256
        ) {
            throw new TypeError(`Source-removal baseline identity is stale: ${approval.path}`);
        }
        if (context.currentCoverage.has(approval.path)) {
            throw new TypeError(
                `Source-removal approval is stale because the source exists: ${approval.path}`
            );
        }

        assertOwnedBy(approval.path, approval.owner, context.patterns, "removed source");
        const transition = validateReview(approval, context);
        for (const replacement of approval.replacements) {
            if (replacement === approval.path) {
                throw new TypeError(
                    `Source removal names itself as a replacement: ${approval.path}`
                );
            }
            if (!context.currentCoverage.has(replacement)) {
                throw new TypeError(
                    `Source-removal replacement is missing coverage: ${approval.path} -> ${replacement}`
                );
            }
            const replacementOwner = exactOwner(replacement, context.patterns, "replacement");
            if (
                replacementOwner !== approval.owner &&
                !(
                    transition.canonicalOwner === replacementOwner &&
                    transition.allowedForeignPaths.includes(replacement)
                )
            ) {
                throw new TypeError(
                    `Source-removal replacement lacks transition authorization: ${approval.path} -> ${replacement}`
                );
            }
        }
        for (const selector of approval.tests) {
            if (tests.has(selector)) {
                throw new TypeError(`Duplicate source-removal test selector: ${selector}`);
            }
            tests.add(selector);
        }
        requirePassingTests(approval.tests, context.executed, approval.path);
        removals.add(approval.path);
        digests.add(approval.digest);
    }
    return removals;
}

export function sourceRemovalDigest(approval) {
    const evidence = { ...approval };
    delete evidence.digest;
    return sha256(JSON.stringify(canonicalValue(evidence)));
}

function validateApprovalShape(approval) {
    assertExactKeys(
        approval,
        ["path", "owner", "replacements", "rationale", "original", "review", "tests", "digest"],
        "Source-removal approval"
    );
    assertString(approval.path, "Source-removal path");
    assertString(approval.owner, "Source-removal owner");
    assertUniqueStrings(approval.replacements, "Source-removal replacements");
    if (approval.replacements.length === 0) {
        throw new TypeError("Source-removal replacements must not be empty");
    }
    assertString(approval.rationale, "Source-removal rationale");
    assertUniqueStrings(approval.tests, "Source-removal tests");
    if (approval.tests.length === 0) {
        throw new TypeError("Source-removal tests must not be empty");
    }
    assertHash(approval.digest, "Source-removal digest");

    assertExactKeys(approval.original, ["baseCommit", "sha256"], "Source-removal original");
    assertString(approval.original.baseCommit, "Source-removal baseline commit");
    assertHash(approval.original.sha256, "Source-removal source digest");

    assertExactKeys(
        approval.review,
        ["disposition", "resolution", "transition"],
        "Source-removal review"
    );
    assertExactKeys(approval.review.disposition, ["owner", "commit"], "Source-removal disposition");
    assertString(approval.review.disposition.owner, "Source-removal disposition owner");
    assertString(approval.review.disposition.commit, "Source-removal disposition commit");
    assertExactKeys(approval.review.resolution, ["source", "sha256"], "Source-removal resolution");
    assertString(approval.review.resolution.source, "Source-removal resolution source");
    assertHash(approval.review.resolution.sha256, "Source-removal resolution digest");
    assertString(approval.review.transition, "Source-removal transition");
}

function validateReview(approval, context) {
    const { disposition, resolution, transition: transitionId } = approval.review;
    const stage = context.stage ?? "building";
    if (disposition.owner !== approval.owner) {
        throw new TypeError(`Source-removal disposition owner is stale: ${approval.path}`);
    }
    const dispositions = context.dispositions.waves.filter(
        (item) =>
            item.owner === disposition.owner &&
            item.commit === disposition.commit &&
            item.state === "accepted-input"
    );
    if (dispositions.length !== 1) {
        throw new TypeError(`Source-removal disposition is stale: ${approval.path}`);
    }

    const bomEntries = context.bom.entries.filter(
        (entry) => entry.owner === disposition.owner && entry.commit === disposition.commit
    );
    const resolutionEntry = normalizeResolutions(context.resolutions).filter(
        (entry) => entry.source === resolution.source && entry.sourceSha256 === resolution.sha256
    );
    if (resolutionEntry.length !== 1) {
        throw new TypeError(`Source-removal BOM resolution is stale: ${approval.path}`);
    }
    const finalizedResolution = resolutionEntry[0];
    const archived = finalizedResolution.archive !== null;
    const bomArtifacts = bomEntries.flatMap((entry) =>
        entry.artifacts.filter(
            (artifact) =>
                artifact.source === resolution.source &&
                artifact.sourceSha256 === resolution.sha256 &&
                (archived
                    ? artifact.destination === finalizedResolution.archive &&
                      artifact.sha256 === finalizedResolution.archiveSha256
                    : artifact.destination === resolution.source &&
                      artifact.sha256 === resolution.sha256)
        )
    );
    if (bomEntries.length !== 1 || bomArtifacts.length !== 1) {
        throw new TypeError(`Source-removal BOM resolution is stale: ${approval.path}`);
    }
    if (
        stage === "final" &&
        (!new Set(["applied", "rejected", "external-gated"]).has(finalizedResolution.state) ||
            finalizedResolution.completion === null)
    ) {
        throw new TypeError(`Source-removal resolution is not completed: ${approval.path}`);
    }

    const transitions = context.transitions.filter((transition) => transition.id === transitionId);
    if (transitions.length !== 1) {
        throw new TypeError(`Source-removal transition is stale: ${approval.path}`);
    }
    const transition = transitions[0];
    if (
        !(stage === "final"
            ? transition.state === "completed"
            : ["ready-for-coordinated-integration", "completed"].includes(transition.state)) ||
        !transition.inputs.some(
            (input) => input.owner === approval.owner && input.commit === disposition.commit
        ) ||
        !transition.acceptance.some((item) => item.startsWith("Packed"))
    ) {
        throw new TypeError(`Source-removal transition does not admit its owner: ${approval.path}`);
    }
    if (
        stage === "final" &&
        (transition.completion === null || !transition.completion.checks?.includes("exports"))
    ) {
        throw new TypeError(
            `Source-removal transition lacks negative packed evidence: ${approval.path}`
        );
    }
    return transition;
}

function assertOwnedBy(path, owner, patterns, kind) {
    const actual = exactOwner(path, patterns, kind);
    if (actual !== owner) {
        throw new TypeError(`Source-removal ${kind} is owned by ${actual}, not ${owner}: ${path}`);
    }
}

function exactOwner(path, patterns, kind) {
    const owners = ownersForPath(path, patterns);
    if (owners.length !== 1) {
        throw new TypeError(
            `Source-removal ${kind} must have exactly one owner: ${path} (${owners.join(", ") || "none"})`
        );
    }
    return owners[0];
}

function assertHash(value, owner) {
    if (typeof value !== "string" || !hashPattern.test(value)) {
        throw new TypeError(`${owner} must be a lowercase SHA-256 digest`);
    }
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalValue(value[key])])
        );
    }
    return value;
}
