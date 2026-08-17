import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { parseCanonicalJson, portablePath } from "../../agent-core/scripts/quality/project.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(packageRoot, "../agent-core");
const consumerRoot = await mkdtemp(resolve(tmpdir(), "agent-core-harness-consumer-"));
const harnessArchive = resolve(consumerRoot, "agent-core-harness-0.1.0.tgz");
const coreArchive = resolve(consumerRoot, "agent-core-core-0.1.0.tgz");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const exportsPath = resolve(packageRoot, "quality/exports.json");
const registry = parseCanonicalJson(await readFile(exportsPath, "utf8"), portablePath(exportsPath));
const specifier = packageJson.name;

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
    throw new TypeError("Harness package files manifest must contain only dist");
}
if (JSON.stringify(packageJson.exports) !== JSON.stringify(registry.exports)) {
    throw new TypeError("Harness package exports differ from the W0-owned registry");
}
if (Object.keys(packageJson.exports).length !== 1 || packageJson.exports["."] === undefined) {
    throw new TypeError("Harness package must expose only its root entrypoint");
}

try {
    run("pnpm", ["pack", "--pack-destination", consumerRoot], "built package archive", packageRoot);
    run("pnpm", ["pack", "--pack-destination", consumerRoot], "core package archive", coreRoot);
    await writeFile(
        resolve(consumerRoot, "package.json"),
        JSON.stringify({
            name: "agent-core-harness-dist-consumer",
            private: true,
            type: "module",
            dependencies: {
                "@agent-core/harness": `file:${harnessArchive}`,
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
        resolve(consumerRoot, "node_modules/@agent-core/harness/dist/index.d.ts")
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
    // The positive consumer proves the packed package still satisfies the kernel's
    // published seams by assignment, not by structural resemblance.
    await writeFile(
        resolve(consumerRoot, "consumer.ts"),
        `
import {
    AgentLoopTurnExecutor,
    OpenAiCompatibleModelProvider,
    PlacementOperationSource,
    TranscriptPromptAssembler,
    TranscriptTurnModelPort,
    workersAiEndpoint,
    type ModelCompletion
} from "@agent-core/harness";
import {
    TurnExecutor,
    TurnModelPort,
    TurnOperationSource,
    TurnPromptAssembler
} from "@agent-core/core/agents/runs";
import { ContentStore } from "@agent-core/core/content";

declare const content: ContentStore;
const provider = new OpenAiCompatibleModelProvider({
    endpoint: workersAiEndpoint("account"),
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    credential: async () => "token",
    fetch: globalThis.fetch
});
const executor: TurnExecutor = new AgentLoopTurnExecutor({ maximumSteps: 4 });
const model: TurnModelPort = new TranscriptTurnModelPort(provider, content);
const prompt: TurnPromptAssembler = new TranscriptPromptAssembler("Be brief.", content);
const operations: TurnOperationSource = new PlacementOperationSource([]);
declare const completion: ModelCompletion;
void executor;
void model;
void prompt;
void operations;
void completion;
`
    );
    const forbiddenSubpaths = registry.forbiddenSubpaths ?? [];
    await writeFile(
        resolve(consumerRoot, "consumer-negative.ts"),
        `
${forbiddenSubpaths
    .map(
        (subpath) =>
            `// @ts-expect-error The package exposes only its root entrypoint.\nimport ${JSON.stringify(subpath)};`
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
import * as harness from "@agent-core/harness";
const expected = ${JSON.stringify(registry.runtime[specifier])};
const forbidden = ${JSON.stringify(forbiddenSubpaths)};
const actual = Object.keys(harness).sort();
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
