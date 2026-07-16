// @ts-nocheck
import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import {
    Digest,
    JsonSchema,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { ActorId, ActorRef } from "../../src/actors";
import {
    FacetRef,
    OperationDescriptor,
    OperationName,
    type FacetData,
    type OperationContext
} from "../../src/facets";
import {
    AttemptReceipt,
    ApprovalId,
    AuditRecordId,
    type CanonicalBatchInvoker,
    ClaimWorkerId,
    EffectAttemptId,
    InvocationId,
    InvocationContinuation,
    InvocationProtectedOperationPort,
    InvocationPublicationDrainer,
    InvocationPublicationOutbox,
    ItemClaimId,
    MediatedReplayRecord,
    MemoryInvocationMediationPersistence,
    PreEffectReceipt,
    ReceiptId,
    ReplayOperationInvocationPort,
    cloneInvocationMediationMemoryState,
    createInvocationMediationMemoryState,
    type CanonicalBatchInvocationRequest,
    type InvocationMediationMemoryState,
    type InvocationTransactionPort
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { referenceCodec } from "./fixture";

const descriptor = new OperationDescriptor(
    new OperationName("send"),
    "externalSend",
    new JsonSchema({}),
    new JsonSchema({})
);

describe("W6 operation mediation integration", () => {
    test("[invocation.continuation] [invocation.mediated-replay] [invocation.publication-outbox] round-trips continuation, replay, and publication durable records", () => {
        const continuation = new InvocationContinuation(
            new InvocationId("codec-invocation"),
            new Digest("a".repeat(64)),
            new ApprovalId("codec-approval"),
            new EffectAttemptId("codec-attempt"),
            0,
            0,
            new ItemClaimId("codec-claim"),
            {
                kind: "system",
                actor: new ActorRef("workspace", new ActorId("codec-actor")),
                worker: new ClaimWorkerId("codec-worker")
            },
            "codec-item-key",
            new Date(1)
        );
        expect(
            InvocationContinuation.decode(
                InvocationContinuation.encode(continuation, referenceCodec),
                referenceCodec
            ).firstAttempt.value
        ).toBe("codec-attempt");

        const replay = MediatedReplayRecord.reserve({
            ...replayReservationBinding(),
            scope: "codec-scope",
            requestKey: "codec-request",
            facet: "workspace:codec",
            operation: "send",
            descriptorDigest: new Digest("b".repeat(64)),
            shape: { kind: "single" },
            rawPayloadIdentities: [new Digest("c".repeat(64))]
        });
        expect(MediatedReplayRecord.decode(MediatedReplayRecord.encode(replay)).id.value).toBe(
            replay.id.value
        );

        const publication = InvocationPublicationOutbox.pending(
            Object.freeze({
                invocation: new InvocationId("codec-invocation"),
                receipt: new ReceiptId("codec-receipt"),
                audit: new AuditRecordId("codec-audit")
            })
        );
        expect(
            InvocationPublicationOutbox.decode(InvocationPublicationOutbox.encode(publication)).id
                .value
        ).toBe(publication.id.value);
    });

    test("[C13-PREPARED-REPLAY-POST] [invocation.mediated-replay] [invocation-replay-persistence] reserves before interception and reuses durable before/after presentation", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const invocation = new InvocationId("mediated-invocation");
        const batch = new SuccessfulBatch(invocation);
        const port = new ReplayOperationInvocationPort(
            "caller-scope",
            transactions,
            persistence,
            { invocation: () => invocation },
            { context: (_key, itemIndex) => directContext(itemIndex) },
            batch
        );
        const preflight = {
            requestKey: new OperationRequestKey("request-key"),
            facet: new FacetRef("workspace:target"),
            descriptor,
            shape: { kind: "single" as const },
            inputs: [{ raw: true }],
            authorization: "permit",
            replayBinding: replayReservationBinding()
        };
        let beforeRuns = 0;
        const first = await port.prepareMediated(preflight, () => {
            beforeRuns += 1;
            return {
                inputs: [{ prepared: true }],
                interceptions: [[trace("operation.before")]]
            };
        });
        expect(first.kind).toBe("new");

        await port.invoke({
            ...preflight,
            inputs: first.kind === "new" ? first.preparation.inputs : [],
            authorization: "permit",
            interceptions: first.kind === "new" ? first.preparation.interceptions : [],
            execute: async () => ({ effect: true })
        });
        transactions.restart();
        const recovered = await port.prepareMediated(preflight, () => {
            throw new TypeError("before must not rerun after an effect");
        });
        expect(recovered.kind).toBe("new");
        const recoveredResult = await port.invoke({
            ...preflight,
            inputs: recovered.kind === "new" ? recovered.preparation.inputs : [],
            authorization: "permit",
            interceptions: recovered.kind === "new" ? recovered.preparation.interceptions : [],
            execute: async () => {
                throw new TypeError("effect must not rerun");
            }
        });
        expect(batch.calls).toBe(1);
        let afterRuns = 0;
        const presentation = await port.presentMediated(
            recoveredResult.evidence,
            recoveredResult.outputs,
            (_itemIndex, output) => {
                afterRuns += 1;
                return {
                    value: { ...object(output), presented: true },
                    traces: [trace("operation.after")]
                };
            },
            {
                requestKey: preflight.requestKey,
                facet: preflight.facet,
                descriptor,
                shape: preflight.shape
            }
        );
        expect(presentation).toEqual([{ effect: true, presented: true }]);

        transactions.restart();
        const replay = await port.prepareMediated(preflight, () => {
            beforeRuns += 1;
            throw new TypeError("before must not rerun");
        });
        expect(replay).toMatchObject({
            kind: "replay",
            result: {
                kind: "mediated",
                output: { effect: true, presented: true }
            }
        });
        expect(beforeRuns).toBe(1);
        expect(afterRuns).toBe(1);
    });

    test("[C13-PREPARED-REPLAY-PRE] commits raw replay identity before mutating interception and rejects conflicts first", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const invocation = new InvocationId("reserved-before-interception");
        const port = new ReplayOperationInvocationPort(
            "reservation-scope",
            transactions,
            persistence,
            { invocation: () => invocation },
            { context: (_key, itemIndex) => directContext(itemIndex) },
            new SuccessfulBatch(invocation)
        );
        const preflight = {
            requestKey: new OperationRequestKey("reserved-request"),
            facet: new FacetRef("workspace:target"),
            descriptor,
            shape: { kind: "single" as const },
            inputs: [{ raw: true }],
            authorization: "permit",
            replayBinding: replayReservationBinding()
        };

        await expect(
            port.prepareMediated(preflight, () => {
                expect(
                    transactions.transact((transaction) =>
                        persistence.replay(transaction, "reservation-scope", "reserved-request")
                    )?.revision.value
                ).toBe(0);
                throw new TypeError("interceptor crash");
            })
        ).rejects.toThrow("interceptor crash");

        let conflictingInterceptorRan = false;
        await expect(
            port.prepareMediated({ ...preflight, inputs: [{ raw: false }] }, () => {
                conflictingInterceptorRan = true;
                return { inputs: [], interceptions: [] };
            })
        ).rejects.toMatchObject({ code: "invocation.invalid" });
        expect(conflictingInterceptorRan).toBe(false);

        for (const replayBinding of substitutedReplayBindings(preflight.replayBinding)) {
            await expect(
                port.prepareMediated({ ...preflight, replayBinding }, () => {
                    conflictingInterceptorRan = true;
                    return { inputs: [], interceptions: [] };
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
        }
        expect(conflictingInterceptorRan).toBe(false);

        await expect(
            port.prepareMediated(preflight, () => ({
                inputs: [{ prepared: true }],
                interceptions: [[]]
            }))
        ).resolves.toMatchObject({ kind: "new" });
    });

    test("[C13-ADV-RECEIPT-CANCELLED] [invocation.publication-outbox] [invocation-evidence-persistence] durably drains Receipt publication without fire-and-forget", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const publication = InvocationPublicationOutbox.pending(
            Object.freeze({
                invocation: new InvocationId("publish-invocation"),
                receipt: new ReceiptId("publish-receipt"),
                audit: new AuditRecordId("publish-audit")
            })
        );
        transactions.transact((transaction) =>
            persistence.appendPublication(transaction, publication)
        );
        const published: string[] = [];
        const drainer = new InvocationPublicationDrainer(
            transactions,
            persistence,
            {
                publish: async (_outboxId, observation) => {
                    published.push(`event:${observation.receipt.value}`);
                }
            },
            {
                append: async (_outboxId, observation) => {
                    published.push(`commit:${observation.receipt.value}`);
                }
            },
            () => new Date(10)
        );

        await drainer.flush();
        expect(published).toEqual(["event:publish-receipt", "commit:publish-receipt"]);
        expect(
            transactions.transact(
                (transaction) => persistence.publication(transaction, publication.id)?.state.kind
            )
        ).toBe("published");
        await drainer.flush();
        expect(published).toHaveLength(2);
    });

    test("persists independent sink acknowledgements and never republishes an acknowledged sink", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("partial-publication"),
            receipt: new ReceiptId("partial-receipt"),
            audit: new AuditRecordId("partial-audit")
        });
        transactions.transact((transaction) =>
            persistence.appendPublication(transaction, publication)
        );
        const events: string[] = [];
        const commits: string[] = [];
        let commitCrash = true;
        const drainer = new InvocationPublicationDrainer(
            transactions,
            persistence,
            {
                publish: async (outboxId) => {
                    events.push(outboxId.value);
                }
            },
            {
                append: async (outboxId) => {
                    commits.push(outboxId.value);
                    if (commitCrash) {
                        commitCrash = false;
                        throw new TypeError("commit sink crash");
                    }
                }
            },
            () => new Date(10)
        );

        await expect(drainer.flush()).rejects.toThrow("commit sink crash");
        expect(
            transactions.transact(
                (transaction) => persistence.publication(transaction, publication.id)?.state
            )
        ).toMatchObject({ kind: "pending", eventPublishedAt: new Date(10) });
        await drainer.flush();
        expect(events).toEqual([publication.id.value]);
        expect(commits).toEqual([publication.id.value, publication.id.value]);
        expect(
            transactions.transact(
                (transaction) => persistence.publication(transaction, publication.id)?.state.kind
            )
        ).toBe("published");
    });

    test("[C13-ADV-APPROVAL-REPLAY] rejects noncanonical replay scopes, attempted direct contexts, and unprepared invocation", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const invocation = new InvocationId("guarded-invocation");
        const dependencies = [
            transactions,
            persistence,
            { invocation: () => invocation },
            { context: () => attemptedContext(invocation, 0) },
            new SuccessfulBatch(invocation)
        ] as const;
        expect(() => new ReplayOperationInvocationPort(" replay", ...dependencies)).toThrow(
            /canonical/
        );
        const port = new ReplayOperationInvocationPort("replay", ...dependencies);
        expect(() =>
            port.directContext(new OperationRequestKey("direct"), 0, { kind: "single" }, "permit")
        ).toThrow(/cannot carry an EffectAttempt/);
        await expect(
            port.invoke({
                ...preflight("missing-preparation"),
                authorization: "permit",
                interceptions: [[]],
                execute: async () => null
            })
        ).rejects.toThrow(/no reserved prepared replay identity/);
    });

    test("keeps a reservation recoverable when before interception returns malformed cardinality", async () => {
        const { port } = replayHarness("malformed-before");
        const request = preflight("malformed-before");
        await expect(
            port.prepareMediated(request, () => ({ inputs: [], interceptions: [] }))
        ).rejects.toThrow(/changed the item count/);
        await expect(
            port.prepareMediated(request, () => ({
                inputs: [{ prepared: true }],
                interceptions: [[]]
            }))
        ).resolves.toMatchObject({ kind: "new" });
    });

    test.each(["invocation", "count", "index"] as const)(
        "rejects substituted canonical batch %s evidence before recording output",
        async (substitution) => {
            const invocation = new InvocationId(`substituted-${substitution}`);
            const batch: CanonicalBatchInvoker<string> = {
                invoke: async () => ({
                    invocation:
                        substitution === "invocation"
                            ? new InvocationId("wrong-invocation")
                            : invocation,
                    items:
                        substitution === "count"
                            ? []
                            : [
                                  {
                                      kind: "succeeded",
                                      itemIndex: substitution === "index" ? 1 : 0,
                                      output: { effect: true },
                                      receipt: attemptReceipt("substituted", 0)
                                  }
                              ]
                })
            };
            const { port } = replayHarness(invocation.value, batch);
            const request = preflight(invocation.value);
            const prepared = await port.prepareMediated(request, () => ({
                inputs: [{ prepared: true }],
                interceptions: [[]]
            }));
            await expect(
                port.invoke({
                    ...request,
                    inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
                    authorization: "permit",
                    interceptions:
                        prepared.kind === "new" ? prepared.preparation.interceptions : [],
                    execute: async () => ({ effect: true })
                })
            ).rejects.toThrow(/substituted item evidence/);
        }
    );

    test("[C13-BATCH-OUTCOME-TERMINAL] persists terminal batch evidence and fails closed on every replay", async () => {
        const invocation = new InvocationId("terminal-replay");
        const terminalReceipt = new PreEffectReceipt(
            new ReceiptId("terminal-receipt"),
            invocation,
            0,
            "deniedPreEffect",
            new Date(5),
            "permit denied"
        );
        const batch: CanonicalBatchInvoker<string> = {
            invoke: async () => ({
                invocation,
                items: [{ kind: "terminal", itemIndex: 0, receipt: terminalReceipt }]
            })
        };
        const { port } = replayHarness(invocation.value, batch);
        const request = preflight(invocation.value);
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: true }],
            interceptions: [[]]
        }));
        const invocationRequest = {
            ...request,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            authorization: "permit",
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            execute: async () => ({ effect: true })
        };
        await expect(port.invoke(invocationRequest)).rejects.toMatchObject({
            code: "authority.denied"
        });
        await expect(port.invoke(invocationRequest)).rejects.toMatchObject({
            code: "authority.denied"
        });
    });

    test("[C13-PREPARED-APPROVAL-BINDING] binds presentation to exact invocation evidence, item count, and persisted outputs", async () => {
        const invocation = new InvocationId("presentation-guards");
        const { port } = replayHarness(invocation.value);
        const request = preflight(invocation.value);
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: true }],
            interceptions: [[]]
        }));
        const result = await port.invoke({
            ...request,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            authorization: "permit",
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            execute: async () => ({ effect: true })
        });
        const interception = {
            requestKey: request.requestKey,
            facet: request.facet,
            descriptor,
            shape: request.shape
        };
        for (const evidence of [null, {}, { invocation: "wrong-invocation" }] as const) {
            await expect(
                port.presentMediated(
                    evidence,
                    result.outputs,
                    (_index, output) => ({
                        value: output,
                        traces: []
                    }),
                    interception
                )
            ).rejects.toMatchObject({ code: "invocation.invalid" });
        }
        await expect(
            port.presentMediated(
                result.evidence,
                [],
                (_index, output) => ({
                    value: output,
                    traces: []
                }),
                interception
            )
        ).rejects.toThrow(/does not bind/);
        await expect(
            port.presentMediated(
                result.evidence,
                [{ substituted: true }],
                (_index, output) => ({
                    value: output,
                    traces: []
                }),
                interception
            )
        ).rejects.toThrow(/substituted an item output/);

        let presentations = 0;
        const first = await port.presentMediated(
            result.evidence,
            result.outputs,
            (_index, output) => {
                presentations += 1;
                return { value: { ...object(output), presented: true }, traces: [] };
            },
            interception
        );
        const replayed = await port.presentMediated(
            result.evidence,
            result.outputs,
            () => {
                throw new TypeError("presentation must not rerun");
            },
            interception
        );
        expect(replayed).toEqual(first);
        expect(presentations).toBe(1);
    });

    test("[C13-ADV-NONHOMOGENEOUS-BATCH] enforces replay phase immutability and nonempty exact batch shape", () => {
        const reservation = replayReservation("phase-guards");
        expect(() =>
            MediatedReplayRecord.reserve({
                ...reservation,
                shape: { kind: "batch", itemCount: 0 },
                rawPayloadIdentities: []
            })
        ).toThrow(/nonempty payload shape/);
        expect(() =>
            MediatedReplayRecord.reserve({ ...reservation, rawPayloadIdentities: [] })
        ).toThrow(/do not match its shape/);
        expect(() => MediatedReplayRecord.reserve({ ...reservation, scope: " scope" })).toThrow(
            /canonical/
        );

        const reserved = MediatedReplayRecord.reserve(reservation);
        expect(() => reserved.recordEffect(0, {}, new ReceiptId("early"))).toThrow(/preparation/);
        expect(() => reserved.recordTerminal(-1, new ReceiptId("negative"))).toThrow(
            /non-negative/
        );
        expect(() =>
            reserved.prepare(new InvocationId("wrong-trace"), [{}], [[trace("operation.after")]])
        ).toThrow(/wrong cut point/);
        const prepared = reserved.prepare(new InvocationId("phase-invocation"), [{}], [[]]);
        expect(() => prepared.prepare(new InvocationId("again"), [{}], [[]])).toThrow(
            /exactly once/
        );
        const effected = prepared.recordEffect(0, { value: 1 }, new ReceiptId("effect-receipt"));
        expect(() => effected.recordEffect(0, { value: 2 }, new ReceiptId("other"))).toThrow(
            /immutable/
        );
        expect(() => effected.recordTerminal(0, new ReceiptId("other"))).toThrow(/immutable/);
        const presented = effected.present(0, [], { value: 1 });
        expect(() => presented.present(0, [], { value: 1 })).toThrow(/unpresented/);

        const terminal = prepared.recordTerminal(0, new ReceiptId("terminal"));
        expect(terminal.complete).toBe(true);
        expect(() => terminal.recordTerminal(0, new ReceiptId("other"))).toThrow(/immutable/);
        expect(() => terminal.present(0, [], null)).toThrow(/effect output/);
    });

    test("[C13-BATCH-OUTCOME-COMPLETE] maps profile receipt mode and terminal outcomes without leaking batch shapes", async () => {
        const invocation = new InvocationId("profile-modes");
        const operation = {
            descriptor,
            execute: async (_context: OperationContext, input: FacetData) => input
        };
        const request = {
            facet: new FacetRef("workspace:target"),
            binding: {} as never,
            operation,
            input: { value: 1 },
            resultMode: "receipt" as const
        };
        const receipt = attemptReceipt("profile", 0);
        const receiptPort = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            {
                invoke: async () => ({
                    invocation,
                    items: [{ kind: "succeeded", itemIndex: 0, receipt, output: {} }]
                })
            }
        );
        await expect(receiptPort.invoke(request)).resolves.toEqual({ kind: "receipt", receipt });

        const malformed = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            { invoke: async () => ({ invocation, items: [] }) }
        );
        await expect(malformed.invoke({ ...request, resultMode: "output" })).rejects.toThrow(
            /substituted canonical item/
        );

        const outcomes = [
            new PreEffectReceipt(
                new ReceiptId("profile-denied"),
                invocation,
                0,
                "deniedPreEffect",
                new Date(1),
                "profile denied"
            ),
            new AttemptReceipt(
                new ReceiptId("profile-indeterminate"),
                new EffectAttemptId("profile-indeterminate-attempt"),
                "indeterminate",
                undefined,
                new Date(1),
                undefined
            ),
            new AttemptReceipt(
                new ReceiptId("profile-failed"),
                new EffectAttemptId("profile-failed-attempt"),
                "failed",
                undefined,
                new Date(1),
                undefined
            )
        ];
        for (const terminal of outcomes) {
            const port = new InvocationProtectedOperationPort(
                { invocation: () => invocation },
                {
                    invoke: async () => ({
                        invocation,
                        items: [{ kind: "terminal", itemIndex: 0, receipt: terminal }]
                    })
                }
            );
            await expect(port.invoke({ ...request, resultMode: "output" })).rejects.toBeInstanceOf(
                Error
            );
        }
    });

    test("[C13-PREPARED-NO-TURN-OWNER] rejects substituted continuation identifiers, owner kinds, actor kinds, and indexes", () => {
        class SubstitutedInvocationId extends InvocationId {}
        const owner = {
            kind: "system" as const,
            actor: new ActorRef("workspace", new ActorId("continuation-owner")),
            worker: new ClaimWorkerId("continuation-worker")
        };
        const create = (
            invocation: InvocationId = new InvocationId("continuation-guards"),
            itemIndex = 0,
            itemKey = "continuation-key"
        ) =>
            new InvocationContinuation(
                invocation,
                new Digest("a".repeat(64)),
                new ApprovalId("continuation-approval"),
                new EffectAttemptId("continuation-attempt"),
                itemIndex,
                0,
                new ItemClaimId("continuation-claim"),
                owner,
                itemKey,
                new Date(1)
            );
        expect(() => create(new SubstitutedInvocationId("substituted"))).toThrow(/exact context/);
        expect(() => create(undefined, -1)).toThrow(/non-negative/);
        expect(() => create(undefined, 0, " continuation-key")).toThrow(/canonical/);

        const record = create();
        expect(
            InvocationContinuation.decode(
                InvocationContinuation.encode(
                    new InvocationContinuation(
                        record.invocation,
                        record.intentDigest,
                        record.approval,
                        record.firstAttempt,
                        0,
                        0,
                        record.firstClaim,
                        {
                            kind: "executor",
                            token: "lease:continuation",
                            worker: owner.worker
                        },
                        record.firstItemKey,
                        record.admittedAt
                    ),
                    referenceCodec
                ),
                referenceCodec
            ).firstClaimOwner
        ).toMatchObject({ kind: "executor", token: "lease:continuation" });

        expect(() =>
            InvocationContinuation.decode(
                mutateRecord(InvocationContinuation.encode(record, referenceCodec), (payload) => {
                    const claimOwner = payload["firstClaimOwner"] as { [key: string]: JsonValue };
                    claimOwner["kind"] = "substituted";
                }),
                referenceCodec
            )
        ).toThrow(/owner kind is invalid/);
        expect(() =>
            InvocationContinuation.decode(
                mutateRecord(InvocationContinuation.encode(record, referenceCodec), (payload) => {
                    const claimOwner = payload["firstClaimOwner"] as { [key: string]: JsonValue };
                    const actor = claimOwner["actor"] as { [key: string]: JsonValue };
                    actor["kind"] = "substituted";
                }),
                referenceCodec
            )
        ).toThrow(/Actor kind is invalid/);
    });
});

class MemoryTransactions implements InvocationTransactionPort<InvocationMediationMemoryState> {
    #state = createInvocationMediationMemoryState();

    public transact<Result>(
        operation: (transaction: InvocationMediationMemoryState) => Result
    ): Result {
        const draft = cloneInvocationMediationMemoryState(this.#state);
        const result = operation(draft);
        this.#state = cloneInvocationMediationMemoryState(draft);
        return result;
    }

    public restart(): void {
        this.#state = cloneInvocationMediationMemoryState(this.#state);
    }
}

class SuccessfulBatch implements CanonicalBatchInvoker<string> {
    public calls = 0;

    public constructor(private readonly invocation: InvocationId) {}

    public async invoke(request: CanonicalBatchInvocationRequest<string>) {
        this.calls += 1;
        const outputs = await Promise.all(
            request.request.inputs.map((_input, itemIndex) =>
                request.request.execute(itemIndex, attemptedContext(this.invocation, itemIndex))
            )
        );
        return {
            invocation: this.invocation,
            items: outputs.map((output, itemIndex) => ({
                kind: "succeeded" as const,
                itemIndex,
                output,
                receipt: new AttemptReceipt(
                    new ReceiptId(`receipt-${itemIndex}`),
                    new EffectAttemptId(`attempt-${itemIndex}`),
                    "succeeded",
                    undefined,
                    new Date(5),
                    undefined
                )
            }))
        };
    }
}

function directContext(itemIndex: number): OperationContext {
    return Object.freeze({
        invocation: new InvocationId(`direct-${itemIndex}`),
        itemIndex,
        idempotencyKey: `direct-key-${itemIndex}`,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function attemptedContext(invocation: InvocationId, itemIndex: number): OperationContext {
    return Object.freeze({
        invocation,
        itemIndex,
        idempotencyKey: `mediated-key-${itemIndex}`,
        attempt: Object.freeze({
            id: new EffectAttemptId(`attempt-${itemIndex}`),
            ordinal: 0,
            intentDigest: new Digest("a".repeat(64))
        }),
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function trace(cutPoint: "operation.before" | "operation.after") {
    return Object.freeze({
        itemIndex: 0,
        interceptor: cutPoint,
        contributor: "workspace:interceptor",
        cutPoint,
        before: new Digest("a".repeat(64)),
        after: new Digest("b".repeat(64)),
        outcome: "rewritten" as const
    });
}

function object(value: FacetData): Readonly<Record<string, FacetData>> {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object output");
    }
    return value as Readonly<Record<string, FacetData>>;
}

function replayHarness(scope: string, batch?: CanonicalBatchInvoker<string>) {
    const transactions = new MemoryTransactions();
    const persistence = new MemoryInvocationMediationPersistence();
    const invocation = new InvocationId(scope);
    return {
        port: new ReplayOperationInvocationPort(
            scope,
            transactions,
            persistence,
            { invocation: () => invocation },
            { context: (_key, itemIndex) => directContext(itemIndex) },
            batch ?? new SuccessfulBatch(invocation)
        ),
        transactions,
        persistence,
        invocation
    };
}

function preflight(id: string) {
    return {
        requestKey: new OperationRequestKey(`request:${id}`),
        facet: new FacetRef("workspace:target"),
        descriptor,
        shape: { kind: "single" as const },
        inputs: [{ raw: true }],
        authorization: "permit",
        replayBinding: replayReservationBinding()
    };
}

function attemptReceipt(id: string, itemIndex: number): AttemptReceipt {
    return new AttemptReceipt(
        new ReceiptId(`receipt:${id}:${itemIndex}`),
        new EffectAttemptId(`attempt:${id}:${itemIndex}`),
        "succeeded",
        undefined,
        new Date(5),
        undefined
    );
}

function replayReservation(id: string) {
    return {
        ...replayReservationBinding(),
        scope: id,
        requestKey: `request:${id}`,
        facet: "workspace:target",
        operation: "send",
        descriptorDigest: new Digest("d".repeat(64)),
        shape: { kind: "single" as const },
        rawPayloadIdentities: [new Digest("e".repeat(64))]
    };
}

function replayReservationBinding() {
    const authorityIdentity = new Digest("a".repeat(64));
    return {
        principal: new PrincipalRef(
            new TenantId("replay-tenant"),
            new PrincipalId("replay-principal")
        ),
        authorityIdentity,
        packageOperationPin: new Digest("b".repeat(64)),
        execution: { kind: "lease" as const, digest: new Digest("c".repeat(64)) }
    };
}

function substitutedReplayBindings(binding: ReturnType<typeof replayReservationBinding>) {
    return [
        {
            ...binding,
            principal: new PrincipalRef(
                binding.principal.tenantId,
                new PrincipalId("substituted-principal")
            )
        },
        { ...binding, authorityIdentity: new Digest("d".repeat(64)) },
        { ...binding, packageOperationPin: new Digest("e".repeat(64)) },
        {
            ...binding,
            execution: { kind: "lease" as const, digest: new Digest("f".repeat(64)) }
        }
    ];
}

function mutateRecord(
    bytes: Uint8Array,
    mutate: (payload: { [key: string]: JsonValue }) => void
): Uint8Array {
    const envelope = decodeCanonicalJson(bytes) as {
        kind: string;
        version: { major: number; minor: number };
        payload: { [key: string]: JsonValue };
    };
    mutate(envelope.payload);
    return encodeCanonicalJson(envelope as unknown as JsonValue);
}
