// Mutation testing over the security-critical core. Run per-area via
// scripts/quality/mutation.mjs — full-tree mutation is too slow for the default
// gates, so areas are measured one at a time and scores are pinned in
// artifacts/quality/mutation-baseline.json.
export default {
    testRunner: "vitest",
    // pnpm isolates plugin packages; point Stryker at the installed runner explicitly.
    appendPlugins: ["@stryker-mutator/vitest-runner"],
    vitest: { configFile: "vitest.mutation.config.mjs" },
    // Mutating a source file re-runs only the tests that cover it. This is the only
    // setting the vitest runner honours: its dryRun reports mutant coverage
    // unconditionally and core never discards it, so "all" and "off" still build the same
    // per-test filter. Measured: an actors run configured "off" returned the identical
    // status for all 178 shared mutants. Cross-checking a survivor means applying the
    // mutant and running the whole suite, not changing this line.
    coverageAnalysis: "perTest",
    // Mutants that only run at module load have no covering test, so Stryker would run
    // the entire suite for each. Ignoring them keeps a mutant's cost proportional to its
    // coverage, at the price of leaving them out of the measurement: 19 of the 1044
    // mutants in actors, 4 of which the suite does not kill.
    ignoreStatic: true,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "reports/quality/mutation/report.json" },
    thresholds: { high: 90, low: 80, break: null },
    tempDirName: ".stryker-tmp",
    concurrency: 8,
    timeoutMS: 20000,
    // The instrumented dry run executes the whole behavior suite once; the 5-minute
    // default is calibrated for far smaller suites and aborts a healthy run here.
    dryRunTimeoutMinutes: 15
};
