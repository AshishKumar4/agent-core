import type { FacetSet, OperationCatalog, SurfaceSet } from "../facets";
import type { AgentPrompt } from "./prompt";
import type { RuntimeContext } from "./context";
import type { TurnOutcome } from "./runs";

export abstract class AgentRuntime {
    protected constructor(public readonly context: RuntimeContext) {
    }

    public get facets(): FacetSet {
        return this.context.facets;
    }

    public prompt(): AgentPrompt {
        return this.context.prompt();
    }

    public operationCatalog(): OperationCatalog {
        return this.context.operationCatalog();
    }

    public surfaceSet(): SurfaceSet {
        return this.context.surfaceSet();
    }

    public async start(): Promise<void> {
        await this.context.facets.start(this.context.operation);
    }

    public async stop(): Promise<void> {
        await this.context.facets.stop(this.context.operation);
    }

    public abstract execute(): Promise<TurnOutcome>;

}
