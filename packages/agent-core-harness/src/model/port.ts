import { ContentStore } from "@agent-core/core/content";
import {
    TurnModelPort,
    type TurnBoundOperation,
    type TurnModelCall,
    type TurnModelResult
} from "@agent-core/core/agents/runs";
import { AssistantMessage, Transcript, TranscriptCodec } from "../transcript";
import { HarnessError } from "../error";
import { ModelProvider, type ModelToolSpec } from "./provider";

/**
 * Binds a `ModelProvider` to the kernel's content-addressed model seam: the prompt
 * arrives as a ContentRef naming exactly one Transcript, and the reply leaves as a
 * ContentRef naming exactly one assistant message. The port never touches Run state.
 */
export class TranscriptTurnModelPort extends TurnModelPort {
    public constructor(
        private readonly provider: ModelProvider,
        private readonly content: ContentStore
    ) {
        super();
    }

    public async call(request: TurnModelCall): Promise<TurnModelResult> {
        const transcript = TranscriptCodec.decode(await this.content.get(request.prompt));
        const completion = await this.provider.complete(
            Object.freeze({
                transcript,
                tools: toolSpecs(request.operations),
                signal: request.signal
            })
        );
        requireDeclaredTools(completion.message, request.operations);
        const stored = await this.content.put(
            AssistantMessageCodec.encode(completion.message),
            undefined
        );
        return Object.freeze({ output: stored.ref, usage: completion.usage });
    }
}

/**
 * The model's own reply is content-addressed on its own, so a Turn's message commit
 * names exactly the bytes the provider produced.
 */
export const AssistantMessageCodec = Object.freeze({
    encode(message: AssistantMessage): Uint8Array {
        return TranscriptCodec.encode(new Transcript("", [message]));
    },
    decode(bytes: Uint8Array): AssistantMessage {
        const transcript = TranscriptCodec.decode(bytes);
        const message = transcript.messages[0];
        if (transcript.messages.length !== 1 || !(message instanceof AssistantMessage)) {
            throw new HarnessError(
                "transcript.invalid",
                "Model output must carry exactly one assistant message"
            );
        }
        return message;
    }
});

function toolSpecs(operations: readonly TurnBoundOperation[]): readonly ModelToolSpec[] {
    return Object.freeze(
        operations.map((operation) =>
            Object.freeze({
                name: operation.binding.value,
                description: operation.descriptor.help ?? operation.descriptor.name.value,
                input: operation.descriptor.input.document
            })
        )
    );
}

function requireDeclaredTools(
    message: AssistantMessage,
    operations: readonly TurnBoundOperation[]
): void {
    for (const call of message.toolCalls) {
        if (!operations.some((operation) => operation.binding.equals(call.binding))) {
            throw new HarnessError(
                "model.unknown-tool",
                `Model requested undeclared tool ${call.binding.value}`
            );
        }
    }
}
