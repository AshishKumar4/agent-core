export interface BomArtifactIdentity {
    readonly source: string;
    readonly destination: string;
}

export interface BomEntryIdentity {
    readonly artifacts: readonly BomArtifactIdentity[];
}

export function validateBomImportDenominator(
    entries: readonly BomEntryIdentity[],
    pendingImmutableInputs: ReadonlySet<string>
): { readonly requestCount: number; readonly pendingCount: number };
