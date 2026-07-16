// @ts-nocheck
export function loadOwnership(): Promise<{
    readonly ownership: unknown;
    readonly patterns: ReadonlyMap<string, string>;
}>;
export function ownersForPath(path: string, patterns: ReadonlyMap<string, string>): string[];
export function deriveOwner(base: string): Promise<string | undefined>;
export function validateCompleteOwnership(): Promise<number>;
export function validateStageTransition(base: string): Promise<void>;
export function changedPaths(base: string): string[];
export function changedPathsBetween(base: string, candidate: string): string[];
export interface TransitionAuthorization {
    readonly id: string;
    readonly canonicalOwner: string;
    readonly participants: ReadonlySet<string>;
    readonly allowedForeignPaths: ReadonlySet<string>;
    readonly allowedForeignOwners: ReadonlyMap<string, string>;
    readonly deletedPaths?: ReadonlySet<string>;
    readonly allowedForeignDeletions?: ReadonlySet<string>;
}
export interface OwnershipViolation {
    readonly path: string;
    readonly owners: readonly string[];
    readonly reason: string;
}
export function validateOwnershipPaths(
    owner: string,
    paths: readonly string[],
    patterns: ReadonlyMap<string, string>,
    authorization?: TransitionAuthorization
): OwnershipViolation[];
export function loadTransitionAuthorization(
    transitionId: string,
    owner: string,
    patterns: ReadonlyMap<string, string>,
    paths?: readonly string[],
    base?: string,
    bom?: unknown
): Promise<TransitionAuthorization>;
export interface CandidateManifestEntry {
    readonly path: string;
    readonly owner: string;
    readonly sourceBlob: string;
    readonly candidateBlob: string;
    readonly disposition: "added" | "modified" | "deleted";
}
export function candidateManifestSha256(entries: readonly CandidateManifestEntry[]): string;
export function validateClosureManifest(
    transition: {
        readonly id: string;
        readonly inputs: readonly { readonly owner: string }[];
        readonly closureManifest?: {
            readonly base: string;
            readonly commit: string;
            readonly tree: string;
            readonly sha256: string;
            readonly paths: readonly CandidateManifestEntry[];
        };
        readonly completion?: { readonly commit: string };
    },
    patterns: ReadonlyMap<string, string>
): readonly CandidateManifestEntry[];
export function validateArchivedRequestDeletions(
    entries: readonly CandidateManifestEntry[],
    patterns: ReadonlyMap<string, string>,
    bom: unknown,
    closureCommit: string
): Promise<ReadonlySet<string>>;
export function validateRemediationManifest(
    transition: {
        readonly id: string;
        readonly inputs: readonly { readonly owner: string }[];
        readonly remediationManifest?: {
            readonly base: string;
            readonly commit: string;
            readonly tree: string;
            readonly sha256: string;
            readonly paths: readonly CandidateManifestEntry[];
        };
    },
    patterns: ReadonlyMap<string, string>
): readonly CandidateManifestEntry[];
export function validateCandidateChangeManifest(
    transition: {
        readonly id: string;
        readonly inputs: readonly { readonly owner: string }[];
        readonly changeManifest?: {
            readonly base: string;
            readonly sha256: string;
            readonly paths: readonly {
                readonly path: string;
                readonly owner: string;
                readonly sourceBlob: string;
                readonly candidateBlob: string;
                readonly disposition: "added" | "modified" | "deleted";
            }[];
        };
    },
    paths: readonly string[],
    patterns: ReadonlyMap<string, string>,
    base: string
): readonly CandidateManifestEntry[];
export function validateCompletedCandidateManifest(
    transition: Parameters<typeof validateCandidateChangeManifest>[0] & {
        readonly completion: { readonly commit: string };
    },
    patterns: ReadonlyMap<string, string>
): readonly CandidateManifestEntry[];
export function validateCandidateWorktreeManifest(transition: {
    readonly id: string;
    readonly changeManifest: { readonly paths: readonly CandidateManifestEntry[] };
}): void;
