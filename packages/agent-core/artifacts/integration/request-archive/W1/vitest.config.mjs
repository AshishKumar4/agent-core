import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageFile = path => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./verification-manifest.json", import.meta.url), "utf8"));

export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      "bun:test": packageFile("scripts/vitest-bun-test.mjs"),
      "bun:sqlite": packageFile("scripts/vitest-bun-sqlite.mjs")
    }
  },
  test: {
    environment: "node",
    include: manifest.testFiles,
    coverage: {
      provider: "v8",
      all: true,
      include: manifest.sourceFiles,
      exclude: [],
      reporter: ["text", "json-summary"]
    }
  }
});
