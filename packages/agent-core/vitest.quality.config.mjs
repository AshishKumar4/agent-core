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
        include: ["test/quality/**/*.test.ts"],
        exclude: [
            "test/quality/governance.test.ts",
            "test/quality/ownership.test.ts",
            "test/quality/protocols.test.ts",
            "**/node_modules/**"
        ],
        fileParallelism: false
    }
});
