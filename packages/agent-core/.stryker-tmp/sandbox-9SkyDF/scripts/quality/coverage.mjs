// @ts-nocheck
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
    absoluteFromRepository,
    artifactRoot,
    collectFiles,
    fileSha256,
    portable,
    portablePath,
    readCanonicalJson,
    readJson,
    reportRoot,
    repositoryRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { changedPaths, loadOwnership, ownersForPath } from "./ownership.mjs";
import {
    assertCoverageAgreement,
    failedMetrics,
    failedUniverseMetrics,
    mergeRawCoverage,
    metricRatios,
    metricsFromFinal,
    validateCoveragePolicy,
    validateCoverageSeed
} from "./coverage-policy.mjs";
import { approvedSourceRemovals } from "./source-removals.mjs";

const options = parseArguments(process.argv.slice(2));
const policy = await readCanonicalJson(resolve(artifactRoot, "quality/policy.json"));
validateCoveragePolicy(policy.coverage);
await validateWorkspaceUniverses(policy.coverage.sourceUniverses);
const discovery = await discoverUniverses(policy.coverage.sourceUniverses);
const universes = discovery.universes;
const reportData = await loadReports(universes);
const sourcePaths = universes.flatMap((universe) => universe.files.map((file) => file.path)).sort();
const reportPaths = [...reportData.files.keys()].sort();
const missing = sourcePaths.filter((path) => !reportData.files.has(path));
const unknown = reportPaths.filter((path) => !sourcePaths.includes(path));
if (missing.length > 0 || unknown.length > 0) {
    throw new TypeError(
        [
            "Coverage source universe mismatch",
            ...missing.map((path) => `missing: ${path}`),
            ...unknown.map((path) => `unknown: ${path}`)
        ].join("\n")
    );
}

const totals = emptyMetrics(policy.coverage.metrics);
for (const coverage of reportData.files.values())
    addMetrics(totals, coverage, policy.coverage.metrics);
const ratios = metricRatios(totals, policy.coverage.metrics);
const universeTotals = Object.fromEntries(
    universes.map((universe) => {
        const totals = emptyMetrics(policy.coverage.metrics);
        for (const file of universe.files)
            addMetrics(totals, reportData.files.get(file.path), policy.coverage.metrics);
        return [universe.id, totals];
    })
);
const universeRatios = Object.fromEntries(
    Object.entries(universeTotals).map(([id, metrics]) => [
        id,
        metricRatios(metrics, policy.coverage.metrics)
    ])
);
const thresholdFailures = failedUniverseMetrics(
    universeTotals,
    policy.coverage.metrics,
    policy.coverage.threshold
);
const seedPath = resolve(artifactRoot, "quality/coverage-seed.json");
const seed = await loadSeed(seedPath);
if (seed !== undefined) await validateSeedProvenance(seed, policy.baseCommit);
const approvedRemovals =
    seed === undefined
        ? new Set()
        : await approvedSourceRemovals(seed, reportData.files, options.stage);
const regressions =
    seed === undefined
        ? []
        : await unchangedRegressions(
              seed,
              reportData.files,
              policy.coverage.metrics,
              approvedRemovals
          );
const ownerCoverage =
    options.owner === undefined
        ? undefined
        : await changedOwnerCoverage(
              options.owner,
              options.base,
              reportData.files,
              policy.coverage.metrics
          );
const ownerFailures =
    ownerCoverage === undefined
        ? []
        : policy.coverage.metrics.every((name) => ownerCoverage[name].total === 0)
          ? []
          : failedMetrics(ownerCoverage, policy.coverage.metrics, policy.coverage.threshold);

const sourceUniverse = {
    edition: "1.0.0",
    universes: universes.map((universe) => ({
        id: universe.id,
        root: universe.root,
        reports: universe.reports,
        files: universe.files
    }))
};
const attestation = {
    edition: "1.0.0",
    stage: options.stage,
    sourceFiles: sourcePaths.length,
    totals,
    ratios,
    universeTotals,
    universeRatios,
    threshold: policy.coverage.threshold,
    thresholdFailures,
    missingUniverses: discovery.missingUniverses,
    regressions,
    approvedRemovedSources: [...approvedRemovals].sort(),
    owner: options.owner ?? null,
    ownerTotals: ownerCoverage ?? null,
    ownerFailures,
    complete:
        discovery.missingUniverses.length === 0 &&
        thresholdFailures.length === 0 &&
        regressions.length === 0 &&
        ownerFailures.length === 0
};
await writeCanonicalJson(resolve(reportRoot, "coverage/source-universe.json"), sourceUniverse);
await writeCanonicalJson(resolve(reportRoot, "coverage/attestation.json"), attestation);

if (options.writeSeed) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the coverage seed requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    await writeCanonicalJson(seedPath, {
        edition: "1.0.0",
        baseCommit: policy.baseCommit,
        files: Object.fromEntries(
            await Promise.all(
                sourcePaths.map(async (path) => [
                    path,
                    {
                        sha256: await fileSha256(absoluteFromRepository(path)),
                        metrics: reportData.files.get(path)
                    }
                ])
            )
        )
    });
} else {
    if (seed === undefined) throw new TypeError("Coverage seed is missing");
    if (regressions.length > 0)
        throw new TypeError(`Unchanged coverage regressed:\n${regressions.join("\n")}`);
    if (ownerFailures.length > 0)
        throw new TypeError(
            `Owned changed-source coverage is below 95%: ${ownerFailures.join(", ")}`
        );
    if (discovery.missingUniverses.length > 0 || thresholdFailures.length > 0) {
        throw new TypeError(
            [
                discovery.missingUniverses.length === 0
                    ? undefined
                    : `Source universes are empty: ${discovery.missingUniverses.join(", ")}`,
                thresholdFailures.length === 0
                    ? undefined
                    : `Source universe coverage is below 95%: ${thresholdFailures.join(", ")}`
            ]
                .filter(Boolean)
                .join("\n")
        );
    }
    console.log(
        `coverage ${attestation.complete ? "complete" : "incomplete"}: ${formatRatios(ratios)}`
    );
}

async function discoverUniverses(configured) {
    const universes = [];
    const missingUniverses = [];
    for (const config of configured) {
        const root = absoluteFromRepository(config.root);
        const files = await collectFiles(
            root,
            (path) =>
                config.extensions.some((extension) => path.endsWith(extension)) &&
                !/\.d\.[cm]?ts$/.test(path)
        );
        if (files.length === 0) {
            missingUniverses.push(config.id);
            continue;
        }
        universes.push({
            id: config.id,
            root: config.root,
            reports: config.reports,
            files: await Promise.all(
                files.map(async (path) => ({
                    path: portablePath(path),
                    sha256: await fileSha256(path)
                }))
            )
        });
    }
    if (universes.length === 0) throw new TypeError("Coverage has no runtime source universe");
    return { universes, missingUniverses };
}

async function loadReports(universes) {
    const files = new Map();
    for (const universe of universes) {
        const workspaceRoot = absoluteFromRepository(universe.root.split("/src")[0]);
        const merged = new Map();
        for (const configuredReport of universe.reports) {
            const reportDirectory = absoluteFromRepository(configuredReport);
            const summary = await readJson(resolve(reportDirectory, "coverage-summary.json"));
            const final = await readJson(resolve(reportDirectory, "coverage-final.json"));
            const finalByPath = new Map(
                Object.entries(final).map(([path, value]) => [
                    reportPath(path, workspaceRoot),
                    value
                ])
            );
            const finalPaths = new Set(finalByPath.keys());
            for (const [path, metrics] of Object.entries(summary)) {
                if (path === "total") continue;
                const normalized = reportPath(path, workspaceRoot);
                if (!finalPaths.has(normalized)) {
                    throw new TypeError(`Coverage final report is missing ${normalized}`);
                }
                const raw = finalByPath.get(normalized);
                assertCoverageAgreement(
                    normalizeMetrics(metrics),
                    metricsFromFinal(raw),
                    normalized
                );
                merged.set(
                    normalized,
                    merged.has(normalized)
                        ? mergeRawCoverage(merged.get(normalized), raw, normalized)
                        : structuredClone(raw)
                );
            }
            for (const path of finalPaths) {
                if (
                    !Object.hasOwn(summary, absoluteFromRepository(path)) &&
                    !hasSummaryPath(summary, path, workspaceRoot)
                ) {
                    throw new TypeError(`Coverage summary is missing ${path}`);
                }
            }
        }
        for (const [path, raw] of merged) {
            if (files.has(path)) throw new TypeError(`Coverage reports duplicate ${path}`);
            files.set(path, metricsFromFinal(raw));
        }
    }
    return { files };
}

function hasSummaryPath(summary, expected, workspaceRoot) {
    return Object.keys(summary).some(
        (path) => path !== "total" && reportPath(path, workspaceRoot) === expected
    );
}

function reportPath(path, workspaceRoot) {
    const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path);
    const normalized = portable(relative(repositoryRoot, absolute));
    if (normalized === ".." || normalized.startsWith("../")) {
        throw new TypeError(`Coverage path escapes repository: ${path}`);
    }
    return normalized;
}

function normalizeMetrics(value) {
    const result = {};
    for (const metric of ["statements", "branches", "functions", "lines"]) {
        const counts = value[metric];
        if (
            !Number.isSafeInteger(counts?.covered) ||
            !Number.isSafeInteger(counts?.total) ||
            counts.covered < 0 ||
            counts.total < 0 ||
            counts.covered > counts.total
        ) {
            throw new TypeError(`Coverage report has invalid ${metric} counters`);
        }
        result[metric] = { covered: counts.covered, total: counts.total };
    }
    return result;
}

function emptyMetrics(metrics) {
    return Object.fromEntries(metrics.map((metric) => [metric, { covered: 0, total: 0 }]));
}

function addMetrics(target, source, metrics) {
    for (const metric of metrics) {
        target[metric].covered += source[metric].covered;
        target[metric].total += source[metric].total;
    }
}

async function unchangedRegressions(seed, current, metrics, approvedRemovals) {
    const regressions = [];
    for (const [path, previous] of Object.entries(seed.files)) {
        const absolute = absoluteFromRepository(path);
        let hash;
        try {
            hash = await fileSha256(absolute);
        } catch (error) {
            if (error?.code === "ENOENT") {
                if (!approvedRemovals.has(path))
                    regressions.push(`${path}: removed without reviewed source-removal evidence`);
                continue;
            }
            throw error;
        }
        if (hash !== previous.sha256) continue;
        const next = current.get(path);
        if (next === undefined) {
            regressions.push(`${path}: missing unchanged source`);
            continue;
        }
        for (const metric of metrics) {
            if (next[metric].covered < previous.metrics[metric].covered) {
                regressions.push(
                    `${path}: ${metric} ${next[metric].covered} < ${previous.metrics[metric].covered}`
                );
            }
        }
    }
    return regressions;
}

async function validateSeedProvenance(seed, baseCommit) {
    if (seed.baseCommit !== baseCommit) throw new TypeError("Coverage seed base commit is stale");
    const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", baseCommit, "packages"], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (listed.status !== 0)
        throw new TypeError(`Cannot inspect coverage seed commit ${baseCommit}`);
    const expected = listed.stdout
        .split("\n")
        .filter(
            (path) =>
                path.includes("/src/") &&
                /\.(?:[cm]?ts|tsx)$/u.test(path) &&
                !/\.d\.[cm]?ts$/u.test(path)
        )
        .sort();
    const actual = Object.keys(seed.files).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError("Coverage seed does not contain the exact base source universe");
    }
    for (const [path, value] of Object.entries(seed.files)) {
        const result = spawnSync("git", ["show", `${baseCommit}:${path}`], {
            cwd: repositoryRoot,
            encoding: null,
            maxBuffer: 16 * 1024 * 1024
        });
        if (result.status !== 0 || sha256(result.stdout) !== value.sha256) {
            throw new TypeError(`Coverage seed source does not match ${baseCommit}: ${path}`);
        }
    }
}

async function validateWorkspaceUniverses(configured) {
    const entries = await readdir(resolve(repositoryRoot, "packages"), { withFileTypes: true });
    const expected = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}/src`)
        .sort();
    const actual = configured.map((universe) => universe.root).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(
            `Coverage universes do not equal workspace packages; expected=${expected.join(",")}`
        );
    }
    for (const universe of configured) {
        if (
            !Array.isArray(universe.reports) ||
            universe.reports.length === 0 ||
            new Set(universe.reports).size !== universe.reports.length
        ) {
            throw new TypeError(`Coverage universe ${universe.id} has invalid report lanes`);
        }
    }
}

async function changedOwnerCoverage(owner, base, files, metrics) {
    const { patterns } = await loadOwnership();
    const changed = changedPaths(base).filter(
        (path) => files.has(path) && ownersForPath(path, patterns).includes(owner)
    );
    if (changed.length === 0) return undefined;
    const total = emptyMetrics(metrics);
    for (const path of changed) addMetrics(total, files.get(path), metrics);
    return total;
}

async function loadSeed(path) {
    try {
        const seed = await readCanonicalJson(path);
        validateCoverageSeed(seed);
        return seed;
    } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
    }
}

function formatRatios(ratios) {
    return Object.entries(ratios)
        .map(([name, value]) => `${name}=${value === null ? "n/a" : value.toFixed(2)}%`)
        .join(", ");
}

function parseArguments(args) {
    let stage = "building";
    let owner;
    let base = "f558d0ff3f7e93308481ea09c3bf369abbdd19ba";
    let writeSeed = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--owner") owner = required(args, ++index, argument);
        else if (argument === "--base") base = required(args, ++index, argument);
        else if (argument === "--write-seed") writeSeed = true;
        else throw new TypeError(`Unknown coverage argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, owner, base, writeSeed };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
