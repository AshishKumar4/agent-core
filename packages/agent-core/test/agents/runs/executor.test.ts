import { describe, expect, it } from "vitest";
import { JsonSchema, type ContentRef } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "../../../src/facets";
import {
    RunCheckpoint,
    RunCheckpointId,
    RunCommit,
    RunRuntime,
    PlacementPin,
    OperationGatewayTurnInvocationPort,
    TurnBoundTool,
    TurnExecutor,
    TurnExecutorHost,
    TurnId,
    TurnInboxEntry,
    TurnInboxEntryId,
    type TurnContext,
    type TurnModelCall,
    type TurnOutcome
} from "../../../src/agents/runs";
import { RunCommitId } from "../../../src/execution-references";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import {
    OperationGateway,
    OperationRequestKey,
    ResolvedFacet,
    type OperationDispatchResult,
    type OperationRequest
} from "../../../src/operations";
import { content, harness, ids, seedRunningTurn } from "./fixture";

class HostedExecutor extends TurnExecutor {
    public async execute(turn: TurnContext): Promise<TurnOutcome> {
        if (turn.tools[0] !== undefined) {
            await turn.invocation.invoke(
                turn.tools[0],
                new OperationRequestKey("executor-tool-call"),
                { key: "value" }
            );
        }
        await turn.stream.publish({
            kind: "content",
            bytes: new TextEncoder().encode("ephemeral")
        });
        const response = await turn.model.call({ prompt: turn.prompt });
        return turn.outcome.succeed(
            new RunCommit({
                id: new RunCommitId("executor-result"),
                run: turn.turn.run,
                branch: turn.turn.branch,
                kind: "result",
                parents: [turn.turn.startHead],
                pins: turn.turn.pins,
                writer: { kind: "turn", token: turn.token },
                subjectTurn: turn.turn.id,
                content: response.output
            })
        );
    }
}

class FunctionExecutor extends TurnExecutor {
    public calls = 0;

    public constructor(private readonly run: (context: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public async execute(context: TurnContext): Promise<TurnOutcome> {
        this.calls += 1;
        return this.run(context);
    }
}

describe("TurnExecutor seam", () => {
    it("exposes one exact typed bound tool contract through the supported Run export", () => {
        const descriptor = new OperationDescriptor(
            new OperationName("read"),
            "observe",
            new JsonSchema({ type: "object" }),
            new JsonSchema({ type: "object" }),
            "Read the canonical value."
        );
        const tool = new TurnBoundTool(
            new BindingName("memory"),
            new FacetRef("memory:primary"),
            new OperationRef("memory:read"),
            descriptor
        );

        expect(tool.binding).toEqual(new BindingName("memory"));
        expect(tool.facet).toEqual(new FacetRef("memory:primary"));
        expect(tool.operation).toEqual(new OperationRef("memory:read"));
        expect(tool.descriptor).toBe(descriptor);
        expect(tool.descriptor.help).toBe("Read the canonical value.");
        expect(tool.descriptor.impact).toBe("observe");
        expect(tool.descriptor.input.document).toEqual({ type: "object" });
        expect(
            () =>
                new TurnBoundTool(
                    tool.binding,
                    tool.facet,
                    new OperationRef("memory:write"),
                    descriptor
                )
        ).toThrow(/one operation/);
    });

    it("[C13-TURN-MODEL-CALL] hosts a model call only inside the exact live Turn and commits its complete output", async () => {
        const placement = new PlacementPin({
            facet: new FacetRef("memory:primary"),
            manifest: ["dynamic"],
            policy: ["dynamic"],
            substrate: ["dynamic"],
            trust: ["dynamic"],
            selected: "dynamic"
        });
        const seeded = seedRunningTurn(undefined, {}, [placement]);
        const contentStore = new MemoryContentStore();
        const prompt = (await contentStore.put(new TextEncoder().encode("prompt"))).ref;
        const output = (await contentStore.put(new TextEncoder().encode("complete output"))).ref;
        const read = boundTool("read", "memory.read", "observe", "Read memory.");
        const write = boundTool("write", "memory.write", "mutate", "Write memory.");
        const modelCalls: ReturnType<typeof content>[] = [];
        const invocationCalls: TurnBoundTool[] = [];
        const stream: Uint8Array[] = [];
        const host = new TurnExecutorHost({
            runtime: seeded.runtime,
            executor: new HostedExecutor(),
            content: contentStore,
            tools: { resolve: async () => [write, read] },
            prompt: { assemble: async () => prompt },
            invocations: {
                invoke: async (request) => {
                    invocationCalls.push(request.tool);
                    expect(request.token).toEqual(seeded.token);
                    expect(request.input).toEqual({ key: "value" });
                    return { output: { stored: true }, evidence: { receipt: "receipt-1" } };
                }
            },
            model: {
                call: async (request) => {
                    modelCalls.push(request.prompt);
                    expect(request.tools).toEqual([write, read]);
                    return {
                        output,
                        usage: { inputTokens: 2, outputTokens: 3 }
                    };
                }
            },
            stream: {
                publish: async (publication) => {
                    if (publication.event.kind === "content") {
                        stream.push(publication.event.bytes);
                    }
                }
            },
            now: () => new Date(2_000)
        });

        await expect(host.execute(seeded.token)).resolves.toEqual({
            kind: "succeeded",
            result: output,
            commit: new RunCommitId("executor-result")
        });
        expect(modelCalls).toEqual([prompt]);
        expect(invocationCalls).toEqual([write]);
        expect(stream.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["ephemeral"]);
        const persisted = seeded.repository.transaction((transaction) => ({
            turn: seeded.repository.loadTurn(transaction, ids.turn),
            branch: seeded.repository.loadBranch(transaction, ids.branch)
        }));
        expect(persisted.turn?.status.kind).toBe("succeeded");
        expect(persisted.turn?.result).toEqual(output);
        expect(persisted.branch?.head).toEqual(new RunCommitId("executor-result"));
    });

    it("adapts one exact bound tool to the existing mediated OperationGateway and disposes it", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const resolved = new TestResolvedFacet(tool, {
            kind: "mediated",
            output: { value: 1 },
            evidence: { receipt: "receipt-1" }
        });
        const gateway = new TestOperationGateway(resolved);
        const adapter = new OperationGatewayTurnInvocationPort({
            open: async (scope) => {
                expect(scope.token).toEqual(seeded.token);
                return gateway;
            }
        });

        await expect(
            adapter.invoke({
                turn: seeded.running,
                token: seeded.token,
                tool,
                requestKey: new OperationRequestKey("gateway-call"),
                input: { key: "value" },
                signal: new AbortController().signal
            })
        ).resolves.toEqual({ output: { value: 1 }, evidence: { receipt: "receipt-1" } });
        expect(resolved.requests).toEqual([
            {
                requestKey: new OperationRequestKey("gateway-call"),
                operation: tool.descriptor.name,
                payload: { kind: "single", input: { key: "value" } }
            }
        ]);
        expect(resolved.disposed).toBe(true);
    });

    it("rejects wrong-Turn, wrong-holder, and stale-epoch host admission before executor code", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async () => {
            throw new TypeError("executor must not run");
        });
        const host = boundaries.host(seeded, executor);
        const tokens = [
            { ...seeded.token, turn: new TurnId("wrong-turn") },
            {
                ...seeded.token,
                holder: new PrincipalRef(ids.holder.tenantId, new PrincipalId("wrong-holder"))
            },
            { ...seeded.token, epoch: seeded.token.epoch + 1 }
        ];

        for (const token of tokens) {
            await expect(host.execute(token)).rejects.toBeInstanceOf(AgentCoreError);
        }
        expect(executor.calls).toBe(0);
        expect(boundaries.modelCalls).toHaveLength(0);
    });

    it("fails closed before execution for duplicate bindings or tools absent from placement", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const read = boundTool("read", "memory.shared", "observe", "Read memory.");
        const write = boundTool("write", "memory.shared", "mutate", "Write memory.");
        const executor = new FunctionExecutor(async () => {
            throw new TypeError("executor must not run");
        });
        const duplicate = await TestBoundaries.create([read, write]);
        await expect(duplicate.host(seeded, executor).execute(seeded.token)).rejects.toThrow(
            /unique/
        );

        const absent = seedRunningTurn();
        const absentBoundaries = await TestBoundaries.create([read]);
        await expect(
            absentBoundaries.host(absent, executor).execute(absent.token)
        ).rejects.toMatchObject({ code: "turn.invalid-state" });
        expect(executor.calls).toBe(0);
    });

    it("rejects a wrong-Turn or stale-head commit at the handle call without mutation", async () => {
        const cases = [
            {
                name: "wrong Turn",
                subject: new TurnId("other-turn"),
                parent: ids.root
            },
            {
                name: "stale head",
                subject: ids.turn,
                parent: new RunCommitId("not-the-current-head")
            }
        ];
        for (const testCase of cases) {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const executor = new FunctionExecutor(async (context) =>
                context.outcome.succeed(
                    resultCommit(
                        context,
                        `invalid-${testCase.name.replace(" ", "-")}`,
                        boundaries.output,
                        testCase.parent,
                        testCase.subject
                    )
                )
            );

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
            const persisted = seeded.repository.transaction((transaction) => ({
                turn: seeded.repository.loadTurn(transaction, ids.turn),
                branch: seeded.repository.loadBranch(transaction, ids.branch)
            }));
            expect(persisted.turn?.status.kind).toBe("running");
            expect(persisted.branch?.head).toEqual(ids.root);
        }
    });

    it("observes exact takeover cancellation and fences every effectful handle", async () => {
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const placement = memoryPlacement();
        const seeded = seedRunningTurn(undefined, {}, [placement]);
        const boundaries = await TestBoundaries.create([tool]);
        const newHolder = new PrincipalRef(ids.holder.tenantId, new PrincipalId("takeover-holder"));
        const errors: string[] = [];
        let modelSignal: AbortSignal | undefined;
        const executor = new FunctionExecutor(async (context) => {
            const cancellation = cancellationEntry(
                "takeover-cancellation",
                seeded.token,
                boundaries.cancellationPayload,
                0
            );
            seeded.runtime.reclaimTurn(
                ids.turn,
                seeded.running.revision,
                newHolder,
                new Date(6_000),
                new Date(10_000),
                cancellation
            );
            const calls: readonly (() => Promise<unknown>)[] = [
                () => context.content.get(boundaries.prompt),
                async () => {
                    const call = context.model.call({ prompt: boundaries.prompt });
                    modelSignal = boundaries.lastModelSignal;
                    return call;
                },
                () => context.stream.publish({ kind: "content", bytes: new Uint8Array([1]) }),
                () =>
                    context.invocation.invoke(
                        tool,
                        new OperationRequestKey("stale-invocation"),
                        {}
                    ),
                () =>
                    context.commit.append(
                        messageCommit(context, "stale-message", boundaries.output, ids.root)
                    ),
                () => context.checkpoint.current(),
                () =>
                    context.outcome.succeed(
                        resultCommit(context, "stale-result", boundaries.output, ids.root)
                    )
            ];
            for (const call of calls) {
                try {
                    await call();
                } catch (error) {
                    errors.push(errorCode(error));
                }
            }
            const inbox = await context.inbox.read(0);
            expect(inbox).toEqual([cancellation]);
            expect(context.cancellation.aborted).toBe(true);
            return context.outcome.cancelled();
        });

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).resolves.toEqual({
            kind: "cancelled"
        });
        expect(errors).toEqual(Array.from({ length: 7 }, () => "lease.invalid"));
        expect(modelSignal?.aborted ?? true).toBe(true);
        expect(boundaries.modelCalls).toHaveLength(0);
        expect(boundaries.invocationCalls).toHaveLength(0);
        expect(boundaries.streamEvents).toHaveLength(0);
        const persisted = seeded.repository.transaction((transaction) => ({
            turn: seeded.repository.loadTurn(transaction, ids.turn),
            branch: seeded.repository.loadBranch(transaction, ids.branch)
        }));
        expect(persisted.turn?.status.kind).toBe("running");
        expect(persisted.turn?.lease.holder).toEqual(newHolder);
        expect(persisted.branch?.head).toEqual(ids.root);
    });

    it("atomically suspends with the canonical checkpoint and recovers it after restart", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            const commit = checkpointCommit(
                context,
                "suspend-commit",
                boundaries.checkpointState,
                ids.root
            );
            return context.checkpoint.persist(
                new RunCheckpoint(
                    new RunCheckpointId("suspend-checkpoint"),
                    context.turn.id,
                    commit.id,
                    boundaries.checkpointState,
                    0,
                    undefined
                ),
                commit
            );
        });
        const expected = {
            kind: "suspended" as const,
            checkpoint: new RunCheckpoint(
                new RunCheckpointId("suspend-checkpoint"),
                ids.turn,
                new RunCommitId("suspend-commit"),
                boundaries.checkpointState,
                0,
                undefined
            ),
            commit: new RunCommitId("suspend-commit")
        };

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).resolves.toEqual(
            expected
        );
        const restarted = harness(seeded.storage.snapshot());
        const mustNotRun = new FunctionExecutor(async () => {
            throw new TypeError("recovery must not rerun the executor");
        });
        await expect(boundaries.host(restarted, mustNotRun).execute(seeded.token)).resolves.toEqual(
            expected
        );
        expect(mustNotRun.calls).toBe(0);

        const suspended = restarted.repository.transaction((transaction) =>
            restarted.repository.loadTurn(transaction, ids.turn)
        );
        if (suspended === undefined) throw new TypeError("Suspended Turn must exist");
        const resumed = restarted.runtime.claimTurn(
            ids.turn,
            suspended.revision,
            ids.holder,
            new Date(2_500),
            new Date(8_000)
        );
        const resumedToken = Object.freeze({
            turn: ids.turn,
            holder: ids.holder,
            epoch: resumed.lease.epoch
        });
        const resumeExecutor = new FunctionExecutor(async (context) => {
            expect(context.resumeCheckpoint).toEqual(expected.checkpoint);
            await expect(context.checkpoint.current()).resolves.toEqual(expected.checkpoint);
            return context.outcome.succeed(
                resultCommit(context, "resumed-result", boundaries.output, expected.commit)
            );
        });
        await expect(
            boundaries.host(restarted, resumeExecutor).execute(resumedToken)
        ).resolves.toEqual({
            kind: "succeeded",
            result: boundaries.output,
            commit: new RunCommitId("resumed-result")
        });
    });

    it("durably records explicit failure and self-cancellation outcomes", async () => {
        const failure = seedRunningTurn();
        const failureBoundaries = await TestBoundaries.create();
        const failExecutor = new FunctionExecutor((context) =>
            context.outcome.fail(
                resultCommit(context, "failed-result", failureBoundaries.output, ids.root)
            )
        );
        await expect(
            failureBoundaries.host(failure, failExecutor).execute(failure.token)
        ).resolves.toEqual({
            kind: "failed",
            result: failureBoundaries.output,
            commit: new RunCommitId("failed-result")
        });

        const cancelled = seedRunningTurn();
        const cancelBoundaries = await TestBoundaries.create();
        const cancelExecutor = new FunctionExecutor((context) =>
            context.outcome.cancel(
                resultCommit(context, "cancelled-result", cancelBoundaries.output, ids.root),
                cancellationEntry(
                    "self-cancellation",
                    context.token,
                    cancelBoundaries.cancellationPayload,
                    0
                )
            )
        );
        await expect(
            cancelBoundaries.host(cancelled, cancelExecutor).execute(cancelled.token)
        ).resolves.toEqual({
            kind: "cancelled",
            result: cancelBoundaries.output,
            commit: new RunCommitId("cancelled-result")
        });
    });

    it("recovers a committed result when the executor crashes before returning and never reruns it", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const crashing = new FunctionExecutor(async (context) => {
            await context.outcome.succeed(
                resultCommit(context, "crash-result", boundaries.output, ids.root)
            );
            throw new TypeError("crash after canonical transition");
        });
        const expected = {
            kind: "succeeded" as const,
            result: boundaries.output,
            commit: new RunCommitId("crash-result")
        };

        await expect(boundaries.host(seeded, crashing).execute(seeded.token)).resolves.toEqual(
            expected
        );
        await expect(
            boundaries.host(seeded, crashing).execute({
                ...seeded.token,
                holder: new PrincipalRef(
                    seeded.token.holder.tenantId,
                    new PrincipalId("post-terminal-impostor")
                )
            })
        ).rejects.toMatchObject({ code: "lease.invalid" });
        const restarted = harness(seeded.storage.snapshot());
        const mustNotRun = new FunctionExecutor(async () => {
            throw new TypeError("recovery must not rerun the executor");
        });
        await expect(boundaries.host(restarted, mustNotRun).execute(seeded.token)).resolves.toEqual(
            expected
        );
        expect(crashing.calls).toBe(1);
        expect(mustNotRun.calls).toBe(0);
    });

    it("leaves canonical state unchanged when the executor crashes before a transition", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async () => {
            throw new TypeError("crash before transition");
        });

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).rejects.toThrow(
            "crash before transition"
        );
        const state = seeded.repository.transaction((transaction) => ({
            turn: seeded.repository.loadTurn(transaction, ids.turn),
            branch: seeded.repository.loadBranch(transaction, ids.branch),
            commits: seeded.repository.listCommits(transaction)
        }));
        expect(state.turn?.status.kind).toBe("running");
        expect(state.branch?.head).toEqual(ids.root);
        expect(state.commits.map((commit) => commit.id)).toEqual([ids.root]);
    });

    it("uses the exact current head after an intermediate message commit", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            const message = messageCommit(context, "message", boundaries.prompt, ids.root);
            await context.commit.append(message);
            return context.outcome.succeed(
                resultCommit(context, "result-after-message", boundaries.output, message.id)
            );
        });

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).resolves.toEqual({
            kind: "succeeded",
            result: boundaries.output,
            commit: new RunCommitId("result-after-message")
        });
        expect(
            seeded.repository.transaction(
                (transaction) => seeded.repository.loadBranch(transaction, ids.branch)?.head
            )
        ).toEqual(new RunCommitId("result-after-message"));
    });
});

class TestBoundaries {
    public readonly modelCalls: TurnModelCall[] = [];
    public readonly invocationCalls: TurnBoundTool[] = [];
    public readonly streamEvents: Uint8Array[] = [];
    public lastModelSignal: AbortSignal | undefined;

    private constructor(
        public readonly content: MemoryContentStore,
        public readonly prompt: ContentRef,
        public readonly output: ContentRef,
        public readonly checkpointState: ContentRef,
        public readonly cancellationPayload: ContentRef,
        public readonly tools: readonly TurnBoundTool[]
    ) {}

    public static async create(tools: readonly TurnBoundTool[] = []): Promise<TestBoundaries> {
        const contentStore = new MemoryContentStore();
        const put = async (value: string) =>
            (await contentStore.put(new TextEncoder().encode(value))).ref;
        return new TestBoundaries(
            contentStore,
            await put("prompt"),
            await put("output"),
            await put("checkpoint"),
            await put("cancellation"),
            tools
        );
    }

    public host<Transaction>(
        seeded: { readonly runtime: RunRuntime<Transaction> },
        executor: TurnExecutor
    ): TurnExecutorHost<Transaction> {
        return new TurnExecutorHost({
            runtime: seeded.runtime,
            executor,
            content: this.content,
            tools: { resolve: async () => this.tools },
            prompt: { assemble: async () => this.prompt },
            invocations: {
                invoke: async (request) => {
                    this.invocationCalls.push(request.tool);
                    return { output: {}, evidence: { receipt: "test" } };
                }
            },
            model: {
                call: async (request) => {
                    this.modelCalls.push(request);
                    this.lastModelSignal = request.signal;
                    return {
                        output: this.output,
                        usage: { inputTokens: 1, outputTokens: 1 }
                    };
                }
            },
            stream: {
                publish: async (publication) => {
                    if (publication.event.kind === "content") {
                        this.streamEvents.push(publication.event.bytes);
                    }
                }
            },
            now: () => new Date(2_000)
        });
    }
}

class TestOperationGateway extends OperationGateway {
    public constructor(private readonly resolved: ResolvedFacet) {
        super();
    }

    public async resolve(): Promise<ResolvedFacet> {
        return this.resolved;
    }
}

class TestResolvedFacet extends ResolvedFacet {
    public readonly facet: FacetRef;
    public readonly package;
    public readonly requests: OperationRequest[] = [];
    public disposed = false;

    public constructor(
        private readonly tool: TurnBoundTool,
        private readonly result: OperationDispatchResult
    ) {
        super();
        this.facet = tool.facet;
        this.package = tool.operation.facet;
    }

    public descriptor(name: OperationName): OperationDescriptor | undefined {
        return name.equals(this.tool.descriptor.name) ? this.tool.descriptor : undefined;
    }

    public async dispatch(request: OperationRequest): Promise<OperationDispatchResult> {
        this.requests.push(request);
        return this.result;
    }

    public [Symbol.dispose](): void {
        this.disposed = true;
    }
}

function memoryPlacement(): PlacementPin {
    return new PlacementPin({
        facet: new FacetRef("memory:primary"),
        manifest: ["dynamic"],
        policy: ["dynamic"],
        substrate: ["dynamic"],
        trust: ["dynamic"],
        selected: "dynamic"
    });
}

function resultCommit(
    context: TurnContext,
    id: string,
    output: ReturnType<typeof content>,
    parent: RunCommitId,
    subject: TurnId = context.turn.id
): RunCommit {
    return turnCommit(context, id, "result", output, parent, subject);
}

function messageCommit(
    context: TurnContext,
    id: string,
    output: ReturnType<typeof content>,
    parent: RunCommitId
): RunCommit {
    return turnCommit(context, id, "message", output, parent, context.turn.id);
}

function checkpointCommit(
    context: TurnContext,
    id: string,
    output: ReturnType<typeof content>,
    parent: RunCommitId
): RunCommit {
    return turnCommit(context, id, "checkpoint", output, parent, context.turn.id);
}

function turnCommit(
    context: TurnContext,
    id: string,
    kind: "message" | "checkpoint" | "result",
    output: ReturnType<typeof content>,
    parent: RunCommitId,
    subject: TurnId
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: context.turn.run,
        branch: context.turn.branch,
        kind,
        parents: [parent],
        pins: context.turn.pins,
        writer: { kind: "turn", token: context.token },
        subjectTurn: subject,
        content: output
    });
}

function cancellationEntry(
    id: string,
    token: TurnContext["token"],
    payload: ReturnType<typeof content>,
    sequence: number
): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        token.turn,
        sequence,
        "turn.cancel",
        payload,
        payload.digest,
        `key:${id}`,
        token,
        new Date(6_000)
    );
}

function errorCode(error: unknown): string {
    return error instanceof AgentCoreError ? error.code : String(error);
}

function boundTool(
    name: string,
    binding: string,
    impact: "observe" | "mutate",
    help: string
): TurnBoundTool {
    const descriptor = new OperationDescriptor(
        new OperationName(name),
        impact,
        new JsonSchema({ type: "object" }),
        new JsonSchema({ type: "object" }),
        help
    );
    return new TurnBoundTool(
        new BindingName(binding),
        new FacetRef("memory:primary"),
        new OperationRef(`memory:${name}`),
        descriptor
    );
}
