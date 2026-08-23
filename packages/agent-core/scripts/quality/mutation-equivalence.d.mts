import type { JsonValue } from "./project.mjs";

export type EquivalenceEntry = {
    file: string;
    symbol: string;
    mutator: string;
    replacement: string;
    mutated: string;
    proof: string;
    /** Which of several identical sites in `symbol`, 1-based in source order. */
    occurrence?: number;
    /** How many identical sites existed when the proof was written. Present with `occurrence`. */
    sites?: number;
};

export interface MutationSite {
    mutatorName: string;
    replacement: string;
    location: {
        start: { line: number; column: number };
        end: { line: number; column: number };
    };
}

export interface ReportMutant extends MutationSite {
    id: string;
    status: string;
    /** Tests Stryker's coverage analysis says reach this mutant. */
    coveredBy?: string[];
    /** Tests the mutant's own run actually executed. */
    testsCompleted?: number;
}

export interface MutationReport {
    files: Record<string, { source: string; mutants: ReportMutant[] }>;
    testFiles?: Record<string, { tests: { id: string; name: string }[]; source?: string }>;
}

export interface EquivalenceReconciliation {
    equivalent: Map<string, EquivalenceEntry>;
    refuted: { entry: EquivalenceEntry; mutant: ReportMutant }[];
    stale: EquivalenceEntry[];
    ambiguous: { entry: EquivalenceEntry; matches: ReportMutant[] }[];
}

export type MutationOutcome =
    | "contaminated"
    | "detected"
    | "ignored"
    | "incomplete"
    | "invalid"
    | "undetected";

export function mutationOutcome(status: string): MutationOutcome;

export function unusableMutants(report: MutationReport): string[];

export function requireCompleteMutationReport(report: MutationReport): MutationReport;

export function readEquivalenceRegister(document: JsonValue): EquivalenceEntry[];

export function equivalenceKey(entry: EquivalenceEntry): string;

export function normalizeSource(text: string): string;

export function equivalenceArea(file: string): string;

export function reconcileEquivalence(
    report: MutationReport,
    entries: readonly EquivalenceEntry[]
): EquivalenceReconciliation;

export function auditEquivalenceAnchors(
    entries: readonly EquivalenceEntry[],
    areas: readonly string[],
    readSource: (file: string) => string | undefined,
    readMutants: (file: string, text: string) => Promise<readonly MutationSite[]>
): Promise<string[]>;
