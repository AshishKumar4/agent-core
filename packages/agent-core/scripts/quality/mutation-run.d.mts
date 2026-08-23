import type { MutationReport } from "./mutation-equivalence.mjs";

export interface MutationRunCost {
    source: "cached" | "measured";
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

export function runLedgerPath(area: string): string;

export function runCachePath(area: string): string;

export function measureArea(area: string, mutatePattern: string): Promise<MutationRun>;

export function readRunCache(
    area: string,
    runKey: string
): { report: MutationReport; measuredAt: string; strykerMs: number } | undefined;

export function gitHead(): string;
