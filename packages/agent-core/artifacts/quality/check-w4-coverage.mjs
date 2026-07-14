import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const qualityRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(qualityRoot, "../..");
const evidence = await json("w4-coverage.json");
const inventory = await json("w4-source-inventory.json");
const expectedFiles = [...inventory.sources].sort();
requireInventory(expectedFiles);
const currentFiles = [
    ...(await sourceFiles(resolve(packageRoot, "src/definition"))),
    "src/facets/installation.ts",
    "src/protocol/materialization-commands.ts",
    "src/substrates/sqlite/materialization.ts",
    "src/substrates/sqlite/package.ts"
].sort();
if (JSON.stringify(currentFiles) !== JSON.stringify(expectedFiles)) {
    throw new TypeError(
        "Integrated W4 source inventory does not match the current source universe"
    );
}

await rm(resolve(packageRoot, "coverage/w4-integrated"), { recursive: true, force: true });
const run = spawnSync(
    process.execPath,
    [
        resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        resolve(packageRoot, evidence.config),
        "--coverage"
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: "inherit" }
);
if (run.status !== 0) {
    throw new TypeError(`Integrated W4 focused coverage run failed with status ${run.status}`);
}

const final = JSON.parse(await readFile(resolve(packageRoot, evidence.reports.final), "utf8"));
const summary = JSON.parse(await readFile(resolve(packageRoot, evidence.reports.summary), "utf8"));
const reports = new Map(
    Object.entries(final).map(([path, value]) => [
        portable(isAbsolute(path) ? path : resolve(packageRoot, path)),
        value
    ])
);
const reportedFiles = [...reports.keys()].sort();
const missing = expectedFiles.filter((path) => !reports.has(path));
const unknown = reportedFiles.filter((path) => !expectedFiles.includes(path));
if (missing.length > 0 || unknown.length > 0) {
    throw new TypeError(
        `Integrated W4 coverage source mismatch: missing=${missing.join(",")} unknown=${unknown.join(",")}`
    );
}

const sourceSha256 = await digestFiles(expectedFiles);
await rejectSuppressions(expectedFiles);
const counters = emptyCounters();
for (const value of reports.values()) addCounters(counters, rawCounters(value));
const summaryCounters = normalizeSummary(summary.total);
if (JSON.stringify(counters) !== JSON.stringify(summaryCounters)) {
    throw new TypeError("Integrated W4 raw coverage counters disagree with coverage-summary.json");
}
for (const metric of evidence.metrics) {
    const value = counters[metric];
    if (value.total === 0 || 100 * value.covered < evidence.threshold * value.total) {
        throw new TypeError(`Integrated W4 ${metric} coverage is below ${evidence.threshold}%`);
    }
}

if (process.argv.includes("--measure")) {
    console.log(JSON.stringify({ sourceSha256, expectedCounters: counters }, null, 2));
    process.exit(0);
}
if (sourceSha256 !== inventory.sourceSha256) {
    throw new TypeError(`Integrated W4 source hash changed: ${sourceSha256}`);
}
if (JSON.stringify(counters) !== JSON.stringify(evidence.expectedCounters)) {
    throw new TypeError(`Integrated W4 raw coverage counters changed: ${JSON.stringify(counters)}`);
}
console.log(`Integrated W4 coverage verified: ${JSON.stringify(counters)}`);

function requireInventory(paths) {
    if (paths.length !== inventory.sources.length || new Set(paths).size !== paths.length) {
        throw new TypeError("Integrated W4 source inventory must be sorted and unique");
    }
    if (JSON.stringify(paths) !== JSON.stringify(inventory.sources)) {
        throw new TypeError("Integrated W4 source inventory must use canonical order");
    }
    for (const required of [
        "src/definition/installation.ts",
        "src/facets/installation.ts",
        "src/protocol/materialization-commands.ts",
        "src/substrates/sqlite/materialization.ts",
        "src/substrates/sqlite/package.ts"
    ]) {
        if (!paths.includes(required)) {
            throw new TypeError(`Integrated W4 source inventory is missing ${required}`);
        }
    }
}

async function rejectSuppressions(paths) {
    for (const path of paths) {
        const source = await readFile(resolve(packageRoot, path), "utf8");
        if (/(?:c8|istanbul|v8)\s+ignore/iu.test(source)) {
            throw new TypeError(`Coverage suppression is forbidden in ${path}`);
        }
    }
}

async function sourceFiles(root) {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
            result.push(portable(path));
    }
    return result;
}

function rawCounters(value) {
    const statements = Object.values(value.s ?? {});
    const functions = Object.values(value.f ?? {});
    const branches = Object.values(value.b ?? {}).flat();
    const lines = new Map();
    for (const [id, count] of Object.entries(value.s ?? {})) {
        const line = value.statementMap?.[id]?.start?.line;
        if (!Number.isSafeInteger(line)) throw new TypeError("Raw statement has no source line");
        lines.set(line, Math.max(lines.get(line) ?? 0, count));
    }
    return {
        statements: counts(statements),
        branches: counts(branches),
        functions: counts(functions),
        lines: counts([...lines.values()])
    };
}

function counts(values) {
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError("Raw coverage contains invalid counters");
    }
    return { covered: values.filter((value) => value > 0).length, total: values.length };
}

function emptyCounters() {
    return Object.fromEntries(evidence.metrics.map((metric) => [metric, { covered: 0, total: 0 }]));
}

function addCounters(target, source) {
    for (const metric of evidence.metrics) {
        target[metric].covered += source[metric].covered;
        target[metric].total += source[metric].total;
    }
}

function normalizeSummary(total) {
    return Object.fromEntries(
        evidence.metrics.map((metric) => [
            metric,
            { covered: total[metric].covered, total: total[metric].total }
        ])
    );
}

function portable(path) {
    return relative(packageRoot, path).replaceAll("\\", "/");
}

async function digestFiles(paths) {
    const hash = createHash("sha256");
    for (const path of paths) {
        hash.update(path);
        hash.update("\0");
        hash.update(await readFile(resolve(packageRoot, path)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

async function json(path) {
    return JSON.parse(await readFile(resolve(qualityRoot, path), "utf8"));
}
