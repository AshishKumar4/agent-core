import { ContentStore } from "@agent-core/core/content";
import {
    TurnModelPort,
    type TurnBoundOperation,
    type TurnModelCall,
    type TurnModelResult,
    type TurnShownSection
} from "@agent-core/core/agents/runs";
import { AssistantMessage, Transcript, TranscriptCodec } from "../transcript.js";
import { HarnessError } from "../error.js";
import { ModelProvider, type ModelToolSpec } from "./provider.js";

/**
 * Binds a `ModelProvider` to the kernel's content-addressed model seam: the request
 * arrives as the reconstruction of a committed model input, whose one shown section holds
 * exactly one Transcript, and the reply leaves as a ContentRef naming exactly one
 * assistant message. The port never touches Run state.
 */
export class TranscriptTurnModelPort extends TurnModelPort {
    public constructor(
        private readonly provider: ModelProvider,
        private readonly content: ContentStore
    ) {
        super();
    }

    public async call(request: TurnModelCall): Promise<TurnModelResult> {
        const transcript = TranscriptCodec.decode(shownTranscript(request.sections));
        const completion = await this.provider.complete(
            Object.freeze({
                transcript,
                tools: toolSpecs(request.catalog),
                signal: request.signal
            })
        );
        requireDeclaredTools(completion.message, request.catalog);
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

/**
 * The Transcript the model was shown. This harness assembles the conversation as one
 * section, so a request carrying any other count was not assembled by it and the port
 * refuses it rather than guessing which part is the conversation. Nothing is fetched: the
 * reconstruction already resolved every section's bytes, whether it held them inline or by
 * reference.
 */
function shownTranscript(sections: readonly TurnShownSection[]): Uint8Array {
    const section = sections[0];
    if (sections.length !== 1 || section === undefined) {
        throw new HarnessError(
            "transcript.invalid",
            `A model request must show exactly one Transcript section, not ${sections.length}`
        );
    }
    return section.bytes;
}

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
