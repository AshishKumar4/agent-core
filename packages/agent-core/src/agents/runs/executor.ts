import type { ContentRef } from "../../core";
import type { RunCommitId } from "../../execution-references";
import type { RunCommit } from "./commit";
import type { RunCheckpoint, Turn, TurnInboxEntry } from "./turn";
import type { TurnPlacementSnapshot } from "./placement";

export interface TurnResolvedFacet {
    readonly ref: string;
    readonly operations: readonly string[];
}

export type TurnOutcome =
    | { readonly kind: "succeeded"; readonly result: ContentRef }
    | { readonly kind: "failed"; readonly result: ContentRef }
    | { readonly kind: "suspended"; readonly checkpoint: RunCheckpoint }
    | { readonly kind: "cancelled"; readonly result?: ContentRef };

export abstract class TurnCommitHandle {
    public abstract append(commit: RunCommit): Promise<RunCommitId>;
}

export abstract class TurnCheckpointHandle {
    public abstract persist(checkpoint: RunCheckpoint): Promise<RunCommitId>;
}

export abstract class TurnInvocationHandle {
    public abstract invoke(operation: string, input: ContentRef): Promise<ContentRef>;
}

export abstract class TurnInboxHandle {
    public abstract read(afterSequence: number): Promise<readonly TurnInboxEntry[]>;
}

export interface TurnContext {
    readonly turn: Turn;
    readonly effectiveCommit: RunCommitId;
    readonly placement: TurnPlacementSnapshot;
    readonly resolvedFacets: readonly TurnResolvedFacet[];
    readonly operationCatalog: readonly string[];
    readonly prompt: ContentRef;
    readonly inbox: TurnInboxHandle;
    readonly commit: TurnCommitHandle;
    readonly checkpoint: TurnCheckpointHandle;
    readonly invocation: TurnInvocationHandle;
    readonly cancellation: AbortSignal;
}

export abstract class TurnExecutor {
    public abstract execute(turn: TurnContext): Promise<TurnOutcome>;
}
