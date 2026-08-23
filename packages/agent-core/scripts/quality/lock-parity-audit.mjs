import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Deterministic name-joined audit between the normative.lock of two git refs.
// Usage: node scripts/quality/lock-parity-audit.mjs <base-ref> <head-ref>
// Emits canonical JSON on stdout: designation set diffs, per-designation
// typeSha256 deltas, allowedAxioms deltas with drop/gain direction, and
// declaration-closure growth classified by auxiliary family.

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

const auxiliaryFamily = /(\.ctorIdx|\.casesOn|\.noConfusion|\.rec\b|\.recOn|\.brecOn|\.below|match_\d|\.matcher|_eq_def|_eq_\d+$|sizeOf|injEq|\.decEq|instDecidable)/;

function classify(name) {
    return auxiliaryFamily.test(name) ? "auxiliary" : "source";
}

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
    const gained = [...afterMembers].filter((m) => !beforeMembers.has(m)).map((name) => ({
        name,
        class: classify(name)
    }));
    const lost = [...beforeMembers].filter((m) => !afterMembers.has(m)).map((name) => ({
        name,
        class: classify(name)
    }));
    for (const member of [...gained, ...lost]) {
        if (member.class !== "auxiliary" && member.class !== "source") unclassified += 1;
    }
    closureDeltas.push({
        designation: key,
        semanticClosureSha256: [before.semanticClosureSha256, after.semanticClosureSha256],
        gained,
        lost
    });
}

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

const baseDeclarations = new Map(base.declarations.map((d) => [d.name, d.sha256]));
const headDeclarations = new Map(head.declarations.map((d) => [d.name, d.sha256]));
const declarationsAdded = [...headDeclarations.keys()].filter((n) => !baseDeclarations.has(n));
const declarationsRemoved = [...baseDeclarations.keys()].filter((n) => !headDeclarations.has(n));
const declarationsAddedAuxiliary = declarationsAdded.filter((name) => auxiliaryFamily.test(name));

console.log(
    JSON.stringify(
        {
            refs: { base: baseRef, head: headRef },
            pins: {
                leanToolchain: [base.pins.leanToolchain.identity, head.pins.leanToolchain.identity],
                lakeManifestSha256Equal:
                    base.pins.lakeManifest.manifestSha256 === head.pins.lakeManifest.manifestSha256
            },
            schemaVersionEqual: base.schemaVersion === head.schemaVersion,
            encodingVersionEqual: base.encodingVersion === head.encodingVersion,
            allowedAxiomsEqual:
                JSON.stringify(base.allowedAxioms) === JSON.stringify(head.allowedAxioms),
            auditedModulesEqual: JSON.stringify(base.auditedModules) === JSON.stringify(head.auditedModules),
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
                addedAuxiliaryClassified: declarationsAddedAuxiliary.length,
                addedUnclassifiedSample: declarationsAdded.filter((name) => !auxiliaryFamily.test(name)).slice(0, 30),
                sharedNameShaChangedCount: [...headDeclarations.keys()].filter(
                    (name) => baseDeclarations.has(name) && baseDeclarations.get(name) !== headDeclarations.get(name)
                ).length,
                removedSample: declarationsRemoved.slice(0, 60)
            },
            semanticClosuresCounts: [base.semanticClosures.length, head.semanticClosures.length],
            closureDeltas: {
                count: closureDeltas.length,
                unclassifiedMemberCount: unclassified,
                sourceLossCount: closureDeltas.reduce(
                    (sum, delta) =>
                        sum + delta.lost.filter((member) => member.class === "source").length,
                    0
                ),
                deltas: closureDeltas
            }
        },
        null,
        2
    )
);
