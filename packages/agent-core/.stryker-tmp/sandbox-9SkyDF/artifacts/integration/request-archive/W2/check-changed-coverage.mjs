// @ts-nocheck
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requestRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(requestRoot, "../../..");
const repositoryRoot = resolve(packageRoot, "../..");
const manifest = JSON.parse(readFileSync(resolve(requestRoot, "coverage-manifest.json"), "utf8"));
const base = manifest.baseCommit;
const coveragePath = resolve(packageRoot, process.argv[2] ?? "coverage/w2/coverage-final.json");
const threshold = 95;

const declared = new Set(manifest.sourceFiles.map(path =>
  realpathSync(resolve(packageRoot, path))
));
const changed = new Set([
  ...git(["diff", "--name-only", `${base}..HEAD`]),
  ...git(["diff", "--name-only"]),
  ...git(["diff", "--cached", "--name-only"]),
  ...git(["ls-files", "--others", "--exclude-standard"])
].filter(isW2Source).map(path => realpathSync(resolve(repositoryRoot, path))));

assertExactFiles("W2 source manifest", declared, changed);

const raw = JSON.parse(readFileSync(coveragePath, "utf8"));
const coveredFiles = new Map(Object.entries(raw).map(([path, value]) => [realpathSync(path), value]));
assertExactFiles("W2 coverage report", declared, new Set(coveredFiles.keys()));

const metrics = {
  statements: [0, 0],
  branches: [0, 0],
  functions: [0, 0],
  lines: [0, 0]
};

for (const path of declared) {
  const file = coveredFiles.get(path);
  count(metrics.statements, Object.values(file.s));
  count(metrics.functions, Object.values(file.f));
  count(metrics.branches, Object.values(file.b).flat());
  const lines = new Map();
  for (const [id, location] of Object.entries(file.statementMap)) {
    const line = location.start.line;
    lines.set(line, Math.max(lines.get(line) ?? 0, file.s[id]));
  }
  count(metrics.lines, [...lines.values()]);
}

const report = {
  schemaVersion: "agent-core.w2-changed-coverage/v1",
  base,
  threshold,
  files: [...declared].map(path => relative(repositoryRoot, path)).sort(),
  metrics: Object.fromEntries(Object.entries(metrics).map(([name, [covered, total]]) => [
    name,
    { covered, total, percentage: Number((covered * 100 / total).toFixed(2)) }
  ]))
};

for (const [name, metric] of Object.entries(report.metrics)) {
  if (metric.covered * 100 < metric.total * threshold) {
    throw new Error(`W2 ${name} coverage ${metric.covered}/${metric.total} is below ${threshold}%`);
  }
}

console.log(JSON.stringify(report, null, 2));

function git(args) {
  const output = execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  return output.length === 0 ? [] : output.split("\n");
}

function isW2Source(path) {
  const prefix = "packages/agent-core/src/";
  if (!path.startsWith(prefix) || !path.endsWith(".ts") || path.endsWith("/index.ts")) return false;
  const local = path.slice(prefix.length);
  return local.startsWith("identity/")
    || local.startsWith("authority/")
    || local === "protocol/authority-evidence.ts"
    || local === "protocol/bootstrap.ts"
    || local === "protocol/bootstrap-memory.ts"
    || [
      "substrates/sqlite/identity.ts",
      "substrates/sqlite/tenant.ts",
      "substrates/sqlite/binding.ts",
      "substrates/sqlite/watermark.ts",
      "substrates/sqlite/bootstrap.ts",
      "substrates/sqlite/authority.ts"
    ].includes(local);
}

function count(target, values) {
  target[0] += values.filter(value => value > 0).length;
  target[1] += values.length;
}

function assertExactFiles(name, expected, actual) {
  const missing = [...expected].filter(path => !actual.has(path));
  const unexpected = [...actual].filter(path => !expected.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      `${name} does not match the exact W2 source inventory`,
      ...missing.map(path => `missing: ${relative(repositoryRoot, path)}`),
      ...unexpected.map(path => `unexpected: ${relative(repositoryRoot, path)}`)
    ].join("\n"));
  }
}
