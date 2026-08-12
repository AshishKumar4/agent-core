import type { JsonSchemaDocument } from "@agent-core/core/core";
import type { TurnModelUsage } from "@agent-core/core/agents/runs";
import type { Transcript } from "../transcript";
import type { AssistantMessage } from "../transcript";

/** One tool as the provider sees it: the binding name plus the Operation's input schema. */
export interface ModelToolSpec {
    readonly name: string;
    readonly description: string;
    readonly input: JsonSchemaDocument;
}

export interface ModelRequest {
    readonly transcript: Transcript;
    readonly tools: readonly ModelToolSpec[];
    readonly signal: AbortSignal;
}

export interface ModelCompletion {
    readonly message: AssistantMessage;
    readonly usage: TurnModelUsage;
}

/**
 * The single external seam of the harness. Everything above it is deterministic and
 * testable; only this talks to a network.
 */
export abstract class ModelProvider {
    public abstract complete(request: ModelRequest): Promise<ModelCompletion>;
}
