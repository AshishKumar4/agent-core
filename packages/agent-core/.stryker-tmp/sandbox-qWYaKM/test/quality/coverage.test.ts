// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    assertCoverageAgreement,
    failedMetrics,
    failedUniverseMetrics,
    mergeRawCoverage,
    metricRatios,
    metricsFromFinal,
    validateCoveragePolicy,
    validateCoverageSeed
} from "../../scripts/quality/coverage-policy.mjs";

const metrics = ["statements", "branches", "functions", "lines"] as const;

describe("coverage policy", () => {
    test("uses exact integer counters instead of rounded percentages", () => {
        const exact = Object.fromEntries(
            metrics.map((metric) => [metric, { covered: 95, total: 100 }])
        );
        const roundedOnly = Object.fromEntries(
            metrics.map((metric) => [metric, { covered: 949, total: 999 }])
        );

        expect(failedMetrics(exact, metrics, 95)).toEqual([]);
        expect(failedMetrics(roundedOnly, metrics, 95)).toEqual(metrics);
        expect(metricRatios(roundedOnly, metrics).statements).toBeLessThan(95);
    });

    test("rejects zero denominators", () => {
        const empty = Object.fromEntries(
            metrics.map((metric) => [metric, { covered: 0, total: 0 }])
        );
        expect(failedMetrics(empty, metrics, 95)).toEqual(metrics);
    });

    test("enforces thresholds independently instead of pooling source universes", () => {
        const complete = coverageMetrics(100);
        const incomplete = coverageMetrics(90);

        expect(failedMetrics(sumMetrics(complete, incomplete), metrics, 95)).toEqual([]);
        expect(
            failedUniverseMetrics({ core: complete, cloudflare: incomplete }, metrics, 95)
        ).toEqual(metrics.map((metric) => `cloudflare/${metric}`));
    });

    test("rejects attempts to weaken any hard final metric", () => {
        expect(() => validateCoveragePolicy({ metrics, threshold: 94.99 })).toThrow(/95%/);
        expect(() =>
            validateCoveragePolicy({
                metrics: metrics.filter((metric) => metric !== "branches"),
                threshold: 95
            })
        ).toThrow(/all four metrics/);
        expect(() => validateCoveragePolicy({ metrics, threshold: 95 })).not.toThrow();
    });

    test("derives raw counters and rejects a forged summary", () => {
        const raw = metricsFromFinal({
            s: { 0: 1, 1: 0 },
            f: { 0: 1 },
            b: { 0: [1, 0] },
            statementMap: {
                0: { start: { line: 1 } },
                1: { start: { line: 2 } }
            }
        });
        expect(raw).toEqual({
            statements: { covered: 1, total: 2 },
            branches: { covered: 1, total: 2 },
            functions: { covered: 1, total: 1 },
            lines: { covered: 1, total: 2 }
        });
        expect(() =>
            assertCoverageAgreement(
                {
                    ...raw,
                    statements: { covered: 2, total: 2 }
                },
                raw,
                "source.ts"
            )
        ).toThrow(/disagree/);
    });

    test("unions exact cross-lane counters and rejects different instrumentation", () => {
        const lane = (statements: Record<string, number>) => ({
            path: "/source.ts",
            statementMap: {
                0: { start: { line: 1 } },
                1: { start: { line: 2 } }
            },
            fnMap: { 0: { name: "run" } },
            branchMap: { 0: { type: "if" } },
            s: statements,
            f: { 0: 1 },
            b: { 0: [1, 0] }
        });
        const merged = mergeRawCoverage(lane({ 0: 1, 1: 0 }), lane({ 0: 0, 1: 1 }), "source.ts");
        expect(metricsFromFinal(merged)).toMatchObject({
            statements: { covered: 2, total: 2 },
            lines: { covered: 2, total: 2 }
        });
        expect(() =>
            mergeRawCoverage(
                lane({ 0: 1, 1: 0 }),
                { ...lane({ 0: 1, 1: 0 }), statementMap: {} },
                "source.ts"
            )
        ).toThrow(/differently/);
    });

    test("rejects malformed or lowered seed counters", () => {
        const seed = {
            edition: "1.0.0",
            baseCommit: "f".repeat(40),
            files: {
                "packages/example/src/index.ts": {
                    sha256: "a".repeat(64),
                    metrics: Object.fromEntries(
                        metrics.map((metric) => [metric, { covered: -1, total: 1 }])
                    )
                }
            }
        };
        expect(() => validateCoverageSeed(seed)).toThrow(/invalid counters/);
    });
});

function sumMetrics(
    left: Record<(typeof metrics)[number], { covered: number; total: number }>,
    right: Record<(typeof metrics)[number], { covered: number; total: number }>
) {
    return Object.fromEntries(
        metrics.map((metric) => [
            metric,
            {
                covered: left[metric].covered + right[metric].covered,
                total: left[metric].total + right[metric].total
            }
        ])
    );
}

function coverageMetrics(covered: number) {
    return {
        statements: { covered, total: 100 },
        branches: { covered, total: 100 },
        functions: { covered, total: 100 },
        lines: { covered, total: 100 }
    };
}
