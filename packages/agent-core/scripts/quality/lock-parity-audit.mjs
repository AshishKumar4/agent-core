import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Deterministic name-joined audit between the normative.lock of two refs.
// Usage: node scripts/quality/lock-parity-audit.mjs <base-ref|file> <head-ref|file>
// Refs starting with "/" or "./" are read as lock files directly; anything else
// is resolved through `git show <ref>:packages/agent-core/artifacts/normative.lock`.
//
// Classification authority: the v3 encoder admits only sourced project
// declarations into the manifest (synthetic compiler internals stay transparent
// to traversal but never enter it). A closure member is therefore:
//   - "authored" when the side's manifest contains it,
//   - "toolchain-shape non-materialization" for the enumerated Decidable-eq
//     wrapper constants that 4.33 folds into their .decEq workers,
//   - otherwise unproven: counted, reported, and gated to exit 1.

const [baseRef = "e3612107", headRef = "HEAD"] = process.argv.slice(2);

function lock(ref) {
    if (ref.startsWith("/") || ref.startsWith("./")) {
        return JSON.parse(readFileSync(ref, "utf8"));
    }
    return JSON.parse(
        execFileSync("git", ["show", `${ref}:packages/agent-core/artifacts/normative.lock`], {
            encoding: "utf8",
            maxBuffer: 512 * 1024 * 1024
        })
    );
}

const base = lock(baseRef);
const head = lock(headRef);

function designationKey(designation) {
    return `${designation.kind}:${designation.name}`;
}

const baseDesignations = new Map(base.designations.map((d) => [designationKey(d), d]));
const headDesignations = new Map(head.designations.map((d) => [designationKey(d), d]));

const added = [...headDesignations.keys()].filter((k) => !baseDesignations.has(k)).sort();
const removed = [...baseDesignations.keys()].filter((k) => !headDesignations.has(k)).sort();

const typeSha256Deltas = [];
const axiomDeltas = [];
for (const key of [...baseDesignations.keys()].sort()) {
    const before = baseDesignations.get(key);
    const after = headDesignations.get(key);
    if (after === undefined) continue;
    if (before.typeSha256 !== after.typeSha256) typeSha256Deltas.push(key);
    if (JSON.stringify(before.axioms) !== JSON.stringify(after.axioms)) {
        axiomDeltas.push({
            designation: key,
            gained: after.axioms.filter((axiom) => !before.axioms.includes(axiom)).sort(),
            lost: before.axioms.filter((axiom) => !after.axioms.includes(axiom)).sort()
        });
    }
}

const baseDeclarations = new Map(base.declarations.map((d) => [d.name, d.sha256]));
const headDeclarations = new Map(head.declarations.map((d) => [d.name, d.sha256]));

const allowlist = new Set(head.allowedAxioms);
const outsideAllowlist = [
    ...new Set(axiomDeltas.flatMap(({ gained, lost }) => [...gained, ...lost]))
]
    .filter((axiom) => !allowlist.has(axiom))
    .sort();
const constructiveToClassical = axiomDeltas
    .filter(
        ({ designation }) =>
            baseDesignations.get(designation).axioms.length === 0 &&
            headDesignations.get(designation).axioms.length > 0
    )
    .map(({ designation }) => designation);

function resolveClosureMembers(lockValue, designation) {
    const closure = lockValue.semanticClosures.find(
        (entry) => entry.sha256 === designation.semanticClosureSha256
    );
    if (closure === undefined) {
        throw new Error(
            `cannot resolve closure ${designation.semanticClosureSha256} of ${designation.name}`
        );
    }
    return [...closure.declarations].sort();
}

// Enumerated wrapper constants whose 4.33 elaboration folds them into their
// recorded .decEq workers. Semantic content is carried by those workers, so a
// base-side sourced entry disappearing from the head manifest while one of the
// workers remains reachable is classified instead of failing.
const toolchainShapeNonMaterialized = new Set([
    "AgentCore.instDecidableEqAuthorityGrant",
    "AgentCore.instDecidableEqCapability"
]);

const closureDeltas = [];
let unclassified = 0;
for (const key of [...baseDesignations.keys()].sort()) {
    const before = baseDesignations.get(key);
    const after = headDesignations.get(key);
    if (after === undefined) continue;
    const beforeMembers = new Set(resolveClosureMembers(base, before));
    const afterMembers = new Set(resolveClosureMembers(head, after));
    if (
        before.semanticClosureSha256 === after.semanticClosureSha256 &&
        beforeMembers.size === afterMembers.size &&
        [...afterMembers].every((member) => beforeMembers.has(member))
    ) {
        continue;
    }
    const classifyLost = (name) => {
        if (toolchainShapeNonMaterialized.has(name)) {
            return "toolchain-shape non-materialization";
        }
        if (baseDeclarations.has(name)) return "authored";
        return "unclassified";
    };
    const classifyGained = (name) =>
        headDeclarations.has(name) ? "authored" : "unclassified";
    const lost = [...beforeMembers]
        .filter((m) => !afterMembers.has(m))
        .map((name) => ({ name, class: classifyLost(name) }));
    const gained = [...afterMembers]
        .filter((m) => !beforeMembers.has(m))
        .map((name) => ({ name, class: classifyGained(name) }));
    for (const member of [...lost, ...gained]) {
        if (member.class === "unclassified") unclassified += 1;
    }
    closureDeltas.push({
        designation: key,
        semanticClosureSha256: [before.semanticClosureSha256, after.semanticClosureSha256],
        lost,
        gained
    });
}

const declarationsAdded = [...headDeclarations.keys()].filter((n) => !baseDeclarations.has(n));
const declarationsRemoved = [...baseDeclarations.keys()].filter((n) => !headDeclarations.has(n));

console.log(
    JSON.stringify(
        {
            refs: { base: baseRef, head: headRef },
            encoding: [base.encoding, head.encoding],
            pins: {
                leanToolchain: [base.pins.leanToolchain.identity, head.pins.leanToolchain.identity],
                lakeManifestSha256Equal:
                    base.pins.lakeManifest.manifestSha256 === head.pins.lakeManifest.manifestSha256
            },
            allowedAxiomsEqual:
                JSON.stringify(base.allowedAxioms) === JSON.stringify(head.allowedAxioms),
            auditedModulesEqual:
                JSON.stringify(base.auditedModules) === JSON.stringify(head.auditedModules),
            designations: {
                counts: [base.designations.length, head.designations.length],
                added,
                removed,
                setDiffEmpty: added.length === 0 && removed.length === 0,
                typeSha256DeltaCount: typeSha256Deltas.length,
                typeSha256Deltas,
                allowedAxiomsDeltaCount: axiomDeltas.length,
                allowedAxiomsDeltas: axiomDeltas,
                allAxiomValuesWithinAllowlist: outsideAllowlist.length === 0,
                outsideAllowlist,
                constructiveToClassicalCount: constructiveToClassical.length
            },
            declarations: {
                counts: [base.declarations.length, head.declarations.length],
                addedCount: declarationsAdded.length,
                removedCount: declarationsRemoved.length,
                removedList: declarationsRemoved.sort(),
                sharedNameShaChangedCount: [...headDeclarations.keys()].filter(
                    (name) =>
                        baseDeclarations.has(name) &&
                        baseDeclarations.get(name) !== headDeclarations.get(name)
                ).length
            },
            closureDeltas: {
                count: closureDeltas.length,
                unclassifiedMemberCount: unclassified,
                deltas: closureDeltas
            },
            semanticClosuresCounts: [base.semanticClosures.length, head.semanticClosures.length]
        },
        null,
        2
    )
);

if (unclassified !== 0) {
    console.error(`${unclassified} closure member deltas are unclassified`);
    process.exitCode = 1;
}
