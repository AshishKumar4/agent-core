import type { FacetSet, OperationCatalog, SurfaceSet } from "../facets";
import type { OperationContext } from "../operations";
import type { Telemetry } from "../observability";
import type { Agent } from "./agent";
import type { BindingSet } from "./binding";
import { AgentPrompt } from "./prompt";
import type { Run } from "./runs";

export class RuntimeContext {
    public constructor(
        public readonly agent: Agent,
        public readonly run: Run,
        public readonly operation: OperationContext,
        public readonly telemetry: Telemetry,
        public readonly bindings: BindingSet
    ) {
    }

    public get facets(): FacetSet {
        return this.bindings.facets;
    }

    public prompt(): AgentPrompt {
        return AgentPrompt.fromFacets(this.facets);
    }

    public operationCatalog(): OperationCatalog {
        return this.bindings.operations();
    }

    public surfaceSet(): SurfaceSet {
        return this.bindings.surfaces();
    }
}
