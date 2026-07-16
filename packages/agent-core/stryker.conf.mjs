// Mutation testing over the security-critical core. Run per-area via
// scripts/quality/mutation.mjs — full-tree mutation is too slow for the default
// gates, so areas are measured one at a time and scores are pinned in
// artifacts/quality/mutation-baseline.json.
export default {
    testRunner: "vitest",
    // pnpm isolates plugin packages; point Stryker at the installed runner explicitly.
    appendPlugins: ["@stryker-mutator/vitest-runner"],
    vitest: { configFile: "vitest.mutation.config.mjs" },
    coverageAnalysis: "perTest",
    // Mutating a source file re-runs only the tests that cover it.
    ignoreStatic: true,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "reports/quality/mutation/report.json" },
    thresholds: { high: 90, low: 80, break: null },
    tempDirName: ".stryker-tmp",
    concurrency: 8,
    timeoutMS: 20000
};
