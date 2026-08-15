export interface BacklogOracle {
    readonly kind: string;
    readonly [field: string]: string | number | boolean | readonly string[];
}

export interface BacklogItem {
    readonly id: string;
    readonly type: string;
    readonly source: Readonly<Record<string, string | number>>;
    readonly owner: string;
    readonly priority: number;
    readonly summary: string;
    readonly notes: readonly string[];
    readonly oracle: BacklogOracle;
}

export interface Backlog {
    readonly edition: "1.0.0";
    readonly generatedFrom: Readonly<Record<string, string>>;
    readonly items: readonly BacklogItem[];
}

export interface BacklogPolicy {
    readonly rules: readonly {
        readonly id: string;
        readonly state: string;
        readonly milestone?: string;
    }[];
    readonly infrastructureObligations: readonly {
        readonly id: string;
        readonly disposition: string;
        readonly owner: string;
        readonly priority: number;
        readonly oracle: BacklogOracle;
    }[];
}

export interface BacklogTraceability {
    readonly requirements: readonly {
        readonly id: string;
        readonly remainingEvidence: readonly (string | TraceabilitySourceObligation)[];
    }[];
    readonly releaseChain: {
        readonly entries: readonly Readonly<
            Record<string, string | readonly string[] | LinkState>
        >[];
    };
}

export interface TraceabilitySourceObligation {
    readonly id: string;
    readonly summary: string;
    readonly disposition: string;
    readonly owner: string;
    readonly priority: number;
    readonly oracle: BacklogOracle & {
        readonly selector: string;
        readonly expected: string;
    };
}

export interface LinkState {
    readonly status: string;
    readonly reason: string;
}

export interface ConformanceFragment {
    readonly requirements: readonly {
        readonly id: string;
        readonly owner: string;
        readonly status: string;
        readonly remainingEvidence: readonly string[];
    }[];
}

export function deriveBacklog(
    policy: BacklogPolicy,
    traceability: BacklogTraceability,
    conformanceFragments: readonly ConformanceFragment[]
): Backlog;
export function validateSources(items: readonly BacklogItem[]): void;
