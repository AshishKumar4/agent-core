// How one area's mutation report is obtained, and what obtaining it cost.
//
// A measurement is expensive and nearly always a repeat. Profiled on `errors` — the
// smallest measurable area, six mutants — at concurrency 2 on an idle 24-thread machine,
// timing Stryker's own phases from its debug log:
//
//   startup, project read, instrumentation, sandbox      2s     1%
//   dry run: module load and transform                  59s    31%
//   dry run: 5496 test executions                       39s    20%
//   mutant runs: 3057 test executions                   92s    48%
//   ------------------------------------------------ -----
//   Stryker 191.7s; this runner around it 205.5s wall, 252.5s user CPU
//
// Nothing in that profile is waste. The dry run is what `perTest` coverage is measured
// from, and 3052 of the 3057 mutant test executions belong to one StringLiteral mutant
// that 37 tests kill and `disableBail` runs all 3052 of, which is how the discrimination
// artifact gets a complete `killedBy`. The waste is paying it twice for the same inputs,
// and a campaign pays it constantly: a register repair, an interrupted sweep, a second
// opinion on a count. So a run records itself, and a run whose inputs are byte-identical
// reads that record instead.
//
// Reuse is only as good as its guards, and the guards are the point of this module:
//
//   * the key is recomputed after the run and the measurement is refused if it moved, so
//     a tree edited during those minutes cannot be published as a measurement of either
//     version of it;
//   * the record binds the key before and after, the runtime identity, and a digest of
//     the report, and a reader that cannot reproduce all four treats the record as absent;
//   * publication is a mode-600 temp file in the destination directory, fsynced, then
//     renamed, and two writers under one key either agree or fail — never last-wins;
//   * every Stryker run gets a private report path and a private temp directory, because
//     the committed config names one report file and `cleanTempDir` deletes the whole
//     temp directory, so two areas at once would overwrite and delete each other's work.
//
// Two files, because they answer different questions and a refused run must answer the
// first one:
//   reports/mutation/<area>-run.json     what the run cost and whether it is usable
//   reports/mutation/cache/<area>.json   the report itself, keyed, written only when it is
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { equivalenceArea, mutationOutcome, unusableMutants } from "./mutation-equivalence.mjs";
import { mutationRunIdentity, mutationRunKey } from "./mutation-inputs.mjs";
import {
    assertString,
    canonicalJson,
    isJsonObject,
    jsonKind,
    packageRoot,
    portablePath,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

const strykerBin = resolve(packageRoot, "node_modules/@stryker-mutator/core/bin/stryker.js");
const strykerConfig = resolve(packageRoot, "stryker.conf.mjs");
const scratchRoot = resolve(packageRoot, "reports/mutation/run");

export function runLedgerPath(area) {
    return resolve(packageRoot, `reports/mutation/${area}-run.json`);
}

export function runCachePath(area) {
    return resolve(packageRoot, `reports/mutation/cache/${area}.json`);
}

/**
 * One area's report, measured or reused, with the run's own ledger written either way.
 * `run` is the measurement itself, injected so the guards around it can be tested without
 * paying three minutes a case.
 *
 * `measuredAt` is the commit the report was produced at rather than the commit reading it:
 * a reused report was not measured here, and saying it was would be the one lie a cache
 * can tell that its key cannot catch.
 */
export async function measureArea(area, mutatePattern, run = runStryker) {
    const startedAt = process.hrtime.bigint();
    const identity = mutationRunIdentity();
    const runKey = mutationRunKey(area);
    const { reused, rejected } = readRunCache(area, runKey);
    let measured = reused ?? run(area, mutatePattern);
    if (reused === undefined && run === runStryker) {
        const timed = timeoutMutants(measured.report);
        if (timed.length > 0) {
            const fallback = runStryker(
                `${area}-timeouts`,
                [...new Set(timed.map(({ file }) => file))],
                false
            );
            measured = {
                report: mergeTimeoutRerun(measured.report, fallback.report),
                measuredAt: measured.measuredAt,
                strykerMs: measured.strykerMs + fallback.strykerMs
            };
        }
    }
    requireAreaReport(measured.report, area);
    // After, not only before. A measurement takes minutes, and a key checked once at the
    // start says nothing about the tree the run actually read. Publishing under either
    // version of an edited tree would attach the measurement to inputs it never saw.
    const settledKey = mutationRunKey(area);
    const unusable = unusableMutants(measured.report);
    const cost = {
        cache: reused === undefined ? (rejected ?? "miss") : "hit",
        // Wall time only. Stryker runs as a child process and neither `spawnSync` nor
        // `process.resourceUsage` reports a child's CPU, so a CPU figure here would be
        // this process's, which is idle while the child works. Measure CPU around the
        // whole command with the platform's own tool.
        wallMs: elapsedMs(startedAt),
        strykerMs: measured.strykerMs,
        ...reportCost(measured.report),
        unusable
    };
    await writeCanonicalJson(runLedgerPath(area), {
        edition: "1.0.0",
        area,
        runKey,
        settledKey,
        identity,
        measuredAt: measured.measuredAt,
        reportSha256: reportDigest(measured.report),
        cost
    });
    if (settledKey !== runKey) {
        throw new TypeError(
            `Mutation inputs of ${area} changed while it was measured: the run began at ` +
                `${runKey} and ended at ${settledKey}. The measurement describes neither ` +
                "tree and is refused; re-measure a still tree."
        );
    }
    // A report that settles nothing is never recorded. Its statuses are the ones a rerun
    // exists to replace, so serving them again would make one bad afternoon permanent.
    if (reused === undefined && unusable.length === 0) {
        publishRunCache(area, {
            edition: "1.0.0",
            area,
            runKey,
            identity,
            measuredAt: measured.measuredAt,
            reportSha256: reportDigest(measured.report),
            report: measured.report
        });
    }
    return { report: measured.report, measuredAt: measured.measuredAt, cost };
}

/**
 * A recorded measurement, or the reason a recorded one was not used. The key is the
 * admission test but not the only one: a record must also be this edition, name this
 * area, carry a report that digests to what it claims, and hold a report that describes
 * this area and nothing else. Anything a reader cannot reproduce is treated as absent,
 * because re-measuring is always safe. A symlink at the cache path is not treated as
 * absent — nothing in this harness creates one, so it is refused rather than followed.
 */
export function readRunCache(area, runKey) {
    const path = runCachePath(area);
    const present = statWithoutFollowing(path);
    if (present === undefined) return {};
    if (!present.isFile()) return { rejected: "cache path is not a regular file" };
    let record;
    try {
        record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return { rejected: "cache record does not parse" };
    }
    const fault = cacheFault(record, area, runKey);
    if (fault !== undefined) return { rejected: fault };
    return {
        reused: { report: record.report, measuredAt: record.measuredAt, strykerMs: 0 }
    };
}

/**
 * Why a recorded measurement is not worth having, or undefined when it is. The reader
 * consults this and the publisher consults it too, so "a record worth having" has one
 * definition. It used to have two, and the gap between them was a trap: a record of an
 * edition the reader refused was still a rival to the publisher, which found a matching
 * key and digest, called it converged, and left the unreadable record in place forever.
 */
function cacheFault(record, area, runKey) {
    if (!isJsonObject(record)) return "cache record is not an object";
    if (record.edition !== "1.0.0") {
        return `cache record edition ${JSON.stringify(record.edition)} is not readable`;
    }
    if (record.area !== area) return `cache record names area ${JSON.stringify(record.area)}`;
    if (jsonKind(record.measuredAt) !== "string") return "cache record names no commit";
    if (!isJsonObject(record.identity)) return "cache record names no runtime identity";
    if (record.runKey !== runKey) return "cache record was written under a different run key";
    if (!isJsonObject(record.report)) return "cache record carries no report";
    if (record.reportSha256 !== reportDigest(record.report)) {
        return "cache record and its report disagree";
    }
    if (
        JSON.stringify(canonicalJson(record.identity)) !==
        JSON.stringify(canonicalJson(mutationRunIdentity()))
    ) {
        return "cache record names a different runtime identity";
    }
    try {
        requireAreaReport(record.report, area);
    } catch (error) {
        return `cached report is unusable: ${error instanceof Error ? error.message : "unknown"}`;
    }
    // A record from before contamination was refused, or one placed by hand, can carry a
    // timeout. Treating it as absent is what makes the next run a fresh measurement
    // instead of a permanent refusal on evidence nobody can re-examine.
    const unusable = unusableMutants(record.report);
    if (unusable.length > 0) return `cached report settles nothing: ${unusable[0]}`;
    return undefined;
}

/**
 * That a report is the report of this area, in the shape the classifier reads, carrying
 * verdicts it can account for. Every check here closes a way for kill credit or a clean
 * score to arrive without evidence behind it:
 *
 *   * a report of another area, which a shared output path used to make possible;
 *   * a report with no mutants at all — score 100%, zero kills, an area the ratchet reads
 *     as finished;
 *   * a `Killed` verdict naming no test, naming a test the report does not carry, or
 *     executing none. `killedBy` is what the committed discrimination artifact is built
 *     from, so a kill nobody claims spends the credit and records no claimant;
 *   * a `Survived` verdict with nothing behind it either. A survivor is a mutant some
 *     test ran without telling it apart, so a covering set and an executed count are what
 *     make it a survivor rather than an empty run — the same laundering the zero-test
 *     check refuses, arriving through an absent field instead of a zero;
 *   * a test identity that only looks like one. `String(test.id)` would coerce a number,
 *     an object or `undefined` into a key that a `killedBy` could then match, so ids and
 *     names are text or the report is refused, and two tests may not share an id.
 */
export function requireAreaReport(report, area) {
    if (!isJsonObject(report)) throw new TypeError("Mutation report is not an object");
    if (jsonKind(report.schemaVersion) !== "string") {
        throw new TypeError("Mutation report states no schema version");
    }
    if (report.thresholds !== undefined && !isJsonObject(report.thresholds)) {
        throw new TypeError("Mutation report thresholds is not an object");
    }
    if (!isJsonObject(report.files)) throw new TypeError("Mutation report has no files");
    if (Object.keys(report.files).length === 0) {
        throw new TypeError(`Mutation report of ${area} covers no file`);
    }
    const tests = requireTestFiles(report.testFiles);
    // One set for the whole report, not one per file. `reconcileEquivalence` keys its
    // resolution by `mutant.id` alone, so two files sharing an id would let one proof
    // excuse the other file's mutant.
    const identified = new Set();
    let mutants = 0;
    for (const [path, file] of Object.entries(report.files)) {
        if (!path.startsWith("src/") || equivalenceArea(path) !== area) {
            throw new TypeError(`Mutation report of ${area} names ${path}`);
        }
        if (jsonKind(file.source) !== "string" || jsonKind(file.mutants) !== "array") {
            throw new TypeError(`Mutation report entry ${path} has no source or mutants`);
        }
        if (file.language !== undefined && jsonKind(file.language) !== "string") {
            throw new TypeError(`Mutation report entry ${path} names no language`);
        }
        for (const mutant of file.mutants) {
            requireMutant(path, mutant, tests, identified);
            mutants += 1;
        }
    }
    // Per file it is ordinary — a module of nothing but types carries no mutant. Across the
    // report it is a measurement of nothing wearing a perfect score.
    if (mutants === 0) throw new TypeError(`Mutation report of ${area} holds no mutant`);
    return report;
}

function requireTestFiles(testFiles) {
    const tests = new Set();
    if (testFiles === undefined) return tests;
    if (!isJsonObject(testFiles)) throw new TypeError("Mutation report testFiles is not an object");
    for (const [path, file] of Object.entries(testFiles)) {
        if (!isJsonObject(file) || jsonKind(file.tests) !== "array") {
            throw new TypeError(`Mutation report test file ${path} lists no tests`);
        }
        for (const test of file.tests) {
            if (!isJsonObject(test) || jsonKind(test.id) !== "string") {
                throw new TypeError(`Mutation report test file ${path} holds an unidentified test`);
            }
            if (jsonKind(test.name) !== "string") {
                throw new TypeError(`Test ${path}#${test.id} has no name`);
            }
            if (tests.has(test.id)) {
                throw new TypeError(`Mutation report names two tests ${test.id}`);
            }
            tests.add(test.id);
        }
    }
    return tests;
}

function requireMutant(path, mutant, tests, identified) {
    if (!isJsonObject(mutant) || jsonKind(mutant.id) !== "string") {
        throw new TypeError(`Mutation report entry ${path} holds an unidentified mutant`);
    }
    const at = `${path}#${mutant.id}`;
    if (identified.has(mutant.id)) {
        throw new TypeError(`Mutation report names two mutants ${mutant.id}, one of them ${at}`);
    }
    identified.add(mutant.id);
    if (jsonKind(mutant.mutatorName) !== "string") {
        throw new TypeError(`Mutant ${at} names no mutator`);
    }
    // `mutationOutcome` refuses a status it does not know, so the vocabulary a report may
    // speak is the one the classifier reads, and nothing else reaches classification.
    mutationOutcome(assertString(mutant.status, `mutant ${at} status`));
    if (mutant.replacement !== undefined && jsonKind(mutant.replacement) !== "string") {
        throw new TypeError(`Mutant ${at} has a replacement that is not text`);
    }
    requireSpan(at, mutant.location);
    if (mutant.testsCompleted !== undefined) {
        if (!Number.isSafeInteger(mutant.testsCompleted) || mutant.testsCompleted < 0) {
            throw new TypeError(`Mutant ${at} counts a nonsense number of executed tests`);
        }
    }
    for (const field of ["coveredBy", "killedBy"]) {
        if (mutant[field] === undefined) continue;
        if (jsonKind(mutant[field]) !== "array") {
            throw new TypeError(`Mutant ${at} ${field} is not a list of tests`);
        }
        for (const id of mutant[field]) {
            if (jsonKind(id) !== "string" || !tests.has(id)) {
                throw new TypeError(`Mutant ${at} ${field} names test ${String(id)}, absent`);
            }
        }
    }
    requireEvidence(at, mutant);
}

function requireSpan(at, location) {
    const start = isJsonObject(location) ? location.start : undefined;
    const end = isJsonObject(location) ? location.end : undefined;
    for (const [edge, position] of [
        ["start", start],
        ["end", end]
    ]) {
        if (
            !isJsonObject(position) ||
            !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.column)
        ) {
            throw new TypeError(`Mutant ${at} has no ${edge} of its source location`);
        }
    }
}

/**
 * A surviving verdict must run every test its coverage filter names. A killed verdict
 * needs one named covering test that actually failed; running the rest cannot make the
 * mutant alive again. This distinction lets a no-bail fallback settle deadlocking mutants
 * without weakening the complete evidence required for survivors.
 */
function requireEvidence(at, mutant) {
    if (mutant.status !== "Killed" && mutant.status !== "Survived") return;
    // The claimant first, because it is the more specific absence: a kill with no killer
    // named is a different defect from a kill with no coverage recorded, and the reader of
    // the failure wants the narrower one.
    if (mutant.status === "Killed" && (mutant.killedBy ?? []).length === 0) {
        throw new TypeError(`Mutant ${at} is reported Killed and names no test that killed it`);
    }
    const coveredBy = mutant.coveredBy ?? [];
    const covering = coveredBy.length;
    const completed = mutant.testsCompleted ?? 0;
    if (covering === 0) {
        throw new TypeError(`Mutant ${at} is reported ${mutant.status} and no test covers it`);
    }
    if (mutant.status === "Killed") {
        if (!(mutant.killedBy ?? []).every((id) => coveredBy.includes(id))) {
            throw new TypeError(`Mutant ${at} names a killer outside its coverage filter`);
        }
        if (completed < 1) {
            throw new TypeError(`Mutant ${at} is reported Killed without executing a test`);
        }
        return;
    }
    if (completed < covering) {
        throw new TypeError(
            `Mutant ${at} is reported Survived having executed ${completed} of the ` +
                `${covering} tests that cover it`
        );
    }
}

/**
 * Publishes a record under its key. No lock: a lock file survives the crash that dropped
 * it and then blocks publication forever, and stealing one on a timer trades that for
 * the race it was meant to stop. The destination is created instead of replaced —
 * `link` refuses to overwrite, atomically — so the only thing a crash can leave behind is
 * a temp file nothing reads.
 *
 * Losing the create is not a failure but the interesting case, because the winner's record
 * is right there to compare against: the same evidence converges, and different evidence
 * under one key fails, because identical inputs cannot yield two reports. A record that
 * cannot vouch for its own report, or that was written under another key, holds nothing
 * worth keeping and is unlinked so the next attempt creates.
 */
export function publishRunCache(area, record) {
    const path = runCachePath(area);
    const directory = dirname(path);
    requireOwnedDirectory(directory);
    const temp = join(
        directory,
        `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`
    );
    const handle = openSync(temp, "wx", 0o600);
    try {
        writeFileSync(handle, `${JSON.stringify(record)}\n`);
        fsyncSync(handle);
    } finally {
        closeSync(handle);
    }
    try {
        // Bounded, because each turn either creates or removes something: an unbounded
        // loop against a writer that keeps replacing the record would spin forever.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            if (created(temp, path)) return "published";
            const present = statWithoutFollowing(path);
            if (present !== undefined && !present.isFile()) {
                throw new TypeError(`${portablePath(path)} is not a regular file`);
            }
            const existing = verifiedRecord(path, area, record.runKey);
            // Not a rival: another key, an edition this cannot read, a report it would
            // refuse. Unlink and let the next turn create, which is the repair.
            if (existing === undefined) {
                rmSync(path, { force: true });
                continue;
            }
            if (existing.reportSha256 === record.reportSha256) return "converged";
            throw new TypeError(
                `Two measurements of ${area} under run key ${record.runKey} disagree: ` +
                    `${String(existing.reportSha256)} is recorded and this run produced ` +
                    `${record.reportSha256}. Identical inputs cannot yield two reports; ` +
                    "delete the record only once you know which run was wrong."
            );
        }
        throw new TypeError(
            `Publishing the ${area} measurement kept losing to another writer. Nothing is ` +
                "lost: the measurement stands and the next run will record it."
        );
    } finally {
        rmSync(temp, { force: true });
    }
}

// `link` is the create-if-absent this needs: it is atomic and it never replaces, so two
// writers cannot both believe they published. EEXIST is the loser's answer, not an error.
function created(temp, path) {
    try {
        linkSync(temp, path);
        return true;
    } catch (error) {
        if (error instanceof Error && error.message.includes("EEXIST")) return false;
        throw error;
    }
}

// A rival worth deferring to: a record the reader would have used. Judged by `cacheFault`
// and nothing else, so the publisher and the reader cannot disagree about what a usable
// record is. Anything it rejects holds no evidence to lose and is replaced, which is how
// an unreadable record gets repaired rather than outliving every run that meets it.
function verifiedRecord(path, area, runKey) {
    let record;
    try {
        record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    return cacheFault(record, area, runKey) === undefined ? record : undefined;
}

/**
 * `lstat` on every component from the package root down, so a symlink anywhere on the
 * way is seen rather than followed. Checking the leaf alone leaves the interesting
 * substitution unguarded: nothing stops a link at `reports/` or `reports/mutation/` from
 * redirecting every record this runner writes, and the leaf would look like an ordinary
 * file the whole time. Absence is an answer rather than an exception.
 */
function statWithoutFollowing(path) {
    const offset = relative(packageRoot, path).split(sep);
    for (let depth = 1; depth < offset.length; depth += 1) {
        const ancestor = resolve(packageRoot, ...offset.slice(0, depth));
        const above = lstatSync(ancestor, { throwIfNoEntry: false });
        if (above?.isSymbolicLink() === true) throw redirection(ancestor);
    }
    const present = lstatSync(path, { throwIfNoEntry: false });
    if (present === undefined) return undefined;
    if (present.isSymbolicLink()) throw redirection(path);
    return present;
}

function redirection(path) {
    return new TypeError(
        `${portablePath(path)} is a symbolic link; this runner reads and writes its own ` +
            "files and follows no redirection into someone else's"
    );
}

function requireOwnedDirectory(directory) {
    const present = statWithoutFollowing(directory);
    if (present === undefined) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        return;
    }
    if (!present.isDirectory()) {
        throw new TypeError(`${portablePath(directory)} is not a directory`);
    }
}

function runStryker(area, mutatePattern, disableBail = true) {
    const startedAt = process.hrtime.bigint();
    requireOwnedDirectory(scratchRoot);
    const scratch = mkdtempSync(join(scratchRoot, `${area}-`));
    try {
        const reportPath = join(scratch, "report.json");
        const configPath = join(scratch, "stryker.conf.mjs");
        const mutatePatterns = Array.isArray(mutatePattern) ? mutatePattern : [mutatePattern];
        writeFileSync(
            configPath,
            privateOutputConfig(reportPath, join(scratch, "tmp"), disableBail, mutatePatterns),
            { mode: 0o600 }
        );
        // `process.execPath`, not `node`: the key binds `process.version`, and a `node`
        // resolved off PATH is free to be a different interpreter than the one that
        // hashed it.
        const stryker = spawnSync(process.execPath, [strykerBin, "run", configPath], {
            cwd: packageRoot,
            encoding: "utf8",
            stdio: ["ignore", "inherit", "inherit"]
        });
        if (stryker.status !== 0) throw new TypeError(`Stryker failed for area ${area}`);
        return {
            report: JSON.parse(readFileSync(reportPath, "utf8")),
            measuredAt: gitHead(),
            strykerMs: elapsedMs(startedAt)
        };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

/**
 * The committed configuration with private output paths. It spreads the committed module
 * rather than restating any of it, so only output paths, bail policy, and the measured
 * locations differ. The normal run keeps complete discrimination; a timeout fallback
 * disables bail only for the unresolved mutants it names.
 */
function privateOutputConfig(reportPath, tempDirName, disableBail, mutatePatterns) {
    return [
        `import committed from ${JSON.stringify(pathToFileURL(strykerConfig).href)};`,
        "",
        "export default {",
        "    ...committed,",
        `    mutate: ${JSON.stringify(mutatePatterns)},`,
        `    jsonReporter: { fileName: ${JSON.stringify(reportPath)} },`,
        `    tempDirName: ${JSON.stringify(tempDirName)},`,
        `    disableBail: ${JSON.stringify(disableBail)}`,
        "};",
        ""
    ].join("\n");
}

function timeoutMutants(report) {
    return Object.entries(report.files ?? {}).flatMap(([file, result]) =>
        result.mutants
            .filter((mutant) => mutant.status === "Timeout")
            .map((mutant) => ({ file, mutant }))
    );
}

export function mergeTimeoutRerun(report, rerun) {
    const rerunMutants = new Map(
        Object.entries(rerun.files ?? {}).flatMap(([file, result]) =>
            result.mutants.map((mutant) => [mutantKey(file, mutant), mutant])
        )
    );
    let merged = 0;
    const files = Object.fromEntries(
        Object.entries(report.files ?? {}).map(([file, result]) => [
            file,
            {
                ...result,
                mutants: result.mutants.map((mutant) => {
                    if (mutant.status !== "Timeout") return mutant;
                    const replacement = rerunMutants.get(mutantKey(file, mutant));
                    if (replacement === undefined) {
                        throw new TypeError(`Timeout fallback omitted ${file}#${mutant.id}`);
                    }
                    merged += 1;
                    return replacement;
                })
            }
        ])
    );
    const expected = timeoutMutants(report).length;
    if (merged !== expected) {
        throw new TypeError(`Timeout fallback replaced ${merged} of ${expected} mutants`);
    }
    return {
        ...report,
        files,
        testFiles: { ...report.testFiles, ...rerun.testFiles }
    };
}

function mutantKey(file, mutant) {
    return JSON.stringify([
        file,
        mutant.location.start.line,
        mutant.location.start.column,
        mutant.location.end.line,
        mutant.location.end.column,
        mutant.mutatorName,
        mutant.replacement
    ]);
}

/**
 * What the run bought, in the terms a next run is planned in. `testsRun` is the work
 * Stryker actually did; the mean beside it hides how that work is distributed, and the
 * distribution is the whole story — one widely covered literal can be every second of an
 * area's mutant phase while every other mutant costs one test.
 */
function reportCost(report) {
    const mutants = Object.values(report.files ?? {})
        .flatMap((file) => file.mutants)
        .filter((mutant) => mutant.status !== "Ignored");
    const completed = mutants.map((mutant) => mutant.testsCompleted ?? 0);
    const testsRun = completed.reduce((total, count) => total + count, 0);
    return {
        mutants: mutants.length,
        timeouts: mutants.filter((mutant) => mutant.status === "Timeout").length,
        dryRunTests: Object.values(report.testFiles ?? {}).reduce(
            (total, file) => total + (file.tests ?? []).length,
            0
        ),
        testsRun,
        meanTestsPerMutant:
            mutants.length === 0 ? 0 : Math.round((testsRun / mutants.length) * 10) / 10,
        maxTestsPerMutant: completed.reduce((most, count) => Math.max(most, count), 0)
    };
}

// Over the bytes a round trip through JSON reproduces, which is what a reader can check.
function reportDigest(report) {
    return `sha256:${sha256(JSON.stringify(report))}`;
}

function elapsedMs(startedAt) {
    return Number((process.hrtime.bigint() - startedAt) / 1000000n);
}

/** The commit a measurement was made at, and the mutation family's only reading of it. */
export function gitHead() {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: packageRoot,
        encoding: "utf8"
    });
    return result.status === 0 ? result.stdout.trim() : "unknown";
}
