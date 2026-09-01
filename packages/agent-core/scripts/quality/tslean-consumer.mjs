// TSLean consumer gate: a generated package is verified against its own manifest, offline.
//
// `src/facets/generated/` is what the TSLean compiler lowers from the Lean module the kernel
// checks (`formal/AgentCore/Facets/Enforcement.lean`). Those bytes are the product now — the
// handwritten twin is gone — so nothing downstream re-derives them: the floor suites import the
// generated module, and the contract tests prove it against SPEC §7.1-§7.2's own table. What
// nothing else can check is whether the committed bytes are still the ones the compiler
// produced for the committed Lean source, and that is this gate's whole job.
// Default mode reads only committed bytes: every generated file hashes to the digests the
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertArray,
    assertExactKeys,
    assertObject,
    assertString,
    assertUniqueStrings,
    fileSha256,
    parseCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedRoot = resolve(packageDir, "src/facets/generated");
const manifestPath = join(generatedRoot, "tslean.manifest.json");
const entryModule = "AgentCore.Facets.Enforcement";
const leanSource = resolve(packageDir, "formal/AgentCore/Facets/Enforcement.lean");
const leanSourceIdentity = `source:${entryModule}`;
// The semantic identity is the canonical JSON of exactly these fields, in this order; the
// manifest's own header line and this list must move together (tslean's manifest.ts
// canonicalSemanticIdentity is the one definition).
const semanticIdentityFields = [
    "fragmentVersion",
    "entryModule",
    "leanProjectPath",
    "declarations",
    "leanToolchain",
    "modules",
    "closure",
    "inputs",
    "inputClosureSha256",
    "semanticIrSha256",
    "certificates",
    "generatedBodySha256"
];

const options = parseArguments(process.argv.slice(2));
const manifest = parseCanonicalJson(await readFile(manifestPath, "utf8"));
const issues = [];
const summary = { modules: 0, files: 0, certificates: 0, regenerated: false };

if (options.write) await regenerateIntoTree();
else if (options.regenerate) await regenerateAndCompare();
else await verifyCommittedIntegrity();

await writeCanonicalJson(join(reportRoot, "nodes", "tslean-consumer.json"), {
    edition: "1.0.0",
    stage: options.stage,
    ...summary,
    complete: issues.length === 0
});

if (issues.length > 0) {
    throw new TypeError(
        [
            "generated TSLean package is not intact:",
            ...issues.map((issue) => `  ${issue}`),
            // The most common way this gate goes red is a formatter rewriting bytes a
            // manifest already binds. The package is compiler output, not styled source:
            // .prettierignore must carry packages/agent-core/src/facets/generated/, and the
            // fix is to regenerate, never to re-bless the manifest.
            "restore the compiler bytes with: node scripts/quality/tslean-consumer.mjs --regenerate-into-tree (or the TSLean CLI directly); .prettierignore must cover src/facets/generated/"
        ].join("\n")
    );
}
console.log(
    `tslean consumer verified: ${summary.files} generated file(s) over ${summary.modules} module(s), ` +
        `${summary.certificates} certificate(s), manifest bound to ${entryModule}` +
        (summary.regenerated ? " and byte-identical to a fresh regeneration" : "")
);

/**
 * Offline integrity: the committed bytes must be the ones the manifest describes, and the
 * manifest must describe the committed Lean source. Every check reads a digest the compiler
 * recorded; none re-derives the lowering.
 */
async function verifyCommittedIntegrity() {
    const semantic = semanticIdentity(manifest);
    const modules = assertArray(manifest.semantic.modules, "manifest modules");
    summary.modules = modules.length;
    if (semantic.entryModule !== entryModule) {
        issues.push(`manifest entry module is ${semantic.entryModule}, not ${entryModule}`);
    }
    const declaredRoots = [
        "AgentCore.Facets.claimHonorsEnforcementFloor",
        "AgentCore.Facets.enforcementFloor"
    ];
    assertUniqueStrings(semantic.declarations, "manifest declaration roots");
    if (
        semantic.declarations.length !== declaredRoots.length ||
        [...semantic.declarations]
            .sort()
            .some((declaration, index) => declaration !== declaredRoots[index])
    ) {
        issues.push(
            `manifest declaration roots are [${semantic.declarations.join(", ")}], not the enforcement surface [${declaredRoots.join(", ")}]`
        );
    }

    // Every module the manifest names must exist, hash to its recorded body and source map
    // digests, and carry the exact provenance header the semantic identity produces — so no
    // single file can be refreshed in isolation and no extra file can hide beside them.
    for (const module of modules) {
        await verifyModule(module);
        summary.files += 2;
    }
    if (generatedPackageDigest(modules) !== semantic.generatedBodySha256) {
        issues.push("generated package body digest does not match its module bodies");
    }

    // The runtime certificates the package spends: an `inline:` form is the registry's one
    // emitted form (hash of the exact source text), a `helper:` form names the declaration the
    // allocator resolved. Both name a theorem the registry certifies; a row that names neither
    // form, or an inline row claiming a declaration, is a defect the compiler would have
    // refused.
    const certificates = assertArray(semantic.certificates, "manifest certificates");
    summary.certificates = certificates.length;
    for (const certificate of certificates) {
        const binding = assertObject(certificate, "runtime certificate binding");
        assertExactKeys(
            binding,
            ["opcode", "runtimeSymbol", "declaration", "runtimeBodySha256"],
            `runtime certificate ${binding.opcode ?? "?"}`
        );
        assertString(binding.opcode, "certificate opcode");
        const symbol = assertString(binding.runtimeSymbol, "certificate runtimeSymbol");
        if (symbol.startsWith("inline:")) {
            if (binding.declaration !== "") {
                issues.push(`inline runtime symbol ${symbol} must not record a declaration`);
            }
            continue;
        }
        if (symbol.startsWith("helper:")) {
            if (binding.declaration === "") {
                issues.push(`helper runtime symbol ${symbol} must record its declaration`);
            }
            continue;
        }
        issues.push(`runtime symbol ${symbol} carries neither the inline: nor the helper: tag`);
    }
    if (certificates.length === 0) {
        issues.push("the generated package records no runtime certificate");
    }

    // The one binding that makes the generated bytes meaningful: the manifest's recorded digest
    // of the Lean source it lowered. `source:<module>` is the compiler's own identity for that
    // file, and its digest is the file's plain sha256.
    const sourceInput = semantic.inputs.find((input) => input.identity === leanSourceIdentity);
    if (sourceInput === undefined) {
        issues.push(`manifest inputs omit ${leanSourceIdentity}`);
    } else {
        const committed = `sha256:${await fileSha256(leanSource)}`;
        if (sourceInput.sha256 !== committed) {
            issues.push(
                `manifest Lean source digest ${sourceInput.sha256} does not match committed formal/AgentCore/Facets/Enforcement.lean (${committed})`
            );
        }
    }
}

/** One generated module: header bytes and body digest, with the file set exactly as recorded. */
async function verifyModule(module) {
    const record = assertObject(module, "manifest module");
    assertExactKeys(
        record,
        ["path", "leanModule", "imports", "declarations", "bodySha256", "sourceMapSha256"],
        `manifest module ${record.path ?? "?"}`
    );
    const path = assertString(record.path, "module path");
    if (record.leanModule !== entryModule) {
        issues.push(`module ${path} lowers ${record.leanModule}, not ${entryModule}`);
    }
    const bodyPath = join(generatedRoot, path);
    const mapPath = `${bodyPath}.map`;
    const body = await readFile(bodyPath, "utf8").catch(() => {
        issues.push(`generated module is absent: src/facets/generated/${path}`);
        return undefined;
    });
    const sourceMap = await readFile(mapPath, "utf8").catch(() => {
        issues.push(`generated source map is absent: src/facets/generated/${path}.map`);
        return undefined;
    });
    if (body === undefined || sourceMap === undefined) return;
    if (sha256Text(body.slice(headerLength(manifest, path))) !== record.bodySha256) {
        issues.push(`generated module body does not hash to its manifest digest: ${path}`);
    }
    if (sha256Text(sourceMap) !== record.sourceMapSha256) {
        issues.push(`generated source map does not hash to its manifest digest: ${path}`);
    }
    // The header the semantic identity itself produces must be the committed file's own first
    // bytes, so a manifest edited to bless new body bytes cannot keep an old header honest.
    if (!body.startsWith(provenanceHeader(manifest, path))) {
        issues.push(`generated provenance header does not match its manifest: ${path}`);
    }
}

/**
 * The one TSLean invocation this gate knows. Out-dir depth matters: the manifest records
 * `leanProjectPath` and the source map records a relative source path, so the compiler must
 * write into `src/facets/generated` itself — copying output from a scratch directory would
 * bind the manifest to the scratch tree's geometry instead of the tree it lives in.
 */
function runCompiler(outputDirectory) {
    const root = process.env.TSLEAN_ROOT ?? "/home/mrwhite0racle/tslean";
    const compiler = join(root, "dist/cli.js");
    const result = spawnSync(
        process.execPath,
        [
            compiler,
            "lean-to-ts",
            "--project-root",
            resolve(packageDir, "formal"),
            "--module",
            entryModule,
            "--source",
            leanSource,
            "--declaration",
            "AgentCore.Facets.enforcementFloor",
            "--declaration",
            "AgentCore.Facets.claimHonorsEnforcementFloor",
            "--out-dir",
            outputDirectory,
            "--manifest",
            join(outputDirectory, "tslean.manifest.json")
        ],
        { cwd: packageDir, encoding: "utf8", timeout: 600_000 }
    );
    return { root, result };
}

/**
 * `--regenerate-into-tree`: the write mode. Runs the real compiler directly into
 * `src/facets/generated`, replacing whatever bytes are there (a formatter's rewrite, a
 * hand edit, a partial landing) with the compiler's own. The gate's read of the manifest
 * happens before the write, so this mode always restores exactly the artifact the
 * committed Lean source lowers to.
 */
async function regenerateIntoTree() {
    const { root, result } = runCompiler(generatedRoot);
    if (result.error !== undefined || result.status !== 0) {
        issues.push(
            `regeneration failed under TSLEAN_ROOT=${root}: ${result.stderr ?? String(result.error)}`
        );
        return;
    }
    summary.regenerated = true;
    await verifyCommittedIntegrity();
}

/**
 * `--regenerate`: run the real compiler against the committed Lean source into a scratch
 * directory, then compare every emitted file byte for byte. The compiler's own `--check`
 * mode compares digests; bytes are stronger here because the committed artifact is the
 * product, and a regeneration that produced semantically-equal but differently-laid-out
 * bytes would still be a change the repository never accepted.
 */
async function regenerateAndCompare() {
    const scratch = join(reportRoot, "tslean-regeneration");
    const { root, result } = runCompiler(scratch);
    if (result.error !== undefined || result.status !== 0) {
        issues.push(
            `regeneration failed under TSLEAN_ROOT=${root}: ${result.stderr ?? String(result.error)}`
        );
        return;
    }
    await verifyCommittedIntegrity();
    summary.regenerated = true;
    const emitted = assertArray(manifest.semantic.modules, "manifest modules").map(
        (module) => module.path
    );
    for (const path of [...emitted, "tslean.manifest.json"]) {
        const committed = await readFile(join(generatedRoot, path)).catch(() => {
            issues.push(`regenerated a file the package does not hold: ${path}`);
            return undefined;
        });
        const fresh = await readFile(join(scratch, path)).catch(() => {
            issues.push(`regeneration omitted a committed file: ${path}`);
            return undefined;
        });
        if (committed !== undefined && fresh !== undefined) {
            if (Buffer.compare(committed, fresh) !== 0) {
                issues.push(`regeneration is not byte-identical to the committed ${path}`);
            }
        }
    }
}

/** The canonical semantic identity, whose sha256 is the header's `Semantic identity` line. */
function semanticIdentity(value) {
    const semantic = assertObject(value.semantic, "manifest semantic identity");
    for (const field of semanticIdentityFields) {
        if (!(field in semantic)) {
            throw new TypeError(`manifest semantic identity omits ${field}`);
        }
    }
    return semantic;
}

/** The exact header lines tslean's provenanceHeader emits, for `startsWith`-level equality. */
function provenanceHeader(value, path) {
    const semantic = value.semantic;
    const module = semantic.modules.find((candidate) => candidate.path === path);
    if (module === undefined) throw new TypeError(`manifest is missing module ${path}`);
    const lines = [
        "/*",
        " * Generated by TSLean from kernel-checked Lean declarations.",
        ` * Fragment: ${semantic.fragmentVersion}`,
        ` * Lean module: ${module.leanModule}`,
        ` * Generated module: ${module.path}`,
        ` * Package entry module: ${semantic.entryModule}`,
        ` * Semantic identity: ${sha256Text(canonicalSemanticIdentity(semantic))}`,
        ` * Input closure: ${semantic.inputClosureSha256}`,
        ` * Semantic IR: ${semantic.semanticIrSha256}`,
        ` * Generated module body: ${module.bodySha256}`,
        ` * Generated package body: ${semantic.generatedBodySha256}`,
        ` * Lean toolchain: ${semantic.leanToolchain.identity}`,
        ` * Lean: ${semantic.leanToolchain.leanVersion}`,
        ` * Lake: ${semantic.leanToolchain.lakeVersion}`,
        ` * Runtime certificates: ${sha256Text(JSON.stringify(semantic.certificates))}`,
        " * Environment attestation: recorded in the manifest sidecar; it does not affect these bytes.",
        " * Evidence boundary: Lean certificates prove source-to-model refinement conditionally; engine conformance remains an explicit obligation.",
        " */",
        ""
    ];
    return lines.join("\n");
}

function headerLength(value, path) {
    return provenanceHeader(value, path).length;
}

/** The canonical JSON of the identity fields, key order and number formatting included. */
function canonicalSemanticIdentity(semantic) {
    const canonical = {
        fragmentVersion: semantic.fragmentVersion,
        entryModule: semantic.entryModule,
        leanProjectPath: semantic.leanProjectPath,
        declarations: [...semantic.declarations],
        leanToolchain: {
            identity: semantic.leanToolchain.identity,
            leanVersion: semantic.leanToolchain.leanVersion,
            lakeVersion: semantic.leanToolchain.lakeVersion
        },
        modules: semantic.modules.map((module) => ({
            path: module.path,
            leanModule: module.leanModule,
            imports: module.imports,
            declarations: module.declarations.map((declaration) => ({
                declaration: declaration.declaration,
                emitted: declaration.emitted,
                line: declaration.line,
                span: {
                    source: declaration.span.source,
                    startLine: declaration.span.startLine,
                    startColumn: declaration.span.startColumn,
                    endLine: declaration.span.endLine,
                    endColumn: declaration.span.endColumn
                }
            })),
            bodySha256: module.bodySha256,
            sourceMapSha256: module.sourceMapSha256
        })),
        closure: semantic.closure.map((entry) => ({
            declaration: entry.declaration,
            module: entry.module,
            role: entry.role,
            reason: entry.reason
        })),
        inputs: semantic.inputs,
        inputClosureSha256: semantic.inputClosureSha256,
        semanticIrSha256: semantic.semanticIrSha256,
        certificates: semantic.certificates.map((certificate) => ({
            opcode: certificate.opcode,
            runtimeSymbol: certificate.runtimeSymbol,
            declaration: certificate.declaration,
            runtimeBodySha256: certificate.runtimeBodySha256
        })),
        generatedBodySha256: semantic.generatedBodySha256
    };
    return JSON.stringify(canonical);
}

/** One digest over every generated module body, in path order: the package's own identity. */
function generatedPackageDigest(modules) {
    return sha256Text(JSON.stringify(modules.map((module) => [module.path, module.bodySha256])));
}

function sha256Text(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseArguments(args) {
    let stage = "building";
    let regenerate = false;
    let write = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--regenerate") regenerate = true;
        else if (argument === "--regenerate-into-tree") write = true;
        else throw new TypeError(`Unknown tslean-consumer argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") {
        throw new TypeError(`Unknown quality stage ${stage}`);
    }
    return { stage, regenerate, write };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
