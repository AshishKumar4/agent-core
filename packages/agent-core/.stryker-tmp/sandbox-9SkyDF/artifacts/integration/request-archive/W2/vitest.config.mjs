// @ts-nocheck
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const requestRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(requestRoot, "../../..");
const manifest = JSON.parse(readFileSync(resolve(requestRoot, "coverage-manifest.json"), "utf8"));
const packageFile = path => resolve(packageRoot, path);

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
      reporter: ["json", "text-summary"],
      reportsDirectory: packageFile("coverage/w2")
    }
  }
});
