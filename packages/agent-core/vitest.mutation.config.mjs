// Vitest configuration for mutation runs (see stryker.conf.mjs). Identical to the
// default suite except that self-inspecting meta-tests are excluded: they read source
// files as text (TypeError census, focused-coverage sub-runs) or spawn heavyweight
// subprocesses (the Lean oracle), so inside Stryker's instrumented sandbox they fail
// the dry run without measuring any behavior of the mutated area.
//
// The stress lane is excluded for the same practical reason: its volume and
// contention timeouts are calibrated for uninstrumented runs, so instrumentation
// pushes the dry run past its budget. It proves the same invariants the behavior
// suite proves, under contention, so no mutant loses its only killer here.
//
// test/conformance/profile-base.test.ts is excluded for a third reason, and it is the
// only exclusion that is not a matter of degree: C13-CONTENT-CUSTODY opens the source
// project through scripts/quality/evidence.mjs, which spans this package AND
// packages/agent-core-cloudflare. Stryker's sandbox is rooted at this package, so the
// sibling package is not copied into it and `resolve(repositoryRoot, ...)` lands on
// <package>/packages/agent-core-cloudflare, a path that cannot exist there. No
// resolution fixes it — the files are genuinely absent — so the dry run fails for every
// area and the whole gate stops running. The file's other assertions were never a sole
// killer: at be905bac the one mutation kill it recorded was
// src/facets/contribution.ts lines 113 and 211, both also killed by other tests.
import defaultConfig from "./vitest.config.mjs";

const mutationTestTimeoutMs = 15_000;

export default {
    ...defaultConfig,
    test: {
        ...defaultConfig.test,
        // Per-test instrumentation pushed otherwise green SQLite and transcript cases past
        // the default five-second ceiling under ordinary workstation load. This is only a
        // dry-run ceiling: unresolved mutant timeouts are remeasured without bail and are
        // still refused unless a named test kills them.
        testTimeout: mutationTestTimeoutMs,
        exclude: [
            ...defaultConfig.test.exclude,
            "test/conformance/profile-base.test.ts",
            "test/core/error-taxonomy.test.ts",
            "test/definition/coverage-gate.test.ts",
            "test/definition/error-taxonomy.test.ts",
            "test/differential/**",
            "test/integration/stress/**",
            "test/quality/**"
        ],
        coverage: { ...defaultConfig.test.coverage, enabled: false }
    }
};
