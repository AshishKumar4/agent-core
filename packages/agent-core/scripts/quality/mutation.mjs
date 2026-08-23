// Per-area mutation measurement with an actionability ratchet.
//
//   node scripts/quality/mutation.mjs --area authority            measure + gate one area
//   node scripts/quality/mutation.mjs --area authority --update   re-pin the area baseline
//   node scripts/quality/mutation.mjs --gate                      gate every measured area
//   node scripts/quality/mutation.mjs --area authority --report r.json
//                                                                  reclassify a recorded run
//
// Mutation testing is the objective adequacy signal: a test suite that cannot kill a
// behavior-changing mutant does not test that behavior. Full-tree mutation is far too
// slow for the default gates, so areas are measured one at a time and their results are
// pinned in artifacts/quality/mutation-baseline.json with a one-way ratchet: the count
// of actionable survivors in an area may only fall.
//
// Survivors are classified before they count:
//   actionable — behavior mutants (conditionals, operators, returns, literals that feed
//                identity such as codec field names and key namespaces). These indicate
//                missing behavioral assertions and ratchet toward zero.
//   tolerated  — mutants of human-facing message text inside throw sites. Tests assert
//                error codes and types, not prose; killing these would pin every message
//                string without adding behavioral confidence.
//   equivalent — mutants whose own entry in artifacts/quality/mutation-equivalence.json
//                proves no test can distinguish them. See mutation-equivalence.mjs; this
//                is the only way a survivor is excused, and there is no count-level
//                override. An actionable count that rises is closed by killing the
//                mutants or by proving them one at a time.
//
// The baseline holds counts, the register holds proofs, and neither restates the other:
// `mutants` counts every mutant Stryker ran, `killed + actionable + tolerated` counts the
// ones the register says nothing about, and the difference is exactly the entries the
// register carries for that area.
import { spawnSync } from "node:child_process";
import * as ts from "typescript/unstable/ast";
import { sourceFiles } from "./compiler.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { mutationFingerprint, sourceAreas } from "./mutation-inputs.mjs";
import { generatedMutants } from "./mutation-instrumenter.mjs";
import {
    auditEquivalenceAnchors,
    equivalenceArea,
    equivalenceKey,
    readEquivalenceRegister,
    reconcileEquivalence,
    requireCompleteMutationReport
} from "./mutation-equivalence.mjs";
import { gitHead, measureArea, requireAreaReport } from "./mutation-run.mjs";
import {
    artifactRoot,
    compareCanonicalText,
    packageRoot,
    readCanonicalJson,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

const options = parseArguments(process.argv.slice(2));
const baselinePath = options.baseline ?? resolve(artifactRoot, "quality/mutation-baseline.json");
const registerPath =
    options.registerArtifact ?? resolve(artifactRoot, "quality/mutation-equivalence.json");
const register = readEquivalenceRegister(await readCanonicalJson(registerPath));

if (options.gate) {
    // The gate follows the project's two-stage discipline. While the SPEC conformance
    // stage is `building`, the kill campaign is in flight: measured areas must be
    // fingerprint-fresh against current sources, and their actionable counts only
    // ratchet downward (enforced at measure time); unmeasured areas and nonzero
    // actionable counts are reported as notes. Declaring the stage `final` demands the
    // endgame: every source area measured fresh with zero actionable survivors.
    const stageArtifact = await readCanonicalJson(
        options.stageArtifact ?? resolve(artifactRoot, "conformance/stage.json")
    );
    const finalStage = stageArtifact.stage === "final";
    const baseline = await readCanonicalJson(baselinePath);
    const failures = [];
    const notes = [];
    const expectedAreas = sourceAreas();
    // Whether a registered mutant still *survives* is only knowable at measure time, and
    // is enforced there. Everything else the gate settles on every run: each entry still
    // anchors exactly one site in the tree it claims to describe, and the mutator and
    // replacement it names are still a mutation Stryker generates over that site. A proof
    // cannot quietly outlive either the code or the mutation it was written about.
    failures.push(
        ...(await auditEquivalenceAnchors(
            register,
            expectedAreas,
            (file) => {
                const path = resolve(packageRoot, file);
                return existsSync(path) ? readFileSync(path, "utf8") : undefined;
            },
            generatedMutants
        ))
    );
    const recordedAreas = Object.keys(baseline.areas).sort();
    const unmeasured = expectedAreas.filter((area) => baseline.areas[area] === undefined);
    if (unmeasured.length > 0) {
        (finalStage ? failures : notes).push(`unmeasured areas: ${unmeasured.join(", ")}`);
    }
    for (const area of recordedAreas) {
        if (!expectedAreas.includes(area)) {
            failures.push(`${area}: baseline records a nonexistent source area`);
        }
    }
    for (const area of expectedAreas) {
        const entry = baseline.areas[area];
        if (entry === undefined) continue;
        const proven = register.filter((item) => equivalenceArea(item.file) === area).length;
        console.log(
            `${area}: score ${entry.score}%, ${entry.actionable} actionable, ` +
                `${entry.tolerated} tolerated, ${proven} proven equivalent ` +
                `of ${entry.mutants} mutants`
        );
        if (entry.actionable > 0) {
            (finalStage ? failures : notes).push(`${area}: ${entry.actionable} actionable`);
        }
        const currentFingerprint = mutationFingerprint(area);
        if (entry.fingerprint !== currentFingerprint) {
            failures.push(`${area}: missing or stale mutation fingerprint`);
        }
    }
    for (const note of notes) console.log(`note: ${note}`);
    if (failures.length > 0) {
        throw new TypeError(`Mutation gate failed:\n${failures.join("\n")}`);
    }
    process.exit(0);
}

// An area is a src/ subdirectory, or a single root module such as errors.
if (!sourceAreas().includes(options.area)) {
    throw new TypeError(`Unknown source area: ${options.area}`);
}
const areaRoot = resolve(packageRoot, "src", options.area);
const areaFile = resolve(packageRoot, "src", `${options.area}.ts`);
const mutatePattern = existsSync(areaRoot)
    ? `src/${options.area}/**/*.ts`
    : existsSync(areaFile)
      ? `src/${options.area}.ts`
      : undefined;
if (mutatePattern === undefined) throw new TypeError(`Unknown source area: ${options.area}`);

/**
 * An area of pure re-export barrels has nothing to mutate, and Stryker cannot say so:
 * it instruments zero mutants and then exits non-zero because its dry run finds no
 * covering test — which happens only when no test in this package imports the file.
 * src/facets-public.ts survives that by accident, because something imports it, while
 * src/mediation-public.ts does not and failed the sweep. Deciding it from the source
 * makes the outcome a property of the area rather than of incidental coverage.
 *
 * Deliberately conservative: any statement that is not an import or a re-export means
 * the file may carry a mutant, so the area runs normally. Skipping an area that has
 * something to measure would be the expensive mistake.
 */
function barrelOnly(files) {
    return files.every((file) => {
        const source = sourceFiles([file]).get(file);
        return source.statements.every(
            (statement) =>
                ts.isImportDeclaration(statement) ||
                (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined)
        );
    });
}

const measured = await measurement();
// One gate, one place, for every source a report can arrive from — measured, reused, or
// named by `--report`. It used to be two: `measureArea` validated what it was about to
// cache and `--report` went straight to the status check, so a hand-written report of no
// files scored 100% and overwrote an area's committed discrimination attribution with
// nothing. A contaminated run has already written its ledger by now, so the refusals here
// name what went wrong without discarding what it cost to find out.
const report = requireCompleteMutationReport(
    measured.barrel
        ? requireNothingToMutate(measured.report)
        : requireAreaReport(measured.report, options.area)
);

/**
 * Where this run's mutant statuses come from. `--report` names a report a run already
 * produced, so a register repair can be checked against the run that found it instead of
 * paying half an hour to reproduce it — and Stryker's own report.json is scratch that the
 * next area overwrites, so a recorded copy is the only thing left to check against. It
 * cannot re-pin a baseline; `parseArguments` refuses that.
 */
async function measurement() {
    if (options.report !== undefined) {
        // A recorded report carries no commit, and the commit reading it is not the one
        // that produced it. `measuredAt` says where a measurement happened, so here it
        // says it does not know — the same word `gitHead` uses when git cannot answer.
        return {
            report: JSON.parse(readFileSync(resolve(packageRoot, options.report), "utf8")),
            measuredAt: "unknown",
            barrel: false
        };
    }
    // An empty report carries a barrel-only area through the same classification, survivor
    // and baseline path as any other, recording the zeros it truly has instead of branching.
    // It also costs nothing, so it earns no ledger and no cache entry.
    const areaSources = existsSync(areaRoot) ? typescriptSources(areaRoot) : [areaFile];
    if (barrelOnly(areaSources)) {
        return { report: { files: {} }, measuredAt: gitHead(), barrel: true };
    }
    return { ...(await measureArea(options.area, mutatePattern)), barrel: false };
}

/**
 * The one report allowed to be empty, and only because `barrelOnly` read the area's own
 * statements and found nothing a mutator could touch. A measurement of no mutants scores
 * 100% and reads to the ratchet as an area with no work left in it, so the exception is
 * bound to that decision rather than to the emptiness itself: if the area has files to
 * mutate, an empty report is a broken run, not a barrel.
 */
function requireNothingToMutate(empty) {
    if (Object.keys(empty.files).length > 0) {
        throw new TypeError(`Mutation area ${options.area} is barrel-only and reported mutants`);
    }
    return empty;
}

// Kill attribution is the trustworthy direction of a perTest measurement: a test is
// recorded only because it actually failed while the mutant was applied. The JSON
// report indexes killedBy into its testFiles section; a test's selector rebuilt from
// it is byte-identical to the conformance ledger's testSelectors format.
const testSelectors = new Map();
for (const [testPath, testFile] of Object.entries(report.testFiles ?? {})) {
    for (const test of testFile.tests ?? []) {
        testSelectors.set(String(test.id), `${testPath}#${test.name}`);
    }
}
const { equivalent, refuted, stale, ambiguous } = reconcileEquivalence(report, register);
const registerFailures = [
    ...refuted.map(({ entry, mutant }) => {
        const by = killingTests(mutant);
        return (
            `refuted — ${equivalenceKey(entry)} is reported ${mutant.status}` +
            `${by.length === 0 ? "" : ` by ${by.join(", ")}`}; the proof is wrong`
        );
    }),
    ...stale.map((entry) => `stale — ${equivalenceKey(entry)} no longer anchors a live mutant`),
    ...ambiguous.map(
        ({ entry, matches }) =>
            `ambiguous — ${equivalenceKey(entry)} anchors ${matches.length} mutants; ` +
            "one proof excuses one mutant"
    )
];
// The throw is deferred to just past the survivor and discrimination writes. It used to
// stand here, and it cost an area's whole measurement — 35 minutes for `actors` — every
// time one entry of 383 went stale, because nothing had been written yet and the next
// area overwrites Stryker's own report.json. Nothing about that made the gate stronger:
// the classification below already refuses to excuse a mutant whose entry did not
// reconcile, so the recorded measurement is the conservative one either way, and the
// entries are named in the report the reader reaches for.

const summary = {
    mutants: 0,
    killed: 0,
    actionable: 0,
    tolerated: 0,
    equivalent: 0,
    survivors: []
};
const measuredFiles = new Map();
const kills = new Map();
const messageHelperCall = messageHelperPattern();
for (const [path, file] of Object.entries(report.files)) {
    const source = file.source.split("\n");
    const measured = { mutants: 0, sha256: `sha256:${sha256(file.source)}` };
    measuredFiles.set(path, measured);
    for (const mutant of file.mutants) {
        if (mutant.status === "Ignored") continue;
        measured.mutants += 1;
        summary.mutants += 1;
        const proven = equivalent.get(mutant.id);
        if (proven !== undefined) {
            summary.equivalent += 1;
            summary.survivors.push(
                survivorRecord(path, mutant, source, "equivalent", proven.proof)
            );
            continue;
        }
        if (mutant.status === "NoCoverage") {
            summary.actionable += 1;
            summary.survivors.push(survivorRecord(path, mutant, source, "actionable"));
            continue;
        }
        // One status is a kill, and it is the one that names the tests that did it. The
        // branch here used to read `!== "Survived"`, which made every status a kill by
        // default: 25 of the 1042 mutants in the retained `actors` report timed out under
        // machine load and 1 of 1732 in `identity` did, and every one of them raised
        // `killed` and lowered `actionable`. `requireCompleteMutationReport` now refuses
        // such a run outright, and this branch no longer infers a kill from the absence of
        // survival, so neither guard depends on the other being right.
        if (mutant.status === "Killed") {
            summary.killed += 1;
            recordKills(path, mutant);
            continue;
        }
        const classification = classify(mutant, source);
        summary[classification] += 1;
        summary.survivors.push(survivorRecord(path, mutant, source, classification));
    }
}
const score =
    summary.mutants === 0 ? 100 : Math.round((summary.killed / summary.mutants) * 1000) / 10;

const baseline = existsSync(baselinePath)
    ? await readCanonicalJson(baselinePath)
    : { edition: "1.0.0", areas: {} };
const previous = baseline.areas[options.area];
const entry = {
    measuredAt: measured.measuredAt,
    fingerprint: mutationFingerprint(options.area),
    mutants: summary.mutants,
    killed: summary.killed,
    score,
    actionable: summary.actionable,
    tolerated: summary.tolerated
};

// A measurement writes two files, and one of them is committed evidence. Naming both, as
// the baseline and the register are already named, is what lets the measure path be
// exercised without a test overwriting an area's real discrimination artifact.
const survivorsPath =
    options.survivors ?? resolve(packageRoot, `reports/mutation/${options.area}-survivors.json`);
const discriminationPath =
    options.discrimination ?? resolve(artifactRoot, `quality/discrimination/${options.area}.json`);

await writeCanonicalJson(survivorsPath, {
    edition: "1.0.0",
    area: options.area,
    ...entry,
    equivalent: summary.equivalent,
    registerFailures,
    survivors: summary.survivors
});
await writeCanonicalJson(discriminationPath, {
    edition: "1.0.0",
    area: options.area,
    measuredAt: entry.measuredAt,
    fingerprint: entry.fingerprint,
    files: sortedObject(measuredFiles),
    killed: sortedObject(
        new Map(
            [...kills].map(([selector, files]) => [
                selector,
                sortedObject(
                    new Map(
                        [...files].map(([path, lines]) => [
                            path,
                            [...lines].sort((left, right) => left - right)
                        ])
                    )
                )
            ])
        )
    )
});
console.log(
    `${options.area}: score ${score}%, ${summary.actionable} actionable + ` +
        `${summary.tolerated} tolerated + ${summary.equivalent} proven equivalent ` +
        `survivors of ${summary.mutants} mutants`
);

// A stale, refuted or ambiguous entry is a failure of the register, not of the
// measurement, so it is reported once the measurement is on disk and named rather than
// counted. The baseline is still never written under one: `--update` is below this.
if (registerFailures.length > 0) {
    throw new TypeError(
        `Mutation equivalence register failed:\n${registerFailures.join("\n")}\n` +
            `The ${options.area} measurement is recorded in ${survivorsPath} ` +
            "and is not lost; " +
            "rewrite or drop each entry named above."
    );
}

if (options.update) {
    requireCleanWorktree();
    // The ratchet has to bite here. It used to live only in the read-only branch below,
    // so --update — the one path that actually writes the floor — accepted any increase
    // silently, and a re-pin could raise the number it was supposed to hold down.
    if (previous !== undefined && summary.actionable > previous.actionable) {
        throw new TypeError(ratchetFailure(previous.actionable, summary.actionable));
    }
    baseline.areas[options.area] = entry;
    await writeCanonicalJson(baselinePath, baseline);
    console.log(`baseline ${previous === undefined ? "recorded" : "re-pinned"}`);
} else if (previous === undefined) {
    throw new TypeError(
        `Mutation area ${options.area} has no reviewed baseline; rerun with --update from a clean tree`
    );
} else if (summary.actionable > previous.actionable) {
    throw new TypeError(ratchetFailure(previous.actionable, summary.actionable));
} else if (summary.actionable < previous.actionable) {
    console.log(
        `mutation improved ${previous.actionable} -> ${summary.actionable}; ` +
            "review and re-run with --update from a clean tree"
    );
}

// There is one way out of a rising actionable count and it is per mutant. A count-level
// override would let one sentence absorb any number of genuine coverage gaps, and nothing
// could ever contradict it; a register entry names its mutant and dies the moment a test
// kills it.
function ratchetFailure(previous, actual) {
    return (
        `Mutation ratchet: ${options.area} actionable survivors rose ${previous} -> ${actual}. ` +
        "Kill them, or prove each equivalent mutant individually in " +
        "artifacts/quality/mutation-equivalence.json."
    );
}

function killingTests(mutant) {
    return (mutant.killedBy ?? [])
        .map((id) => testSelectors.get(String(id)))
        .filter((selector) => selector !== undefined);
}

function requireCleanWorktree() {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: packageRoot,
        encoding: "utf8"
    });
    if (result.status !== 0) {
        throw new TypeError("Mutation baselines may be updated only from a clean worktree");
    }
    // The baseline and per-area discrimination attribution are this runner's own
    // outputs: a multi-area measurement sequence legitimately dirties them between
    // areas. Everything else must be clean so the recorded fingerprints describe
    // committed sources.
    const dirty = result.stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(
            (path) =>
                path.length > 0 &&
                path !== "packages/agent-core/artifacts/quality/mutation-baseline.json" &&
                !path.startsWith("packages/agent-core/artifacts/quality/discrimination/")
        );
    if (dirty.length > 0) {
        throw new TypeError(
            `Mutation baselines may be updated only from a clean worktree; dirty: ${dirty.slice(0, 5).join(", ")}`
        );
    }
}

function classify(mutant, source) {
    if (mutant.mutatorName !== "StringLiteral") return "actionable";
    const line = source[mutant.location.start.line - 1] ?? "";
    // Message text inside a throw (or the subject label passed to a validator that
    // throws) does not carry behavior; identity strings (key namespaces, codec field
    // names, error codes) do and stay actionable.
    const messageContext =
        /throw new (?:TypeError|RangeError|Error)\(/.test(line) ||
        /^\s*(?:"|`)[^"`]*(?:"|`)\s*\)?;?\s*$/.test(line) ||
        /require[A-Z]\w*\([^)]*"[^"]+"\s*\)/.test(line) ||
        messageHelperCall.test(line);
    const identityContext =
        /Key\(|codec|new AgentCoreError\(\s*"[a-z]|fromData|toData|requireString\(object/.test(
            line
        );
    return messageContext && !identityContext ? "tolerated" : "actionable";
}

/**
 * Prose reaches its throw through this codebase's own error helpers — `invalidTurn`,
 * `corruptRecord`, `required` — far more often than through `throw new TypeError(`.
 * Their names are read back out of the sources rather than listed here, so the set
 * cannot drift as helpers are added or renamed.
 *
 * A helper qualifies only when one of its parameters is literally named `message`,
 * which is what makes the string it receives prose. That excludes the helpers which
 * take an identity instead — `invalidSqliteColumn(expected, column)`,
 * `malformedProviderOutcome(kind)`, `missingPointer(pointer)` — whose literals are
 * discriminants and must keep ratcheting. The failure to avoid is over-tolerating:
 * counting a behavior mutant as prose hides a real gap, so anything unrecognised
 * stays actionable.
 */
function messageHelperPattern() {
    const names = new Set();
    const declaration = /function\s+([a-z]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gu;
    for (const path of typescriptSources(resolve(packageRoot, "src"))) {
        const text = readFileSync(path, "utf8");
        for (const [, name, parameters] of text.matchAll(declaration)) {
            if (/\bmessage\s*[?:=]/u.test(parameters)) names.add(name);
        }
    }
    if (names.size === 0) return /$^/u;
    return new RegExp(`\\b(?:${[...names].sort().join("|")})\\(`, "u");
}

function typescriptSources(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...typescriptSources(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}

function recordKills(path, mutant) {
    for (const id of mutant.killedBy ?? []) {
        const selector = testSelectors.get(String(id));
        if (selector === undefined) continue;
        const files = kills.get(selector) ?? new Map();
        kills.set(selector, files);
        const lines = files.get(path) ?? new Set();
        files.set(path, lines);
        lines.add(mutant.location.start.line);
    }
}

function sortedObject(map) {
    return Object.fromEntries(
        [...map].sort(([left], [right]) => compareCanonicalText(left, right))
    );
}

// The exact span, not just the line. One line routinely carries several mutants: a
// short-circuiting condition yields one per operand plus one for the whole expression,
// and those have different coverage and different verdicts. A line plus a replacement
// cannot say which of them survived — reading `false` against
// `current === undefined || left < current`, triage cannot tell the surviving operand
// from the killed whole condition, and reproducing the wrong one invents a phantom.
function survivorRecord(path, mutant, source, classification, proof) {
    const record = {
        file: path,
        line: mutant.location.start.line,
        column: mutant.location.start.column,
        endLine: mutant.location.end.line,
        endColumn: mutant.location.end.column,
        mutator: mutant.mutatorName,
        classification,
        // Two different defects wear the same `actionable` label and want opposite work.
        // A Survived mutant ran under some test and no assertion told it apart, so the
        // fix is an assertion. A NoCoverage mutant never ran at all, so the fix is a test
        // that reaches the site — or, where nothing can reach it, an unreachability proof.
        // Without the status a reader cannot tell which, and the classifier cannot say:
        // NoCoverage bypasses classify() entirely, so a message literal in an unreached
        // throw is reported actionable while the identical literal one line into a
        // covered path is reported tolerated.
        status: mutant.status,
        // Whole, never truncated. The replacement is what a reader applies to reproduce
        // the mutant and what an equivalence entry anchors on, so a clipped one is worse
        // than absent twice over: applying a cut LogicalOperator chain is a syntax error,
        // which fails the run for a reason that is not a kill and reads as one, and an
        // entry written from the clipped text can never match a real mutant, leaving a
        // proof permanently stale. `source` is a reading aid and stays bounded.
        replacement: mutant.replacement ?? "",
        source: (source[mutant.location.start.line - 1] ?? "").trim().slice(0, 160)
    };
    if (proof === undefined) return record;
    return { ...record, proof };
}

function parseArguments(args) {
    let area;
    let update = false;
    let gate = false;
    let baseline;
    let stageArtifact;
    let registerArtifact;
    let report;
    let survivors;
    let discrimination;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--area") area = args[++index];
        else if (args[index] === "--update") update = true;
        else if (args[index] === "--gate") gate = true;
        else if (args[index] === "--baseline") baseline = args[++index];
        else if (args[index] === "--stage-artifact") stageArtifact = args[++index];
        else if (args[index] === "--register") registerArtifact = args[++index];
        else if (args[index] === "--report") report = args[++index];
        else if (args[index] === "--survivors") survivors = args[++index];
        else if (args[index] === "--discrimination") discrimination = args[++index];
        else throw new TypeError(`Unknown mutation argument ${args[index]}`);
    }
    if (!gate && area === undefined) throw new TypeError("--area or --gate is required");
    // A recorded report says nothing about the tree the baseline would be pinned against,
    // and the fingerprint written beside it is read from that tree.
    if (update && report !== undefined) {
        throw new TypeError("--update pins a baseline and so must measure, not read --report");
    }
    return {
        area,
        update,
        gate,
        baseline,
        stageArtifact,
        registerArtifact,
        report,
        survivors,
        discrimination
    };
}
