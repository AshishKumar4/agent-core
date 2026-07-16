// @ts-nocheck
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedBom } from "./bom.mjs";
import { changedPaths, loadOwnership, ownersForPath } from "./ownership.mjs";
import { repositoryRoot } from "./project.mjs";
import { run } from "./process.mjs";

const owner = argument("--owner");
const base = argument("--base");
const stage = argument("--stage") ?? "building";
const prettier = resolve(repositoryRoot, "node_modules/prettier/bin/prettier.cjs");
const supported = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md)$/;
const canonicalOnly = new Set(["packages/agent-core/artifacts/traceability.yaml"]);
const immutableImports = new Set((await loadValidatedBom(stage)).imports.keys());
let paths;

if (base === undefined) throw new TypeError("Formatting requires --base");
if (owner === undefined) {
    paths = changedPaths(base).filter(
        (path) =>
            supported.test(path) &&
            !canonicalOnly.has(path) &&
            !immutableImports.has(path) &&
            existsSync(resolve(repositoryRoot, path))
    );
} else {
    const { patterns } = await loadOwnership();
    paths = changedPaths(base).filter(
        (path) =>
            supported.test(path) &&
            !canonicalOnly.has(path) &&
            !immutableImports.has(path) &&
            existsSync(resolve(repositoryRoot, path)) &&
            ownersForPath(path, patterns).includes(owner)
    );
}

if (paths.length > 0)
    run(process.execPath, [prettier, "--check", ...paths], { cwd: repositoryRoot });

function argument(name) {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} requires a value`);
    return value;
}
