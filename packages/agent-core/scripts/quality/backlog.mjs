import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
    artifactRoot,
    assertExactKeys,
    assertUniqueIds,
    isNonEmptyString,
    jsonKind,
    readCanonicalJson,
    sha256
} from "./project.mjs";

const NEUTRAL_TRIAGE_PRIORITY = 5;
const ACTIONABLE_DISPOSITIONS = new Set(["candidate", "mechanize", "conformance"]);

export function deriveBacklog(policy, traceability, conformanceFragments) {
    const items = [];
    const legacySourcesAllowed = policy.rules.some(
        (rule) => rule.id === "M-2" && rule.state === "milestone-gated" && rule.milestone === "M-2"
    );
    for (const obligation of policy.infrastructureObligations) {
        if (obligation.disposition !== "candidate") continue;
        items.push({
            id: `T-INFRA:${obligation.id}`,
            type: "T-INFRA",
            source: { kind: "doctrine", id: obligation.id },
            owner: obligation.owner,
            priority: obligation.priority,
            summary: `Activate doctrine milestone ${obligation.id}`,
            notes: [],
            oracle: obligation.oracle
        });
    }
    for (const fragment of conformanceFragments) {
        for (const requirement of fragment.requirements) {
            if (requirement.status === "verified") continue;
            items.push({
                id: `T-EVIDENCE:${requirement.id}`,
                type: "T-EVIDENCE",
                source: { kind: "conformance", id: requirement.id },
                owner: requirement.owner,
                priority: NEUTRAL_TRIAGE_PRIORITY,
                summary: `Advance ${requirement.id} from ${requirement.status} with exact evidence`,
                notes: requirement.remainingEvidence,
                oracle: {
                    kind: "conformance-status",
                    requirementId: requirement.id,
                    expected: "verified"
                }
            });
        }
    }
    for (const requirement of traceability.requirements) {
        for (const evidence of requirement.remainingEvidence) {
            if (jsonKind(evidence) !== "string") {
                assertExactKeys(
                    evidence,
                    ["id", "summary", "disposition", "owner", "priority", "oracle"],
                    `Traceability requirement ${requirement.id} source obligation`
                );
                assertExactKeys(
                    evidence.oracle,
                    ["kind", "selector", "expected"],
                    `Traceability source obligation ${evidence.id} oracle`
                );
                if (evidence.disposition === "permanent-boundary") continue;
                if (!ACTIONABLE_DISPOSITIONS.has(evidence.disposition)) {
                    throw new TypeError(
                        `Traceability source obligation ${evidence.id} has unknown disposition`
                    );
                }
                items.push({
                    id: `T-FORMAL:${evidence.id}`,
                    type: "T-FORMAL",
                    source: {
                        kind: "traceability-obligation",
                        id: evidence.id,
                        requirementId: requirement.id
                    },
                    owner: evidence.owner,
                    priority: evidence.priority,
                    summary: evidence.summary,
                    notes: [],
                    oracle: evidence.oracle
                });
                continue;
            }
            if (!legacySourcesAllowed) {
                throw new TypeError(
                    "Legacy traceability evidence is allowed only while M-2 is milestone-gated"
                );
            }
            const evidenceDigest = sha256(evidence);
            items.push({
                id: `T-TRIAGE:${requirement.id}:${evidenceDigest}`,
                type: "T-TRIAGE",
                source: {
                    kind: "traceability-remaining-evidence",
                    id: requirement.id,
                    digest: evidenceDigest
                },
                owner: "maintainer-triage",
                priority: NEUTRAL_TRIAGE_PRIORITY,
                summary: `Type the disposition and oracle for ${requirement.id} evidence ${evidenceDigest}`,
                notes: [evidence],
                oracle: {
                    kind: "typed-disposition",
                    requirementId: requirement.id,
                    evidenceDigest,
                    expected: "migrated-or-permanent"
                }
            });
        }
    }
    for (const entry of traceability.releaseChain.entries) {
        for (const [link, value] of Object.entries(entry)) {
            if (value?.status !== "open") continue;
            items.push({
                id: `T-EVIDENCE:${entry.requirementId}:${link}`,
                type: "T-EVIDENCE",
                source: { kind: "release-chain", id: entry.requirementId, link },
                owner: "W0",
                priority: NEUTRAL_TRIAGE_PRIORITY,
                summary: `Close ${entry.requirementId} release-chain link ${link}`,
                notes: [value.reason],
                oracle: {
                    kind: "release-link-status",
                    requirementId: entry.requirementId,
                    link,
                    expected: "recorded"
                }
            });
        }
    }
    assertUniqueIds(items, (item) => item.id, "derived doctrine backlog");
    validateSources(items);
    return {
        edition: "1.0.0",
        generatedFrom: {
            doctrine: "artifacts/quality/doctrine.json",
            traceability: "artifacts/traceability.yaml",
            conformance: "artifacts/conformance/index.json"
        },
        items: items.sort(
            (left, right) => left.priority - right.priority || compareCodeUnits(left.id, right.id)
        )
    };
}

function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function validateSources(items) {
    const sources = new Set();
    for (const item of items) {
        if (
            !isNonEmptyString(item.oracle?.kind) ||
            !isNonEmptyString(item.summary) ||
            !isNonEmptyString(item.owner) ||
            !Number.isInteger(item.priority) ||
            item.priority < 1
        ) {
            throw new TypeError(`Backlog item ${item.id} lacks a typed oracle or summary`);
        }
        const source = JSON.stringify(item.source);
        if (sources.has(source)) throw new TypeError(`Backlog source is duplicated: ${source}`);
        sources.add(source);
    }
}

async function main() {
    const mode = parseMode(process.argv.slice(2));
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/doctrine.json"));
    const traceability = await readCanonicalJson(resolve(artifactRoot, "traceability.yaml"));
    const index = await readCanonicalJson(resolve(artifactRoot, "conformance/index.json"));
    const fragments = await Promise.all(
        index.fragments.map((fragment) =>
            readCanonicalJson(resolve(artifactRoot, "conformance", fragment))
        )
    );
    const backlog = deriveBacklog(policy, traceability, fragments);
    const path = resolve(artifactRoot, "quality/backlog.json");
    const prettierConfig = await resolveConfig(path);
    const expected = await format(JSON.stringify(backlog), {
        ...prettierConfig,
        filepath: path
    });
    if (mode === "write") {
        await writeFile(path, expected, "utf8");
    } else {
        const committed = await readFile(path, "utf8");
        if (committed !== expected) {
            throw new TypeError("Derived doctrine backlog is stale; run pnpm backlog:update");
        }
    }
    console.log(`Derived doctrine backlog verified: ${backlog.items.length} items`);
}

function parseMode(args) {
    if (JSON.stringify(args) === JSON.stringify(["--check"])) return "check";
    if (JSON.stringify(args) === JSON.stringify(["--write"])) return "write";
    throw new TypeError("Backlog generator requires exactly --check or --write");
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) await main();
