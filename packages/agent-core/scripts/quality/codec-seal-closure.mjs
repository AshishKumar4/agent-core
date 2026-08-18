// Codec seal closure. `sealRecordClasses` freezes exactly the classes a codec names, so a
// codec naming only an exported abstract base leaves its cases' prototypes writable. Those
// prototypes are where the behaviour lives — `requireEvidence` on a coherence verdict, `fold`
// on a plan change — so omitting them means the mechanism silently does not do its job:
// `Object.defineProperty(prototype, method, …)` still succeeds and the record's own guarantee
// can be redefined at runtime.
//
// THE RULE. When a codec's declared tuple names a class B, every module-private class that
// extends B must be named too whenever a prototype in that chain carries a MEMBER — method,
// getter or setter — whether the member is the case's own or B's.
//
// The second half of that condition is the whole point, and it is the part nobody derives by
// reading. A case's prototype sits BETWEEN the instance and the base, so writing a method
// there does not replace the base's guard — it SHADOWS it. Shadowing is strictly more
// dangerous than replacing a base method, because the base still reads correct, every other
// case still behaves, and only the one shadowed case silently permits what it exists to
// forbid. So a case carrying nothing at all is still a hole when its base carries the guard:
// `TerminalTurn` has only a `kind` field, yet
// `Object.defineProperty(TerminalTurn.prototype, "claim", …)` turned
// `TurnStatus.succeeded.claim()` from a throw into a transition to `running` — AGENTS.md's
// own sentence, that illegal transitions must be unrepresentable as method calls that
// succeed, violated verbatim. An earlier narrower rule asked only about the case's own
// members and passed over it; a rule scoped to preserve that premise is not a gate.
//
// The same two lines apply to `EventVerification.equals`, so `VerifiedEvent`/`HostEvent` are
// findings too and `EventCodecV1` names them. Two class names cost nothing; a false pass
// costs a guarantee whose failure is invisible in the evidence plane.
//
// Why the check reads what a codec CONSTRUCTS rather than what happens to be frozen when it
// runs: a seal that depends on another codec's construction order is not a seal. `TextId`
// measures as frozen inside plan.ts only because CoherenceFindingCodecV1 was constructed
// first, so a tuple trimmed against observed frozenness would silently depend on module load
// order.
//
// SCOPE, stated because a silent limit is worse than a declared one: the walk is
// module-local. A base imported from another context — `CodecRecord` — has members this pass
// cannot read, so for those the condition falls back to the case's own members. A negative
// control aimed at such a base fires nothing and proves nothing.
//
// It reports; it does not fix. Each finding names the codec, the base it named, the missing
// class, and the prototype members that are consequently writable.
import { relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { sourceFiles } from "./compiler.mjs";
import { ownersForPath, patternsForOwnership } from "./ownership.mjs";
import {
    artifactRoot,
    collectFiles,
    compareCanonicalText,
    packageRoot,
    portable,
    readCanonicalJson,
    writeCanonicalJson
} from "./project.mjs";

const writeOwed = process.argv.slice(2).includes("--update-owed");
const ownershipPatterns = patternsForOwnership(
    await readCanonicalJson(resolve(artifactRoot, "quality/ownership.json"))
);

const sourceRoot = resolve(packageRoot, "src");
const paths = (await collectFiles(sourceRoot, (path) => path.endsWith(".ts"))).filter(
    (path) => !path.endsWith(".d.ts")
);
const findings = [];
const sealed = [];
const delegating = [];
const unsealed = [];

for (const [path, source] of sourceFiles(paths)) {
    if (source === undefined || source.isDeclarationFile) continue;
    const file = portable(relative(packageRoot, path));
    const classes = source.statements.filter(ts.isClassDeclaration);
    const named = new Map(
        classes.flatMap((node) => (node.name === undefined ? [] : [[node.name.text, node]]))
    );
    for (const declaration of classes) {
        if (extendsName(declaration, source) !== "RecordCodec") continue;
        const codec = declaration.name?.text ?? "<anonymous>";
        const declared = declaredClosure(declaration, source);
        if (declared === "delegating") {
            // A generic forwarding codec takes its tuple as a constructor parameter, so the
            // closure is its callers' to declare and there is nothing literal to judge here.
            delegating.push(`${file}#${codec}`);
            continue;
        }
        if (declared === undefined) {
            unsealed.push(`${file}#${codec}`);
            continue;
        }
        sealed.push(`${file}#${codec}`);
        const inTuple = new Set(declared);
        for (const base of declared) {
            for (const [name, candidate] of named) {
                if (inTuple.has(name) || extendsName(candidate, source) !== base) continue;
                // Only a module-private case is reachable solely through its base. An
                // exported sibling that merely shares a base is a record in its own right
                // with its own codec and its own tuple, so naming it here would be a claim
                // about a decode path this codec does not have.
                if (isExported(candidate)) continue;
                // The case's own members, or — when it has none — the base's, because a
                // member on the base is exactly what an own method written onto this
                // prototype would shadow.
                const own = prototypeMembers(candidate, source);
                const baseDeclaration = named.get(base);
                const shadowable =
                    baseDeclaration === undefined
                        ? []
                        : prototypeMembers(baseDeclaration, source);
                const members = own.length > 0 ? own : shadowable;
                if (members.length === 0) continue;
                findings.push({
                    file,
                    codec,
                    base,
                    missing: name,
                    members,
                    risk: own.length > 0 ? "own" : "shadowed"
                });
            }
        }
    }
}

findings.sort((left, right) =>
    compareCanonicalText(
        `${left.file}#${left.codec}#${left.missing}`,
        `${right.file}#${right.codec}#${right.missing}`
    )
);
for (const finding of findings) {
    finding.fingerprint = `SEAL:${finding.file}#${finding.codec}:${finding.missing}`;
    finding.owner = ownersForPath(`packages/agent-core/${finding.file}`, ownershipPatterns).join("/");
    finding.counterfactual =
        `Object.defineProperty(${finding.missing}.prototype, "${finding.members[0]}", …) ` +
        `succeeds while ${finding.codec} does not name it, ` +
        (finding.risk === "own"
            ? `replacing the case's own ${finding.members[0]}`
            : `shadowing ${finding.base}.prototype.${finding.members[0]}`);
}

// The owed list is an enumeration of debts, never an exemption: each entry states what is
// owed and is discharged by naming the class, not by a written reason. There is no
// equivalent of `normative-coverage.json`'s `exempt` here, because the counterfactual is a
// proof in the opposite direction — the tamper succeeds — so a claim that one of these is
// harmless would be false.
const owedPath = resolve(artifactRoot, "quality/codec-seal-owed.json");
const owed = await readOwed(owedPath);
const owedFingerprints = new Set(owed.owed.map((entry) => entry.fingerprint));
const currentFingerprints = new Set(findings.map((finding) => finding.fingerprint));
const added = findings.filter((finding) => !owedFingerprints.has(finding.fingerprint));
const discharged = owed.owed.filter((entry) => !currentFingerprints.has(entry.fingerprint));

console.log(
    `codec seal closure: ${sealed.length} sealed codec(s), ${delegating.length} delegating, ` +
        `${unsealed.length} unsealed, ${findings.length} finding(s), ` +
        `${added.length} new, ${discharged.length} discharged`
);
for (const codec of unsealed.sort(compareCanonicalText)) {
    console.log(`  UNSEALED ${codec} names no record-class tuple`);
}
for (const finding of findings) {
    console.log(
        `  ${owedFingerprints.has(finding.fingerprint) ? "owed" : "NEW "} ` +
            `${finding.file}#${finding.codec} [${finding.owner}]: names ${finding.base} but not ` +
            `${finding.missing}, whose prototype ${finding.risk === "own" ? "carries" : "shadows"} ` +
            `${finding.members.join(", ")}`
    );
}
for (const entry of discharged) {
    console.log(`  DISCHARGED ${entry.fingerprint} no longer reproduces; remove it from the owed list`);
}

if (writeOwed) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError("Writing the codec seal owed list requires QUALITY_WRITE_BASELINE=1 outside CI");
    }
    await writeCanonicalJson(owedPath, {
        edition: "1.0.0",
        owed: findings.map(
            ({ fingerprint, file, codec, base, missing, members, risk, owner, counterfactual }) => ({
                fingerprint,
                file,
                codec,
                base,
                missing,
                members,
                risk,
                owner,
                counterfactual
            })
        )
    });
    console.log(`recorded ${findings.length} owed seal closure(s)`);
} else if (added.length > 0 || discharged.length > 0 || unsealed.length > 0) {
    // A discharged entry fails too: an owed list that keeps a fixed finding re-accepts the
    // defect the moment it returns, which is the failure mode the discrimination baseline
    // already refuses.
    process.exitCode = 1;
}

/** The class names a `super([...], kind, version)` call names, or undefined for a non-codec. */
function declaredClosure(declaration, source) {
    let closure;
    visit(declaration, (node) => {
        if (
            !ts.isCallExpression(node) ||
            node.expression.kind !== ts.SyntaxKind.SuperKeyword ||
            node.arguments.length !== 3
        ) {
            return;
        }
        if (!ts.isArrayLiteralExpression(node.arguments[0])) {
            closure = "delegating";
            return;
        }
        closure = node.arguments[0].elements
            .filter(ts.isIdentifier)
            .map((element) => element.getText(source));
    });
    return closure;
}

async function readOwed(path) {
    try {
        return await readCanonicalJson(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { edition: "1.0.0", owed: [] };
        throw error;
    }
}

function extendsName(declaration, source) {
    const clause = declaration.heritageClauses?.find(
        (candidate) => candidate.token === ts.SyntaxKind.ExtendsKeyword
    );
    const expression = clause?.types[0]?.expression;
    if (expression === undefined) return undefined;
    const target = ts.isCallExpression(expression) ? expression.expression : expression;
    return ts.isIdentifier(target) ? target.getText(source) : undefined;
}

/** Prototype members a tamperer can redefine. Instance fields live on the object, not here. */
function prototypeMembers(declaration, source) {
    return declaration.members
        .filter(
            (member) =>
                (ts.isMethodDeclaration(member) ||
                    ts.isGetAccessorDeclaration(member) ||
                    ts.isSetAccessorDeclaration(member)) &&
                !(member.modifiers ?? []).some(
                    (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
                )
        )
        .flatMap((member) => (member.name === undefined ? [] : [member.name.getText(source)]))
        .sort(compareCanonicalText);
}

function isExported(declaration) {
    return (declaration.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
}

function visit(node, inspect) {
    inspect(node);
    node.forEachChild((child) => visit(child, inspect));
}
