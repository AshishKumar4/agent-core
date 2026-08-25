import type { MutationReport } from "./mutation-equivalence.mjs";
import type { MutationRunIdentity } from "./mutation-inputs.mjs";

export interface MutationRunCost {
    /** `hit`, `miss`, or the reason a recorded measurement was refused. */
    cache: string;
    wallMs: number;
    strykerMs: number;
    mutants: number;
    timeouts: number;
    dryRunTests: number;
    testsRun: number;
    meanTestsPerMutant: number;
    maxTestsPerMutant: number;
    unusable: string[];
}

export interface MutationRun {
    report: MutationReport;
    measuredAt: string;
    cost: MutationRunCost;
}

export interface MutationMeasurement {
    report: MutationReport;
    measuredAt: string;
    strykerMs: number;
}

export function runLedgerPath(area: string): string;

export function runCachePath(area: string): string;

export function measureArea(
    area: string,
    mutatePattern: string,
    run?: (area: string, mutatePattern: string) => MutationMeasurement
): Promise<MutationRun>;

export function readRunCache(
    area: string,
    runKey: string
): { reused?: MutationMeasurement; rejected?: string };

export interface MutationRunRecord {
    edition: string;
    area: string;
    runKey: string;
    identity: MutationRunIdentity;
    measuredAt: string;
    reportSha256: string;
    report: MutationReport;
}

export function publishRunCache(area: string, record: MutationRunRecord): "converged" | "published";

export function requireAreaReport(report: MutationReport, area: string): MutationReport;
export function mergeTimeoutRerun(report: MutationReport, rerun: MutationReport): MutationReport;

export function gitHead(): string;

export type { MutationRunIdentity };
