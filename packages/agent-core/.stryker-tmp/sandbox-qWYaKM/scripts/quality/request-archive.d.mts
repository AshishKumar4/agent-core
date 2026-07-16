// @ts-nocheck
export interface CompletionArtifact {
    readonly path: string;
    readonly blob: string;
    readonly sha256: string;
}
export interface Completion {
    readonly commit: string;
    readonly tree: string;
    readonly artifacts: readonly CompletionArtifact[];
}
export interface FinalResolution {
    readonly source: string;
    readonly sourceSha256: string;
    readonly archive: string | null;
    readonly archiveSha256: string | null;
    readonly state: string;
    readonly completion: Completion | null;
    readonly outcome?: {
        readonly kind: string;
        readonly treatment: string;
        readonly commit: string;
        readonly tree: string;
        readonly rationale: string;
        readonly tests: readonly string[];
        readonly checks: readonly string[];
        readonly artifacts: readonly CompletionArtifact[];
        readonly items: readonly {
            readonly obligationId: string;
            readonly source: string;
            readonly anchor: string;
            readonly atomSha256: string;
            readonly treatment: string;
            readonly rationale: string;
            readonly artifactPaths: readonly string[];
            readonly tests: readonly string[];
            readonly checks: readonly string[];
        }[];
    };
    readonly externalItems?: readonly {
        readonly obligationId: string;
        readonly source: string;
        readonly anchor: string;
        readonly atomSha256: string;
        readonly treatment: "external-gated";
        readonly consentRequestId: string;
    }[];
}
export function isRequestSource(path: string): boolean;
export function normalizeResolutions(document: {
    readonly entries: readonly (
        readonly [string, string, string, Completion | null] | FinalResolution
    )[];
}): FinalResolution[];
export const requestArchivePrefix: string;
export function validateFinalRequestArchive(context: {
    readonly archive: {
        readonly entries: readonly {
            readonly owner: string;
            readonly source: string;
            readonly sourceSha256: string;
            readonly path: string;
            readonly sha256: string;
        }[];
    };
    readonly resolutions: { readonly entries: readonly FinalResolution[] };
    readonly bom: {
        readonly entries: readonly {
            readonly owner: string;
            readonly artifacts: readonly {
                readonly source: string;
                readonly destination: string;
                readonly sourceSha256: string;
                readonly sha256: string;
            }[];
        }[];
    };
    readonly archiveFiles?: readonly string[];
    readonly resolvePath?: (path: string) => string;
    readonly completionRoot?: string;
    readonly verifyCompletionEvidence?: (
        label: string,
        completion: Completion,
        root?: string
    ) => void;
    readonly requireOutcome?: boolean;
}): Promise<ReadonlyMap<string, unknown>>;
