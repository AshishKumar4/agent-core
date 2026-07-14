import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { artifactRoot, packageRoot, writeCanonicalJson } from "./project.mjs";

if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
    throw new TypeError("Snapshotting exports requires QUALITY_WRITE_BASELINE=1 outside CI");
}
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const runtime = {};
const declarations = {};
const declarationPaths = new Map();
for (const [subpath, targets] of Object.entries(packageJson.exports)) {
    const specifier =
        subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`;
    const module = await import(
        `${pathToFileURL(resolve(packageRoot, targets.import)).href}?snapshot=${Date.now()}`
    );
    runtime[specifier] = Object.keys(module).sort();
    declarationPaths.set(specifier, resolve(packageRoot, targets.types));
}
const program = ts.createProgram([...declarationPaths.values()], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022
});
const checker = program.getTypeChecker();
for (const [specifier, path] of declarationPaths) {
    const source = program.getSourceFile(path);
    const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (symbol === undefined) throw new TypeError(`Missing declaration module ${specifier}`);
    declarations[specifier] = checker
        .getExportsOfModule(symbol)
        .map((item) => item.name)
        .sort();
}
let governance = {};
try {
    const previous = JSON.parse(
        await readFile(resolve(artifactRoot, "quality/exports.json"), "utf8")
    );
    governance = {
        forbiddenSymbols: previous.forbiddenSymbols ?? {},
        forbiddenSubpaths: previous.forbiddenSubpaths ?? [],
        forbiddenMembers: previous.forbiddenMembers ?? []
    };
} catch (error) {
    if (error?.code !== "ENOENT") throw error;
}
await writeCanonicalJson(resolve(artifactRoot, "quality/exports.json"), {
    edition: "1.0.0",
    exports: packageJson.exports,
    runtime,
    declarations,
    ...governance
});
console.log(`snapshotted ${Object.keys(runtime).length} public subpaths`);
