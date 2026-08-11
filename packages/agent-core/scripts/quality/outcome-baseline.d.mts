export type Ratification = "commit" | "lost" | "signature";
export interface OutcomeEntry {
    readonly source: string;
    readonly commit: string | null;
    readonly sha256: string;
    readonly ratification: Ratification;
    readonly reason?: string;
}
export interface OutcomeBaseline {
    readonly edition: "1.0.0";
    readonly outcomes: readonly OutcomeEntry[];
}
export interface OutcomeProvenance {
    readonly recorded: number;
    readonly ratified: number;
    readonly unverifiable: number;
    readonly signed: number;
}
export interface OutcomeBaselineUpdate {
    readonly baseline: OutcomeBaseline;
    readonly additions: readonly string[];
    readonly restorations: readonly string[];
    readonly regressions: readonly string[];
}
export interface ResolutionLedger {
    readonly entries: readonly unknown[];
}
export function outcomeFingerprint(outcome: unknown): string;
export function surveyOutcomes(resolutions: ResolutionLedger, root?: string): OutcomeEntry[];
export function verifyOutcomeLedger(
    resolutions: ResolutionLedger,
    baseline: OutcomeBaseline,
    root?: string
): OutcomeProvenance;
export function updateOutcomeBaseline(
    resolutions: ResolutionLedger,
    previous: OutcomeBaseline | undefined,
    reason: string | undefined,
    root?: string
): OutcomeBaselineUpdate;
