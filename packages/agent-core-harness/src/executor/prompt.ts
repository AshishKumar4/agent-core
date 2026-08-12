import { ContentStore } from "@agent-core/core/content";
import type { ContentRef } from "@agent-core/core/core";
import { TurnPromptAssembler, type TurnPromptAssembly } from "@agent-core/core/agents/runs";
import { Transcript, TranscriptCodec, UserMessage } from "../transcript.js";

/**
 * Assembles the Turn's starting Transcript from the Agent's instructions and the
 * Turn's own input. The branch's committed history is deliberately not re-derived
 * here: the input ContentRef already names the Transcript the caller admitted, so the
 * assembler never becomes a second source of conversation truth.
 */
export class TranscriptPromptAssembler extends TurnPromptAssembler {
    public constructor(
        private readonly instructions: string,
        private readonly content: ContentStore
    ) {
        super();
    }

    public async assemble(request: TurnPromptAssembly): Promise<ContentRef> {
        const input = await this.content.get(request.turn.input);
        const stored = await this.content.put(
            TranscriptCodec.encode(
                new Transcript(this.instructions, [new UserMessage(decodeText(input))])
            )
        );
        return stored.ref;
    }
}

function decodeText(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
