import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageFile = path => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

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
      include: [
        "src/definition/**/*.ts",
        "src/protocol/materialization-commands.ts",
        "src/substrates/sqlite/materialization.ts",
        "src/substrates/sqlite/package.ts"
      ],
      exclude: [],
      reportsDirectory: "coverage/w4",
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
