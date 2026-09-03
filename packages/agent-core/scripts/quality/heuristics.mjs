import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { sourceFiles } from "./compiler.mjs";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertOneOf,
    assertString,
    assertUniqueIds,
    collectFiles,
    compareCanonicalText,
    isNonEmptyString,
    packageRoot,
    portable,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";

/**
 * Semantic heuristics: every place the kernel decides a domain fact by guessing at the
 * shape of a value instead of reading a declaration, and every external fact it relies on
 * without naming it.
 *
 * `artifacts/substrate-contracts.json` already does this for the substrate seams: the
 * premises a law cannot state are named one by one, each with the channel that discharges
 * it, and `check-substrate-contracts.mjs` exists to make those citations able to fail.
 * `artifacts/quality/heuristic-register.json` is the same instrument pointed at the source
 * itself, and this is its checker.
 *
 * Four detectors run over the two source universes. Each is deliberately syntactic and
 * total — a construction, not a judgement — because the judgement is what the register
 * carries and a detector that judged would be a second, unreviewable opinion:
 *
 * - `prefix-dispatch`: a `startsWith`/`endsWith` test. Deciding what a value *is* from how
 *   its text begins survives renaming the thing it describes, which is the defect.
 * - `opaque-catch`: a `catch` with no binding. The failure's identity is discarded, so
 *   whatever the block decides next was decided without evidence about what failed.
 * - `ambient-clock`: `Date.now`, `performance.now`, a zero-argument `new Date`, or a timer
 *   call. Real time is not in the record, so any answer derived from it rests on the host.
 * - `unnamed-bound`: a numeric literal other than 0, 1 or 2 compared against something.
 *   A bound with no name has no declared source and no way to be wrong.
 *
 * The register must answer every detected site exactly once and name no site that is not
 * detected, so the two cannot drift in either direction: a new guess fails as unregistered
 * and a row left behind by a fix fails as unlocated. Each row is then answered one of
 * three ways, and none of the three is prose:
 *
 * - `eliminated` — the guess is gone. The row anchors the declared decision that replaced
 *   it and cites the test that fails if the guess comes back, so deleting the declaration
 *   breaks the anchor.
 * - `declared` — the construction *is* the declared semantics, quoting the SPEC clause
 *   that declares it. The quote must occur in SPEC.md, so rewording the clause reopens it.
 * - `bound` — the fact is genuinely outside the process. The row names a premise from this
 *   register's own premise table, and the premise carries executable evidence: a test, a
 *   probe pinning a standard's behavior, or an existing substrate-contracts premise.
 * - `withheld` — the elimination is correct and cannot be applied yet, because the file's
 *   bytes are frozen by the committed live-substrate archive and changing them would
 *   retract every conformance row verified from it. The row states the exact edit it owes
 *   and names the file the archive fingerprints; the checker reads that map, so a
 *   withholding can only be claimed for a file the archive really freezes. This is not an
 *   exemption: the finding stays counted, stays owed, and is reported by name.
 *
 * What this checker does not do is decide whether a premise is true. A premise is bound to
 * evidence that can fail; whether the host honors it is what the evidence measures.
 */

const DETECTORS = Object.freeze(["ambient-clock", "opaque-catch", "prefix-dispatch", "unnamed-bound"]);
const DISPOSITIONS = Object.freeze(["bound", "declared", "eliminated", "withheld"]);
const PREMISE_CHANNELS = Object.freeze(["spec", "standard", "substrateContract", "test"]);
const SHAPES = Object.freeze([
    "catch-to-domain",
    "duck-typing",
    "external-assumption",
    "insertion-order",
    "magic-literal",
    "name-shape",
    "prefix-dispatch",
    "silent-default",
    "timing"
]);
/**
 * The source universes, fixed here rather than trusted from the artifact. A register that
 * could name its own scope could answer every question by narrowing it.
 */
const ROOTS = Object.freeze(["packages/agent-core/src", "packages/agent-core-cloudflare/src"]);
/** Timer entry points: scheduling is a decision about when, made by the host. */
const TIMERS = new Set(["queueMicrotask", "setImmediate", "setInterval", "setTimeout"]);
/** Literals a comparison may carry unnamed: emptiness, singularity, and a pair. */
const UNBOUNDED_LITERALS = new Set(["0", "1", "2"]);
const COMPARISONS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.LessThanToken
]);

const options = parseArguments(process.argv.slice(2));
const register = await readCanonicalJson(options.register);
validateShape(register);
const detected = await detect();
const failures = [
    ...checkSites(register, detected),
    ...(await checkAnchors(register)),
    ...(await checkEvidence(register)),
    ...(await checkWithheld(register))
];
await writeCanonicalJson(resolve(options.reportRoot, "heuristics.json"), {
    edition: "1.0.0",
    stage: options.stage,
    detected: detected.size,
    registered: register.sites.length,
    byDisposition: Object.fromEntries(
        DISPOSITIONS.map((disposition) => [
            disposition,
            register.sites.filter((site) => site.disposition === disposition).length
        ])
    ),
    // Named, not counted: a withheld elimination is owed work, and a report that only
    // totalled them would let one quietly become permanent.
    withheld: register.sites
        .filter((site) => site.disposition === "withheld")
        .map((site) => ({ id: site.id, file: site.file, line: site.line, owedEdit: site.owedEdit })),
    failures
});
if (failures.length > 0) {
    throw new TypeError(
        `Semantic heuristic register does not answer its sources:\n${failures.map((failure) => `  ${failure}`).join("\n")}`
    );
}
const withheld = register.sites.filter((site) => site.disposition === "withheld");
console.log(
    `semantic heuristics registered: ${detected.size} detected site(s), ` +
        `${register.premises.length} named premise(s), 0 unregistered` +
        (withheld.length === 0
            ? ""
            : `\n${withheld.length} elimination(s) withheld behind the live archive: ` +
              withheld.map((site) => `${site.id} (${site.file}:${site.line})`).join(", "))
);

/** Every site the detectors find, keyed by `file:line:detector`. */
async function detect() {
    const files = (
        await Promise.all(
            ROOTS.map((root) =>
                collectFiles(resolve(repositoryRoot, root), (path) => isSourceFile(path))
            )
        )
    )
        .flat()
        .sort(compareCanonicalText);
    const sites = new Map();
    for (const [path, parsed] of sourceFiles(files)) {
        const file = portable(relative(repositoryRoot, path));
        const record = (detector, node) => {
            const line = lineOf(parsed, node);
            sites.set(`${file}:${line}:${detector}`, { file, line, detector });
        };
        visit(parsed, (node) => inspect(node, record));
    }
    return sites;
}

function isSourceFile(path) {
    return path.endsWith(".ts") && !path.endsWith(".d.ts");
}

function visit(node, inspector) {
    inspector(node);
    node.forEachChild((child) => visit(child, inspector));
}

function lineOf(parsed, node) {
    return parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
}

function inspect(node, record) {
    if (ts.isCatchClause(node) && node.variableDeclaration === undefined) {
        record("opaque-catch", node);
        return;
    }
    if (ts.isNewExpression(node)) {
        if (isNamed(node.expression, "Date") && (node.arguments ?? []).length === 0) {
            record("ambient-clock", node);
        }
        return;
    }
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
        const unnamed = [node.left, node.right].some(
            (operand) => ts.isNumericLiteral(operand) && !UNBOUNDED_LITERALS.has(operand.text)
        );
        if (unnamed) record("unnamed-bound", node);
        return;
    }
    if (!ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node.expression) && TIMERS.has(node.expression.text)) {
        record("ambient-clock", node);
        return;
    }
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const member = node.expression.name.text;
    if (member === "startsWith" || member === "endsWith") record("prefix-dispatch", node);
    else if (
        member === "now" &&
        (isNamed(node.expression.expression, "Date") ||
            isNamed(node.expression.expression, "performance"))
    ) {
        record("ambient-clock", node);
    }
}

function isNamed(node, name) {
    return ts.isIdentifier(node) && node.text === name;
}

/** The register's own shape, checked before any file it names is opened. */
function validateShape(value) {
    assertExactKeys(
        value,
        ["detectors", "edition", "owner", "premises", "scope", "sites"],
        "quality/heuristic-register.json"
    );
    if (value.edition !== "1.0.0") throw new TypeError("Heuristic register edition is unsupported");
    assertString(value.owner, "quality/heuristic-register.json owner");
    assertExactKeys(value.scope, ["premiseSource", "roots", "spec"], "heuristic register scope");
    assertString(value.scope.spec, "heuristic register scope spec");
    assertString(value.scope.premiseSource, "heuristic register scope premiseSource");
    if (JSON.stringify(value.scope.roots) !== JSON.stringify([...ROOTS])) {
        throw new TypeError(
            `Heuristic register scope is not the audited source universe: expected=${ROOTS.join(",")}`
        );
    }
    assertArray(value.detectors, "heuristic register detectors");
    assertUniqueIds(value.detectors, (entry) => entry.id, "heuristic register detectors");
    for (const detector of value.detectors) {
        assertExactKeys(detector, ["id", "statement"], "heuristic register detector");
        assertOneOf(detector.id, [...DETECTORS], "heuristic register detector id");
        assertString(detector.statement, "heuristic register detector statement");
    }
    const declared = value.detectors.map((detector) => detector.id).sort(compareCanonicalText);
    if (JSON.stringify(declared) !== JSON.stringify([...DETECTORS])) {
        throw new TypeError(
            `Heuristic register omits a detector this checker runs: expected=${DETECTORS.join(",")}`
        );
    }
    validatePremises(value);
    validateSites(value);
}

function validatePremises(value) {
    assertArray(value.premises, "heuristic register premises");
    assertUniqueIds(value.premises, (entry) => entry.premise, "heuristic register premises");
    for (const premise of value.premises) {
        assertExactKeys(
            premise,
            ["channel", "evidence", "premise", "statement"],
            "heuristic register premise"
        );
        assertString(premise.premise, "heuristic register premise name");
        assertString(premise.statement, "heuristic register premise statement");
        assertOneOf(premise.channel, [...PREMISE_CHANNELS], `premise ${premise.premise} channel`);
        validateEvidenceShape(premise.evidence, `premise ${premise.premise}`, premise.channel);
    }
}

function validateSites(value) {
    assertArray(value.sites, "heuristic register sites");
    assertUniqueIds(value.sites, (site) => site.id, "heuristic register sites");
    const premises = new Set(value.premises.map((premise) => premise.premise));
    const located = new Set();
    for (const site of value.sites) {
        const keys = ["anchor", "detector", "disposition", "file", "guess", "id", "line", "rationale", "shape"];
        const optional = {
            bound: ["premise"],
            declared: ["evidence"],
            eliminated: ["evidence", "replaced"],
            withheld: ["frozenBy", "owedEdit", "premise"]
        };
        assertOneOf(site.disposition, [...DISPOSITIONS], `heuristic site ${site.id} disposition`);
        assertExactKeys(
            site,
            [...keys, ...optional[site.disposition]].sort(compareCanonicalText),
            `heuristic site ${site.id}`
        );
        for (const field of ["anchor", "file", "guess", "id", "rationale"]) {
            assertString(site[field], `heuristic site ${site.id} ${field}`);
        }
        assertOneOf(site.shape, [...SHAPES], `heuristic site ${site.id} shape`);
        if (!site.id.startsWith("HR-")) {
            throw new TypeError(`Heuristic site ${site.id} is not named for this register`);
        }
        if (!Number.isSafeInteger(site.line) || site.line < 1) {
            throw new TypeError(`Heuristic site ${site.id} does not state a source line`);
        }
        if (!ROOTS.some((root) => site.file.startsWith(`${root}/`))) {
            throw new TypeError(`Heuristic site ${site.id} is outside the audited sources`);
        }
        if (site.detector !== null) {
            assertOneOf(site.detector, [...DETECTORS], `heuristic site ${site.id} detector`);
        }
        const key = `${site.file}:${site.line}:${site.detector ?? "reviewed"}`;
        if (located.has(key)) throw new TypeError(`Heuristic site ${site.id} repeats ${key}`);
        located.add(key);
        if (site.disposition === "eliminated") {
            if (site.detector !== null) {
                throw new TypeError(
                    `Heuristic site ${site.id} claims elimination and still names detector ${site.detector}`
                );
            }
            if (!isNonEmptyString(site.replaced)) {
                throw new TypeError(`Heuristic site ${site.id} does not say what it replaced`);
            }
            validateEvidenceShape(site.evidence, `heuristic site ${site.id}`, "test");
        }
        if (site.disposition === "declared") {
            validateEvidenceShape(site.evidence, `heuristic site ${site.id}`, "declared");
        }
        if (site.disposition === "withheld") {
            if (!isNonEmptyString(site.owedEdit)) {
                throw new TypeError(`Heuristic site ${site.id} withholds an unstated edit`);
            }
            if (site.frozenBy !== site.file) {
                throw new TypeError(
                    `Heuristic site ${site.id} withholds against ${site.frozenBy}, not its own file`
                );
            }
            if (site.detector === null) {
                throw new TypeError(
                    `Heuristic site ${site.id} withholds an elimination no detector still sees`
                );
            }
        }
        if (site.disposition === "bound" || site.disposition === "withheld") {
            assertString(site.premise, `heuristic site ${site.id} premise`);
            if (!premises.has(site.premise)) {
                throw new TypeError(
                    `Heuristic site ${site.id} names premise ${site.premise}, which this register does not state`
                );
            }
        }
    }
    const cited = new Set(value.sites.map((site) => site.premise).filter(isNonEmptyString));
    const unused = [...premises].filter((premise) => !cited.has(premise)).sort(compareCanonicalText);
    if (unused.length > 0) {
        throw new TypeError(`Heuristic register states a premise no site binds: ${unused.join(", ")}`);
    }
}

function validateEvidenceShape(evidence, owner, expected) {
    const kinds = {
        premise: ["kind", "premise"],
        spec: ["clause", "kind", "quote"],
        standard: ["document", "kind", "probe", "statement"],
        test: ["file", "kind", "title"]
    };
    assertString(evidence?.kind, `${owner} evidence kind`);
    if (kinds[evidence.kind] === undefined) {
        throw new TypeError(`${owner} cites unknown evidence kind ${evidence.kind}`);
    }
    assertExactKeys(evidence, kinds[evidence.kind], `${owner} evidence`);
    if (evidence.kind === "standard") {
        assertExactKeys(evidence.probe, ["file", "title"], `${owner} standard probe`);
        assertString(evidence.probe.file, `${owner} standard probe file`);
        assertString(evidence.probe.title, `${owner} standard probe title`);
    }
    for (const [field, held] of Object.entries(evidence)) {
        if (field !== "probe") assertString(held, `${owner} evidence ${field}`);
    }
    // A channel decides which evidence a citation may rest on: `test` and `spec` name the
    // one kind their owner admits, `standard` and `substrateContract` name their own.
    const admitted = {
        // A declared construction may cite the SPEC clause that declares it, or the test
        // that pins the declaration where the declaring statement is an API precondition
        // this repository validates rather than prose the SPEC spells out.
        declared: ["spec", "test"],
        spec: ["spec"],
        standard: ["standard"],
        substrateContract: ["premise"],
        test: ["test"]
    };
    if (!admitted[expected].includes(evidence.kind)) {
        throw new TypeError(
            `${owner} is ${expected} evidence and cites a ${evidence.kind} citation instead`
        );
    }
}

/** The register answers exactly the sites the detectors find, in both directions. */
function checkSites(value, detectedSites) {
    const failures = [];
    const answered = new Map();
    for (const site of value.sites) {
        if (site.detector === null) continue;
        answered.set(`${site.file}:${site.line}:${site.detector}`, site);
    }
    for (const [key, site] of detectedSites) {
        if (!answered.has(key)) {
            failures.push(
                `unregistered semantic heuristic at ${site.file}:${site.line} (${site.detector})`
            );
        }
    }
    for (const [key, site] of answered) {
        if (!detectedSites.has(key)) {
            failures.push(
                `heuristic site ${site.id} names no detected ${site.detector} at ${site.file}:${site.line}`
            );
        }
    }
    // A reviewed row is for a guess no detector can see. One sitting on a detected line
    // would be answering a mechanical finding through the unmechanical path.
    for (const site of value.sites) {
        if (site.detector !== null) continue;
        const collision = DETECTORS.filter((detector) =>
            detectedSites.has(`${site.file}:${site.line}:${detector}`)
        );
        if (collision.length > 0) {
            failures.push(
                `heuristic site ${site.id} is reviewed and its line is detected as ${collision.join(", ")}`
            );
        }
    }
    return failures;
}

/**
 * Every row's anchor is the text at the line it names. This is what makes a row perishable:
 * an eliminated guess whose declared replacement is deleted, or a bound site whose code
 * moved, stops being described by its own citation and fails here rather than going stale
 * in silence.
 */
async function checkAnchors(value) {
    const failures = [];
    const lines = new Map();
    for (const site of value.sites) {
        if (!lines.has(site.file)) {
            lines.set(
                site.file,
                (await readFile(resolve(repositoryRoot, site.file), "utf8")).split("\n")
            );
        }
        const held = lines.get(site.file)[site.line - 1];
        if (held === undefined || held.trim() !== site.anchor) {
            failures.push(
                `heuristic site ${site.id} anchor does not match ${site.file}:${site.line}`
            );
        }
    }
    return failures;
}

/** Every citation resolves to text that exists: a SPEC clause, a test title, a premise. */
async function checkEvidence(value) {
    const failures = [];
    const spec = await readFile(resolve(packageRoot, value.scope.spec), "utf8");
    const contracts = await readCanonicalJson(resolve(packageRoot, value.scope.premiseSource));
    const substratePremises = new Set(contracts.premises.map((premise) => premise.premise));
    const titles = new Map();
    const titleHolds = async (file, title) => {
        if (!titles.has(file)) {
            try {
                titles.set(file, await readFile(resolve(packageRoot, file), "utf8"));
            } catch {
                titles.set(file, undefined);
            }
        }
        const source = titles.get(file);
        return source !== undefined && source.includes(title);
    };
    const cited = [
        ...value.premises.map((premise) => [`premise ${premise.premise}`, premise.evidence]),
        ...value.sites
            .filter((site) => site.evidence !== undefined)
            .map((site) => [`heuristic site ${site.id}`, site.evidence])
    ];
    for (const [owner, evidence] of cited) {
        if (evidence.kind === "spec" && !spec.includes(evidence.quote)) {
            failures.push(`${owner} quotes prose ${value.scope.spec} does not state`);
        }
        if (evidence.kind === "premise" && !substratePremises.has(evidence.premise)) {
            failures.push(`${owner} cites substrate premise ${evidence.premise}, which is not declared`);
        }
        if (evidence.kind === "test" && !(await titleHolds(evidence.file, evidence.title))) {
            failures.push(`${owner} cites a test title ${evidence.file} does not carry`);
        }
        if (
            evidence.kind === "standard" &&
            !(await titleHolds(evidence.probe.file, evidence.probe.title))
        ) {
            failures.push(`${owner} cites a probe title ${evidence.probe.file} does not carry`);
        }
    }
    return failures;
}

/**
 * A withheld elimination is only honest if the freeze is real, so the claim is checked
 * against the live archive's own fingerprint map rather than believed. A row withholding a
 * file the archive does not fingerprint is a row hiding behind a freeze that would not
 * happen, and a file that leaves the map has to be eliminated rather than re-withheld.
 */
async function checkWithheld(value) {
    const withheld = value.sites.filter((site) => site.disposition === "withheld");
    if (withheld.length === 0) return [];
    const archive = await readCanonicalJson(
        resolve(artifactRoot, "conformance/live-evidence/run.json")
    );
    const frozen = new Set(Object.keys(archive.sourceFingerprints));
    return withheld
        .filter((site) => !frozen.has(site.frozenBy))
        .map(
            (site) =>
                `heuristic site ${site.id} withholds behind ${site.frozenBy}, which the live archive does not fingerprint`
        );
}

function parseArguments(args) {
    let stage = "building";
    let selectedRegister = resolve(artifactRoot, "quality/heuristic-register.json");
    let selectedReportRoot = reportRoot;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--register") selectedRegister = resolve(required(args, ++index, argument));
        else if (argument === "--report-root")
            selectedReportRoot = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown heuristics argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, register: selectedRegister, reportRoot: selectedReportRoot };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
