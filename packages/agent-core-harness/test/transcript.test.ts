import { describe, expect, test } from "vitest";
import { encodeCanonicalJson } from "@agent-core/core/core";
import { BindingName } from "@agent-core/core/facets";
import {
    AssistantMessage,
    ToolCall,
    ToolCallId,
    ToolResultMessage,
    Transcript,
    TranscriptCodec,
    UserMessage
} from "../src/index";

const transcript = new Transcript("Be brief.", [
    new UserMessage("Where did I park?"),
    new AssistantMessage("Checking.", [
        new ToolCall(new ToolCallId("call-1"), new BindingName("recall"), { query: "parking" })
    ]),
    new ToolResultMessage(new ToolCallId("call-1"), { level: 3 }, false)
]);

describe("Transcript record", () => {
    test("round-trips every message role through its codec", { tags: "p1" }, () => {
        expect(TranscriptCodec.decode(TranscriptCodec.encode(transcript))).toEqual(transcript);
    });

    test("encodes to identical bytes for identical content", { tags: "p1" }, () => {
        expect(TranscriptCodec.encode(transcript)).toEqual(
            TranscriptCodec.encode(
                new Transcript(transcript.instructions, [...transcript.messages])
            )
        );
    });

    test("appends without mutating the original", { tags: "p1" }, () => {
        const extended = transcript.append(new UserMessage("And my keys?"));
        expect(transcript.messages).toHaveLength(3);
        expect(extended.messages).toHaveLength(4);
    });

    test("rejects an unknown major version", { tags: "p1" }, () => {
        const bytes = encodeCanonicalJson({
            kind: "harness.transcript",
            version: { major: 2, minor: 0 },
            payload: { instructions: "", messages: [] }
        });
        expect(() => TranscriptCodec.decode(bytes)).toThrow(/major/u);
    });

    test("rejects malformed payloads with a stable code", { tags: "p1" }, () => {
        for (const payload of [
            { instructions: 1, messages: [] },
            { instructions: "", messages: {} },
            { instructions: "", messages: [{ role: "wizard" }] },
            { instructions: "", messages: [{ role: "user" }] },
            { instructions: "", messages: [{ role: "toolResult", call: "c", output: 1 }] }
        ]) {
            const bytes = encodeCanonicalJson({
                kind: "harness.transcript",
                version: { major: 1, minor: 0 },
                payload
            });
            expect(() => TranscriptCodec.decode(bytes)).toThrow();
        }
    });

    test("rejects duplicate tool call ids in one assistant message", { tags: "p1" }, () => {
        const call = new ToolCall(new ToolCallId("call-1"), new BindingName("recall"), {});
        expect(() => new AssistantMessage("", [call, call])).toThrow(/unique/u);
    });

    test("rejects an empty user message", { tags: "p2" }, () => {
        expect(() => new UserMessage("")).toThrow(/empty/u);
    });

    test("rejects non-object messages and absent required fields", { tags: "p2" }, () => {
        for (const payload of [
            { instructions: "", messages: ["not-an-object"] },
            { instructions: "", messages: [{ role: "assistant", text: "hi", toolCalls: [7] }] },
            {
                instructions: "",
                messages: [
                    { role: "assistant", text: "hi", toolCalls: [{ id: "c", binding: "b" }] }
                ]
            },
            {
                instructions: "",
                messages: [{ role: "toolResult", call: "c", failed: false }]
            }
        ]) {
            const bytes = encodeCanonicalJson({
                kind: "harness.transcript",
                version: { major: 1, minor: 0 },
                payload
            });
            expect(() => TranscriptCodec.decode(bytes)).toThrow();
        }
    });
});
