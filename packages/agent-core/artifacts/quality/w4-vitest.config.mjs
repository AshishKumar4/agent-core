import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageFile = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const inventory = JSON.parse(
    readFileSync(fileURLToPath(new URL("./w4-source-inventory.json", import.meta.url)), "utf8")
);

export default defineConfig({
    root: packageFile("."),
    resolve: {
        alias: {
            "bun:test": packageFile("scripts/vitest-bun-test.mjs"),
            "bun:sqlite": packageFile("scripts/vitest-bun-sqlite.mjs")
        }
    },
    test: {
        environment: "node",
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
        include: [
            "test/definition/**/*.test.ts",
            "test/protocol/materialization-commands.test.ts",
            "test/substrates/sqlite/materialization*.test.ts"
        ],
        exclude: [
            "test/definition/coverage-gate.test.ts",
            "test/definition/error-taxonomy.test.ts"
        ],
        coverage: {
            provider: "v8",
            all: true,
            include: inventory.sources,
            exclude: [],
            reportsDirectory: "coverage/w4-integrated",
            reporter: ["json", "json-summary"],
            thresholds: {
                statements: 95,
                branches: 95,
                functions: 95,
                lines: 95
            }
        }
    }
});
