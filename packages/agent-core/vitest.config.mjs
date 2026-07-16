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
        include: ["test/**/*.test.ts"],
        // The multi-agent governance harness (request/scope/worktree machinery) is not
        // hermetic: it requires the orchestration environment's git state. Product
        // verification never depends on it; run it explicitly with test:governance.
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
