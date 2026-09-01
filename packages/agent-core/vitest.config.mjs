import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageFile = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
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
