import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedBuiltInAxioms, extractAxiomDesignations } from "./formal-policy.mjs";
import { isJsonObject, isNonEmptyString, parseCanonicalJson } from "./quality/project.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const formalRoot = join(packageRoot, "formal");
const axiomsPath = join(formalRoot, "AgentCore", "Axioms.lean");
const toolchainPath = join(formalRoot, "lean-toolchain");
const lakeManifestPath = join(formalRoot, "lake-manifest.json");
const lockPath = join(packageRoot, "artifacts", "normative.lock");
const lakeCommand = process.env.LEAN_LAKE?.trim() || "lake";
const schemaVersion = 2;
const formalModuleRoot = "AgentCore";
const moduleComponentPattern = /^[A-Za-z][A-Za-z0-9_']*$/u;

function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function runLake(args, label) {
    const result = spawnSync(lakeCommand, args, {
        cwd: formalRoot,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024
    });
    if (result.error !== undefined) {
        throw new TypeError(
            `check:normative could not run ${lakeCommand}: ${result.error.message}`
        );
    }
    if (result.status !== 0) {
        const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
            .filter(Boolean)
            .join("\n");
        throw new TypeError(`${output}${output ? "\n" : ""}check:normative ${label} failed`);
    }
    return result.stdout;
}

function strings(value, location) {
    if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
        throw new TypeError(`${location} must be an array of nonempty strings`);
    }
    return value;
}

function objectArray(value, location) {
    if (!Array.isArray(value) || !value.every(isJsonObject)) {
        throw new TypeError(`${location} must be an array of objects`);
    }
    return value;
}

function stringField(value, field, location) {
    const fieldValue = value[field];
    if (!isNonEmptyString(fieldValue)) {
        throw new TypeError(`${location}.${field} must be a nonempty string`);
    }
    return fieldValue;
}

export const structuralPackageKeys = Object.freeze([
    "auditedModules",
    "allowedAxioms",
    "declarations",
    "designations",
    "encodingVersion"
]);

export function parseStructuralPackageLine(line, location) {
    let value;
    try {
        value = parseCanonicalJson(line, location);
    } catch (error) {
        throw new TypeError(
            `${location} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isJsonObject(value)) {
        throw new TypeError(`${location} must be an object`);
    }
    const expected = [...structuralPackageKeys].sort();
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new TypeError(
            `${location} top-level key set must be exactly ${expected.join(", ")}`
        );
    }
    strings(value.auditedModules, `${location}.auditedModules`);
    strings(value.allowedAxioms, `${location}.allowedAxioms`);
    objectArray(value.designations, `${location}.designations`);
    objectArray(value.declarations, `${location}.declarations`);
    stringField(value, "encodingVersion", location);
    return value;
}


export function structuralPackage(source) {
    const candidates = [];
    let lastError;
    let candidateStarted = false;
    for (const candidate of source.split(/\r?\n/u)) {
        if (!candidate.startsWith('{"')) continue;
        candidateStarted = true;
        try {
            candidates.push(
                parseStructuralPackageLine(candidate, "Lean normative structural package")
            );
        } catch (error) {
            lastError = error;
        }
    }
    if (candidates.length !== 1) {
        if (candidates.length === 0 && lastError !== undefined) throw lastError;
        if (!candidateStarted) {
            throw new TypeError("Lean emitted no normative structural package line");
        }
        throw new TypeError(
            `Lean emitted ${candidates.length} normative structural packages; expected exactly one`
        );
    }
    return candidates[0];
}

function dependencyIdentity(value, index) {
    if (!isJsonObject(value)) {
        throw new TypeError(`lake-manifest.json packages[${index}] must be an object`);
    }
    return {
        entrySha256: sha256(JSON.stringify(value)),
        name: stringField(value, "name", `lake-manifest.json packages[${index}]`)
    };
}

function readPins() {
    const toolchainSource = readFileSync(toolchainPath, "utf8");
    const toolchain = toolchainSource.trim();
    if (toolchain.length === 0 || toolchainSource !== `${toolchain}\n`) {
        throw new TypeError(
            "formal/lean-toolchain must contain one newline-terminated toolchain pin"
        );
    }
    const manifestSource = readFileSync(lakeManifestPath, "utf8");
    const manifest = parseCanonicalJson(manifestSource, "formal/lake-manifest.json");
    if (!isJsonObject(manifest)) throw new TypeError("formal/lake-manifest.json must be an object");
    return {
        lakeManifest: {
            dependencies: objectArray(manifest.packages, "lake-manifest.json packages")
                .map(dependencyIdentity)
                .sort((left, right) => compareCodeUnits(left.name, right.name)),
            manifestSha256: sha256(JSON.stringify(manifest)),
            manifestVersion: stringField(manifest, "version", "lake-manifest.json"),
            packageName: stringField(manifest, "name", "lake-manifest.json")
        },
        leanToolchain: {
            fileSha256: sha256(toolchainSource),
            identity: toolchain
        }
    };
}

function collectFormalModules(directory, modulePrefix) {
    const modules = [];
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            throw new TypeError(
                `formal source tree contains symbolic link ${join(directory, entry.name)}`
            );
        }
        if (entry.isDirectory()) {
            if (!moduleComponentPattern.test(entry.name)) {
                throw new TypeError(`invalid Lean module directory ${join(directory, entry.name)}`);
            }
            modules.push(
                ...collectFormalModules(
                    join(directory, entry.name),
                    `${modulePrefix}.${entry.name}`
                )
            );
        } else if (entry.isFile() && entry.name.endsWith(".lean")) {
            const component = entry.name.slice(0, -".lean".length);
            if (!moduleComponentPattern.test(component)) {
                throw new TypeError(`invalid Lean module source ${join(directory, entry.name)}`);
            }
            modules.push(`${modulePrefix}.${component}`);
        } else if (!entry.isFile()) {
            throw new TypeError(
                `formal source tree contains unsupported entry ${join(directory, entry.name)}`
            );
        }
    }
    return modules;
}

function auditedFormalModules() {
    const rootSource = join(formalRoot, `${formalModuleRoot}.lean`);
    if (!lstatSync(rootSource).isFile()) {
        throw new TypeError(`${rootSource} must be a regular Lean source file`);
    }
    const modules = [
        formalModuleRoot,
        ...collectFormalModules(join(formalRoot, formalModuleRoot), formalModuleRoot)
    ].sort();
    if (new Set(modules).size !== modules.length) {
        throw new TypeError("formal source tree resolves to duplicate Lean modules");
    }
    return modules;
}

function driverSource(designations, auditedModules) {
    const tokens = [
        ...allowedBuiltInAxioms.map((name) => `allowed:${name}`),
        ...designations.map(({ kind, name }) => `${kind}:${name}`)
    ];
    return [
        ...auditedModules.map((moduleName) => `import ${moduleName}`),
        "",
        `#agent_core_normative ${tokens.map((token) => JSON.stringify(token)).join(" ")}`,
        ""
    ].join("\n");
}

function validateAndHash(raw, expectedDesignations, expectedModules) {
    const encodingVersion = stringField(raw, "encodingVersion", "structural package");
    const auditedModules = strings(raw.auditedModules, "structural package auditedModules");
    if (new Set(auditedModules).size !== auditedModules.length) {
        throw new TypeError("Lean structural package contains duplicate audited modules");
    }
    if (JSON.stringify([...auditedModules].sort()) !== JSON.stringify(expectedModules)) {
        throw new TypeError(
            "Lean structural package audited module closure does not match formal sources"
        );
    }
    const emittedAllowlist = strings(raw.allowedAxioms, "structural package allowedAxioms");
    if (JSON.stringify(emittedAllowlist) !== JSON.stringify(allowedBuiltInAxioms)) {
        throw new TypeError("Lean structural package axiom allowlist does not match formal policy");
    }

    const declarations = new Map();
    for (const [index, entry] of objectArray(
        raw.declarations,
        "structural package declarations"
    ).entries()) {
        const name = stringField(entry, "name", `structural package declarations[${index}]`);
        if (!("structure" in entry)) {
            throw new TypeError(`structural package declarations[${index}].structure is absent`);
        }
        if (declarations.has(name)) {
            throw new TypeError(`structural package contains duplicate declaration ${name}`);
        }
        declarations.set(name, sha256(JSON.stringify(entry.structure)));
    }

    const emittedDesignations = objectArray(raw.designations, "structural package designations");
    if (emittedDesignations.length !== expectedDesignations.length) {
        throw new TypeError("Lean structural package designation count does not match Axioms.lean");
    }
    const observedAxioms = new Set();
    const referencedDeclarations = new Set();
    const designations = emittedDesignations.map((entry, index) => {
        const location = `structural package designations[${index}]`;
        const expected = expectedDesignations[index];
        const kind = stringField(entry, "kind", location);
        const name = stringField(entry, "name", location);
        if (kind !== expected.kind || name !== expected.name) {
            throw new TypeError(`${location} does not match its Axioms.lean designation`);
        }
        if (!("type" in entry)) throw new TypeError(`${location}.type is absent`);
        const axioms = [...strings(entry.axioms, `${location}.axioms`)].sort();
        for (const axiom of axioms) observedAxioms.add(axiom);
        const closureNames = [...strings(entry.closure, `${location}.closure`)].sort();
        if (new Set(closureNames).size !== closureNames.length) {
            throw new TypeError(`${location}.closure contains duplicate declarations`);
        }
        for (const declarationName of closureNames) {
            const declarationHash = declarations.get(declarationName);
            if (declarationHash === undefined) {
                throw new TypeError(`${location}.closure references absent ${declarationName}`);
            }
            referencedDeclarations.add(declarationName);
        }
        return {
            axioms,
            kind,
            name,
            semanticClosureNames: closureNames,
            typeSha256: sha256(JSON.stringify(entry.type))
        };
    });

    const expectedAxioms = [...allowedBuiltInAxioms].sort();
    if (JSON.stringify([...observedAxioms].sort()) !== JSON.stringify(expectedAxioms)) {
        throw new TypeError("observed designated axiom union does not exactly match formal policy");
    }
    const unreferenced = [...declarations.keys()].filter(
        (name) => !referencedDeclarations.has(name)
    );
    if (unreferenced.length > 0) {
        throw new TypeError(
            `structural package contains unreferenced declarations: ${unreferenced.join(", ")}`
        );
    }
    const declarationEntries = [...declarations]
        .map(([name, declarationSha256]) => ({ name, sha256: declarationSha256 }))
        .sort((left, right) => compareCodeUnits(left.name, right.name));
    const semanticClosures = new Map();
    const normalizedDesignations = designations.map(({ semanticClosureNames, ...designation }) => {
        const closureEntries = semanticClosureNames.map((name) => ({
            name,
            sha256: declarations.get(name)
        }));
        const source = JSON.stringify(closureEntries);
        const closureSha256 = sha256(source);
        const existing = semanticClosures.get(closureSha256);
        if (existing !== undefined && existing.source !== source) {
            throw new TypeError(`semantic closure hash collision at ${closureSha256}`);
        }
        semanticClosures.set(closureSha256, {
            declarations: semanticClosureNames,
            source
        });
        return { ...designation, semanticClosureSha256: closureSha256 };
    });
    return {
        auditedModules: [...auditedModules].sort(),
        declarations: declarationEntries,
        designations: normalizedDesignations,
        encodingVersion,
        semanticClosures: [...semanticClosures]
            .map(([closureSha256, closure]) => ({
                declarations: closure.declarations,
                sha256: closureSha256
            }))
            .sort((left, right) => compareCodeUnits(left.sha256, right.sha256))
    };
}

export function generateNormativeLock() {
    const axiomsSource = readFileSync(axiomsPath, "utf8");
    const designations = extractAxiomDesignations(axiomsSource);
    const auditedModules = auditedFormalModules();
    runLake(["build", ...auditedModules], "Lean build");
    const directory = mkdtempSync(join(tmpdir(), "agent-core-normative-driver-"));
    const driverPath = join(directory, "NormativeDriver.lean");
    try {
        writeFileSync(driverPath, driverSource(designations, auditedModules), "utf8");
        const encoded = structuralPackage(
            runLake(["env", "lean", driverPath], "structural export")
        );
        const normalized = validateAndHash(encoded, designations, auditedModules);
        return canonicalJson({
            allowedAxioms: [...allowedBuiltInAxioms],
            auditedModules: normalized.auditedModules,
            declarations: normalized.declarations,
            designations: normalized.designations,
            encodingVersion: normalized.encodingVersion,
            pins: readPins(),
            schemaVersion,
            semanticClosures: normalized.semanticClosures
        });
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
}

export function checkNormativeLock({ update = false } = {}) {
    const generated = generateNormativeLock();
    if (update) {
        writeFileSync(lockPath, generated, "utf8");
        console.log("normative.lock generated");
        return;
    }
    let committed;
    try {
        committed = readFileSync(lockPath, "utf8");
    } catch {
        throw new TypeError("artifacts/normative.lock is absent; rerun with --update");
    }
    if (committed !== generated) {
        throw new TypeError("artifacts/normative.lock is stale; inspect and rerun with --update");
    }
    console.log("normative.lock verified");
}

function main() {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== "--update") || args.length > 1) {
        throw new TypeError("usage: check-normative.mjs [--update]");
    }
    checkNormativeLock({ update: args[0] === "--update" });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
