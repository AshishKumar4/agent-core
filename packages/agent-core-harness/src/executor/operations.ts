import {
    TurnBoundOperation,
    TurnOperationSource,
    type TurnExecutionScope
} from "@agent-core/core/agents/runs";

/**
 * Resolves the Turn's tool set from a fixed catalogue, keeping only the Operations
 * whose Facet is present in the Turn's immutable placement snapshot. The host
 * re-validates the same rule, so this narrows rather than grants.
 */
export class PlacementOperationSource extends TurnOperationSource {
    private readonly catalogue: readonly TurnBoundOperation[];

    public constructor(catalogue: readonly TurnBoundOperation[]) {
        super();
        this.catalogue = Object.freeze([...catalogue]);
    }

    public async resolve(scope: TurnExecutionScope): Promise<readonly TurnBoundOperation[]> {
        return Object.freeze(
            this.catalogue.filter((operation) =>
                scope.placement.placements.some((pin) => pin.facet.equals(operation.facet))
            )
        );
    }
}
