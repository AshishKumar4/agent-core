export type DoctrineState = "active" | "milestone-gated";
export type DoctrineCheckerPath =
    | "scripts/check-normative.mjs"
    | "scripts/quality/backlog.mjs"
    | "scripts/quality/change-control.mjs"
    | "scripts/quality/claims.mjs"
    | "scripts/quality/doctrine.mjs";

export interface DoctrineRule {
    readonly id: string;
    readonly state: DoctrineState;
    readonly checker: DoctrineCheckerPath;
    readonly testSelectors: readonly string[];
    readonly milestone?: string;
}

export interface GitHubDefaultBranchControlsOracle {
    readonly kind: "github-default-branch-controls";
    readonly repository: string;
    readonly branch: string;
    readonly requiredChecks: readonly string[];
    readonly allowBypass: boolean;
    readonly approvalRoutes: string;
    readonly codeOwnerRoute: string;
    readonly signatureRoute: string;
}

export interface TypedSourceObligationsOracle {
    readonly kind: "typed-source-obligations";
    readonly source: string;
    readonly schema: "traceability-source-obligation-v1";
    readonly expectedLegacyCount: number;
}

export interface TraceabilitySourceOracle {
    readonly kind: string;
    readonly selector: string;
    readonly expected: string;
}

export interface TraceabilitySourceObligation {
    readonly id: string;
    readonly summary: string;
    readonly disposition: "candidate" | "permanent-boundary" | "mechanize" | "conformance";
    readonly owner: string;
    readonly priority: number;
    readonly oracle: TraceabilitySourceOracle;
}

export interface CheckerArtifactsOracle {
    readonly kind: "checker-artifacts";
    readonly checker: string;
    readonly registry: string;
    readonly evidence: string;
    readonly expected: string;
}

export interface CompositeCheckerArtifactsOracle {
    readonly kind: "composite-checker-artifacts";
    readonly transpilerChecker: string;
    readonly transpilerEvidence: string;
    readonly quintChecker: string;
    readonly quintEvidence: string;
    readonly expected: string;
}

export type DoctrineMilestoneOracle =
    | GitHubDefaultBranchControlsOracle
    | TypedSourceObligationsOracle
    | CheckerArtifactsOracle
    | CompositeCheckerArtifactsOracle;

export interface DoctrinePolicy {
    readonly edition: "1.0.0";
    readonly adoptionBase: string;
    readonly tierOrder: readonly string[];
    readonly approvalTiers: readonly string[];
    readonly trustRoot: {
        readonly path: string;
        readonly protectedPath: string;
        readonly bootstrapPath: string;
    };
    readonly formalScope: { readonly source: string };
    readonly claimSurfaces: readonly string[];
    readonly rules: readonly DoctrineRule[];
    readonly infrastructureObligations: readonly {
        readonly id: string;
        readonly disposition: string;
        readonly owner: string;
        readonly priority: number;
        readonly oracle: DoctrineMilestoneOracle;
    }[];
}

export interface FormalBoundary {
    readonly requiredAreaIds: readonly string[];
    readonly areas: readonly { readonly id: string }[];
}

export function validateDoctrinePolicy(
    policy: DoctrinePolicy,
    doctrine: string,
    traceability: {
        readonly formalBoundary: FormalBoundary;
        readonly requirements: readonly {
            readonly id: string;
            readonly remainingEvidence: readonly (string | TraceabilitySourceObligation)[];
        }[];
    }
): void;
export function readDoctrinePolicy(): Promise<DoctrinePolicy>;
export function documentedRuleIds(doctrine: string): string[];
export function validateFormalBoundary(boundary: FormalBoundary): void;
export function validateWorkflowSource(source: string): void;
