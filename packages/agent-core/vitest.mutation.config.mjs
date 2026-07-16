// Vitest configuration for mutation runs (see stryker.conf.mjs). Identical to the
// default suite except that self-inspecting meta-tests are excluded: they read source
// files as text (TypeError census, focused-coverage sub-runs) or spawn heavyweight
// subprocesses (the Lean oracle), so inside Stryker's instrumented sandbox they fail
// the dry run without measuring any behavior of the mutated area.
import defaultConfig from "./vitest.config.mjs";

export default {
    ...defaultConfig,
    test: {
        ...defaultConfig.test,
        exclude: [
            ...defaultConfig.test.exclude,
            "test/core/error-taxonomy.test.ts",
            "test/definition/coverage-gate.test.ts",
            "test/definition/error-taxonomy.test.ts",
            "test/differential/**",
            "test/quality/**"
        ],
        coverage: { ...defaultConfig.test.coverage, enabled: false }
    }
};
