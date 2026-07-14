import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { artifactRoot, packageRoot, readCanonicalJson } from "./quality/project.mjs";

const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const registry = await readCanonicalJson(resolve(artifactRoot, "quality/exports.json"));
if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
    throw new TypeError("Package files manifest must contain only dist");
}
if (JSON.stringify(packageJson.exports) !== JSON.stringify(registry.exports)) {
    throw new TypeError("Package exports differ from the W0-owned export registry");
}

const declarationPaths = new Map();
const runtimeModules = new Map();
for (const [subpath, targets] of Object.entries(packageJson.exports)) {
    await access(resolve(packageRoot, targets.types));
    await access(resolve(packageRoot, targets.import));
    const specifier =
        subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`;
    const runtime = await import(
        `${pathToFileURL(resolve(packageRoot, targets.import)).href}?check=${Date.now()}`
    );
    runtimeModules.set(specifier, runtime);
    assertExact(Object.keys(runtime), registry.runtime[specifier], `${specifier} runtime`);
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
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (module === undefined) throw new TypeError(`Missing declaration module ${specifier}`);
    assertExact(
        checker.getExportsOfModule(module).map((symbol) => symbol.name),
        registry.declarations[specifier],
        `${specifier} declarations`
    );
}
for (const [specifier, symbols] of Object.entries(registry.forbiddenSymbols ?? {})) {
    const runtime = runtimeModules.get(specifier);
    const declarationPath = declarationPaths.get(specifier);
    if (runtime === undefined || declarationPath === undefined)
        throw new TypeError(`Forbidden-symbol lane is not exported: ${specifier}`);
    const source = program.getSourceFile(declarationPath);
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    const declarations = new Set(
        module === undefined ? [] : checker.getExportsOfModule(module).map((symbol) => symbol.name)
    );
    for (const symbol of symbols) {
        if (Object.hasOwn(runtime, symbol) || declarations.has(symbol)) {
            throw new TypeError(
                `Retired compatibility symbol was reintroduced: ${specifier}#${symbol}`
            );
        }
    }
}
for (const rule of registry.forbiddenMembers ?? []) {
    const runtime = runtimeModules.get(rule.specifier)?.[rule.symbol];
    const declarationPath = declarationPaths.get(rule.specifier);
    if (declarationPath === undefined)
        throw new TypeError(`Forbidden-member lane is not exported: ${rule.specifier}`);
    const source = program.getSourceFile(declarationPath);
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    const exported =
        module === undefined
            ? undefined
            : checker.getExportsOfModule(module).find((symbol) => symbol.name === rule.symbol);
    const target =
        exported === undefined
            ? undefined
            : exported.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(exported)
              : exported;
    const members = new Set(
        (target?.declarations ?? []).flatMap((declaration) =>
            "members" in declaration
                ? [...declaration.members]
                      .map((member) => member.name?.getText(source))
                      .filter(Boolean)
                : []
        )
    );
    for (const member of rule.members) {
        if (
            (runtime?.prototype !== undefined && member in runtime.prototype) ||
            members.has(member)
        ) {
            throw new TypeError(
                `Retired compatibility member was reintroduced: ${rule.specifier}#${rule.symbol}.${member}`
            );
        }
    }
}

const packageManager = process.env.npm_execpath;
if (!packageManager)
    throw new TypeError("Export verification must run through the pinned package manager");
const pnpmOnPath = process.env.npm_config_user_agent?.startsWith("pnpm/") === true;
const consumer = await mkdtemp(resolve(tmpdir(), "agent-core-consumer-"));
try {
    const pack = runPackageManager(["pack", "--pack-destination", consumer, "--json"], packageRoot);
    const packed = JSON.parse(pack.stdout);
    const result = Array.isArray(packed) ? packed[0] : packed;
    if (typeof result?.filename !== "string" || !Array.isArray(result.files)) {
        throw new TypeError("pnpm pack did not report its exact manifest");
    }
    if (
        result.files.some((file) => file.path.startsWith("src/") || file.path.startsWith("test/"))
    ) {
        throw new TypeError("Packed package contains source or tests");
    }
    const packedDeclarations = result.files
        .map((file) => file.path)
        .filter((path) => path.endsWith(".d.ts"))
        .sort();
    const expectedDeclarations = await declarationClosure();
    if (JSON.stringify(packedDeclarations) !== JSON.stringify(expectedDeclarations)) {
        throw new TypeError("Packed declaration files exceed the exact public closure");
    }
    await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify(
            {
                name: "agent-core-quality-consumer",
                private: true,
                type: "module"
            },
            null,
            2
        ),
        "utf8"
    );
    runPackageManager(["add", "--ignore-scripts", resolve(consumer, result.filename)], consumer);
    const specifiers = Object.keys(registry.runtime);
    await writeFile(
        resolve(consumer, "consumer.mjs"),
        [
            ...specifiers.map(
                (specifier, index) =>
                    `import * as module${index} from ${JSON.stringify(specifier)};`
            ),
            `const modules = [${specifiers.map((_, index) => `module${index}`).join(", ")}];`,
            `const expected = ${JSON.stringify(specifiers.map((specifier) => registry.runtime[specifier]))};`,
            "for (let index = 0; index < modules.length; index += 1) {",
            "    const actual = Object.keys(modules[index]).sort();",
            "    if (JSON.stringify(actual) !== JSON.stringify([...expected[index]].sort())) {",
            "        throw new Error(`packed runtime exports differ: ${actual.join(',')}`);",
            "    }",
            "}"
        ].join("\n"),
        "utf8"
    );
    await writeFile(
        resolve(consumer, "consumer.ts"),
        [
            ...specifiers.map(
                (specifier, index) =>
                    `import * as module${index} from ${JSON.stringify(specifier)};`
            ),
            `void [${specifiers.map((_, index) => `module${index}`).join(", ")}];`,
            ...Object.entries(registry.forbiddenSymbols ?? {}).flatMap(([specifier, symbols]) =>
                symbols.flatMap((symbol, index) => [
                    `// @ts-expect-error ${specifier}#${symbol} has no public value export`,
                    `type ForbiddenValue_${safeName(specifier)}_${index} = typeof import(${JSON.stringify(specifier)}).${symbol};`,
                    `// @ts-expect-error ${specifier}#${symbol} has no public type export`,
                    `type ForbiddenType_${safeName(specifier)}_${index} = import(${JSON.stringify(specifier)}).${symbol};`
                ])
            ),
            ...(registry.forbiddenSubpaths ?? []).map(
                (specifier, index) =>
                    `// @ts-expect-error private package subpath\nimport type * as ForbiddenSubpath_${index} from ${JSON.stringify(specifier)};`
            )
        ].join("\n"),
        "utf8"
    );
    await writeFile(
        resolve(consumer, "negative-subpaths.mjs"),
        [
            `const forbidden = ${JSON.stringify(registry.forbiddenSubpaths ?? [])};`,
            "for (const specifier of forbidden) {",
            "    try {",
            "        await import(specifier);",
            "    } catch (error) {",
            "        if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;",
            "        throw error;",
            "    }",
            "    throw new Error(`private package subpath resolved: ${specifier}`);",
            "}"
        ].join("\n"),
        "utf8"
    );
    run(process.execPath, [resolve(consumer, "consumer.mjs")], consumer);
    run(process.execPath, [resolve(consumer, "negative-subpaths.mjs")], consumer);
    run(
        process.execPath,
        [
            resolve(packageRoot, "node_modules/typescript/bin/tsc"),
            "--ignoreConfig",
            "--noEmit",
            "--strict",
            "--target",
            "ES2022",
            "--lib",
            "ES2023,ESNext.Disposable,DOM",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            resolve(consumer, "consumer.ts")
        ],
        consumer
    );
} finally {
    await rm(consumer, { recursive: true, force: true });
}

console.log(`packed exports verified: ${declarationPaths.size} exact public subpaths`);

async function declarationClosure() {
    const pending = [...declarationPaths.values()];
    const closure = new Set();
    while (pending.length > 0) {
        const path = pending.pop();
        if (closure.has(path)) continue;
        closure.add(path);
        const source = await readFile(path, "utf8");
        const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        parsed.forEachChild((node) => {
            const literal =
                ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
                    ? node.moduleSpecifier
                    : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
                      ? node.argument.literal
                      : undefined;
            if (literal === undefined || !ts.isStringLiteral(literal)) return;
            if (!literal.text.startsWith("./") && !literal.text.startsWith("../")) return;
            pending.push(resolve(path, "..", literal.text.replace(/\.js$/u, ".d.ts")));
        });
    }
    const distRoot = resolve(packageRoot, "dist");
    return [...closure].map((path) => `dist/${path.slice(distRoot.length + 1)}`).sort();
}

function assertExact(actual, expected, owner) {
    if (
        !Array.isArray(expected) ||
        JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
    ) {
        throw new TypeError(`${owner} symbols differ from the W0-owned export registry`);
    }
}

function safeName(value) {
    return value.replaceAll(/[^a-zA-Z0-9]/gu, "_");
}

function runPackageManager(args, cwd) {
    return pnpmOnPath
        ? run("pnpm", args, cwd, true)
        : run(process.execPath, [packageManager, ...args], cwd, true);
}

function run(command, args, cwd, capture = false) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: capture ? "pipe" : "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(capture ? `${result.stdout}${result.stderr}` : `${command} failed`);
    return result;
}
