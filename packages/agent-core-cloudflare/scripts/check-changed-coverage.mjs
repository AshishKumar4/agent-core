import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASELINE = "f558d0f";
const THRESHOLD = 95;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const coreRoot = resolve(repositoryRoot, "packages/agent-core");
const cloudflareRoot = packageRoot;
const reportRoot = await mkdtemp(resolve(tmpdir(), "agent-core-w8-coverage-"));

try {
    const changed = new Set(
        [
            ...git([
                "diff",
                "--diff-filter=ACMR",
                "--name-only",
                BASELINE,
                "--",
                "packages/agent-core/src",
                "packages/agent-core-cloudflare/src"
            ]),
            ...git([
                "ls-files",
                "--others",
                "--exclude-standard",
                "--",
                "packages/agent-core/src",
                "packages/agent-core-cloudflare/src"
            ])
        ].filter(isW8ProductionSource)
    );
    if (changed.size === 0) throw new TypeError(`No changed W8 production files since ${BASELINE}`);

    const packages = [
        {
            name: "cloudflare",
            root: cloudflareRoot,
            prefix: "packages/agent-core-cloudflare/",
            config: "test/vitest.config.mjs",
            tests: []
        },
        {
            name: "core",
            root: coreRoot,
            prefix: "packages/agent-core/",
            config: "vitest.config.mjs",
            tests: [
                "test/environments",
                "test/slates",
                "test/profiles",
                "test/composition",
                "test/integration"
            ]
        }
    ];
    const totals = Object.fromEntries(
        ["statements", "branches", "functions", "lines"].map((metric) => [
            metric,
            {
                covered: 0,
                total: 0
            }
        ])
    );

    for (const target of packages) {
        const files = [...changed]
            .filter((file) => file.startsWith(target.prefix))
            .map((file) => file.slice(target.prefix.length));
        if (files.length === 0) continue;
        const reportDirectory = resolve(reportRoot, target.name);
        const vitest = resolve(coreRoot, "node_modules/vitest/vitest.mjs");
        const args = [
            vitest,
            "run",
            "--config",
            target.config,
            "--coverage",
            "--coverage.reporter=text",
            "--coverage.reporter=json-summary",
            `--coverage.reportsDirectory=${reportDirectory}`,
            ...target.tests,
            ...files.map((file) => `--coverage.include=${file}`)
        ];
        run(process.execPath, args, target.root, `${target.name} coverage`);
        const summary = JSON.parse(
            await readFile(resolve(reportDirectory, "coverage-summary.json"), "utf8")
        );
        await verifyCoverageFiles(summary, target, files);
        for (const metric of Object.keys(totals)) {
            totals[metric].covered += summary.total[metric].covered;
            totals[metric].total += summary.total[metric].total;
        }
    }

    for (const [metric, value] of Object.entries(totals)) {
        if (value.total === 0) throw new TypeError(`Changed-source ${metric} coverage has no data`);
        const percentage = (value.covered / value.total) * 100;
        if (percentage < THRESHOLD) {
            throw new TypeError(
                `Changed-source ${metric} coverage ${percentage.toFixed(2)}% is below ${THRESHOLD}%`
            );
        }
        process.stdout.write(`W8 changed-source ${metric}: ${percentage.toFixed(2)}%\n`);
    }
} finally {
    await rm(reportRoot, { recursive: true, force: true });
}

function git(args) {
    const result = spawnSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new TypeError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.split("\n").filter(Boolean);
}

function isW8ProductionSource(file) {
    if (!file.endsWith(".ts")) return false;
    return (
        file.startsWith("packages/agent-core-cloudflare/src/") ||
        file.startsWith("packages/agent-core/src/environments/") ||
        file.startsWith("packages/agent-core/src/slates/") ||
        /^packages\/agent-core\/src\/facets\/(approval-gateway|device|environment|filesystem|mcp|memory|self|shell|single-tenant|slate|task|web)\//.test(
            file
        )
    );
}

async function verifyCoverageFiles(summary, target, files) {
    for (const file of files) {
        const coverage = summary[resolve(target.root, file)];
        if (coverage === undefined) {
            if (
                file.split("/").at(-1) === "index.ts" &&
                (await isExportOnlyBarrel(resolve(target.root, file)))
            ) {
                process.stdout.write(
                    `W8 changed-source export-only barrel has zero executable items: ${target.prefix}${file}\n`
                );
                continue;
            }
            throw new TypeError(`${target.name} coverage report omitted changed source ${file}`);
        }
        const isBarrel = file.split("/").at(-1) === "index.ts";
        const executable = ["statements", "branches", "functions", "lines"].some(
            (metric) => coverage[metric].total > 0
        );
        if (isBarrel && !executable) {
            process.stdout.write(
                `W8 changed-source barrel represented with zero executable items: ${target.prefix}${file}\n`
            );
        }
    }
}

async function isExportOnlyBarrel(path) {
    const source = await readFile(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return file.statements.every(
        (statement) => ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement)
    );
}

function run(command, args, cwd, label) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new TypeError(`${label} failed with status ${result.status ?? 1}`);
}
