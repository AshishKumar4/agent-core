import { describe, expect, it } from "vitest";
import { JsonSchema, Revision, type ContentRef } from "../../../src/core";
import { ContentStore, MemoryContentStore } from "../../../src/content";
import {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "../../../src/facets";
import {
    RunCheckpoint,
    RunCheckpointId,
    RunBranchId,
    RunBranch,
    RunCommit,
    RunId,
    RunRuntime,
    PlacementPin,
    GatewayTurnInvocationPort,
    TurnBoundOperation,
    TurnExecutor,
    TurnExecutorHost,
    TurnId,
    TurnInboxEntry,
    TurnInboxEntryId,
    type TurnContext,
    type TurnExecutorHostInit,
    type TurnModelCall,
    type TurnModelUsage,
    type TurnOutcome,
    type TurnStreamPublication
} from "../../../src/agents/runs";
import { RunCommitId } from "../../../src/execution-references";
import type { RunCommitInit } from "../../../src/agents/runs/commit";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import {
    OperationGateway,
    OperationRequestKey,
    ResolvedFacet,
    type OperationDispatchResult,
    type OperationRequest
} from "../../../src/operations";
import { content, harness, ids, refs, seedRunningTurn, type Assembled } from "./fixture";

class HostedExecutor extends TurnExecutor {
    public async execute(turn: TurnContext): Promise<TurnOutcome> {
        if (turn.operations[0] !== undefined) {
            await turn.invocation.invoke(
                turn.operations[0],
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
        const tool = new TurnBoundOperation(
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
                new TurnBoundOperation(
                    tool.binding,
                    tool.facet,
                    new OperationRef("memory:write"),
                    descriptor
                )
        ).toThrow(/one operation/);
    });

    it("identifies exact Turn authorship by commit kind and complete lease token", () => {
        const seeded = seedRunningTurn();
        const commit = new RunCommit({
            id: new RunCommitId("authorship-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: seeded.running.pins,
            writer: { kind: "turn", token: seeded.token },
            subjectTurn: ids.turn,
            content: content("8")
        });
        const wrongHolder = new PrincipalRef(
            seeded.token.holder.tenantId,
            new PrincipalId("wrong-authorship-holder")
        );
        const root = seeded.repository.transaction((transaction) =>
            seeded.repository.loadCommit(transaction, ids.root)
        );
        if (root === undefined) throw new TypeError("Root commit must exist");
        const system = new RunCommit({
            id: new RunCommitId("system-authorship"),
            run: ids.run,
            branch: ids.branch,
            kind: "eventDelivery",
            parents: [ids.root],
            pins: seeded.running.pins,
            writer: {
                kind: "system",
                cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
            },
            subjectTurn: ids.turn,
            reservation: refs.route
        });
        expect([
            commit.isTurnAuthored("result", seeded.token),
            commit.isTurnAuthored("message", seeded.token),
            new RunCommit({
                id: new RunCommitId("wrong-subject-authorship"),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [ids.root],
                pins: seeded.running.pins,
                writer: { kind: "turn", token: seeded.token },
                subjectTurn: new TurnId("other-turn"),
                content: content("8")
            }).isTurnAuthored("result", seeded.token),
            commit.isTurnAuthored("result", { ...seeded.token, turn: new TurnId("other-turn") }),
            commit.isTurnAuthored("result", { ...seeded.token, holder: wrongHolder }),
            commit.isTurnAuthored("result", {
                ...seeded.token,
                epoch: seeded.token.epoch + 1
            }),
            root.isTurnAuthored("root", seeded.token),
            system.isTurnAuthored("eventDelivery", seeded.token)
        ]).toEqual([true, false, false, false, false, false, false, false]);
    });

    it(
        "[C13-TURN-MODEL-CALL] hosts a model call only inside the exact live Turn and commits its complete output",
        { tags: "p1" },
        async () => {
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
            const output = (await contentStore.put(new TextEncoder().encode("complete output")))
                .ref;
            const read = boundTool("read", "memory.read", "observe", "Read memory.");
            const write = boundTool("write", "memory.write", "mutate", "Write memory.");
            const modelCalls: ReturnType<typeof content>[] = [];
            const invocationCalls: TurnBoundOperation[] = [];
            const stream: Uint8Array[] = [];
            const host = new TurnExecutorHost({
                runtime: seeded.runtime,
                executor: new HostedExecutor(),
                content: contentStore,
                operations: { resolve: async () => [write, read] },
                prompt: { assemble: async () => prompt },
                invocations: {
                    invoke: async (request) => {
                        invocationCalls.push(request.operation);
                        expect(request.token).toEqual(seeded.token);
                        expect(request.input).toEqual({ key: "value" });
                        return {
                            tier: "mediated",
                            output: { stored: true },
                            evidence: { receipt: "receipt-1" }
                        };
                    }
                },
                model: {
                    call: async (request) => {
                        modelCalls.push(request.prompt);
                        expect(request.operations).toEqual([write, read]);
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
        }
    );

    it("adapts one exact bound tool to the existing mediated OperationGateway and disposes it", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const resolved = new TestResolvedFacet(tool, {
            kind: "mediated",
            output: { value: 1 },
            evidence: { receipt: "receipt-1" }
        });
        const gateway = new TestOperationGateway(resolved);
        const adapter = new GatewayTurnInvocationPort({
            open: async (scope) => {
                expect(scope.token).toEqual(seeded.token);
                return gateway;
            }
        });

        await expect(
            adapter.invoke({
                turn: seeded.running,
                token: seeded.token,
                operation: tool,
                requestKey: new OperationRequestKey("gateway-call"),
                input: { key: "value" },
                signal: new AbortController().signal
            })
        ).resolves.toEqual({
            tier: "mediated",
            output: { value: 1 },
            evidence: { receipt: "receipt-1" }
        });
        expect(resolved.requests).toEqual([
            {
                requestKey: new OperationRequestKey("gateway-call"),
                operation: tool.descriptor.name,
                payload: { kind: "single", input: { key: "value" } }
            }
        ]);
        expect(resolved.disposed).toBe(true);
    });

    it.each([
        ["facet identity", { facet: new FacetRef("memory:other") }, "binding.invalid"],
        ["package identity", { package: new FacetPackageId("other") }, "binding.invalid"],
        ["missing descriptor", { descriptor: null }, "binding.invalid"],
        [
            "descriptor schema and policy",
            {
                descriptor: new OperationDescriptor(
                    new OperationName("read"),
                    "mutate",
                    new JsonSchema({ type: "string" }),
                    new JsonSchema({ type: "number" }),
                    "A different operation contract."
                )
            },
            "binding.invalid"
        ]
    ] as const)(
        "rejects a gateway %s mismatch and disposes the resolution",
        async (_, options, code) => {
            const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
            const tool = boundTool("read", "memory.read", "observe", "Read memory.");
            const resolved = new TestResolvedFacet(
                tool,
                { kind: "mediated", output: {}, evidence: {} },
                options
            );
            const adapter = invocationAdapter(resolved);

            await expect(adapter.invoke(invocationRequest(seeded, tool))).rejects.toMatchObject({
                code
            });
            expect(resolved.requests).toHaveLength(0);
            expect(resolved.disposed).toBe(true);
        }
    );

    it(
        "reports a direct gateway dispatch as the direct tier and carries no evidence",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
            const tool = boundTool("read", "memory.read", "observe", "Read memory.");
            const direct = new TestResolvedFacet(tool, {
                kind: "direct",
                output: { value: 1 }
            });

            const result = await invocationAdapter(direct).invoke(invocationRequest(seeded, tool));

            // §7.2: a direct call writes nothing durable, so there is no Invocation for
            // the result to name. The output still reaches the executor.
            expect(result).toEqual({ tier: "direct", output: { value: 1 } });
            expect(Object.hasOwn(result, "evidence")).toBe(false);
            expect(direct.requests).toHaveLength(1);
            expect(direct.disposed).toBe(true);
        }
    );

    it("propagates cancellation across the gateway boundary", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const controller = new AbortController();
        const cancelled = new TestResolvedFacet(
            tool,
            { kind: "mediated", output: {}, evidence: {} },
            { afterDispatch: () => controller.abort() }
        );
        await expect(
            invocationAdapter(cancelled).invoke(invocationRequest(seeded, tool, controller.signal))
        ).rejects.toMatchObject({
            code: "lease.invalid",
            message: "Turn execution is cancelled"
        });
        expect(cancelled.disposed).toBe(true);
    });

    it(
        "rejects wrong-Turn, wrong-holder, and stale-epoch host admission before executor code",
        { tags: "p0" },
        async () => {
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
        }
    );

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

    it("assembles the prompt from the complete immutable execution scope", async () => {
        const placement = memoryPlacement();
        const seeded = seedRunningTurn(undefined, {}, [placement]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const boundaries = await TestBoundaries.create([tool]);
        let assemblies = 0;
        const executor = new FunctionExecutor(async (context) => {
            expect(context.prompt).toBe(boundaries.prompt);
            expect(context.cancellation.aborted).toBe(false);
            return context.outcome.succeed(
                resultCommit(context, "assembled-prompt-result", boundaries.output, ids.root)
            );
        });

        await boundaries
            .host(seeded, executor, {
                prompt: {
                    assemble: async (request) => {
                        assemblies += 1;
                        expect(request.turn.id).toEqual(ids.turn);
                        expect(request.token).toEqual(seeded.token);
                        expect(request.effectiveCommit.id).toEqual(ids.root);
                        expect(request.placement.placements).toEqual([placement]);
                        expect(request.resumeCheckpoint).toBeUndefined();
                        expect(request.operations).toEqual([tool]);
                        return boundaries.prompt;
                    }
                }
            })
            .execute(seeded.token);
        expect(assemblies).toBe(1);
    });

    it("rejects a structural tool substitute from the tool source", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const structuralTool: TurnBoundOperation = Object.freeze({
            binding: tool.binding,
            facet: tool.facet,
            operation: tool.operation,
            descriptor: tool.descriptor
        });
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async () => {
            throw new TypeError("executor must not run");
        });

        await expect(
            boundaries
                .host(seeded, executor, { operations: { resolve: async () => [structuralTool] } })
                .execute(seeded.token)
        ).rejects.toBeInstanceOf(TypeError);
        expect(executor.calls).toBe(0);
    });

    it("rejects a wrong-Turn or stale-head commit at the handle call without mutation", async () => {
        const cases = [
            {
                name: "wrong Turn",
                subject: new TurnId("other-turn"),
                parent: ids.root,
                code: "turn.invalid-state"
            },
            {
                name: "stale head",
                subject: ids.turn,
                parent: new RunCommitId("not-the-current-head"),
                code: "protocol.revision-conflict"
            }
        ];
        for (const testCase of cases) {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const executor = new FunctionExecutor(async (context) => {
                return context.outcome.succeed(
                    resultCommit(
                        context,
                        `invalid-${testCase.name.replace(" ", "-")}`,
                        boundaries.output,
                        testCase.parent,
                        testCase.subject
                    )
                );
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({ code: testCase.code });
            const persisted = seeded.repository.transaction((transaction) => ({
                turn: seeded.repository.loadTurn(transaction, ids.turn),
                branch: seeded.repository.loadBranch(transaction, ids.branch)
            }));
            expect(persisted.turn?.status.kind).toBe("running");
            expect(persisted.branch?.head).toEqual(ids.root);
        }
    });

    it(
        "observes exact takeover cancellation and fences every effectful handle",
        { tags: "p0" },
        async () => {
            const tool = boundTool("read", "memory.read", "observe", "Read memory.");
            const placement = memoryPlacement();
            const seeded = seedRunningTurn(undefined, {}, [placement]);
            const boundaries = await TestBoundaries.create([tool]);
            const newHolder = new PrincipalRef(
                ids.holder.tenantId,
                new PrincipalId("takeover-holder")
            );
            const errors: string[] = [];
            let modelSignal: AbortSignal | undefined;
            let observedInbox: readonly TurnInboxEntry[] | undefined;
            let observedCancellation = false;
            let observedCancelledOutcome: unknown;
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
                const calls = [
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
                for (const [index, call] of calls.entries()) {
                    try {
                        await call();
                    } catch (error) {
                        if (!(error instanceof Error)) throw error;
                        errors.push(errorCode(error));
                    }
                    if (index === 0) expect(context.cancellation.aborted).toBe(true);
                }
                observedInbox = await context.inbox.read(0);
                observedCancellation = context.cancellation.aborted;
                const outcome = await context.outcome.cancelled();
                observedCancelledOutcome = outcome;
                return outcome;
            });

            await expect(boundaries.host(seeded, executor).execute(seeded.token)).resolves.toEqual({
                kind: "cancelled"
            });
            expect(errors).toEqual(Array.from({ length: 7 }, () => "lease.invalid"));
            expect(modelSignal?.aborted ?? true).toBe(true);
            expect(boundaries.modelCalls).toHaveLength(0);
            expect(boundaries.invocationCalls).toHaveLength(0);
            expect(boundaries.streamEvents).toHaveLength(0);
            expect(observedInbox).toEqual([
                cancellationEntry(
                    "takeover-cancellation",
                    seeded.token,
                    boundaries.cancellationPayload,
                    0
                )
            ]);
            expect(observedCancellation).toBe(true);
            expect(observedCancelledOutcome).toEqual({ kind: "cancelled" });
            const persisted = seeded.repository.transaction((transaction) => ({
                turn: seeded.repository.loadTurn(transaction, ids.turn),
                branch: seeded.repository.loadBranch(transaction, ids.branch)
            }));
            expect(persisted.turn?.status.kind).toBe("running");
            expect(persisted.turn?.lease.holder).toEqual(newHolder);
            expect(persisted.branch?.head).toEqual(ids.root);
        }
    );

    it(
        "refuses to execute against two cancellation entries for one lease",
        { tags: "p0" },
        async () => {
            // A delivered cancellation request and the holder's own settlement name one
            // entry (SPEC §5.6). Two entries carrying the same token are two versions of
            // what the Turn was told, and the executor cannot pick between them — it reads
            // the first match to decide whether the Turn is cancelled at all.
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            seeded.repository.transaction((transaction) => {
                seeded.repository.insertInbox(
                    transaction,
                    cancellationEntry(
                        "duplicate-cancel-first",
                        seeded.token,
                        boundaries.cancellationPayload,
                        0
                    )
                );
                seeded.repository.insertInbox(
                    transaction,
                    cancellationEntry(
                        "duplicate-cancel-second",
                        seeded.token,
                        boundaries.cancellationPayload,
                        1
                    )
                );
            });
            const executor = new FunctionExecutor(async () => {
                throw new TypeError("executor must not run");
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({
                code: "turn.invalid-state",
                message: "Turn executor cancellation evidence is not canonical"
            });
            expect(executor.calls).toBe(0);
        }
    );

    it(
        "refuses to execute against a result commit its own token left unpaired",
        { tags: "p0" },
        async () => {
            // Recovery reads the Turn's own recorded result to decide which commit settled
            // it. A result commit under the running token with no result on the Turn is the
            // transition come apart, and the host has to refuse the scope rather than fault
            // on the Turn's absent result.
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const orphan = new RunCommit({
                id: new RunCommitId("orphan-result"),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [ids.root],
                pins: seeded.running.pins,
                writer: { kind: "turn", token: seeded.token },
                subjectTurn: ids.turn,
                content: boundaries.output
            });
            seeded.repository.transaction((transaction) => {
                seeded.repository.insertCommit(transaction, orphan);
                seeded.repository.replaceBranch(
                    transaction,
                    new Revision(0),
                    new RunBranch(ids.branch, ids.run, "main", orphan.id, new Revision(1))
                );
            });
            const executor = new FunctionExecutor(async () => {
                throw new TypeError("executor must not run");
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
            expect(executor.calls).toBe(0);
            expect(
                seeded.repository.transaction((transaction) =>
                    seeded.repository.loadTurn(transaction, ids.turn)
                )?.status.kind
            ).toBe("running");
        }
    );

    it(
        "lets the live lease holder observe a delivered cancellation and settle the Turn itself",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const cancellation = cancellationEntry(
                "requested-cancellation",
                seeded.token,
                boundaries.cancellationPayload,
                0
            );
            seeded.runtime.deliverEvent(
                ids.turn,
                seeded.running.revision,
                seeded.token,
                cancellation,
                new Date(2_000)
            );
            let observed: readonly TurnInboxEntry[] | undefined;
            const executor = new FunctionExecutor(async (context) => {
                observed = await context.inbox.read(0);
                expect(context.cancellation.aborted).toBe(true);
                // The lease is still live, so the delivered request is not yet an
                // outcome: only the holder's own transition makes it one.
                await expect(context.outcome.cancelled()).rejects.toMatchObject({
                    code: "turn.invalid-state"
                });
                return context.outcome.cancel(
                    resultCommit(context, "requested-cancel-result", boundaries.output, ids.root),
                    cancellation
                );
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).resolves.toEqual({
                kind: "cancelled",
                result: boundaries.output,
                commit: new RunCommitId("requested-cancel-result")
            });
            expect(observed).toEqual([cancellation]);
            const persisted = seeded.repository.transaction((transaction) => ({
                turn: seeded.repository.loadTurn(transaction, ids.turn),
                inbox: seeded.repository.listInbox(transaction, ids.turn)
            }));
            expect(persisted.turn?.status.kind).toBe("cancelled");
            expect(persisted.turn?.lease.holder).toBeUndefined();
            expect(persisted.inbox).toEqual([cancellation]);
        }
    );

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
        await expect(
            boundaries.host(restarted, mustNotRun).execute({
                ...seeded.token,
                holder: new PrincipalRef(
                    seeded.token.holder.tenantId,
                    new PrincipalId("wrong-suspended-holder")
                )
            })
        ).rejects.toMatchObject({ code: "lease.invalid" });
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
        const failExecutor = new FunctionExecutor(async (context) => {
            return context.outcome.fail(
                resultCommit(context, "failed-result", failureBoundaries.output, ids.root)
            );
        });
        await expect(
            failureBoundaries.host(failure, failExecutor).execute(failure.token)
        ).resolves.toEqual({
            kind: "failed",
            result: failureBoundaries.output,
            commit: new RunCommitId("failed-result")
        });

        const cancelled = seedRunningTurn();
        const cancelBoundaries = await TestBoundaries.create();
        const cancelExecutor = new FunctionExecutor(async (context) => {
            return context.outcome.cancel(
                resultCommit(context, "cancelled-result", cancelBoundaries.output, ids.root),
                cancellationEntry(
                    "self-cancellation",
                    context.token,
                    cancelBoundaries.cancellationPayload,
                    0
                )
            );
        });
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

    it("recovers only the terminal result matching the Turn outcome", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const matching = resultCommitFor(seeded, "matching-result", boundaries.output, ids.root);
        completeSeededTurn(seeded, matching);
        const mustNotRun = new FunctionExecutor(async () => {
            throw new TypeError("recovery must not rerun the executor");
        });
        await expect(boundaries.host(seeded, mustNotRun).execute(seeded.token)).resolves.toEqual({
            kind: "succeeded",
            result: boundaries.output,
            commit: matching.id
        });

        const diverged = seedRunningTurn();
        diverged.repository.transaction((transaction) => {
            const running = diverged.repository.loadTurn(transaction, ids.turn);
            if (running === undefined) throw new TypeError("Seeded Turn must exist");
            diverged.repository.insertCommit(
                transaction,
                resultCommitFor(diverged, "diverged-result", boundaries.output, ids.root)
            );
            diverged.repository.replaceTurn(
                transaction,
                running.revision,
                running.complete(
                    diverged.token,
                    "succeeded",
                    boundaries.checkpointState,
                    new Date(2_000)
                )
            );
        });
        await expect(
            boundaries.host(diverged, mustNotRun).execute(diverged.token)
        ).rejects.toMatchObject({ code: "lease.invalid" });
        expect(mustNotRun.calls).toBe(0);
    });

    it("rejects ambiguous same-token terminal result evidence", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const result = resultCommitFor(seeded, "ambiguous-result", boundaries.output, ids.root);
        completeSeededTurn(seeded, result);
        const mustNotRun = new FunctionExecutor(async () => {
            throw new TypeError("recovery must not rerun the executor");
        });
        await expect(boundaries.host(seeded, mustNotRun).execute(seeded.token)).resolves.toEqual({
            kind: "succeeded",
            result: boundaries.output,
            commit: result.id
        });

        seeded.repository.transaction((transaction) => {
            seeded.repository.insertCommit(
                transaction,
                resultCommitFor(seeded, "ambiguous-duplicate", boundaries.output, ids.root)
            );
        });
        await expect(
            boundaries.host(seeded, mustNotRun).execute(seeded.token)
        ).rejects.toMatchObject({ code: "turn.invalid-state" });
        expect(mustNotRun.calls).toBe(0);
    });

    it("rejects checkpoint and result commits outside their atomic lifecycle transitions", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const invalid = [
            resultCommitFor(seeded, "premature-result", boundaries.output, ids.root),
            checkpointCommitFor(
                seeded,
                "premature-checkpoint",
                boundaries.checkpointState,
                ids.root
            )
        ];
        for (const commit of invalid) {
            expect(() =>
                seeded.runtime.appendTurnCommit(commit, new Revision(0), new Date(2_000))
            ).toThrow(
                expect.objectContaining({
                    code: "run.invalid-state"
                })
            );
        }
        const persisted = seeded.repository.transaction((transaction) => ({
            turn: seeded.repository.loadTurn(transaction, ids.turn),
            branch: seeded.repository.loadBranch(transaction, ids.branch),
            commits: seeded.repository.listCommits(transaction)
        }));
        expect(persisted.turn?.status.kind).toBe("running");
        expect(persisted.branch?.head).toEqual(ids.root);
        expect(persisted.commits.map((commit) => commit.id)).toEqual([ids.root]);
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

    it("rejects an executor that returns without a canonical outcome transition", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async () => ({
            kind: "succeeded",
            result: boundaries.output,
            commit: new RunCommitId("uncommitted-result")
        }));

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).rejects.toMatchObject(
            {
                code: "turn.invalid-state"
            }
        );
        expect(executor.calls).toBe(1);
    });

    it.each(["kind", "content", "commit"] as const)(
        "rejects a %s mismatch between returned and durable terminal outcomes",
        async (mismatch) => {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const canonical = {
                kind: "succeeded" as const,
                result: boundaries.output,
                commit: new RunCommitId(`durable-${mismatch}-result`)
            };
            const executor = new FunctionExecutor(async (context) => {
                await context.outcome.succeed(
                    resultCommit(context, canonical.commit.value, boundaries.output, ids.root)
                );
                switch (mismatch) {
                    case "kind":
                        return { ...canonical, kind: "failed" };
                    case "content":
                        return { ...canonical, result: boundaries.prompt };
                    case "commit":
                        return { ...canonical, commit: new RunCommitId("wrong-returned-result") };
                }
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
            const restarted = harness(seeded.storage.snapshot());
            const mustNotRun = new FunctionExecutor(async () => {
                throw new TypeError("recovery must not rerun the executor");
            });
            await expect(
                boundaries.host(restarted, mustNotRun).execute(seeded.token)
            ).resolves.toEqual(canonical);
            expect(mustNotRun.calls).toBe(0);
        }
    );

    it("rejects a returned checkpoint that differs from the durable checkpoint record", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const checkpointId = new RunCheckpointId("durable-return-checkpoint");
        const commitId = new RunCommitId("durable-return-checkpoint-commit");
        const canonicalCheckpoint = new RunCheckpoint(
            checkpointId,
            ids.turn,
            commitId,
            boundaries.checkpointState,
            0,
            undefined
        );
        const executor = new FunctionExecutor(async (context) => {
            const canonical = await context.checkpoint.persist(
                canonicalCheckpoint,
                checkpointCommit(context, commitId.value, boundaries.checkpointState, ids.root)
            );
            if (canonical.kind !== "suspended") {
                throw new TypeError("Checkpoint persistence must suspend the Turn");
            }
            return {
                ...canonical,
                checkpoint: new RunCheckpoint(
                    checkpointId,
                    ids.turn,
                    commitId,
                    boundaries.prompt,
                    0,
                    undefined
                )
            };
        });

        await expect(boundaries.host(seeded, executor).execute(seeded.token)).rejects.toMatchObject(
            {
                code: "turn.invalid-state"
            }
        );
        const restarted = harness(seeded.storage.snapshot());
        const mustNotRun = new FunctionExecutor(async () => {
            throw new TypeError("recovery must not rerun the executor");
        });
        await expect(boundaries.host(restarted, mustNotRun).execute(seeded.token)).resolves.toEqual(
            {
                kind: "suspended",
                checkpoint: canonicalCheckpoint,
                commit: commitId
            }
        );
        expect(mustNotRun.calls).toBe(0);
    });

    it.each(["content", "commit"] as const)(
        "rejects a %s mismatch between returned and durable cancellation outcomes",
        async (mismatch) => {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const commitId = new RunCommitId(`durable-cancel-${mismatch}`);
            const canonical = {
                kind: "cancelled" as const,
                result: boundaries.output,
                commit: commitId
            };
            const executor = new FunctionExecutor(async (context) => {
                await context.outcome.cancel(
                    resultCommit(context, commitId.value, boundaries.output, ids.root),
                    cancellationEntry(
                        `durable-cancel-${mismatch}-entry`,
                        context.token,
                        boundaries.cancellationPayload,
                        0
                    )
                );
                return mismatch === "content"
                    ? { ...canonical, result: boundaries.prompt }
                    : { ...canonical, commit: new RunCommitId("wrong-returned-cancellation") };
            });

            await expect(
                boundaries.host(seeded, executor).execute(seeded.token)
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
            const restarted = harness(seeded.storage.snapshot());
            const mustNotRun = new FunctionExecutor(async () => {
                throw new TypeError("recovery must not rerun the executor");
            });
            await expect(
                boundaries.host(restarted, mustNotRun).execute(seeded.token)
            ).resolves.toEqual(canonical);
            expect(mustNotRun.calls).toBe(0);
        }
    );

    it("rejects a prompt that is absent or reported under another exact content identity", async () => {
        const cases = [
            async () => undefined,
            async () => {
                const other = content("9");
                return {
                    ref: other,
                    digest: other.digest,
                    size: 1,
                    hint: undefined
                };
            }
        ];
        for (const stat of cases) {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const executor = new FunctionExecutor(async () => {
                throw new TypeError("executor must not run");
            });
            const contentBoundary: ContentStore = {
                put: (bytes, hint) => boundaries.content.put(bytes, hint),
                get: (ref, range) => boundaries.content.get(ref, range),
                stat
            };

            await expect(
                boundaries
                    .host(seeded, executor, { content: contentBoundary })
                    .execute(seeded.token)
            ).rejects.toMatchObject({
                code: "content.not-found",
                message: "Turn content is not available"
            });
            expect(executor.calls).toBe(0);
        }
    });

    it("keeps content access owned and rejects a mismatched put identity", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        let putBytes: Uint8Array | undefined;
        let validPut = true;
        const sharedBytes = new Uint8Array([7, 8, 9]);
        const contentBoundary: ContentStore = {
            put: async (bytes) => {
                putBytes = bytes;
                return {
                    ref: boundaries.prompt,
                    digest: validPut ? boundaries.prompt.digest : boundaries.output.digest
                };
            },
            get: async () => sharedBytes,
            stat: (ref) => boundaries.content.stat(ref)
        };
        const executor = new FunctionExecutor(async (context) => {
            const source = new Uint8Array([1, 2, 3]);
            const stored = await context.content.put(source);
            expect(stored).toEqual({
                ref: boundaries.prompt,
                digest: boundaries.prompt.digest
            });
            expect(Object.isFrozen(stored)).toBe(true);
            validPut = false;
            await expect(context.content.put(source)).rejects.toMatchObject({
                code: "codec.invalid",
                message: "Content store returned mismatched identity"
            });
            expect(putBytes).toEqual(source);
            expect(putBytes).not.toBe(source);

            const first = await context.content.get(boundaries.prompt);
            first[0] = 0;
            const second = await context.content.get(boundaries.prompt);
            expect(second).not.toBe(first);
            expect(second).toEqual(new Uint8Array([7, 8, 9]));
            expect(sharedBytes).toEqual(new Uint8Array([7, 8, 9]));
            await expect(context.content.stat(boundaries.prompt)).resolves.toMatchObject({
                ref: boundaries.prompt,
                digest: boundaries.prompt.digest
            });
            return context.outcome.succeed(
                resultCommit(context, "content-result", boundaries.output, ids.root)
            );
        });

        await expect(
            boundaries.host(seeded, executor, { content: contentBoundary }).execute(seeded.token)
        ).resolves.toMatchObject({ kind: "succeeded", result: boundaries.output });
    });

    it("accepts only the exact immutable bound-tool object for mediated invocation", async () => {
        const seeded = seedRunningTurn(undefined, {}, [memoryPlacement()]);
        const tool = boundTool("read", "memory.read", "observe", "Read memory.");
        const boundaries = await TestBoundaries.create([tool]);
        const executor = new FunctionExecutor(async (context) => {
            const equivalent = boundTool("read", "memory.read", "observe", "Read memory.");
            await expect(
                context.invocation.invoke(
                    equivalent,
                    new OperationRequestKey("equivalent-tool"),
                    {}
                )
            ).rejects.toMatchObject({ code: "operation.missing" });
            await expect(
                context.invocation.invoke(tool, new OperationRequestKey("exact-tool"), {
                    nested: { value: 1 }
                })
            ).resolves.toEqual({ tier: "mediated", output: {}, evidence: { receipt: "test" } });
            return context.outcome.succeed(
                resultCommit(context, "invocation-result", boundaries.output, ids.root)
            );
        });

        await boundaries.host(seeded, executor).execute(seeded.token);
        expect(boundaries.invocationCalls).toEqual([tool]);
    });

    it("canonicalizes ephemeral stream events and validates complete model usage", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const publications: TurnStreamPublication[] = [];
        const executor = new FunctionExecutor(async (context) => {
            const bytes = new Uint8Array([4, 5, 6]);
            await context.stream.publish({ kind: "content", bytes });
            bytes[0] = 0;
            await context.stream.publish({
                kind: "usage",
                usage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    cacheReadTokens: 3,
                    cacheWriteTokens: 4
                }
            });
            await context.stream.publish({
                kind: "usage",
                usage: { inputTokens: 0, outputTokens: 0 }
            });
            await expect(
                context.stream.publish({
                    kind: "usage",
                    usage: { inputTokens: -1, outputTokens: 0 }
                })
            ).rejects.toBeInstanceOf(TypeError);
            await expect(context.model.call({ prompt: boundaries.prompt })).resolves.toEqual({
                output: boundaries.output,
                usage: { inputTokens: 1, outputTokens: 1 }
            });
            return context.outcome.succeed(
                resultCommit(context, "stream-result", boundaries.output, ids.root)
            );
        });

        await boundaries
            .host(seeded, executor, {
                stream: { publish: async (publication) => void publications.push(publication) }
            })
            .execute(seeded.token);
        expect(publications).toHaveLength(3);
        const [contentPublication, usagePublication, zeroUsagePublication] = publications;
        expect(contentPublication?.event).toEqual({
            kind: "content",
            bytes: new Uint8Array([4, 5, 6])
        });
        expect(usagePublication?.event).toEqual({
            kind: "usage",
            usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
        });
        const usage = publishedUsage(usagePublication);
        const zeroUsage = publishedUsage(zeroUsagePublication);
        expect(Object.isFrozen(usage)).toBe(true);
        expect(zeroUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
        expect(Object.keys(zeroUsage)).toEqual(["inputTokens", "outputTokens"]);
    });

    it.each([
        ["negative", -1],
        ["fractional", 0.5],
        ["unsafe", Number.MAX_SAFE_INTEGER + 1]
    ])("rejects %s model usage at the model boundary", async (_, invalid) => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            await expect(context.model.call({ prompt: boundaries.prompt })).rejects.toBeInstanceOf(
                TypeError
            );
            return context.outcome.succeed(
                resultCommit(
                    context,
                    `usage-result-${String(invalid)}`,
                    boundaries.output,
                    ids.root
                )
            );
        });
        await boundaries
            .host(seeded, executor, {
                model: {
                    call: async () => ({
                        output: boundaries.output,
                        usage: { inputTokens: 0, outputTokens: invalid }
                    })
                }
            })
            .execute(seeded.token);
    });

    it("returns the exact inclusive inbox cursor slice", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const first = inboxEntry("inbox-first", ids.turn, 0, "turn.message", boundaries.prompt);
        seeded.runtime.deliverEvent(
            ids.turn,
            seeded.running.revision,
            seeded.token,
            first,
            new Date(2_000)
        );
        const revised = seeded.repository.transaction((transaction) =>
            seeded.repository.loadTurn(transaction, ids.turn)
        );
        if (revised === undefined) throw new TypeError("Revised Turn must exist");
        const second = inboxEntry("inbox-second", ids.turn, 1, "turn.message", boundaries.output);
        seeded.runtime.deliverEvent(
            ids.turn,
            revised.revision,
            seeded.token,
            second,
            new Date(2_000)
        );
        const executor = new FunctionExecutor(async (context) => {
            for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
                await expect(context.inbox.read(cursor)).rejects.toBeInstanceOf(TypeError);
            }
            await expect(context.inbox.read(0)).resolves.toEqual([first, second]);
            await expect(context.inbox.read(1)).resolves.toEqual([second]);
            await expect(context.inbox.read(2)).resolves.toEqual([]);
            expect(context.cancellation.aborted).toBe(false);
            await expect(context.outcome.cancelled()).rejects.toMatchObject({
                code: "turn.invalid-state"
            });
            return context.outcome.succeed(
                resultCommit(context, "inbox-result", boundaries.output, ids.root)
            );
        });

        await boundaries.host(seeded, executor).execute(seeded.token);
    });

    it("does not let a prior lease epoch cancel the current holder", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const displaced = cancellationEntry(
            "prior-epoch-cancellation",
            seeded.token,
            boundaries.cancellationPayload,
            0
        );
        const reclaimed = seeded.runtime.reclaimTurn(
            ids.turn,
            seeded.running.revision,
            ids.holder,
            new Date(6_000),
            new Date(10_000),
            displaced
        );
        const currentToken = Object.freeze({
            turn: ids.turn,
            holder: ids.holder,
            epoch: reclaimed.lease.epoch
        });
        const executor = new FunctionExecutor(async (context) => {
            await expect(context.inbox.read(0)).resolves.toEqual([displaced]);
            expect(context.cancellation.aborted).toBe(false);
            await expect(context.outcome.cancelled()).rejects.toMatchObject({
                code: "turn.invalid-state"
            });
            return context.outcome.succeed(
                resultCommit(context, "reclaimed-result", boundaries.output, ids.root)
            );
        });

        await expect(
            boundaries.host(seeded, executor, { now: () => new Date(7_000) }).execute(currentToken)
        ).resolves.toMatchObject({ kind: "succeeded" });
    });

    it(
        "[C13-TURN-CANCEL-INBOX] fences a boundary result when cancellation arrives during the operation",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            let now = new Date(2_000);
            const cancellation = cancellationEntry(
                "boundary-cancellation",
                seeded.token,
                boundaries.cancellationPayload,
                0
            );
            const contentBoundary: ContentStore = {
                put: (bytes, hint) => boundaries.content.put(bytes, hint),
                get: async (ref, range) => {
                    seeded.runtime.reclaimTurn(
                        ids.turn,
                        seeded.running.revision,
                        ids.holder,
                        new Date(6_000),
                        new Date(10_000),
                        cancellation
                    );
                    now = new Date(7_000);
                    return boundaries.content.get(ref, range);
                },
                stat: (ref) => boundaries.content.stat(ref)
            };
            let boundaryError: string | undefined;
            let boundaryCancellation = false;
            let boundaryOutcome: unknown;
            const executor = new FunctionExecutor(async (context) => {
                try {
                    await context.content.get(boundaries.prompt);
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    boundaryError = errorCode(error);
                }
                boundaryCancellation = context.cancellation.aborted;
                const outcome = await context.outcome.cancelled();
                boundaryOutcome = outcome;
                return outcome;
            });

            await expect(
                boundaries
                    .host(seeded, executor, { content: contentBoundary, now: () => now })
                    .execute(seeded.token)
            ).resolves.toEqual({ kind: "cancelled" });
            expect(boundaryError).toBe("lease.invalid");
            expect(boundaryCancellation).toBe(true);
            expect(boundaryOutcome).toEqual({ kind: "cancelled" });
        }
    );

    it("rejects every stale content operation and stale inbox reads without exact cancellation", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        let now = new Date(2_000);
        const executor = new FunctionExecutor(async (context) => {
            now = new Date(9_000);
            const calls = [
                () => context.content.put(new Uint8Array([1])),
                () => context.content.get(boundaries.prompt),
                () => context.content.stat(boundaries.prompt),
                () => context.inbox.read(0)
            ];
            for (const call of calls) {
                await expect(call()).rejects.toMatchObject({ code: "lease.invalid" });
            }
            throw new AgentCoreError("lease.invalid", "stop stale executor");
        });

        await expect(
            boundaries.host(seeded, executor, { now: () => now }).execute(seeded.token)
        ).rejects.toMatchObject({ code: "lease.invalid" });
        expect(executor.calls).toBe(1);
    });

    it.each([
        ["wrong run", { run: new RunId("wrong-run") }],
        ["wrong branch", { branch: new RunBranchId("wrong-branch") }],
        [
            "wrong token holder",
            {
                writer: {
                    kind: "turn" as const,
                    token: {
                        turn: ids.turn,
                        holder: new PrincipalRef(
                            ids.holder.tenantId,
                            new PrincipalId("wrong-commit-holder")
                        ),
                        epoch: 1
                    }
                }
            }
        ]
    ] as const)("rejects a result commit with %s", async (_, override) => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            const valid = resultCommit(
                context,
                "invalid-exact-commit",
                boundaries.output,
                ids.root
            );
            const commit = replaceResultCommit(valid, override);
            return context.outcome.succeed(commit);
        });

        await expect(
            boundaries.host(seeded, executor).execute(seeded.token)
        ).rejects.toBeInstanceOf(AgentCoreError);
        expect(
            seeded.repository.transaction(
                (transaction) => seeded.repository.loadBranch(transaction, ids.branch)?.head
            )
        ).toEqual(ids.root);
    });

    it("rejects checkpoint commits through the ordinary append handle", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            await expect(
                context.commit.append(
                    checkpointCommit(context, "wrong-handle", boundaries.checkpointState, ids.root)
                )
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
            return context.outcome.succeed(
                resultCommit(context, "append-result", boundaries.output, ids.root)
            );
        });

        await expect(
            boundaries.host(seeded, executor).execute(seeded.token)
        ).resolves.toMatchObject({
            kind: "succeeded"
        });
    });

    it("requires optional checkpoint tree content before suspension", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const missingTree = content("9");
        const executor = new FunctionExecutor(async (context) => {
            const commit = checkpointCommit(
                context,
                "missing-tree-commit",
                boundaries.checkpointState,
                ids.root,
                missingTree
            );
            await expect(
                context.checkpoint.persist(
                    new RunCheckpoint(
                        new RunCheckpointId("missing-tree-checkpoint"),
                        ids.turn,
                        commit.id,
                        boundaries.checkpointState,
                        0,
                        missingTree
                    ),
                    commit
                )
            ).rejects.toMatchObject({ code: "content.not-found" });
            return context.outcome.succeed(
                resultCommit(context, "after-missing-tree", boundaries.output, ids.root)
            );
        });

        await expect(
            boundaries.host(seeded, executor).execute(seeded.token)
        ).resolves.toMatchObject({ kind: "succeeded" });
    });

    it(
        "[C13-RUN-RESOURCE-CEILING] advances the Run's durable token total where each model call commits",
        { tags: "p1" },
        async () => {
            const seeded = seedRunningTurn();
            const boundaries = await TestBoundaries.create();
            const tokens = () =>
                seeded.repository.transaction(
                    (tx) => seeded.repository.loadRun(tx, ids.run)!.tokensConsumed
                );
            expect(tokens()).toBe(0);

            const executor = new FunctionExecutor(async (context) => {
                await context.model.call({ prompt: boundaries.prompt });
                expect(tokens()).toBe(4);
                await context.model.call({ prompt: boundaries.prompt });
                expect(tokens()).toBe(8);
                return context.outcome.succeed(
                    resultCommit(context, "token-total", boundaries.output, ids.root)
                );
            });

            await expect(
                boundaries
                    .host(seeded, executor, {
                        model: {
                            call: async () => ({
                                output: boundaries.output,
                                usage: {
                                    inputTokens: 1,
                                    outputTokens: 1,
                                    cacheReadTokens: 1,
                                    cacheWriteTokens: 1
                                }
                            })
                        }
                    })
                    .execute(seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            expect(tokens()).toBe(8);
        }
    );

    it("appends verdict commits through the ordinary Turn commit handle", async () => {
        const seeded = seedRunningTurn();
        const boundaries = await TestBoundaries.create();
        const executor = new FunctionExecutor(async (context) => {
            const verdict = turnCommit(
                context,
                "turn-verdict",
                "verdict",
                boundaries.prompt,
                ids.root,
                ids.turn
            );
            await expect(context.commit.append(verdict)).resolves.toEqual(verdict.id);
            return context.outcome.succeed(
                resultCommit(context, "after-verdict", boundaries.output, verdict.id)
            );
        });

        await expect(
            boundaries.host(seeded, executor).execute(seeded.token)
        ).resolves.toMatchObject({ kind: "succeeded" });
    });
});

class TestBoundaries {
    public readonly modelCalls: TurnModelCall[] = [];
    public readonly invocationCalls: TurnBoundOperation[] = [];
    public readonly streamEvents: Uint8Array[] = [];
    public lastModelSignal: AbortSignal | undefined;

    private constructor(
        public readonly content: MemoryContentStore,
        public readonly prompt: ContentRef,
        public readonly output: ContentRef,
        public readonly checkpointState: ContentRef,
        public readonly cancellationPayload: ContentRef,
        public readonly tools: readonly TurnBoundOperation[]
    ) {}

    public static async create(tools: readonly TurnBoundOperation[] = []): Promise<TestBoundaries> {
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
        executor: TurnExecutor,
        overrides: Partial<TurnExecutorHostInit<Transaction>> = {}
    ): TurnExecutorHost<Transaction> {
        return new TurnExecutorHost({
            runtime: seeded.runtime,
            executor,
            content: this.content,
            operations: { resolve: async () => this.tools },
            prompt: { assemble: async () => this.prompt },
            invocations: {
                invoke: async (request) => {
                    this.invocationCalls.push(request.operation);
                    return { tier: "mediated", output: {}, evidence: { receipt: "test" } };
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
            now: () => new Date(2_000),
            ...overrides
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
        private readonly tool: TurnBoundOperation,
        private readonly result: OperationDispatchResult,
        private readonly options: {
            readonly facet?: FacetRef;
            readonly package?: FacetPackageId;
            readonly descriptor?: OperationDescriptor | null;
            readonly afterDispatch?: () => void;
        } = {}
    ) {
        super();
        this.facet = options.facet ?? tool.facet;
        this.package = options.package ?? tool.operation.facet;
    }

    public descriptor(name: OperationName): OperationDescriptor | undefined {
        const descriptor = this.options.descriptor;
        if (descriptor === null) return undefined;
        return name.equals(this.tool.descriptor.name)
            ? (descriptor ?? this.tool.descriptor)
            : undefined;
    }

    public async dispatch(request: OperationRequest): Promise<OperationDispatchResult> {
        this.requests.push(request);
        this.options.afterDispatch?.();
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
    parent: RunCommitId,
    tree?: ReturnType<typeof content>
): RunCommit {
    return turnCommit(context, id, "checkpoint", output, parent, context.turn.id, tree);
}

function resultCommitFor(
    seeded: ReturnType<typeof seedRunningTurn>,
    id: string,
    output: ReturnType<typeof content>,
    parent: RunCommitId
): RunCommit {
    return seededTurnCommit(seeded, id, "result", output, parent);
}

function checkpointCommitFor(
    seeded: ReturnType<typeof seedRunningTurn>,
    id: string,
    output: ReturnType<typeof content>,
    parent: RunCommitId
): RunCommit {
    return seededTurnCommit(seeded, id, "checkpoint", output, parent);
}

function completeSeededTurn(seeded: ReturnType<typeof seedRunningTurn>, commit: RunCommit): void {
    const branchRevision = seeded.repository.transaction(
        (transaction) => seeded.repository.loadBranch(transaction, seeded.running.branch)?.revision
    );
    if (branchRevision === undefined) throw new TypeError("Seeded branch must exist");
    seeded.runtime.completeTurn({
        turn: seeded.running.id,
        expectedTurnRevision: seeded.running.revision,
        expectedBranchRevision: branchRevision,
        token: seeded.token,
        outcome: "succeeded",
        commit,
        now: new Date(2_000)
    });
}

function seededTurnCommit(
    seeded: ReturnType<typeof seedRunningTurn>,
    id: string,
    kind: "checkpoint" | "result",
    output: ReturnType<typeof content>,
    parent: RunCommitId
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: seeded.running.run,
        branch: seeded.running.branch,
        kind,
        parents: [parent],
        pins: seeded.running.pins,
        writer: { kind: "turn", token: seeded.token },
        subjectTurn: seeded.running.id,
        content: output
    });
}

function turnCommit(
    context: TurnContext,
    id: string,
    kind: "message" | "checkpoint" | "result" | "verdict",
    output: ReturnType<typeof content>,
    parent: RunCommitId,
    subject: TurnId,
    treeCheckpoint?: ReturnType<typeof content>
): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: context.turn.run,
        branch: context.turn.branch,
        kind,
        parents: [parent],
        pins: context.turn.pins,
        writer: { kind: "turn", token: context.token },
        subjectTurn: subject,
        content: output
    };
    if (treeCheckpoint !== undefined) init.treeCheckpoint = treeCheckpoint;
    return new RunCommit(init);
}

function replaceResultCommit(
    commit: RunCommit,
    override: Partial<{
        readonly run: RunId;
        readonly branch: RunBranchId;
        readonly writer: RunCommit["writer"];
    }>
): RunCommit {
    if (commit.subjectTurn === undefined || commit.content === undefined) {
        throw new TypeError("Result commit must carry its Turn and content");
    }
    return new RunCommit({
        id: commit.id,
        run: override.run ?? commit.run,
        branch: override.branch ?? commit.branch,
        kind: "result",
        parents: commit.parents,
        pins: commit.pins,
        writer: override.writer ?? commit.writer,
        subjectTurn: commit.subjectTurn,
        content: commit.content
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

function inboxEntry(
    id: string,
    turn: TurnId,
    sequence: number,
    event: string,
    payload: ReturnType<typeof content>
): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        turn,
        sequence,
        event,
        payload,
        payload.digest,
        `key:${id}`,
        undefined,
        new Date(2_000)
    );
}

function errorCode(error: Error): string {
    return error instanceof AgentCoreError ? error.code : String(error);
}

/** Reads the usage a stream publication carries, naming any other event kind that arrived. */
function publishedUsage(publication: TurnStreamPublication | undefined): TurnModelUsage {
    if (publication?.event.kind !== "usage") {
        throw new TypeError(`Expected a usage publication, received ${publication?.event.kind}`);
    }
    return publication.event.usage;
}

function invocationAdapter(resolved: ResolvedFacet): GatewayTurnInvocationPort {
    return new GatewayTurnInvocationPort({
        open: async () => new TestOperationGateway(resolved)
    });
}

function invocationRequest(
    seeded: ReturnType<typeof seedRunningTurn>,
    tool: TurnBoundOperation,
    signal: AbortSignal = new AbortController().signal
) {
    return {
        turn: seeded.running,
        token: seeded.token,
        operation: tool,
        requestKey: new OperationRequestKey("gateway-adversarial-call"),
        input: { key: "value" },
        signal
    };
}

function boundTool(
    name: string,
    binding: string,
    impact: "observe" | "mutate",
    help: string
): TurnBoundOperation {
    const descriptor = new OperationDescriptor(
        new OperationName(name),
        impact,
        new JsonSchema({ type: "object" }),
        new JsonSchema({ type: "object" }),
        help
    );
    return new TurnBoundOperation(
        new BindingName(binding),
        new FacetRef("memory:primary"),
        new OperationRef(`memory:${name}`),
        descriptor
    );
}
