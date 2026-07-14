import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const baseline = process.env.W3_COVERAGE_BASELINE ?? "f558d0f";
const threshold = 95;
const W3_FACET_SOURCES = new Set([
    "packages/agent-core/src/facets/automation.ts",
    "packages/agent-core/src/facets/command.ts",
    "packages/agent-core/src/facets/contribution.ts",
    "packages/agent-core/src/facets/data.ts",
    "packages/agent-core/src/facets/id.ts",
    "packages/agent-core/src/facets/manifest.ts",
    "packages/agent-core/src/facets/operation.ts",
    "packages/agent-core/src/facets/slot-entry.ts",
    "packages/agent-core/src/facets/slot-memory.ts",
    "packages/agent-core/src/facets/slot-store.ts"
]);
const changed = [
    ...new Set([
        ...paths(git(["diff", "--name-only", baseline, "--"])),
        ...paths(
            git(["ls-files", "--others", "--exclude-standard", "--", "packages/agent-core/src"])
        )
    ])
].filter((path) => path.startsWith("packages/agent-core/src/") && path.endsWith(".ts"));

for (const path of changed) {
    if (!isW3Source(path)) throw new Error(`W3 changed cross-owner source ${path}`);
}

const reportRoot = mkdtempSync(resolve(tmpdir(), "agent-core-w3-coverage-"));
try {
    const vitest = resolve(packageRoot, "node_modules/vitest/vitest.mjs");
    const result = spawnSync(
        process.execPath,
        [
            vitest,
            "run",
            "--testTimeout=15000",
            `--config=${resolve(packageRoot, "test/w3/vitest.coverage.config.mjs")}`,
            "--coverage",
            "--coverage.reporter=json",
            `--coverage.reportsDirectory=${reportRoot}`
        ],
        { cwd: packageRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`W3 coverage test run failed with status ${result.status ?? 1}`);

    const coverage = JSON.parse(readFileSync(resolve(reportRoot, "coverage-final.json"), "utf8"));
    const totals = emptyTotals();
    const details = [];
    for (const path of changed) {
        const source = resolve(repositoryRoot, path);
        const file = coverage[source];
        if (file === undefined) {
            throw new Error(`W3 changed source is missing raw coverage: ${path}`);
        }
        const fileTotals = emptyTotals();
        accumulate(fileTotals, file);
        accumulateTotals(totals, fileTotals);
        details.push({ path, ...summarize(fileTotals) });
    }
    const summary = Object.fromEntries(
        Object.entries(totals).map(([metric, value]) => [
            metric,
            { ...value, pct: percentage(value.covered, value.total) }
        ])
    );
    console.log(`W3 raw changed-source coverage (${changed.length} files from ${baseline}):`);
    console.log(JSON.stringify(summary, null, 2));
    if (process.env.W3_COVERAGE_DETAILS === "1") console.log(JSON.stringify(details, null, 2));
    for (const [metric, value] of Object.entries(summary)) {
        if (value.pct < threshold) {
            throw new Error(`W3 raw ${metric} coverage ${value.pct}% is below ${threshold}%`);
        }
    }
    for (const detail of details) {
        for (const [metric, value] of Object.entries(detail)) {
            if (metric === "path") continue;
            if (value.pct < threshold) {
                throw new Error(
                    `${detail.path} raw ${metric} coverage ${value.pct}% is below ${threshold}%`
                );
            }
        }
    }
} finally {
    rmSync(reportRoot, { recursive: true, force: true });
}

function git(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
}

function paths(output) {
    return output.trim() === "" ? [] : output.trim().split("\n");
}

function isW3Source(path) {
    return (
        W3_FACET_SOURCES.has(path) ||
        path.startsWith("packages/agent-core/src/operations/") ||
        path === "packages/agent-core/src/protocol/facet-commands.ts" ||
        path === "packages/agent-core/src/substrates/sqlite/slot.ts"
    );
}

function emptyTotals() {
    return {
        statements: { covered: 0, total: 0 },
        branches: { covered: 0, total: 0 },
        functions: { covered: 0, total: 0 },
        lines: { covered: 0, total: 0 }
    };
}

function accumulate(totals, file) {
    addValues(totals.statements, Object.values(file.s));
    addValues(totals.branches, Object.values(file.b).flat());
    addValues(totals.functions, Object.values(file.f));
    const lines = new Map();
    for (const [id, statement] of Object.entries(file.statementMap)) {
        const line = statement.start.line;
        lines.set(line, (lines.get(line) ?? 0) + (file.s[id] ?? 0));
    }
    addValues(totals.lines, [...lines.values()]);
}

function accumulateTotals(totals, candidate) {
    for (const metric of Object.keys(totals)) {
        totals[metric].covered += candidate[metric].covered;
        totals[metric].total += candidate[metric].total;
    }
}

function summarize(totals) {
    return Object.fromEntries(
        Object.entries(totals).map(([metric, value]) => [
            metric,
            { ...value, pct: percentage(value.covered, value.total) }
        ])
    );
}

function addValues(total, values) {
    total.total += values.length;
    total.covered += values.filter(Boolean).length;
}

function percentage(covered, total) {
    return total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100;
}
