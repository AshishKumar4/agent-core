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
}

export interface MutationReport {
    files: Record<string, { source: string; mutants: ReportMutant[] }>;
}

export interface EquivalenceReconciliation {
    equivalent: Map<string, EquivalenceEntry>;
    refuted: { entry: EquivalenceEntry; mutant: ReportMutant }[];
    stale: EquivalenceEntry[];
    ambiguous: { entry: EquivalenceEntry; matches: ReportMutant[] }[];
}

export type MutationOutcome = "detected" | "ignored" | "incomplete" | "invalid" | "undetected";

export function mutationOutcome(status: string): MutationOutcome;

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
