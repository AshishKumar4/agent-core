// @ts-nocheck
import { readFile, readdir } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requestRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(requestRoot, "../../..");
const manifest = JSON.parse(await readFile(resolve(requestRoot, "coverage.manifest"), "utf8"));
await rm(resolve(packageRoot, "coverage/w4"), { recursive: true, force: true });
const run = spawnSync(
  process.execPath,
  [
    resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    resolve(requestRoot, "vitest.config.mjs"),
    "--coverage"
  ],
  { cwd: packageRoot, encoding: "utf8", stdio: "inherit" }
);
if (run.status !== 0) throw new TypeError(`W4 focused coverage run failed with status ${run.status}`);
const final = JSON.parse(await readFile(resolve(packageRoot, manifest.reports.final), "utf8"));
const summary = JSON.parse(await readFile(resolve(packageRoot, manifest.reports.summary), "utf8"));
const expectedFiles = [
  ...(await sourceFiles(resolve(packageRoot, "src/definition"))),
  resolve(packageRoot, "src/protocol/materialization-commands.ts"),
  resolve(packageRoot, "src/substrates/sqlite/materialization.ts"),
  resolve(packageRoot, "src/substrates/sqlite/package.ts")
].map(portable).sort();
const reports = new Map(Object.entries(final).map(([path, value]) => [
  portable(isAbsolute(path) ? path : resolve(packageRoot, path)),
  value
]));
const reportedFiles = [...reports.keys()].sort();
const missing = expectedFiles.filter(path => !reports.has(path));
const unknown = reportedFiles.filter(path => !expectedFiles.includes(path));
if (missing.length > 0 || unknown.length > 0) {
  throw new TypeError(`W4 coverage source mismatch: missing=${missing.join(",")} unknown=${unknown.join(",")}`);
}
if (manifest.expectedSourceFiles !== expectedFiles.length) {
  throw new TypeError(`W4 coverage manifest source count is ${manifest.expectedSourceFiles}, expected ${expectedFiles.length}`);
}
const sourceSha256 = await digestFiles([
  ...expectedFiles,
  manifest.config,
  manifest.checker
]);
if (sourceSha256 !== manifest.sourceSha256) {
  throw new TypeError(`W4 coverage source hash changed: ${sourceSha256}`);
}
await rejectSuppressions(expectedFiles);
const counters = emptyCounters();
for (const value of reports.values()) addCounters(counters, rawCounters(value));
const summaryCounters = normalizeSummary(summary.total);
if (JSON.stringify(counters) !== JSON.stringify(summaryCounters)) {
  throw new TypeError("W4 raw coverage counters disagree with coverage-summary.json");
}
if (JSON.stringify(counters) !== JSON.stringify(manifest.expectedCounters)) {
  throw new TypeError(`W4 raw coverage counters changed: ${JSON.stringify(counters)}`);
}
for (const metric of manifest.metrics) {
  const value = counters[metric];
  if (value.total === 0 || 100 * value.covered < manifest.threshold * value.total) {
    throw new TypeError(`W4 ${metric} coverage is below ${manifest.threshold}%`);
  }
}
console.log(`W4 coverage verified: ${JSON.stringify(counters)}`);

async function sourceFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) result.push(path);
  }
  return result;
}

async function rejectSuppressions(paths) {
  for (const path of paths) {
    const source = await readFile(resolve(packageRoot, path), "utf8");
    if (/(?:c8|istanbul|v8)\s+ignore/iu.test(source)) {
      throw new TypeError(`Coverage suppression is forbidden in ${path}`);
    }
  }
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
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Raw coverage contains invalid counters");
  }
  return { covered: values.filter(value => value > 0).length, total: values.length };
}

function emptyCounters() {
  return Object.fromEntries(manifest.metrics.map(metric => [metric, { covered: 0, total: 0 }]));
}

function addCounters(target, source) {
  for (const metric of manifest.metrics) {
    target[metric].covered += source[metric].covered;
    target[metric].total += source[metric].total;
  }
}

function normalizeSummary(total) {
  return Object.fromEntries(manifest.metrics.map(metric => [metric, {
    covered: total[metric].covered,
    total: total[metric].total
  }]));
}

function portable(path) {
  return relative(packageRoot, path).replaceAll("\\", "/");
}

async function digestFiles(paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(packageRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
