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
    // Record every test that kills a mutant, not just the first. The vitest runner sets
    // `bail: disableBail ? 0 : 1`, so the default stops at the first failure and
    // `killedBy` becomes a lower bound on which tests discriminate a symbol. The
    // discrimination gate reads it as complete, which systematically penalises anything
    // widely covered: 73% of recorded kill sites had exactly one claimant, and 14 of the
    // 65 atoms that gate reported as citing non-discriminating evidence were this
    // artifact rather than a real citation defect. Full attribution costs run time and
    // buys a signal the gate was already claiming to have.
    disableBail: true,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "reports/quality/mutation/report.json" },
    thresholds: { high: 90, low: 80, break: null },
    // Stryker rewrites the sandbox copy of the tsconfig so that `extends` and
    // `references` reaching outside the sandbox still resolve. Under typescript@7 it
    // cannot: its TSConfigPreprocessor calls `ts.parseConfigFileTextToJson`, which the
    // package's root entry no longer exports, so the rewrite throws
    // `ts.parseConfigFileTextToJson is not a function` before a single mutant is
    // instrumented and every area fails identically. There is nothing for it to do here
    // either — this tsconfig has no `extends` and no `references`, and both `include`
    // globs resolve inside the sandbox, so every path it inspects it would hand back
    // unchanged. Naming no tsconfig skips that one step: `tsconfigFile` is read nowhere
    // else in Stryker, and the file itself is still copied into the sandbox verbatim for
    // the runner to read.
    tsconfigFile: "",
    tempDirName: ".stryker-tmp",
    // Stryker's ProjectReader does not read .gitignore. It crawls the working directory
    // and skips only its own ALWAYS_IGNORE list — node_modules, .git, *.tsbuildinfo,
    // /stryker.log, and three framework directories — plus its temp directory, its
    // reporter outputs, and whatever is named here. Without these three entries every
    // sandbox copy carried 131 MB of reports/, 72 MB of Lean build output and 6.8 MB of
    // dist, and two areas measured at once copied each other's private report and cache
    // scratch out of reports/. Nothing that runs under the mutation lane reads any of
    // them: every test that opens reports/ lives in test/quality, which
    // vitest.mutation.config.mjs excludes, and no source or test imports dist.
    //
    // scripts/quality/mutation-inputs.mjs reads this list. The reuse key must hash what
    // a run can read, and what a run can read is the crawl this list prunes.
    ignorePatterns: ["/reports", "/dist", "**/.lake"],
    concurrency: 8,
    timeoutMS: 20000,
    // The instrumented dry run executes the whole behavior suite once; the 5-minute
    // default is calibrated for far smaller suites and aborts a healthy run here.
    dryRunTimeoutMinutes: 15
};
