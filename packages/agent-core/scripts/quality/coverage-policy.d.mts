import type { JsonValue } from "./project.mjs";

export interface CoverageCount {
    readonly covered: number;
    readonly total: number;
}

export const HARD_COVERAGE_THRESHOLD: 95;
export const REQUIRED_COVERAGE_METRICS: readonly ["statements", "branches", "functions", "lines"];
export function validateCoveragePolicy(coverage: JsonValue): void;

export function failedMetrics(
    metrics: Readonly<Record<string, CoverageCount>>,
    names: readonly string[],
    threshold: number
): string[];
export function failedUniverseMetrics(
    universes: Readonly<Record<string, Readonly<Record<string, CoverageCount>>>>,
    names: readonly string[],
    threshold: number
): string[];
export function metricRatios(
    metrics: Readonly<Record<string, CoverageCount>>,
    names: readonly string[]
): Record<string, number | null>;
export function metricsFromFinal(value: JsonValue): Record<string, CoverageCount>;
export function mergeRawCoverage(left: JsonValue, right: JsonValue, path: string): JsonValue;
export function assertCoverageAgreement(
    summary: Readonly<Record<string, CoverageCount>>,
    raw: Readonly<Record<string, CoverageCount>>,
    owner: string
): void;
export function validateCoverageSeed(seed: JsonValue): void;
