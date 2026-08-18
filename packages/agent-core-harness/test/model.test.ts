import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "@agent-core/core/content";
import type { JsonValue } from "@agent-core/core/core";
import {
    AssistantMessage,
    AssistantMessageCodec,
    OpenAiCompatibleModelProvider,
    ToolCall,
    ToolCallId,
    Transcript,
    TranscriptCodec,
    TranscriptMessage,
    TranscriptTurnModelPort,
    ToolResultMessage,
    ModelProvider,
    UserMessage,
    aiGatewayEndpoint,
    workersAiEndpoint
} from "../src/index";
import { boundOperation, ids, modelCall } from "./fixture";
import {
    BindingName,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "@agent-core/core/facets";
import { JsonSchema } from "@agent-core/core/core";
import { TurnBoundOperation } from "@agent-core/core/agents/runs";
import type { ModelCompletion, ModelRequest, ModelToolSpec } from "../src/index";

/** The one seam a port test needs from a provider: the completion it returns. */
class StubModelProvider extends ModelProvider {
    public constructor(
        private readonly respond: (request: ModelRequest) => Promise<ModelCompletion>
    ) {
        super();
    }

    public async complete(request: ModelRequest): Promise<ModelCompletion> {
        return this.respond(request);
    }
}

function respondWith(body: string, status = 200): typeof globalThis.fetch {
    return async () => new Response(body, { status });
}

function provider(fetch: typeof globalThis.fetch): OpenAiCompatibleModelProvider {
    return new OpenAiCompatibleModelProvider({
        endpoint: workersAiEndpoint("account-1"),
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        credential: async () => "token",
        fetch
    });
}

const request = Object.freeze({
    transcript: new Transcript("Be brief.", [new UserMessage("Hello")]),
    tools: [],
    signal: new AbortController().signal
});

describe("OpenAI-compatible model provider", () => {
    test("reads a plain completion and its usage", { tags: "p1" }, async () => {
        const completion = await provider(
            respondWith(
                JSON.stringify({
                    choices: [{ message: { content: "Hi." } }],
                    usage: { prompt_tokens: 5, completion_tokens: 2 }
                })
            )
        ).complete(request);

        expect(completion.message).toEqual(new AssistantMessage("Hi."));
        expect(completion.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    });

    test(
        "reads tool calls whose arguments are ordinary, non-canonical JSON",
        { tags: "p1" },
        async () => {
            const completion = await provider(
                respondWith(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content: null,
                                    tool_calls: [
                                        {
                                            id: "call-1",
                                            type: "function",
                                            function: {
                                                name: "recall",
                                                // Deliberately unsorted keys: a provider is
                                                // under no obligation to emit canonical JSON.
                                                arguments: '{"query":"parking","limit":2}'
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    })
                )
            ).complete(request);

            expect(completion.message.text).toBe("");
            expect(completion.message.toolCalls).toEqual([
                new ToolCall(new ToolCallId("call-1"), new BindingName("recall"), {
                    query: "parking",
                    limit: 2
                })
            ]);
            expect(completion.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
        }
    );

    test("treats empty tool call arguments as an empty object", { tags: "p2" }, async () => {
        const completion = await provider(
            respondWith(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: "",
                                tool_calls: [
                                    { id: "c", function: { name: "recall", arguments: "" } }
                                ]
                            }
                        }
                    ]
                })
            )
        ).complete(request);
        expect(completion.message.toolCalls[0]?.input).toEqual({});
    });

    test(
        "rejects tool calls with malformed identity or function fields",
        { tags: "p2" },
        async () => {
            for (const call of [
                { id: "c", function: { name: 7, arguments: "{}" } },
                { id: 7, function: { name: "recall", arguments: "{}" } },
                { id: "c", function: "not-an-object" },
                "not-an-object"
            ]) {
                await expect(
                    provider(
                        respondWith(
                            JSON.stringify({
                                choices: [{ message: { content: "", tool_calls: [call] } }]
                            })
                        )
                    ).complete(request)
                ).rejects.toMatchObject({ code: "model.malformed-response" });
            }
        }
    );

    test("rejects a response whose choice is not an object", { tags: "p2" }, async () => {
        await expect(
            provider(respondWith(JSON.stringify({ choices: ["nope"] }))).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
        await expect(
            provider(respondWith(JSON.stringify(["not-an-object"]))).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
        await expect(
            provider(
                respondWith(
                    JSON.stringify({ choices: [{ message: { content: "", usage: 1 } }], usage: 5 })
                )
            ).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
    });

    test("maps transport and status failures onto stable codes", { tags: "p1" }, async () => {
        await expect(provider(respondWith("{}", 503)).complete(request)).rejects.toMatchObject({
            code: "model.unavailable"
        });
        await expect(provider(respondWith("{}", 429)).complete(request)).rejects.toMatchObject({
            code: "model.unavailable"
        });
        await expect(provider(respondWith("{}", 400)).complete(request)).rejects.toMatchObject({
            code: "model.rejected"
        });
        await expect(
            provider(() => Promise.reject(new TypeError("dns"))).complete(request)
        ).rejects.toMatchObject({ code: "model.unavailable" });
        await expect(
            provider(() => Promise.reject("offline")).complete(request)
        ).rejects.toMatchObject({ code: "model.unavailable" });
    });

    test("rejects a malformed provider response", { tags: "p1" }, async () => {
        await expect(provider(respondWith("not json")).complete(request)).rejects.toMatchObject({
            code: "model.malformed-response"
        });
        await expect(
            provider(respondWith(JSON.stringify({ choices: [] }))).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
        await expect(
            provider(
                respondWith(JSON.stringify({ choices: [{ message: { content: 7 } }] }))
            ).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
    });

    test("refuses to render an unknown transcript message kind", { tags: "p2" }, async () => {
        await expect(
            provider(
                respondWith(JSON.stringify({ choices: [{ message: { content: "" } }] }))
            ).complete({
                transcript: new Transcript("Be brief.", [new UnknownMessage()]),
                tools: [],
                signal: new AbortController().signal
            })
        ).rejects.toMatchObject({ code: "transcript.invalid" });
    });

    test("renders the whole transcript, including tool results", { tags: "p1" }, async () => {
        let body: JsonValue = null;
        const capture: typeof globalThis.fetch = async (_url, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        };

        await new OpenAiCompatibleModelProvider({
            endpoint: aiGatewayEndpoint("account-1", "gateway-1", "workers-ai"),
            model: "m",
            credential: async () => "token",
            fetch: capture
        }).complete({
            transcript: new Transcript("Be brief.", [
                new UserMessage("Hello"),
                new AssistantMessage("No tools here."),
                new AssistantMessage("Checking.", [
                    new ToolCall(new ToolCallId("call-1"), new BindingName("recall"), { q: 1 })
                ]),
                new ToolResultMessage(new ToolCallId("call-1"), { found: true }, false)
            ]),
            tools: [
                {
                    name: "recall",
                    description: "Recall.",
                    input: { type: "object" }
                }
            ],
            signal: new AbortController().signal
        });

        expect(body).toMatchObject({
            messages: [
                { role: "system", content: "Be brief." },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "No tools here." },
                {
                    role: "assistant",
                    content: "Checking.",
                    tool_calls: [{ id: "call-1", function: { name: "recall" } }]
                },
                { role: "tool", tool_call_id: "call-1" }
            ],
            tools: [{ type: "function", function: { name: "recall" } }]
        });
    });
});

class UnknownMessage extends TranscriptMessage {
    public readonly role = "user" as const;
    public toData() {
        return { role: this.role };
    }
}

describe("Assistant message codec", () => {
    test("refuses bytes that are not exactly one assistant message", { tags: "p1" }, () => {
        for (const transcript of [
            new Transcript("", []),
            new Transcript("", [new UserMessage("hello")]),
            new Transcript("", [new AssistantMessage("a"), new AssistantMessage("b")])
        ]) {
            expect(() => AssistantMessageCodec.decode(TranscriptCodec.encode(transcript))).toThrow(
                /exactly one assistant message/u
            );
        }
    });
});

describe("Transcript model port", () => {
    async function callPort(
        message: AssistantMessage,
        operations = [boundOperation("recall", "recall")]
    ) {
        const content = new MemoryContentStore();
        const prompt = TranscriptCodec.encode(
            new Transcript("Be brief.", [new UserMessage("Hello")])
        );
        const port = new TranscriptTurnModelPort(
            new StubModelProvider(async () => ({
                message,
                usage: { inputTokens: 1, outputTokens: 1 }
            })),
            content
        );
        const call = modelCall(prompt, operations, new AbortController().signal);
        return { content, result: await port.call(call) };
    }

    test(
        "falls back to the Operation name when a descriptor has no help",
        { tags: "p2" },
        async () => {
            const content = new MemoryContentStore();
            const prompt = TranscriptCodec.encode(
                new Transcript("Be brief.", [new UserMessage("Hello")])
            );
            const helpless = new TurnBoundOperation(
                new BindingName("recall"),
                ids.facet,
                new OperationRef("memory:recall"),
                new OperationDescriptor(
                    new OperationName("recall"),
                    "observe",
                    new JsonSchema({ type: "object" }),
                    new JsonSchema({ type: "object" })
                )
            );
            let seen: readonly ModelToolSpec[] = [];
            await new TranscriptTurnModelPort(
                new StubModelProvider(async (request: ModelRequest) => {
                    seen = request.tools;
                    return {
                        message: new AssistantMessage("ok"),
                        usage: { inputTokens: 1, outputTokens: 1 }
                    };
                }),
                content
            ).call(modelCall(prompt, [helpless], new AbortController().signal));
            expect(seen[0]?.description).toBe("recall");
        }
    );

    test("content-addresses the model reply", { tags: "p1" }, async () => {
        const message = new AssistantMessage("Hi.");
        const { content, result } = await callPort(message);
        expect(AssistantMessageCodec.decode(await content.get(result.output))).toEqual(message);
        expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    });

    test("rejects malformed usage counts", { tags: "p2" }, async () => {
        for (const usage of [{ prompt_tokens: -1 }, { completion_tokens: 1.5 }]) {
            await expect(
                provider(
                    respondWith(
                        JSON.stringify({ choices: [{ message: { content: "hi" } }], usage })
                    )
                ).complete(request)
            ).rejects.toMatchObject({ code: "model.malformed-response" });
        }
    });

    test("rejects tool calls that are not an array", { tags: "p2" }, async () => {
        await expect(
            provider(
                respondWith(
                    JSON.stringify({ choices: [{ message: { content: "", tool_calls: 7 } }] })
                )
            ).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
    });

    test("rejects tool call arguments that are not JSON", { tags: "p2" }, async () => {
        await expect(
            provider(
                respondWith(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content: "",
                                    tool_calls: [
                                        {
                                            id: "c",
                                            function: { name: "recall", arguments: "{oops" }
                                        }
                                    ]
                                }
                            }
                        ]
                    })
                )
            ).complete(request)
        ).rejects.toMatchObject({ code: "model.malformed-response" });
    });

    test("refuses a reply that names an unbound tool", { tags: "p0" }, async () => {
        await expect(
            callPort(
                new AssistantMessage("", [
                    new ToolCall(new ToolCallId("c"), new BindingName("other"), {})
                ])
            )
        ).rejects.toMatchObject({ code: "model.unknown-tool" });
    });
});
