import { describe, expect, test } from "vitest";
import {
    TurnExecutorHost,
    TurnInboxEntry,
    TurnInboxEntryId,
    TurnInvocationPort,
    TurnModelPort,
    TurnStreamPort,
    type TurnInvocationRequest,
    type TurnInvocationResult,
    type TurnModelResult,
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
    Transcript,
    TranscriptTurnModelPort,
    UserMessage,
    type ModelCompletion,
    type ModelRequest
} from "../src/index";
import {
    admissionHandle,
    boundOperation,
    cutPoints,
    ids,
    seedRunningTurn,
    type RunFixture
} from "./fixture";

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

class RecordingInvocationPort extends TurnInvocationPort {
    public readonly requests: TurnInvocationRequest[] = [];
    public readonly served: TurnInvocationResult[] = [];
    public outcome: (input: FacetData) => FacetData = (input) => ({ echoed: input });
    public tier: "direct" | "mediated" = "mediated";

    public async invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult> {
        this.requests.push(request);
        const output = this.outcome(request.input);
        const result: TurnInvocationResult = Object.freeze(
            this.tier === "direct"
                ? { tier: "direct", output }
                : {
                      tier: "mediated",
                      output,
                      evidence: { receipt: `receipt-${this.requests.length}` },
                      admission: admissionHandle(this.requests.length)
                  }
        );
        this.served.push(result);
        return result;
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

/** A stop request against the live lease, delivered the way §5.6 says it arrives. */
function deliverCancellation(fixture: RunFixture): void {
    const turn = fixture.repository.transaction((transaction) =>
        fixture.repository.loadTurn(transaction, ids.turn)
    );
    if (turn === undefined) throw new TypeError("Turn must exist");
    const sequence = fixture.repository.transaction(
        (transaction) => fixture.repository.listInbox(transaction, ids.turn).length
    );
    fixture.runtime.deliverEvent(
        ids.turn,
        turn.revision,
        fixture.token,
        new TurnInboxEntry(
            new TurnInboxEntryId(`cancel-${sequence}`),
            ids.turn,
            sequence,
            "turn.cancel",
            fixture.input,
            fixture.inputDigest,
            `cancel-key-${sequence}`,
            fixture.token,
            new Date(1_500)
        ),
        new Date(1_500)
    );
}

async function runLoop(
    replies: readonly ModelCompletion[],
    options: { readonly maximumSteps?: number; readonly tier?: "direct" | "mediated" } = {}
) {
    const fixture = await seedRunningTurn("Where did I park?");
    const provider = new ScriptedModelProvider(replies);
    const invocations = new RecordingInvocationPort();
    invocations.tier = options.tier ?? "mediated";
    const stream = new RecordingStreamPort();
    const host = new TurnExecutorHost({
        runtime: fixture.runtime,
        content: fixture.content,
        cutPoints,
        executor: new AgentLoopTurnExecutor({ maximumSteps: options.maximumSteps ?? 4 }),
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
        "routes every mediated tool call through the invocation port and commits each step",
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
            // The model seam commits the request it issued before issuing it, under this
            // Turn's own lease (§5.6), so a Turn that called the model twice authors two
            // `modelInput` commits the loop never appended. Their ids are content-addressed,
            // so the count is the claim; the loop's own commits stay named exactly.
            expect(authored.filter((entry) => entry.endsWith(":modelInput"))).toHaveLength(2);
            expect(authored.filter((entry) => !entry.endsWith(":modelInput"))).toEqual([
                `${ids.turn.value}-assistant-0:message`,
                `${ids.turn.value}-result:result`,
                `${ids.turn.value}-tools-0:message`
            ]);
        }
    );

    test(
        "commits a direct-tier tool result exactly as it commits a mediated one",
        { tags: "p0" },
        async () => {
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                { query: "parking" }
            );
            const { fixture, invocations, provider, outcome } = await runLoop(
                [reply("Let me check.", [call]), reply("You parked on level 3.")],
                { tier: "direct" }
            );

            expect(outcome.kind).toBe("succeeded");
            expect(invocations.requests).toHaveLength(1);
            expect(invocations.served.map((result) => result.tier)).toEqual(["direct"]);

            // A direct call carries no invocation evidence (§7.2), and the loop needs
            // none: the tool output is what the model reads and what the step commits.
            const second = provider.requests[1]!;
            expect(second.transcript.messages[2]).toMatchObject({
                role: "toolResult",
                failed: false,
                output: { echoed: { query: "parking" } }
            });

            const commits = fixture.repository.transaction((transaction) =>
                fixture.repository.listCommits(transaction)
            );
            const authored = commits
                .filter((commit) => commit.subjectTurn?.equals(ids.turn) === true)
                .map((commit) => `${commit.id.value}:${commit.kind}`)
                .sort();
            expect(authored.filter((entry) => entry.endsWith(":modelInput"))).toHaveLength(2);
            expect(authored.filter((entry) => !entry.endsWith(":modelInput"))).toEqual([
                `${ids.turn.value}-assistant-0:message`,
                `${ids.turn.value}-result:result`,
                `${ids.turn.value}-tools-0:message`
            ]);

            const tools = commits.find((commit) => commit.id.value === `${ids.turn.value}-tools-0`);
            if (tools?.content === undefined) throw new TypeError("expected a tool step commit");
            expect(
                TranscriptCodec.decode(await fixture.content.get(tools.content)).messages
            ).toMatchObject([{ role: "toolResult", output: { echoed: { query: "parking" } } }]);
        }
    );

    test("renders a non-Error tool rejection into the transcript", { tags: "p2" }, async () => {
        const fixture = await seedRunningTurn("Where did I park?");
        const call = new ToolCall(
            new ToolCallId("call-1"),
            boundOperation("recall", "recall").binding,
            {}
        );
        const invocations = new RecordingInvocationPort();
        invocations.outcome = () => {
            throw "binding is unavailable";
        };
        const provider = new ScriptedModelProvider([
            reply("Checking.", [call]),
            reply("I could not look that up.")
        ]);
        const outcome = await new TurnExecutorHost({
            runtime: fixture.runtime,
            content: fixture.content,
            cutPoints,
            executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
            operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
            prompt: new TranscriptPromptAssembler("Be brief.", fixture.content),
            invocations,
            model: new TranscriptTurnModelPort(provider, fixture.content),
            stream: new RecordingStreamPort(),
            now: () => new Date(2_000)
        }).execute(fixture.token);

        expect(outcome.kind).toBe("succeeded");
        expect(provider.requests[1]!.transcript.messages[2]).toMatchObject({
            failed: true,
            output: { error: "binding is unavailable" }
        });
    });

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
                content: fixture.content,
                cutPoints,
                executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
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

    test(
        "stops committing and settles as cancelled once turn.cancel reaches the inbox",
        { tags: "p0" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const provider = new ScriptedModelProvider([reply("You parked on level 3.")]);
            deliverCancellation(fixture);

            const outcome = await new TurnExecutorHost({
                runtime: fixture.runtime,
                content: fixture.content,
                cutPoints,
                executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
                operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
                prompt: new TranscriptPromptAssembler("You are a helpful agent.", fixture.content),
                invocations: new RecordingInvocationPort(),
                model: new TranscriptTurnModelPort(provider, fixture.content),
                stream: new RecordingStreamPort(),
                now: () => new Date(2_000)
            }).execute(fixture.token);

            expect(outcome.kind).toBe("cancelled");
            expect(provider.requests).toHaveLength(0);

            // The holder performed the transition itself: the Turn is durably cancelled
            // and its result commit is the transcript the loop had reached (§5.3, §5.6).
            const turn = fixture.repository.transaction((transaction) =>
                fixture.repository.loadTurn(transaction, ids.turn)
            );
            expect(turn?.status.kind).toBe("cancelled");
            expect(turn?.lease.holder).toBeUndefined();
            if (outcome.kind !== "cancelled" || outcome.result === undefined) {
                throw new TypeError("expected a cancelled result");
            }
            expect(turn?.result?.equals(outcome.result)).toBe(true);
            expect(
                TranscriptCodec.decode(await fixture.content.get(outcome.result)).messages
            ).toEqual([new UserMessage("Where did I park?")]);
        }
    );

    test(
        "refuses a tool call the Turn never bound even when the model port admits it",
        { tags: "p0" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const unbound = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("forbidden", "forbidden").binding,
                {}
            );
            // A permissive TurnModelPort stands in for any implementation that does not
            // re-check the bound set; the loop must still refuse the call itself.
            const permissive = new (class extends TurnModelPort {
                public async call(): Promise<TurnModelResult> {
                    const stored = await fixture.content.put(
                        TranscriptCodec.encode(
                            new Transcript("", [new AssistantMessage("Checking.", [unbound])])
                        )
                    );
                    return { output: stored.ref, usage: { inputTokens: 1, outputTokens: 1 } };
                }
            })();

            await expect(
                new TurnExecutorHost({
                    runtime: fixture.runtime,
                    content: fixture.content,
                    cutPoints,
                    executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
                    operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
                    prompt: new TranscriptPromptAssembler("Be brief.", fixture.content),
                    invocations: new RecordingInvocationPort(),
                    model: permissive,
                    stream: new RecordingStreamPort(),
                    now: () => new Date(2_000)
                }).execute(fixture.token)
            ).rejects.toMatchObject({ code: "model.unknown-tool" });
        }
    );

    test(
        "propagates a tool failure that happens because the Turn was cancelled mid-call",
        { tags: "p0" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const call = new ToolCall(
                new ToolCallId("call-1"),
                boundOperation("recall", "recall").binding,
                { query: "parking" }
            );
            const invocations = new RecordingInvocationPort();
            invocations.outcome = () => {
                deliverCancellation(fixture);
                throw new TypeError("the lease was fenced");
            };

            const outcome = await new TurnExecutorHost({
                runtime: fixture.runtime,
                content: fixture.content,
                cutPoints,
                executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
                operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
                prompt: new TranscriptPromptAssembler("Be brief.", fixture.content),
                invocations,
                model: new TranscriptTurnModelPort(
                    new ScriptedModelProvider([reply("Checking.", [call]), reply("Level 3.")]),
                    fixture.content
                ),
                stream: new RecordingStreamPort(),
                now: () => new Date(2_000)
            }).execute(fixture.token);

            // The loop rethrows rather than reporting a tool failure, and the host
            // settles the Turn from the cancellation evidence it recovers.
            expect(outcome.kind).toBe("cancelled");
        }
    );

    test("rejects a non-positive step budget", { tags: "p2" }, () => {
        for (const maximumSteps of [0, -1, 1.5, Number.NaN]) {
            expect(() => new AgentLoopTurnExecutor({ maximumSteps })).toThrow(
                /positive safe integer/u
            );
        }
    });

    test("advances its inbox cursor past entries it has already read", { tags: "p1" }, async () => {
        const fixture = await seedRunningTurn("Where did I park?");
        const turn = fixture.repository.transaction((transaction) =>
            fixture.repository.loadTurn(transaction, ids.turn)
        );
        if (turn === undefined) throw new TypeError("Turn must exist");
        fixture.runtime.deliverEvent(
            ids.turn,
            turn.revision,
            fixture.token,
            new TurnInboxEntry(
                new TurnInboxEntryId("note-1"),
                ids.turn,
                0,
                "note",
                fixture.input,
                fixture.inputDigest,
                "note-key",
                undefined,
                new Date(1_500)
            ),
            new Date(1_500)
        );
        const call = new ToolCall(
            new ToolCallId("call-1"),
            boundOperation("recall", "recall").binding,
            { query: "parking" }
        );
        const outcome = await new TurnExecutorHost({
            runtime: fixture.runtime,
            content: fixture.content,
            cutPoints,
            executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
            operations: new PlacementOperationSource([boundOperation("recall", "recall")]),
            prompt: new TranscriptPromptAssembler("You are a helpful agent.", fixture.content),
            invocations: new RecordingInvocationPort(),
            model: new TranscriptTurnModelPort(
                new ScriptedModelProvider([reply("Checking.", [call]), reply("Level 3.")]),
                fixture.content
            ),
            stream: new RecordingStreamPort(),
            now: () => new Date(2_000)
        }).execute(fixture.token);

        expect(outcome.kind).toBe("succeeded");
    });

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
