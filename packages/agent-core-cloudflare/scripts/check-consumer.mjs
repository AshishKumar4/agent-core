import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(packageRoot, "../agent-core");
const consumerRoot = await mkdtemp(resolve(tmpdir(), "agent-core-cloudflare-consumer-"));
const cloudflareArchive = resolve(consumerRoot, "agent-core-cloudflare-0.1.0.tgz");
const coreArchive = resolve(consumerRoot, "agent-core-core-0.1.0.tgz");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const registry = JSON.parse(await readFile(resolve(packageRoot, "quality/exports.json"), "utf8"));
const specifier = packageJson.name;
if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
    throw new TypeError("Cloudflare package files manifest must contain only dist");
}
if (JSON.stringify(packageJson.exports) !== JSON.stringify(registry.exports)) {
    throw new TypeError("Cloudflare package exports differ from the W0-owned registry");
}
if (Object.keys(packageJson.exports).length !== 1 || packageJson.exports["."] === undefined) {
    throw new TypeError("Cloudflare package must expose only its root entrypoint");
}

try {
    run("pnpm", ["pack", "--pack-destination", consumerRoot], "built package archive", packageRoot);
    run("pnpm", ["pack", "--pack-destination", consumerRoot], "core package archive", coreRoot);
    await writeFile(
        resolve(consumerRoot, "package.json"),
        JSON.stringify({
            name: "agent-core-cloudflare-dist-consumer",
            private: true,
            type: "module",
            dependencies: {
                "@agent-core/cloudflare": `file:${cloudflareArchive}`,
                "@agent-core/core": `file:${coreArchive}`
            }
        })
    );
    await writeFile(
        resolve(consumerRoot, "pnpm-workspace.yaml"),
        `packages: []\noverrides:\n    "@agent-core/core": "file:${coreArchive}"\n`
    );
    run("pnpm", ["install", "--ignore-scripts"], "packed package install");
    verifyDeclarationExports(
        resolve(consumerRoot, "node_modules/@agent-core/cloudflare/dist/index.d.ts")
    );
    await writeFile(
        resolve(consumerRoot, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                lib: ["ES2023", "ESNext.Disposable", "DOM"],
                strict: true,
                noEmit: true
            },
            include: ["consumer.ts", "consumer-negative.ts"]
        })
    );
    await writeFile(
        resolve(consumerRoot, "consumer.ts"),
        `
import {
    DurableObjectEnvironmentProvider,
    DynamicWorkerLoaderAdapter,
    type CloudflareErrorPort,
    type DynamicWorkerLoadOptions
} from "@agent-core/cloudflare";
import { AgentCoreError } from "@agent-core/core";
import { EnvironmentProvider } from "@agent-core/core/environment-provider";
import { SlateProvider } from "@agent-core/core/slate-provider";

declare const environmentProvider: DurableObjectEnvironmentProvider;
const canonicalEnvironmentProvider: EnvironmentProvider = environmentProvider;
declare const canonicalSlateProvider: SlateProvider;

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};
const options: DynamicWorkerLoadOptions = {
    compatibilityDate: "2026-07-10",
    mainModule: "index.js",
    modules: { "index.js": "export default {}" },
    env: { CAPABILITY: "allowed" },
    globalOutbound: null
};
const adapter = new DynamicWorkerLoaderAdapter({
    load: (_value: DynamicWorkerLoadOptions) => ({ getEntrypoint: () => ({}) })
}, ["CAPABILITY"], errors);
void options;
void adapter;
void canonicalEnvironmentProvider;
void canonicalSlateProvider;
`
    );
    const forbiddenSubpaths = registry.forbiddenSubpaths ?? [];
    await writeFile(
        resolve(consumerRoot, "consumer-negative.ts"),
        `
${forbiddenSubpaths
    .map(
        (specifier) =>
            `// @ts-expect-error The package exposes only its root entrypoint.\nimport ${JSON.stringify(specifier)};`
    )
    .join("\n")}
${Object.entries(registry.forbiddenSymbols ?? {})
    .flatMap(([moduleSpecifier, symbols]) =>
        symbols.flatMap((symbol, index) => [
            `// @ts-expect-error ${moduleSpecifier}#${symbol} has no public value export`,
            `type ForbiddenValue_${index} = typeof import(${JSON.stringify(moduleSpecifier)}).${symbol};`,
            `// @ts-expect-error ${moduleSpecifier}#${symbol} has no public type export`,
            `type ForbiddenType_${index} = import(${JSON.stringify(moduleSpecifier)}).${symbol};`
        ])
    )
    .join("\n")}
`
    );
    await writeFile(
        resolve(consumerRoot, "consumer.mjs"),
        `
import * as substrate from "@agent-core/cloudflare";
const expected = ${JSON.stringify(registry.runtime[specifier])};
const forbidden = ${JSON.stringify(forbiddenSubpaths)};
const actual = Object.keys(substrate).sort();
if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(\`Unexpected package exports: \${actual.join(", ")}\`);
}
for (const specifier of forbidden) {
    try {
        await import(specifier);
        throw new TypeError("Undeclared package subpath resolved: " + specifier);
    } catch (error) {
        if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
}
`
    );

    run(
        process.execPath,
        [
            resolve(coreRoot, "node_modules/typescript/bin/tsc"),
            "-p",
            resolve(consumerRoot, "tsconfig.json")
        ],
        "NodeNext consumer typecheck"
    );
    run(process.execPath, [resolve(consumerRoot, "consumer.mjs")], "package-name import");
} finally {
    await rm(consumerRoot, { recursive: true, force: true });
}

function verifyDeclarationExports(declarationPath) {
    const program = ts.createProgram({
        rootNames: [declarationPath],
        options: {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true,
            target: ts.ScriptTarget.ES2022
        }
    });
    const source = program.getSourceFile(declarationPath);
    if (source === undefined) throw new TypeError("Packed declaration entrypoint is missing");
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined)
        throw new TypeError("Packed declaration entrypoint is not a module");
    const actual = { values: [], types: [] };
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol =
            (exported.flags & ts.SymbolFlags.Alias) === 0
                ? exported
                : checker.getAliasedSymbol(exported);
        const bucket = (symbol.flags & ts.SymbolFlags.Value) === 0 ? actual.types : actual.values;
        bucket.push(exported.name);
    }
    actual.values.sort();
    actual.types.sort();
    if (JSON.stringify(actual) !== JSON.stringify(registry.declarations[specifier])) {
        throw new TypeError(`Unexpected declaration exports: ${JSON.stringify(actual)}`);
    }
}

function run(command, args, label, cwd = consumerRoot) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
        throw new TypeError(`${label} failed with status ${result.status ?? 1}`);
    }
}
