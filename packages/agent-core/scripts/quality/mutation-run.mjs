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
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
    equivalenceArea,
    mutationOutcome,
    unusableMutants
} from "./mutation-equivalence.mjs";
import { mutationRunIdentity, mutationRunKey } from "./mutation-inputs.mjs";
import {
    assertString,
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
    const measured = reused ?? run(area, mutatePattern);
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

function cacheFault(record, area, runKey) {
    if (!isJsonObject(record)) return "cache record is not an object";
    if (record.edition !== "1.0.0") {
        return `cache record edition ${JSON.stringify(record.edition)} is not readable`;
    }
    if (record.area !== area) return `cache record names area ${JSON.stringify(record.area)}`;
    if (jsonKind(record.measuredAt) !== "string") return "cache record names no commit";
    if (record.runKey !== runKey) return "cache record was written under a different run key";
    if (!isJsonObject(record.report)) return "cache record carries no report";
    if (record.reportSha256 !== reportDigest(record.report)) {
        return "cache record and its report disagree";
    }
    try {
        requireAreaReport(record.report, area);
    } catch (error) {
        return `cached report is unusable: ${error instanceof Error ? error.message : "unknown"}`;
    }
    return undefined;
}

/**
 * That a report is the report of this area, in the shape the classifier reads, carrying
 * verdicts it can account for. Three separate laundering routes close here:
 *
 *   * a report of another area arriving under the right key, which a shared output path
 *     used to make possible;
 *   * a report of nothing at all, whose score is 100% and whose kill count is zero, and
 *     which the ratchet would accept as an area with no work left in it;
 *   * a `Killed` verdict naming no test, or naming a test the report does not carry, or
 *     completing no test. `killedBy` is what the committed discrimination artifact is
 *     built from, so a kill nobody claims spends the credit and records no claimant.
 */
export function requireAreaReport(report, area) {
    if (!isJsonObject(report)) throw new TypeError("Mutation report is not an object");
    if (!isJsonObject(report.files)) throw new TypeError("Mutation report has no files");
    if (Object.keys(report.files).length === 0) {
        throw new TypeError(`Mutation report of ${area} covers no file`);
    }
    const tests = new Set();
    if (report.testFiles !== undefined) {
        if (!isJsonObject(report.testFiles)) {
            throw new TypeError("Mutation report testFiles is not an object");
        }
        for (const file of Object.values(report.testFiles)) {
            if (jsonKind(file.tests) !== "array") {
                throw new TypeError("Mutation report testFiles entry lists no tests");
            }
            for (const test of file.tests) tests.add(String(test.id));
        }
    }
    for (const [path, file] of Object.entries(report.files)) {
        if (!path.startsWith("src/") || equivalenceArea(path) !== area) {
            throw new TypeError(`Mutation report of ${area} names ${path}`);
        }
        if (jsonKind(file.source) !== "string" || jsonKind(file.mutants) !== "array") {
            throw new TypeError(`Mutation report entry ${path} has no source or mutants`);
        }
        for (const mutant of file.mutants) {
            requireMutant(path, mutant, tests);
        }
    }
    return report;
}

function requireMutant(path, mutant, tests) {
    if (!isJsonObject(mutant) || jsonKind(mutant.id) !== "string") {
        throw new TypeError(`Mutation report entry ${path} holds an unidentified mutant`);
    }
    const at = `${path}#${String(mutant.id)}`;
    if (jsonKind(mutant.mutatorName) !== "string") throw new TypeError(`Mutant ${at} names no mutator`);
    // `mutationOutcome` refuses a status it does not know, so the vocabulary a report may
    // speak is the one the classifier reads, and nothing else reaches classification.
    mutationOutcome(assertString(mutant.status, `mutant ${at} status`));
    if (mutant.replacement !== undefined && jsonKind(mutant.replacement) !== "string") {
        throw new TypeError(`Mutant ${at} has a replacement that is not text`);
    }
    const start = isJsonObject(mutant.location) ? mutant.location.start : undefined;
    const end = isJsonObject(mutant.location) ? mutant.location.end : undefined;
    if (!isJsonObject(start) || !Number.isSafeInteger(start.line)) {
        throw new TypeError(`Mutant ${at} has no source location`);
    }
    if (!isJsonObject(end) || !Number.isSafeInteger(end.line)) {
        throw new TypeError(`Mutant ${at} has no end of its source location`);
    }
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
            if (!tests.has(String(id))) {
                throw new TypeError(`Mutant ${at} ${field} names test ${String(id)}, absent`);
            }
        }
    }
    if (mutant.status !== "Killed") return;
    if ((mutant.killedBy ?? []).length === 0) {
        throw new TypeError(`Mutant ${at} is reported Killed and names no test that killed it`);
    }
    if ((mutant.testsCompleted ?? 0) === 0) {
        throw new TypeError(`Mutant ${at} is reported Killed having executed no test`);
    }
}

/**
 * Publishes a record under its key, holding an exclusive lock across the whole
 * check-and-replace. Without the lock two writers both read an absent or stale record and
 * both rename over the destination, and the one that renamed second wins silently — which
 * is the one outcome this is here to prevent. A lock nobody can take means somebody else
 * is publishing, and declining costs nothing: publication is an optimisation, so the
 * measurement stands either way.
 *
 * Under the lock: the same evidence converges, different evidence under one key fails
 * because identical inputs cannot yield two reports, and a record that cannot vouch for
 * its own report holds no evidence to lose and is replaced.
 */
export function publishRunCache(area, record) {
    const path = runCachePath(area);
    const directory = dirname(path);
    requireOwnedDirectory(directory);
    const lock = `${path}.lock`;
    let held;
    try {
        held = openSync(lock, "wx", 0o600);
    } catch (error) {
        if (isJsonObject(error) || !(error instanceof Error)) throw error;
        if (!error.message.includes("EEXIST")) throw error;
        return "deferred";
    }
    try {
        const present = statWithoutFollowing(path);
        if (present !== undefined) {
            if (!present.isFile()) {
                throw new TypeError(`${portablePath(path)} is not a regular file`);
            }
            const existing = verifiedRecord(path);
            if (existing?.runKey === record.runKey) {
                if (existing.reportSha256 === record.reportSha256) return "converged";
                throw new TypeError(
                    `Two measurements of ${area} under run key ${record.runKey} disagree: ` +
                        `${String(existing.reportSha256)} is recorded and this run produced ` +
                        `${record.reportSha256}. Identical inputs cannot yield two reports; ` +
                        "delete the record only once you know which run was wrong."
                );
            }
        }
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
            renameSync(temp, path);
        } catch (error) {
            rmSync(temp, { force: true });
            throw error;
        }
        return "published";
    } finally {
        closeSync(held);
        rmSync(lock, { force: true });
    }
}

// A record that vouches for its own report. Anything else — unparseable, not an object,
// or carrying a report it does not digest to — holds no evidence, so a writer replaces it
// instead of treating it as a rival measurement.
function verifiedRecord(path) {
    let record;
    try {
        record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    if (!isJsonObject(record) || !isJsonObject(record.report)) return undefined;
    return record.reportSha256 === reportDigest(record.report) ? record : undefined;
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

function runStryker(area, mutatePattern) {
    const startedAt = process.hrtime.bigint();
    requireOwnedDirectory(scratchRoot);
    const scratch = mkdtempSync(join(scratchRoot, `${area}-`));
    try {
        const reportPath = join(scratch, "report.json");
        const configPath = join(scratch, "stryker.conf.mjs");
        writeFileSync(configPath, privateOutputConfig(reportPath, join(scratch, "tmp")), {
            mode: 0o600
        });
        // `process.execPath`, not `node`: the key binds `process.version`, and a `node`
        // resolved off PATH is free to be a different interpreter than the one that
        // hashed it.
        const stryker = spawnSync(
            process.execPath,
            [strykerBin, "run", configPath, "--mutate", mutatePattern],
            { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] }
        );
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
 * rather than restating any of it, so the only fields that can differ from what the run
 * key hashed are the two this function names — and neither of them can change a mutant's
 * status. Without it, two areas measured at once write one report file and `cleanTempDir`
 * deletes one another's sandbox.
 */
function privateOutputConfig(reportPath, tempDirName) {
    return [
        `import committed from ${JSON.stringify(pathToFileURL(strykerConfig).href)};`,
        "",
        "export default {",
        "    ...committed,",
        `    jsonReporter: { fileName: ${JSON.stringify(reportPath)} },`,
        `    tempDirName: ${JSON.stringify(tempDirName)}`,
        "};",
        ""
    ].join("\n");
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
