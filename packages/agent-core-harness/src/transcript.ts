import {
    RecordCodec,
    TextId,
    isJsonObject,
    type JsonObject,
    type JsonValue,
    type RecordVersion
} from "@agent-core/core/core";
import { BindingName, canonicalFacetData, type FacetData } from "@agent-core/core/facets";
import { HarnessError } from "./error.js";

/**
 * Identifies one tool call inside one Transcript. The model echoes it back on the
 * result, and the loop derives the mediated request key from it, so it must be stable
 * across a replayed step rather than freshly generated.
 */
export class ToolCallId extends TextId {
    public constructor(value: string) {
        super(value, "Tool call id");
        Object.freeze(this);
    }
}

export class ToolCall {
    public constructor(
        public readonly id: ToolCallId,
        public readonly binding: BindingName,
        public readonly input: FacetData
    ) {
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return {
            id: this.id.value,
            binding: this.binding.value,
            input: canonicalFacetData(this.input)
        };
    }

    public static fromData(value: JsonValue): ToolCall {
        const record = requireObject(value, "Tool call");
        return new ToolCall(
            new ToolCallId(requireString(record["id"], "Tool call id")),
            new BindingName(requireString(record["binding"], "Tool call binding")),
            requireDefined(record["input"], "Tool call input")
        );
    }
}

/**
 * One turn-of-conversation entry. Roles are separate classes rather than a tagged
 * union so each carries only the fields it can legally have.
 */
export abstract class TranscriptMessage {
    public abstract readonly role: "user" | "assistant" | "toolResult";
    public abstract toData(): JsonObject;

    public static fromData(value: JsonValue): TranscriptMessage {
        const record = requireObject(value, "Transcript message");
        const role = requireString(record["role"], "Transcript message role");
        if (role === "user") return UserMessage.fromData(record);
        if (role === "assistant") return AssistantMessage.fromData(record);
        if (role === "toolResult") return ToolResultMessage.fromData(record);
        throw new HarnessError("transcript.invalid", `Unknown transcript role ${role}`);
    }
}

export class UserMessage extends TranscriptMessage {
    public readonly role = "user" as const;

    public constructor(public readonly text: string) {
        super();
        if (text.length === 0) throw new TypeError("User message text must not be empty");
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return { role: this.role, text: this.text };
    }

    public static fromData(record: JsonObject): UserMessage {
        return new UserMessage(requireString(record["text"], "User message text"));
    }
}

export class AssistantMessage extends TranscriptMessage {
    public readonly role = "assistant" as const;
    public readonly text: string;
    public readonly toolCalls: readonly ToolCall[];

    public constructor(text: string, toolCalls: readonly ToolCall[] = []) {
        super();
        const seen = new Set<string>();
        for (const call of toolCalls) {
            if (seen.has(call.id.value)) {
                throw new TypeError("Assistant tool call ids must be unique within one message");
            }
            seen.add(call.id.value);
        }
        this.text = text;
        this.toolCalls = Object.freeze([...toolCalls]);
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return {
            role: this.role,
            text: this.text,
            toolCalls: this.toolCalls.map((call) => call.toData())
        };
    }

    public static fromData(record: JsonObject): AssistantMessage {
        return new AssistantMessage(
            requireString(record["text"], "Assistant message text"),
            requireArray(record["toolCalls"], "Assistant tool calls").map(ToolCall.fromData)
        );
    }
}

export class ToolResultMessage extends TranscriptMessage {
    public readonly role = "toolResult" as const;

    public constructor(
        public readonly call: ToolCallId,
        public readonly output: FacetData,
        public readonly failed: boolean
    ) {
        super();
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return {
            role: this.role,
            call: this.call.value,
            output: canonicalFacetData(this.output),
            failed: this.failed
        };
    }

    public static fromData(record: JsonObject): ToolResultMessage {
        return new ToolResultMessage(
            new ToolCallId(requireString(record["call"], "Tool result call")),
            requireDefined(record["output"], "Tool result output"),
            requireBoolean(record["failed"], "Tool result failure flag")
        );
    }
}

/**
 * The complete conversation state the model sees. It is content-addressed on every
 * step, so the ContentRef crossing `TurnModelPort` names exactly these bytes.
 */
export class Transcript {
    public readonly messages: readonly TranscriptMessage[];

    public constructor(
        public readonly instructions: string,
        messages: readonly TranscriptMessage[]
    ) {
        this.messages = Object.freeze([...messages]);
        Object.freeze(this);
    }

    public append(...messages: readonly TranscriptMessage[]): Transcript {
        return new Transcript(this.instructions, [...this.messages, ...messages]);
    }

    public toData(): JsonObject {
        return {
            instructions: this.instructions,
            messages: this.messages.map((message) => message.toData())
        };
    }

    public static fromData(value: JsonValue): Transcript {
        const record = requireObject(value, "Transcript");
        return new Transcript(
            requireString(record["instructions"], "Transcript instructions"),
            requireArray(record["messages"], "Transcript messages").map(TranscriptMessage.fromData)
        );
    }
}

class TranscriptRecordCodec extends RecordCodec<Transcript> {
    public constructor() {
        super("harness.transcript", { major: 1, minor: 0 });
        Object.freeze(this);
    }

    protected encodePayload(record: Transcript): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Transcript {
        return Transcript.fromData(payload);
    }
}

export const TranscriptCodec: RecordCodec<Transcript> = new TranscriptRecordCodec();

/** A JSON string is exactly the value that is its own string rendering. */
function isJsonString(value: JsonValue | undefined): value is string {
    return value === String(value);
}

function requireObject(value: JsonValue | undefined, subject: string): JsonObject {
    if (!isJsonObject(value)) {
        throw new HarnessError("transcript.invalid", `${subject} must be an object`);
    }
    return value;
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (!isJsonString(value)) {
        throw new HarnessError("transcript.invalid", `${subject} must be a string`);
    }
    return value;
}

function requireBoolean(value: JsonValue | undefined, subject: string): boolean {
    if (value !== true && value !== false) {
        throw new HarnessError("transcript.invalid", `${subject} must be a boolean`);
    }
    return value;
}

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new HarnessError("transcript.invalid", `${subject} must be an array`);
    }
    return value;
}

function requireDefined(value: JsonValue | undefined, subject: string): FacetData {
    if (value === undefined) {
        throw new HarnessError("transcript.invalid", `${subject} is required`);
    }
    return value;
}
