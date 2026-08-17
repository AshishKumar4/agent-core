import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageFile = (path) => fileURLToPath(new URL(path, import.meta.url));

// `AGENT_CORE_ENFORCEMENT=generated` resolves every import of `src/facets/enforcement` to the
// module TSLean lowers from `AgentCore.Facets.Enforcement`. The two export the same surface, so
// the suite runs unmodified against either and the comparison is apples to apples: a test that
// passes for one and fails for the other is either a behavioural difference or a test that was
// asserting the handwritten implementation rather than SPEC §7.1-§7.2.
const enforcementSubstitution = {
    name: "agent-core-enforcement-substitution",
    enforce: "pre",
    resolveId(source) {
        return source === "./enforcement" ? packageFile("./src/facets/enforcement.generated.ts") : null;
    }
};

// The two answers are different shapes rather than one value: an absent variable means
// "handwritten", `generated` means the twin, and anything else is refused. Falling an
// unrecognised value through to handwritten would make a typo report a green that reads as
// "the generated module passes the suite" while never having loaded it.
const enforcementSelection = process.env.AGENT_CORE_ENFORCEMENT;
if (enforcementSelection !== undefined && enforcementSelection !== "generated") {
    throw new TypeError(
        `AGENT_CORE_ENFORCEMENT must be unset or "generated", not ${JSON.stringify(enforcementSelection)}`
    );
}

export default defineConfig({
    plugins: enforcementSelection === "generated" ? [enforcementSubstitution] : [],
    resolve: {
        alias: {
            "bun:test": packageFile("./scripts/vitest-bun-test.mjs"),
            "bun:sqlite": packageFile("./scripts/vitest-bun-sqlite.mjs")
        }
    },
    test: {
        environment: "node",
        // Priority measures regression impact, independently of whether a test is
        // deterministic, model-based, differential, fault-driven, or long-running.
        // Every priority remains release-blocking; final classification permits no
        // untagged product assertion.
        tags: [
            {
                name: "p0",
                description:
                    "Critical safety, authority, durability, and irreversible-integrity behavior"
            },
            {
                name: "p1",
                description: "Required runtime correctness, recovery, and integration behavior"
            },
            {
                name: "p2",
                description: "Compatibility, diagnostics, and exhaustive edge behavior"
            }
        ],
        strictTags: true,
        include: ["test/**/*.test.ts"],
        // The quality harness has its own configuration and quality-DAG node. Keeping
        // it out of product coverage prevents checker implementation from affecting
        // the runtime coverage denominator.
        exclude: ["test/quality/**", "**/node_modules/**"],
        coverage: {
            provider: "v8",
            all: true,
            include: ["src/**/*.ts"],
            reporter: ["text", "json", "json-summary", "lcov", "html"],
            reportsDirectory: "reports/quality/coverage"
        }
    }
});
