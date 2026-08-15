import type { DoctrineRule } from "./doctrine.mjs";

export type ChangeTier = "P" | "I" | "L" | "D" | "S";

export interface ChangeClassification {
    readonly categories: readonly ChangeTier[];
    readonly tier: ChangeTier;
}

export interface ChangeMetadata {
    readonly tier: ChangeTier;
    readonly ruleIds: readonly string[];
    readonly integrityCorrection: string | undefined;
}

export interface ChangeControlArguments {
    readonly base: string;
    readonly head: string;
    readonly event: string | undefined;
    readonly repository: string | undefined;
    readonly body: string | undefined;
}

export interface PullRequestReview {
    readonly id: number;
    readonly state: string;
    readonly commit_id: string;
    readonly user?: { readonly login?: string };
}
export interface VerifiedCommitApproval {
    readonly oid?: string;
    readonly signature?: {
        readonly isValid?: boolean;
        readonly state?: string;
        readonly wasSignedByGitHub?: boolean;
        readonly signature?: string;
        readonly payload?: string;
        readonly verifiedAt?: string;
        readonly signer?: { readonly login?: string };
    };
}

export function classifyChange(
    paths: readonly string[],
    lockChanged: boolean,
    claimSurfaces: ReadonlySet<string>
): ChangeClassification;
export function validateReviewedBase(mergeBase: string, base: string): void;
export function parseChangeMetadata(body: string, knownRules: ReadonlySet<string>): ChangeMetadata;
export function parseChangeControlArguments(args: readonly string[]): ChangeControlArguments;
export function validateExactHeadApproval(
    reviews: readonly PullRequestReview[],
    trustedReviewers: ReadonlySet<string>,
    head: string
): string;
export function validateVerifiedCommitApproval(
    commit: VerifiedCommitApproval,
    trustedReviewers: ReadonlySet<string>,
    head: string
): string;
export function ownersForProtectedPath(
    source: string,
    protectedPath: string,
    bootstrapPath: string,
    bootstrap: boolean
): Set<string>;
export function enforceNormativeFreeze(
    paths: readonly string[],
    policy: { readonly adoptionBase: string; readonly rules: readonly DoctrineRule[] },
    metadata: Pick<ChangeMetadata, "integrityCorrection">,
    base: string
): void;
export function validateIntegrityCorrection(
    record: IntegrityCorrectionRecord,
    id: string,
    knownRules: ReadonlySet<string>,
    expectedDigests: IntegrityDigests
): void;
export interface IntegrityDigests {
    readonly beforeNormativeManifest: string;
    readonly afterNormativeManifest: string;
    readonly beforeSpec: string;
    readonly afterSpec: string;
}
export interface IntegrityCorrectionRecord {
    readonly edition?: string;
    readonly id?: string;
    readonly task?: string;
    readonly obstruction?: string;
    readonly weakeningRejected?: string;
    readonly recommendation?: string;
    readonly ruleIds?: readonly string[];
    readonly alternatives?: readonly string[];
    readonly evidence?: readonly string[];
    readonly affectedClaimIds?: readonly string[];
    readonly beforeNormativeManifest?: string;
    readonly afterNormativeManifest?: string;
    readonly beforeSpec?: string;
    readonly afterSpec?: string;
    readonly adversaryReview?: {
        readonly mode?: string;
        readonly verdict?: string;
        readonly report?: string;
    };
}
export interface MergedPull {
    readonly merged_at: string | null;
    readonly merge_commit_sha: string | null;
    readonly base?: { readonly sha?: string };
}
export function selectMergedPull(
    pulls: readonly MergedPull[],
    head: string,
    base: string
): MergedPull | undefined;
export interface BootstrapDoctrinePolicy {
    readonly adoptionBase: string;
    readonly edition: string;
    readonly tierOrder: readonly string[];
    readonly approvalTiers: readonly string[];
    readonly trustRoot: {
        readonly path: string;
        readonly protectedPath: string;
        readonly bootstrapPath: string;
    };
}
export function selectEffectivePolicy<Policy extends BootstrapDoctrinePolicy>(
    basePolicy: Policy | undefined,
    candidatePolicy: Policy,
    base: string
): Policy;
