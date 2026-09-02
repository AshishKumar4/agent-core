// TSLean consumer gate: every generated package is verified against its own manifest, offline.
//
// A generated package is a directory of compiler output — one Lean entry module, its Lean import
// closure, and the TypeScript those modules lower to — whose bytes are the product. The handwritten
// twins are gone, so nothing downstream re-derives them: the floor suites import the generated
// modules and the contract tests prove them against the SPEC's own tables. What nothing else can
// check is whether the committed bytes are still the ones the compiler produced for the committed
// Lean source, and that is this gate's whole job.
//
// `artifacts/quality/tslean-packages.json` is the catalog: one row per package, naming its entry
// module, the Lean sources it lowers, the tree its bytes live in, the declaration roots the
// compiler was asked for, and the exact export surface consumers may import. The catalog is the
// only list — a generated tree with no row fails, and a row with no tree fails, so a package
// cannot be added, moved, or quietly retired without passing through it.
//
// Default mode reads only committed bytes: every generated file hashes to the digests its manifest
// records, every provenance header is the one that manifest produces, every Lean source hashes to
// the digest the manifest recorded for it, and every export the catalog promises is present in the
// bytes. `--regenerate` additionally runs the real compiler into a scratch tree and compares byte
// for byte; `--regenerate-into-tree` runs it directly into the committed tree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { hasModifier, sourceFiles } from "./compiler.mjs";
import {
    assertArray,
    assertExactKeys,
    assertObject,
    assertString,
    assertUniqueStrings,
    collectFiles,
    fileSha256,
    parseCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogPath = resolve(packageDir, "artifacts/quality/tslean-packages.json");
const leanProjectRoot = resolve(packageDir, "formal");
const sourceRoot = resolve(packageDir, "src");
const prettierIgnorePath = resolve(packageDir, "../../.prettierignore");
const manifestName = "tslean.manifest.json";
// The compiler's own runtime module carries no Lean module of its own, which is how the manifest
// spells "this file is the package's shared runtime" rather than a lowering of a source file.
const runtimeModuleMarker = "";
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
const catalog = decodeCatalog(parseCanonicalJson(await readFile(catalogPath, "utf8")));
const issues = [];
const summary = { packages: 0, modules: 0, files: 0, certificates: 0, regenerated: 0 };

const selected = catalog.filter(
    (entry) => options.package === undefined || entry.id === options.package
);
if (selected.length === 0) {
    throw new TypeError(`no catalogued TSLean package is named ${options.package}`);
}

for (const entry of selected) {
    if (options.write) await regenerateIntoTree(entry);
    else if (options.regenerate) await regenerateAndCompare(entry);
    else await verifyCommittedIntegrity(entry);
}
// Catalog and tree are checked against each other whichever mode ran: a package the catalog does
// not name is a package no gate verifies, and the fix is a row, never a deletion from the tree.
await verifyCatalogCoversTree();
await verifyFormattingIsExempted();

await writeCanonicalJson(join(reportRoot, "nodes", "tslean-consumer.json"), {
    edition: "1.0.0",
    stage: options.stage,
    ...summary,
    complete: issues.length === 0
});

if (issues.length > 0) {
    throw new TypeError(
        [
            "generated TSLean packages are not intact:",
            ...issues.map((issue) => `  ${issue}`),
            // The most common way this gate goes red is a formatter rewriting bytes a manifest
            // already binds. A generated package is compiler output, not styled source:
            // .prettierignore must carry every catalogued root, and the fix is to regenerate,
            // never to re-bless the manifest.
            "restore the compiler bytes with: node scripts/quality/tslean-consumer.mjs --regenerate-into-tree (or the TSLean CLI directly); .prettierignore must cover every catalogued generated root"
        ].join("\n")
    );
}
console.log(
    `tslean consumer verified: ${summary.files} generated file(s) over ${summary.modules} module(s) ` +
        `in ${summary.packages} package(s), ${summary.certificates} certificate(s)` +
        (summary.regenerated > 0
            ? `, ${summary.regenerated} byte-identical to a fresh regeneration`
            : "")
);

/**
 * Offline integrity for one package: the committed bytes must be the ones its manifest describes,
 * the manifest must describe the committed Lean sources, and the catalog must describe the
 * manifest. Every check reads a digest the compiler recorded; none re-derives the lowering.
 */
async function verifyCommittedIntegrity(entry) {
    summary.packages += 1;
    const manifest = parseCanonicalJson(await readFile(entry.manifestPath, "utf8"));
    const semantic = semanticIdentity(manifest, entry);
    const modules = assertArray(semantic.modules, `${entry.id} manifest modules`);
    if (semantic.entryModule !== entry.entryModule) {
        issues.push(
            `${entry.id}: manifest entry module is ${semantic.entryModule}, not ${entry.entryModule}`
        );
    }
    // The recorded project path is the geometry the source maps and the Lean closure were resolved
    // against. A package copied from another tree keeps its old geometry, and that is exactly the
    // state in which a manifest describes bytes nobody can regenerate here.
    const expectedProjectPath = posix(relative(entry.generatedRoot, leanProjectRoot));
    if (semantic.leanProjectPath !== expectedProjectPath) {
        issues.push(
            `${entry.id}: manifest lean project path is ${semantic.leanProjectPath}, not ${expectedProjectPath}`
        );
    }
    assertUniqueStrings(semantic.declarations, `${entry.id} manifest declaration roots`);
    const declared = [...semantic.declarations].sort();
    if (
        declared.length !== entry.declarations.length ||
        declared.some((declaration, index) => declaration !== entry.declarations[index])
    ) {
        issues.push(
            `${entry.id}: manifest declaration roots are [${declared.join(", ")}], not the catalogued roots [${entry.declarations.join(", ")}]`
        );
    }

    // Every module the manifest names must exist, hash to its recorded body and source map
    // digests, and carry the exact provenance header the semantic identity produces — so no single
    // file can be refreshed in isolation.
    for (const module of modules) {
        await verifyModule(entry, manifest, module);
    }
    if (generatedPackageDigest(modules) !== semantic.generatedBodySha256) {
        issues.push(`${entry.id}: generated package body digest does not match its module bodies`);
    }
    // ...and no extra file can hide beside them: the manifest's file set is the tree's file set.
    await verifyNoUnrecordedFiles(entry, modules);
    verifyExportSurface(entry, modules);

    // The runtime certificates the package spends: an `inline:` form is the registry's one emitted
    // form (hash of the exact source text), a `helper:` form names the declaration the allocator
    // resolved. Both name a theorem the registry certifies; a row that names neither form, or an
    // inline row claiming a declaration, is a defect the compiler would have refused.
    const certificates = assertArray(semantic.certificates, `${entry.id} manifest certificates`);
    summary.certificates += certificates.length;
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
                issues.push(
                    `${entry.id}: inline runtime symbol ${symbol} must not record a declaration`
                );
            }
            continue;
        }
        if (symbol.startsWith("helper:")) {
            if (binding.declaration === "") {
                issues.push(
                    `${entry.id}: helper runtime symbol ${symbol} must record its declaration`
                );
            }
            continue;
        }
        issues.push(
            `${entry.id}: runtime symbol ${symbol} carries neither the inline: nor the helper: tag`
        );
    }
    // A package spends exactly the opcodes its lowering reaches. Requiring the set the catalog
    // records — rather than merely requiring one — catches drift in both directions: an opcode
    // that appears because a lowering changed, and one that disappears because a declaration
    // stopped being reached. A package that spends none records none, which is the honest
    // answer for a lowering that is all matches and constructors.
    const opcodes = certificates.map((certificate) => certificate.opcode).sort();
    if (
        opcodes.length !== entry.certificates.length ||
        opcodes.some((opcode, index) => opcode !== entry.certificates[index])
    ) {
        issues.push(
            `${entry.id}: spends runtime opcodes [${opcodes.join(", ")}], not the catalogued [${entry.certificates.join(", ")}]`
        );
    }

    // The bindings that make the generated bytes meaningful: the manifest's recorded digest of
    // every Lean source it lowered. `source:<module>` is the compiler's own identity for such a
    // file, and its digest is the file's plain sha256.
    await verifyLeanSources(entry, semantic, modules);
}

/** One generated module: header bytes and body digest, with the file set exactly as recorded. */
async function verifyModule(entry, manifest, module) {
    const record = assertObject(module, `${entry.id} manifest module`);
    assertExactKeys(
        record,
        ["path", "leanModule", "imports", "declarations", "bodySha256", "sourceMapSha256"],
        `manifest module ${record.path ?? "?"}`
    );
    const path = assertString(record.path, "module path");
    summary.modules += 1;
    const bodyPath = join(entry.generatedRoot, path);
    const mapPath = `${bodyPath}.map`;
    const body = await readFile(bodyPath, "utf8").catch(() => {
        issues.push(`${entry.id}: generated module is absent: ${entry.root}/${path}`);
        return undefined;
    });
    const sourceMap = await readFile(mapPath, "utf8").catch(() => {
        issues.push(`${entry.id}: generated source map is absent: ${entry.root}/${path}.map`);
        return undefined;
    });
    if (body === undefined || sourceMap === undefined) return;
    summary.files += 2;
    if (sha256Text(body.slice(headerLength(manifest, path))) !== record.bodySha256) {
        issues.push(
            `${entry.id}: generated module body does not hash to its manifest digest: ${path}`
        );
    }
    if (sha256Text(sourceMap) !== record.sourceMapSha256) {
        issues.push(
            `${entry.id}: generated source map does not hash to its manifest digest: ${path}`
        );
    }
    // The header the semantic identity itself produces must be the committed file's own first
    // bytes, so a manifest edited to bless new body bytes cannot keep an old header honest.
    if (!body.startsWith(provenanceHeader(manifest, path))) {
        issues.push(
            `${entry.id}: generated provenance header does not match its manifest: ${path}`
        );
    }
}

/**
 * The package tree holds exactly the manifest, the modules it names, and their source maps. The
 * compiler refuses to publish into a tree holding anything else; at rest, an added file is how a
 * hand-written module hides inside compiler output and gets imported as though it were proved.
 */
async function verifyNoUnrecordedFiles(entry, modules) {
    const expected = new Set([entry.manifestPath]);
    for (const module of modules) {
        const bodyPath = join(entry.generatedRoot, module.path);
        expected.add(bodyPath);
        expected.add(`${bodyPath}.map`);
    }
    for (const path of await collectFiles(entry.generatedRoot)) {
        if (!expected.has(path)) {
            issues.push(
                `${entry.id}: the generated tree holds a file its manifest does not name: ${entry.root}/${posix(relative(entry.generatedRoot, path))}`
            );
        }
    }
}

/**
 * Every Lean module the package lowered is the committed one. The compiler records one
 * `source:<module>` input per source file it read from the target project; the modules it emitted
 * name exactly those Lean modules, so the two lists are checked against each other rather than
 * against a hand-kept list that could omit the module a defect was introduced in.
 */
async function verifyLeanSources(entry, semantic, modules) {
    const inputs = new Map(
        assertArray(semantic.inputs, `${entry.id} manifest inputs`)
            .filter((input) => assertString(input.identity, "input identity").startsWith("source:"))
            .map((input) => [input.identity.slice("source:".length), input.sha256])
    );
    for (const module of modules) {
        if (module.leanModule === runtimeModuleMarker) continue;
        const recorded = inputs.get(module.leanModule);
        const relativeSource = `formal/${module.leanModule.split(".").join("/")}.lean`;
        if (recorded === undefined) {
            issues.push(`${entry.id}: manifest inputs omit source:${module.leanModule}`);
            continue;
        }
        const committed = await fileSha256(resolve(packageDir, relativeSource)).then(
            (digest) => `sha256:${digest}`,
            () => undefined
        );
        if (committed === undefined) {
            issues.push(`${entry.id}: manifest lowers ${relativeSource}, which is not committed`);
            continue;
        }
        if (recorded !== committed) {
            issues.push(
                `${entry.id}: manifest Lean source digest ${recorded} does not match committed ${relativeSource} (${committed})`
            );
        }
    }
}

/**
 * The export surface consumers may import. The bytes are already digest-bound, so this is not a
 * second integrity check: it is the substitutability contract. A regeneration that renames or drops
 * an export produces a perfectly self-consistent package that no longer serves its consumers, and
 * the catalog row is the only place that difference is visible before the type checker finds it in
 * whichever module happened to import the missing name.
 */
function verifyExportSurface(entry, modules) {
    const emitted = new Map(modules.map((module) => [module.path, module.declarations]));
    // Every declaration root the catalog asked the compiler for reached the package. A root is
    // not always a module export — a root on a value object emits as a method — so this is
    // checked against what the manifest records as emitted, and the export list below is
    // checked against the bytes.
    const roots = new Set(
        [...emitted.values()].flatMap((declarations) =>
            declarations.map((declaration) => declaration.declaration)
        )
    );
    for (const declaration of entry.declarations) {
        if (!roots.has(declaration)) {
            issues.push(
                `${entry.id}: no generated module emits the catalogued root ${declaration}`
            );
        }
    }
    for (const path of Object.keys(entry.surface)) {
        if (!emitted.has(path)) {
            issues.push(
                `${entry.id}: catalogued surface names a module the manifest omits: ${path}`
            );
        }
    }
    const parsed = new Map(
        sourceFiles([...emitted.keys()].map((path) => join(entry.generatedRoot, path)))
    );
    for (const path of emitted.keys()) {
        const expected = entry.surface[path];
        if (expected === undefined) {
            issues.push(`${entry.id}: the catalog declares no export surface for ${path}`);
            continue;
        }
        const source = parsed.get(join(entry.generatedRoot, path));
        if (source === undefined) {
            issues.push(`${entry.id}: generated module could not be read as TypeScript: ${path}`);
            continue;
        }
        const exported = exportedNames(source);
        const surface = [...exported].sort();
        if (
            surface.length !== expected.length ||
            surface.some((name, index) => name !== expected[index])
        ) {
            issues.push(
                `${entry.id}: ${path} exports [${surface.join(", ")}], not the catalogued surface [${expected.join(", ")}]`
            );
        }
    }
}

/** Every name a generated module exports, however it spells the export. */
function exportedNames(source) {
    const names = new Set();
    for (const statement of source.statements) {
        if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                names.add(declaration.name.getText(source));
            }
            continue;
        }
        if (statement.name !== undefined) names.add(statement.name.getText(source));
    }
    return names;
}

/**
 * Every generated package in the tree is catalogued. The manifest file is the marker: the compiler
 * writes exactly one per package root, so finding one outside the catalog means a package is
 * shipping bytes this gate never verified.
 */
async function verifyCatalogCoversTree() {
    const catalogued = new Set(catalog.map((entry) => entry.manifestPath));
    for (const path of await collectFiles(sourceRoot, (file) => file.endsWith(manifestName))) {
        if (!catalogued.has(path)) {
            issues.push(
                `generated package is not catalogued: src/${posix(relative(sourceRoot, dirname(path)))} (add a row to artifacts/quality/tslean-packages.json)`
            );
        }
    }
}

/**
 * A formatter rewriting compiler output breaks every digest in that package's manifest, and the
 * repair is a regeneration rather than a re-blessing. The exemption is therefore part of the
 * package's definition, not a convention: every catalogued root is named in `.prettierignore`.
 */
async function verifyFormattingIsExempted() {
    const ignored = new Set(
        (await readFile(prettierIgnorePath, "utf8"))
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"))
    );
    for (const entry of catalog) {
        const covered = [...ignored].some((pattern) =>
            `${entry.workspaceRoot}/`.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`)
        );
        if (!covered) {
            issues.push(
                `.prettierignore does not cover the generated root ${entry.workspaceRoot}/ (a formatter would break every digest in ${entry.id})`
            );
        }
    }
}

/**
 * The one TSLean invocation this gate knows. Out-dir depth matters: the manifest records
 * `leanProjectPath` and the source maps record relative source paths, so the compiler must write
 * into the package's own root — copying output from a scratch directory would bind the manifest to
 * the scratch tree's geometry instead of the tree it lives in.
 */
function runCompiler(entry, outputDirectory) {
    const root = process.env.TSLEAN_ROOT ?? "/home/mrwhite0racle/tslean";
    const compiler = join(root, "dist/cli.js");
    const result = spawnSync(
        process.execPath,
        [
            compiler,
            "lean-to-ts",
            "--project-root",
            leanProjectRoot,
            "--module",
            entry.entryModule,
            "--source",
            resolve(packageDir, entry.leanSource),
            ...entry.declarations.flatMap((declaration) => ["--declaration", declaration]),
            "--out-dir",
            outputDirectory,
            "--manifest",
            join(outputDirectory, manifestName)
        ],
        { cwd: packageDir, encoding: "utf8", timeout: 1_800_000 }
    );
    return { root, result };
}

/**
 * `--regenerate-into-tree`: the write mode. Runs the real compiler directly into the package's
 * committed root, replacing whatever bytes are there (a formatter's rewrite, a hand edit, a partial
 * landing) with the compiler's own, then verifies the result.
 */
async function regenerateIntoTree(entry) {
    const { root, result } = runCompiler(entry, entry.generatedRoot);
    if (result.error !== undefined || result.status !== 0) {
        issues.push(
            `${entry.id}: regeneration failed under TSLEAN_ROOT=${root}: ${result.stderr ?? String(result.error)}`
        );
        return;
    }
    summary.regenerated += 1;
    await verifyCommittedIntegrity(entry);
}

/**
 * `--regenerate`: run the real compiler against the committed Lean source into a scratch directory,
 * then compare every emitted file byte for byte. The compiler's own `--check` mode compares
 * digests; bytes are stronger here because the committed artifact is the product, and a
 * regeneration that produced semantically-equal but differently-laid-out bytes would still be a
 * change the repository never accepted.
 *
 * The manifest's `leanProjectPath` is the relative path from the emitted root to the Lean
 * project and is part of the semantic identity, so the scratch root must sit at exactly the
 * committed root's depth below the package directory; otherwise every regeneration would
 * differ by geometry alone and the comparison would prove nothing.
 */
async function regenerateAndCompare(entry) {
    const scratch = scratchRootAtCommittedDepth(entry);
    const { root, result } = runCompiler(entry, scratch);
    if (result.error !== undefined || result.status !== 0) {
        issues.push(
            `${entry.id}: regeneration failed under TSLEAN_ROOT=${root}: ${result.stderr ?? String(result.error)}`
        );
        return;
    }
    await verifyCommittedIntegrity(entry);
    summary.regenerated += 1;
    const manifest = parseCanonicalJson(await readFile(entry.manifestPath, "utf8"));
    const emitted = assertArray(manifest.semantic.modules, "manifest modules").flatMap((module) => [
        module.path,
        `${module.path}.map`
    ]);
    for (const path of [...emitted, manifestName]) {
        const committed = await readFile(join(entry.generatedRoot, path)).catch(() => {
            issues.push(`${entry.id}: regenerated a file the package does not hold: ${path}`);
            return undefined;
        });
        const fresh = await readFile(join(scratch, path)).catch(() => {
            issues.push(`${entry.id}: regeneration omitted a committed file: ${path}`);
            return undefined;
        });
        if (
            committed !== undefined &&
            fresh !== undefined &&
            Buffer.compare(committed, fresh) !== 0
        ) {
            issues.push(`${entry.id}: regeneration is not byte-identical to the committed ${path}`);
        }
    }
}

const SCRATCH_BASE = ["reports", "quality", "tslean-regeneration"];

function scratchRootAtCommittedDepth(entry) {
    const committedDepth = relative(packageDir, entry.generatedRoot).split(sep).length;
    const base = [...SCRATCH_BASE, entry.id];
    if (committedDepth < base.length) {
        throw new TypeError(
            `${entry.id}: generated root ${entry.generatedRoot} sits shallower than the ` +
                `regeneration scratch can mirror (${committedDepth} < ${base.length} segments)`
        );
    }
    const padding = Array.from({ length: committedDepth - base.length }, () => "_");
    return join(packageDir, ...base, ...padding);
}

/** The catalog, with every row resolved to the paths the rest of the gate reads. */
function decodeCatalog(value) {
    const document = assertObject(value, "TSLean package catalog");
    assertExactKeys(document, ["edition", "packages"], "TSLean package catalog");
    const rows = assertArray(document.packages, "catalogued TSLean packages");
    if (rows.length === 0) throw new TypeError("the TSLean package catalog names no package");
    const entries = rows.map((row) => {
        const record = assertObject(row, "catalogued TSLean package");
        assertExactKeys(
            record,
            ["id", "entryModule", "leanSource", "root", "declarations", "certificates", "surface"],
            `catalogued TSLean package ${record.id ?? "?"}`
        );
        const id = assertString(record.id, "package id");
        const root = assertString(record.root, "package root");
        const declarations = assertArray(record.declarations, `${id} declaration roots`).map(
            (declaration) => assertString(declaration, `${id} declaration root`)
        );
        assertUniqueStrings(declarations, `${id} declaration roots`);
        const surface = assertObject(record.surface, `${id} export surface`);
        for (const [path, names] of Object.entries(surface)) {
            assertUniqueStrings(assertArray(names, `${id} exports of ${path}`), `${id} exports`);
        }
        const certificates = assertArray(record.certificates, `${id} runtime opcodes`).map(
            (opcode) => assertString(opcode, `${id} runtime opcode`)
        );
        assertUniqueStrings(certificates, `${id} runtime opcodes`);
        return {
            id,
            entryModule: assertString(record.entryModule, `${id} entry module`),
            leanSource: assertString(record.leanSource, `${id} Lean source`),
            root,
            generatedRoot: resolve(packageDir, root),
            manifestPath: resolve(packageDir, root, manifestName),
            workspaceRoot: `packages/agent-core/${root}`,
            declarations: [...declarations].sort(),
            certificates: [...certificates].sort(),
            surface
        };
    });
    assertUniqueStrings(
        entries.map((entry) => entry.id),
        "catalogued package ids"
    );
    assertUniqueStrings(
        entries.map((entry) => entry.root),
        "catalogued package roots"
    );
    assertUniqueStrings(
        entries.map((entry) => entry.entryModule),
        "catalogued package entry modules"
    );
    return entries;
}

/** The canonical semantic identity, whose sha256 is the header's `Semantic identity` line. */
function semanticIdentity(value, entry) {
    const semantic = assertObject(value.semantic, `${entry.id} manifest semantic identity`);
    for (const field of semanticIdentityFields) {
        if (!(field in semantic)) {
            throw new TypeError(`${entry.id} manifest semantic identity omits ${field}`);
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
        ` * Lean module: ${module.leanModule === runtimeModuleMarker ? "(generated package runtime)" : module.leanModule}`,
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

function posix(path) {
    return path.split(sep).join("/");
}

function parseArguments(args) {
    let stage = "building";
    let regenerate = false;
    let write = false;
    let packageId;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--package") packageId = required(args, ++index, argument);
        else if (argument === "--regenerate") regenerate = true;
        else if (argument === "--regenerate-into-tree") write = true;
        else throw new TypeError(`Unknown tslean-consumer argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") {
        throw new TypeError(`Unknown quality stage ${stage}`);
    }
    return { stage, regenerate, write, package: packageId };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
