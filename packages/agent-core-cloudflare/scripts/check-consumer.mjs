import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SymbolFlags } from "typescript/unstable/sync";
import { openProject } from "../../agent-core/scripts/quality/compiler.mjs";
import {
    isNonEmptyString,
    parseCanonicalJson,
    portablePath
} from "../../agent-core/scripts/quality/project.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(packageRoot, "../agent-core");
const consumerRoot = await mkdtemp(resolve(tmpdir(), "agent-core-cloudflare-consumer-"));
const cloudflareArchive = resolve(consumerRoot, "agent-core-cloudflare-0.1.0.tgz");
const coreArchive = resolve(consumerRoot, "agent-core-core-0.1.0.tgz");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const exportsPath = resolve(packageRoot, "quality/exports.json");
const registry = parseCanonicalJson(await readFile(exportsPath, "utf8"), portablePath(exportsPath));
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

/**
 * AtLeastOnceQueueAdapter retries an undecodable body on purpose, so the queue's own
 * dead-letter policy takes custody instead of the adapter destroying an authoritative
 * delivery. Without a dead-letter queue that disposition becomes retry-then-drop, which is
 * exactly the accepted-mutation loss the adapter exists to avoid. Every consumer this
 * package configures therefore declares its custody: either it dead-letters somewhere, or
 * it IS a dead-letter queue and says so by taking no retries.
 */
for (const [label, configPath] of [
    ["wrangler.test.jsonc", resolve(packageRoot, "wrangler.test.jsonc")],
    ["live/wrangler.live.jsonc", resolve(packageRoot, "live/wrangler.live.jsonc")]
]) {
    const config = parseCanonicalJson(
        (await readFile(configPath, "utf8")).replace(/^\s*\/\/.*$/gmu, ""),
        portablePath(configPath)
    );
    const consumers = config.queues?.consumers ?? [];
    if (consumers.length === 0) {
        throw new TypeError(`${label} declares a queue producer with no consumer`);
    }
    const terminal = new Set(
        consumers.filter((entry) => entry.max_retries === 0).map((entry) => entry.queue)
    );
    for (const consumer of consumers) {
        if (!Number.isSafeInteger(consumer.max_retries) || consumer.max_retries < 0) {
            throw new TypeError(`${label} consumer ${consumer.queue} declares no max_retries`);
        }
        if (terminal.has(consumer.queue)) continue;
        if (!isNonEmptyString(consumer.dead_letter_queue)) {
            throw new TypeError(
                `${label} consumer ${consumer.queue} has no dead_letter_queue, so a poison ` +
                    "body the adapter retries is dropped rather than preserved"
            );
        }
        if (!terminal.has(consumer.dead_letter_queue)) {
            throw new TypeError(
                `${label} dead-letter queue ${consumer.dead_letter_queue} is not declared as a ` +
                    "consumer that takes no retries, so dead-lettered deliveries have no custody"
            );
        }
    }
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
    // `skipLibCheck` is about one third-party declaration file, not about this package:
    // capnweb 0.12.0 ships an `UnstubifyInner` arm that spreads a union into a tuple,
    // which TypeScript 7 rejects where 5.9 deferred it. Everything this check exists to
    // prove still runs — `consumer.ts` resolves every packed type at a real use site,
    // `consumer-negative.ts` proves the forbidden ones stay unreachable, and
    // `verifyDeclarationExports` walks the packed entrypoint's own symbols.
    await writeFile(
        resolve(consumerRoot, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                lib: ["ES2023", "ESNext.Disposable", "DOM"],
                strict: true,
                noEmit: true,
                skipLibCheck: true
            },
            include: ["consumer.ts", "consumer-negative.ts"]
        })
    );
    await writeFile(
        resolve(consumerRoot, "consumer.ts"),
        `
import {
    DurableObjectEnvironmentProvider,
    DurableObjectFacetHost,
    DynamicDomainName,
    DynamicWorkerLimits,
    DynamicWorkerLoaderAdapter,
    PassedCapabilityRegistry,
    ProviderCapabilityScope,
    WorkerLoaderAuthoredCodeBacking,
    type CloudflareErrorPort,
    type DynamicWorkerLoadOptions,
    type DurableObjectFacetsLike,
    type ProviderActorStubLike
} from "@agent-core/cloudflare";
import { AgentCoreError } from "@agent-core/core";
import { AuthoredCodeBacking } from "@agent-core/core/operations";
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
    env: {},
    globalOutbound: null,
    limits: { cpuMs: 50, subRequests: 8 }
};
const adapter = new DynamicWorkerLoaderAdapter({
    load: (_value: DynamicWorkerLoadOptions) => ({ getEntrypoint: () => ({}) })
}, new DynamicWorkerLimits(50, 8), errors);
declare const facets: DurableObjectFacetsLike<{ readonly stub: true }, { readonly code: true }>;
const domains = new DurableObjectFacetHost(facets, errors);
void domains.open(new DynamicDomainName("slate-backend"), () => ({ class: { code: true } }));
const registry = new PassedCapabilityRegistry(errors);
const backing = new WorkerLoaderAuthoredCodeBacking(
    adapter,
    "2026-07-10",
    registry,
    (props) => ({ invoke: (operation, input) => registry.invoke(props, operation, input) }),
    errors
);
const canonicalBacking: AuthoredCodeBacking = backing;
void options;
void adapter;
void canonicalBacking;
void canonicalEnvironmentProvider;
void canonicalSlateProvider;

// The §10.2 provider seam, through the packed surface: the session is opened against a
// provider Actor stub, the directory is reached by authenticating in band, and the
// capability it grants is invoked through without awaiting the binding it descends
// from — one batch, one round trip. The scope releases stub and socket together.
declare const providerActor: ProviderActorStubLike;
async function sealThroughProvider(): Promise<unknown> {
    using scope = await ProviderCapabilityScope.open(providerActor, errors);
    using capability = scope.endpoint
        .authenticate({ credential: "consumer" })
        .binding("gateway");
    return await capability.invoke("seal", { payload: "consumer" });
}
void sealThroughProvider;
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
    const declarationProject = openProject({
        files: [declarationPath],
        compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            skipLibCheck: true,
            target: "ES2022"
        }
    });
    const program = declarationProject.program;
    const source = program.getSourceFile(declarationPath);
    if (source === undefined) throw new TypeError("Packed declaration entrypoint is missing");
    const checker = declarationProject.checker;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined)
        throw new TypeError("Packed declaration entrypoint is not a module");
    const actual = { values: [], types: [] };
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol =
            (exported.flags & SymbolFlags.Alias) === 0
                ? exported
                : checker.getAliasedSymbol(exported);
        const bucket = (symbol.flags & SymbolFlags.Value) === 0 ? actual.types : actual.values;
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
