export interface SourceRemovalApproval {
    path: string;
    owner: string;
    replacements: string[];
    rationale: string;
    original: {
        baseCommit: string;
        sha256: string;
    };
    review: {
        disposition: {
            owner: string;
            commit: string;
        };
        resolution: {
            source: string;
            sha256: string;
        };
        transition: string;
    };
    tests: string[];
    digest: string;
}

export interface SourceRemovalApprovalDocument {
    edition: string;
    approvals: SourceRemovalApproval[];
}

export interface SourceRemovalValidationContext {
    seed: {
        baseCommit: string;
        files: Record<string, { sha256: string }>;
    };
    currentCoverage: ReadonlyMap<string, unknown> | ReadonlySet<string>;
    patterns: ReadonlyMap<string, string>;
    executed: ReadonlySet<string>;
    bom: {
        entries: Array<{
            owner: string;
            commit: string;
            artifacts: Array<{
                source: string;
                destination: string;
                sourceSha256: string;
                sha256: string;
            }>;
        }>;
    };
    dispositions: {
        waves: Array<{ owner: string; commit: string | null; state: string }>;
    };
    resolutions: {
        entries: Array<
            | [string, string, string, unknown]
            | {
                  source: string;
                  sourceSha256: string;
                  archive: string;
                  archiveSha256: string;
                  state: string;
                  completion: unknown;
              }
        >;
    };
    transitions: Array<{
        id: string;
        state: string;
        canonicalOwner: string;
        inputs: Array<{ owner: string; commit: string }>;
        acceptance: string[];
        allowedForeignPaths: string[];
        completion?: null | { tests: string[]; checks?: string[] };
    }>;
    stage?: "building" | "final";
}

export function approvedSourceRemovals(
    seed: SourceRemovalValidationContext["seed"],
    currentCoverage: SourceRemovalValidationContext["currentCoverage"],
    stage?: "building" | "final"
): Promise<Set<string>>;
export function validateSourceRemovalApprovals(
    document: SourceRemovalApprovalDocument,
    context: SourceRemovalValidationContext
): Set<string>;
export function sourceRemovalDigest(approval: SourceRemovalApproval): string;
