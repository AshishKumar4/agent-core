export const HARD_COVERAGE_THRESHOLD = 95;
export const REQUIRED_COVERAGE_METRICS = ["statements", "branches", "functions", "lines"];

export function validateCoveragePolicy(coverage) {
    if (
        coverage?.threshold !== HARD_COVERAGE_THRESHOLD ||
        JSON.stringify(coverage.metrics) !== JSON.stringify(REQUIRED_COVERAGE_METRICS)
    ) {
        throw new TypeError("Coverage policy must enforce all four metrics at 95%");
    }
}

export function failedMetrics(metrics, names, threshold) {
    return names.filter(
        (name) =>
            metrics[name].total === 0 ||
            100 * metrics[name].covered < threshold * metrics[name].total
    );
}

export function failedUniverseMetrics(universes, names, threshold) {
    return Object.entries(universes).flatMap(([universe, metrics]) =>
        failedMetrics(metrics, names, threshold).map((metric) => `${universe}/${metric}`)
    );
}

export function metricRatios(metrics, names) {
    return Object.fromEntries(
        names.map((name) => [
            name,
            metrics[name].total === 0 ? null : (metrics[name].covered / metrics[name].total) * 100
        ])
    );
}

export function metricsFromFinal(value) {
    const statementCounts = Object.values(value?.s ?? {});
    const functionCounts = Object.values(value?.f ?? {});
    const branchCounts = Object.values(value?.b ?? {}).flat();
    const lines = new Map();
    for (const [id, count] of Object.entries(value?.s ?? {})) {
        const line = value.statementMap?.[id]?.start?.line;
        if (!Number.isSafeInteger(line))
            throw new TypeError("Raw coverage statement has no source line");
        lines.set(line, Math.max(lines.get(line) ?? 0, count));
    }
    return {
        statements: rawCounts(statementCounts),
        branches: rawCounts(branchCounts),
        functions: rawCounts(functionCounts),
        lines: rawCounts([...lines.values()])
    };
}

export function mergeRawCoverage(left, right, path) {
    for (const map of ["statementMap", "fnMap", "branchMap"]) {
        if (JSON.stringify(left[map]) !== JSON.stringify(right[map])) {
            throw new TypeError(`Coverage lanes instrument ${path} differently`);
        }
    }
    const merged = structuredClone(left);
    for (const counter of ["s", "f"]) {
        if (
            JSON.stringify(Object.keys(left[counter])) !==
            JSON.stringify(Object.keys(right[counter]))
        ) {
            throw new TypeError(`Coverage lanes have different ${counter} counters for ${path}`);
        }
        for (const id of Object.keys(merged[counter])) {
            merged[counter][id] = Math.max(left[counter][id], right[counter][id]);
        }
    }
    if (JSON.stringify(Object.keys(left.b)) !== JSON.stringify(Object.keys(right.b))) {
        throw new TypeError(`Coverage lanes have different branch counters for ${path}`);
    }
    for (const id of Object.keys(merged.b)) {
        if (left.b[id].length !== right.b[id].length) {
            throw new TypeError(`Coverage lanes have different branch arity for ${path}`);
        }
        merged.b[id] = left.b[id].map((count, index) => Math.max(count, right.b[id][index]));
    }
    return merged;
}

export function assertCoverageAgreement(summary, raw, owner) {
    if (JSON.stringify(summary) !== JSON.stringify(raw)) {
        throw new TypeError(`Coverage summary counters disagree with raw coverage for ${owner}`);
    }
}

export function validateCoverageSeed(seed) {
    exactKeys(seed, ["edition", "baseCommit", "files"], "Coverage seed");
    if (
        seed.edition !== "1.0.0" ||
        !/^[a-f0-9]{40}$/u.test(seed.baseCommit) ||
        seed.files === null ||
        Array.isArray(seed.files) ||
        typeof seed.files !== "object"
    ) {
        throw new TypeError("Coverage seed is malformed");
    }
    for (const [path, value] of Object.entries(seed.files)) {
        exactKeys(value, ["sha256", "metrics"], `Coverage seed ${path}`);
        if (!/^[a-f0-9]{64}$/u.test(value.sha256)) {
            throw new TypeError(`Coverage seed has invalid source digest: ${path}`);
        }
        exactKeys(value.metrics, ["statements", "branches", "functions", "lines"], path);
        for (const metric of Object.values(value.metrics)) {
            exactKeys(metric, ["covered", "total"], `Coverage seed metric ${path}`);
            if (
                !Number.isSafeInteger(metric.covered) ||
                !Number.isSafeInteger(metric.total) ||
                metric.covered < 0 ||
                metric.total < 0 ||
                metric.covered > metric.total
            ) {
                throw new TypeError(`Coverage seed has invalid counters: ${path}`);
            }
        }
    }
}

function rawCounts(values) {
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError("Raw coverage contains invalid counters");
    }
    return { covered: values.filter((value) => value > 0).length, total: values.length };
}

function exactKeys(value, expected, owner) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${owner} must be an object`);
    }
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new TypeError(`${owner} has missing or unknown fields`);
    }
}
