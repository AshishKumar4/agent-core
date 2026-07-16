// @ts-nocheck
export interface RequestObligation {
    readonly obligationId: string;
    readonly source: string;
    readonly sourceSha256: string;
    readonly anchor: string;
    readonly atomSha256: string;
}

export function extractRequestObligations(
    source: string,
    sourceSha256: string,
    bytes: string
): readonly RequestObligation[];
