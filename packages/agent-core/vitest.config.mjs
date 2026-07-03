import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageFile = path => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": packageFile("./scripts/vitest-bun-test.mjs"),
      "bun:sqlite": packageFile("./scripts/vitest-bun-sqlite.mjs")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
