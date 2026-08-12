import { describe, expect, test } from "vitest";
import {
    TurnExecutorHost,
    TurnMediatedInvocationPort,
    TurnStreamPort,
    type TurnMediatedInvocationRequest,
    type TurnMediatedInvocationResult,
    type TurnStreamEvent,
    type TurnStreamPublication
} from "@agent-core/core/agents/runs";
import type { FacetData } from "@agent-core/core/facets";
import {
    AgentLoopTurnExecutor,
    AssistantMessage,
    ModelProvider,
    PlacementOperationSource,
    ToolCall,
    ToolCallId,
    TranscriptCodec,
    TranscriptPromptAssembler,
    TranscriptTurnModelPort,
    UserMessage,
    type ModelCompletion,
    type ModelRequest
} from "../src/index";
import { boundOperation, ids, seedRunningTurn } from "./fixture";

class ScriptedModelProvider extends ModelProvider {
    public readonly requests: ModelRequest[] = [];

    public constructor(private readonly replies: readonly ModelCompletion[]) {
        super();
    }

    public async complete(request: ModelRequest): Promise<ModelCompletion> {
        this.requests.push(request);
        const reply = this.replies[this.requests.length - 1];
        if (reply === undefined) throw new TypeError("Scripted model ran out of replies");
        return reply;
    }
}

class RecordingInvocationPort extends TurnMediatedInvocationPort {
    public readonly requests: TurnMediatedInvocationRequest[] = [];
    public outcome: (input: FacetData) => FacetData = (input) => ({ echoed: input });

    public async invoke(
        request: TurnMediatedInvocationRequest
    ): Promise<TurnMediatedInvocationResult> {
        this.requests.push(request);
        return Object.freeze({
            output: this.outcome(request.input),
            evidence: { receipt: `receipt-${this.requests.length}` }
        });
    }
}

class RecordingStreamPort extends TurnStreamPort {
    public readonly events: TurnStreamEvent[] = [];

    public async publish(publication: TurnStreamPublication): Promise<void> {
        this.events.push(publication.event);
    }
}

function reply(text: string, calls: readonly ToolCall[] = []): ModelCompletion {
    return {
        message: new AssistantMessage(text, calls),
        usage: { inputTokens: 11, outputTokens: 7 }
    };
}

async function runLoop(
    replies: readonly ModelCompletion[],
    options: { readonly maximumSteps?: number } = {}
) {
    const fixture = await seedRunningTurn("Where did I park?");
    const provider = new ScriptedModelProvider(replies);
    const invocations = new RecordingInvocationPort();
    const stream = new RecordingStreamPort();
    const host = new TurnExecutorHost({
        runtime: fixture.runtime,
        executor: new AgentLoopTurnExecutor({ maximumSteps: options.maximumSteps ?? 4 }),
        content: fixture.content,
        operations: new PlacementOperationSource([
            boundOperation("recall", "recall"),
            boundOperation("remember", "remember")
        ]),
        prompt: new TranscriptPromptAssembler("You are a helpful agent.", fixture.content),
        invocations,
        model: new TranscriptTurnModelPort(provider, fixture.content),
        stream,
        now: () => new Date(2_000)
    });
    const outcome = await host.execute(fixture.token);
    return { fixture, provider, invocations, stream, outcome };
}

describe("Agent loop hosted behind the Turn executor seam", () => {
    test(
        "settles a one-message conversation as a succeeded Turn with a durable result commit",
        { tags: "p1" },
        async () => {
            const { fixture, provider, outcome, stream } = await runLoop([
                reply("You parked on level 3.")
            ]);

            expect(outcome.kind).toBe("succeeded");
            expect(provider.requests).toHaveLength(1);
            expect(provider.requests[0]!.transcript.instructions).toBe("You are a helpful agent.");
            expect(provider.requests[0]!.transcript.messages).toEqual([
                new UserMessage("Where did I park?")
            ]);
            expect(stream.events).toEqual([
                { kind: "usage", usage: { inputTokens: 11, outputTokens: 7 } }
            ]);

            const turn = fixture.repository.transaction((transaction) =>
                fixture.repository.loadTurn(transaction, ids.turn)
            );
            expect(turn?.status.kind).toBe("succeeded");
            if (outcome.kind !== "succeeded") throw new TypeError("expected success");
            expect(turn?.result?.equals(outcome.result)).toBe(true);
        }
    );

    test(
        "routes every tool call through the mediated invocation port and commits each step",
        { tags: "p0" },
        async () => {
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                {
                    query: "parking"
                }
            );
            const { fixture, invocations, provider, outcome } = await runLoop([
                reply("Let me check.", [call]),
                reply("You parked on level 3.")
            ]);

            expect(outcome.kind).toBe("succeeded");
            expect(invocations.requests).toHaveLength(1);
            const request = invocations.requests[0]!;
            expect(request.operation.binding.value).toBe("recall");
            expect(request.input).toEqual({ query: "parking" });
            expect(request.requestKey.value).toBe(`${ids.turn.value}:0:call-1`);
            expect(request.token).toEqual(fixture.token);

            // The tool result reaches the next model call as a transcript entry.
            const second = provider.requests[1]!;
            expect(second.transcript.messages).toHaveLength(3);
            expect(second.transcript.messages[2]).toMatchObject({
                role: "toolResult",
                failed: false
            });

            const commits = fixture.repository.transaction((transaction) =>
                fixture.repository.listCommits(transaction)
            );
            const authored = commits
                .filter((commit) =>
                    commit.writer.kind === "turn"
                        ? commit.subjectTurn?.equals(ids.turn) === true
                        : false
                )
                .map((commit) => `${commit.id.value}:${commit.kind}`)
                .sort();
            expect(authored).toEqual([
                `${ids.turn.value}-assistant-0:message`,
                `${ids.turn.value}-result:result`,
                `${ids.turn.value}-tools-0:message`
            ]);
        }
    );

    test(
        "derives a stable mediated request key so a re-executed step replays instead of repeating",
        { tags: "p0" },
        async () => {
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                {
                    query: "parking"
                }
            );
            const first = await runLoop([reply("Checking.", [call]), reply("Level 3.")]);
            const second = await runLoop([reply("Checking.", [call]), reply("Level 3.")]);

            expect(first.invocations.requests[0]!.requestKey.value).toBe(
                second.invocations.requests[0]!.requestKey.value
            );
        }
    );

    test(
        "presents the declared Operations to the model as tools drawn from the placement snapshot",
        { tags: "p1" },
        async () => {
            const { provider } = await runLoop([reply("Done.")]);
            expect(provider.requests[0]!.tools).toEqual([
                {
                    name: "recall",
                    description: "Perform recall.",
                    input: { type: "object" }
                },
                {
                    name: "remember",
                    description: "Perform remember.",
                    input: { type: "object" }
                }
            ]);
        }
    );

    test(
        "returns a failed tool result to the model rather than abandoning the Turn",
        { tags: "p1" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                {
                    query: "parking"
                }
            );
            const invocations = new RecordingInvocationPort();
            invocations.outcome = () => {
                throw new TypeError("binding is unavailable");
            };
            const host = new TurnExecutorHost({
                runtime: fixture.runtime,
                executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
                content: fixture.content,
                operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
                prompt: new TranscriptPromptAssembler("You are a helpful agent.", fixture.content),
                invocations,
                model: new TranscriptTurnModelPort(
                    new ScriptedModelProvider([
                        reply("Checking.", [call]),
                        reply("I could not look that up.")
                    ]),
                    fixture.content
                ),
                stream: new RecordingStreamPort(),
                now: () => new Date(2_000)
            });

            const outcome = await host.execute(fixture.token);
            expect(outcome.kind).toBe("succeeded");
        }
    );

    test(
        "fails the Turn explicitly when the step budget is exhausted",
        { tags: "p1" },
        async () => {
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                {
                    query: "parking"
                }
            );
            const { fixture, outcome } = await runLoop(
                [reply("Checking.", [call]), reply("Still checking.", [call])],
                { maximumSteps: 2 }
            );

            expect(outcome.kind).toBe("failed");
            const turn = fixture.repository.transaction((transaction) =>
                fixture.repository.loadTurn(transaction, ids.turn)
            );
            expect(turn?.status.kind).toBe("failed");
            if (outcome.kind !== "failed") throw new TypeError("expected failure");
            const stored = TranscriptCodec.decode(await fixture.content.get(outcome.result));
            expect(stored.messages.at(-1)).toMatchObject({
                text: "Step budget of 2 model calls was exhausted."
            });
        }
    );

    test("rejects a model reply naming a tool the Turn never bound", { tags: "p0" }, async () => {
        await expect(
            runLoop([
                reply("Checking.", [
                    new ToolCall(
                        new ToolCallId("call-1"),
                        boundOperation("forbidden", "forbidden").binding,
                        {}
                    )
                ])
            ])
        ).rejects.toMatchObject({ code: "model.unknown-tool" });
    });
});
