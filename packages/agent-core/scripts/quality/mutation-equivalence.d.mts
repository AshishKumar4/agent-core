export interface EquivalenceEntry {
    file: string;
    symbol: string;
    mutator: string;
    replacement: string;
    mutated: string;
    proof: string;
}

export interface ReportMutant {
    id: string;
    mutatorName: string;
    replacement: string;
    status: string;
    location: {
        start: { line: number; column: number };
        end: { line: number; column: number };
    };
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

export function readEquivalenceRegister(document: unknown): EquivalenceEntry[];

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
    readSource: (file: string) => string | undefined
): string[];
