export interface QualityGraph {
    readonly edition: string;
    readonly nodes: Readonly<Record<string, readonly string[]>>;
    readonly stages: {
        readonly building: readonly string[];
        readonly final: readonly string[];
    };
}

export function validateGraph(graph: QualityGraph): void;
export function dependencyClosure(
    targets: readonly string[],
    nodes: QualityGraph["nodes"]
): Set<string>;
export function topologicalOrder(
    selected: ReadonlySet<string>,
    nodes: QualityGraph["nodes"]
): string[];
