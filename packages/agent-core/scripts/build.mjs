import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

const sourceEntrypoints = [...new Set(collectExportTargets(packageJson.exports))]
  .filter(target => target.startsWith("./src/") && target.endsWith(".ts"));

if (sourceEntrypoints.length === 0) {
  throw new Error("No TypeScript source entrypoints found in package.json exports.");
}

const entries = Object.fromEntries(
  sourceEntrypoints.map(target => [
    target.slice("./src/".length, -".ts".length),
    resolve(packageRoot, target)
  ])
);

await build({
  configFile: false,
  root: packageRoot,
  build: {
    emptyOutDir: true,
    lib: {
      entry: entries,
      formats: ["es"]
    },
    minify: false,
    outDir: resolve(packageRoot, "dist"),
    rollupOptions: {
      external: id => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "[name].js"
      }
    },
    sourcemap: true,
    target: "es2022"
  }
});

function collectExportTargets(value) {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectExportTargets);
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectExportTargets);
  }

  return [];
}
