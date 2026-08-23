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
// Two files, because they answer different questions and a contaminated run must answer
// the first one:
//   reports/mutation/<area>-run.json     what the run cost and whether it is usable
//   reports/mutation/cache/<area>.json   the report itself, keyed, written only when it is
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unusableMutants } from "./mutation-equivalence.mjs";
import { mutationRunKey } from "./mutation-inputs.mjs";
import { packageRoot, writeCanonicalJson } from "./project.mjs";

const strykerBin = resolve(packageRoot, "node_modules/@stryker-mutator/core/bin/stryker.js");
const strykerReport = resolve(packageRoot, "reports/quality/mutation/report.json");

export function runLedgerPath(area) {
    return resolve(packageRoot, `reports/mutation/${area}-run.json`);
}

export function runCachePath(area) {
    return resolve(packageRoot, `reports/mutation/cache/${area}.json`);
}

/**
 * One area's report, measured or reused, with the run's own ledger written either way.
 * `measuredAt` is the commit the report was produced at rather than the commit reading
 * it: a reused report was not measured here, and saying it was would be the one lie a
 * cache can tell that its key cannot catch.
 */
export async function measureArea(area, mutatePattern) {
    const startedAt = process.hrtime.bigint();
    const runKey = mutationRunKey(area);
    const reused = readRunCache(area, runKey);
    const measured = reused ?? runStryker(area, mutatePattern);
    const unusable = unusableMutants(measured.report);
    const cost = {
        source: reused === undefined ? "measured" : "cached",
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
        measuredAt: measured.measuredAt,
        cost
    });
    // A contaminated report is never cached. Its statuses are the ones a rerun exists to
    // replace, so serving them again would make one bad afternoon permanent.
    if (reused === undefined && unusable.length === 0) {
        const path = runCachePath(area);
        mkdirSync(dirname(path), { recursive: true });
        // Compact, unlike every artifact this harness writes: nobody reads an 8 MB report
        // of 268 inlined test sources, and indenting it costs a second of every run.
        writeFileSync(
            path,
            JSON.stringify({
                edition: "1.0.0",
                area,
                runKey,
                measuredAt: measured.measuredAt,
                report: measured.report
            })
        );
    }
    return { report: measured.report, measuredAt: measured.measuredAt, cost };
}

/**
 * A recorded report, or undefined when nothing recorded matches. The key is the only
 * admission test: it covers every source file, every test file a mutation run executes,
 * the Stryker and Vitest configuration, the lockfile, and the area's slice of the
 * equivalence register, so a hit means a fresh run had the same bytes to work from.
 */
export function readRunCache(area, runKey) {
    const path = runCachePath(area);
    if (!existsSync(path)) return undefined;
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    if (recorded.runKey !== runKey) return undefined;
    return { report: recorded.report, measuredAt: recorded.measuredAt, strykerMs: 0 };
}

function runStryker(area, mutatePattern) {
    const startedAt = process.hrtime.bigint();
    const stryker = spawnSync("node", [strykerBin, "run", "--mutate", mutatePattern], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "inherit"]
    });
    if (stryker.status !== 0) throw new TypeError(`Stryker failed for area ${area}`);
    return {
        report: JSON.parse(readFileSync(strykerReport, "utf8")),
        measuredAt: gitHead(),
        strykerMs: elapsedMs(startedAt)
    };
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
