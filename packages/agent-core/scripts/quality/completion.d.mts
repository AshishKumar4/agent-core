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
export function verifyCompletionArtifacts(
    label: string,
    completion: Completion,
    root?: string
): boolean;
