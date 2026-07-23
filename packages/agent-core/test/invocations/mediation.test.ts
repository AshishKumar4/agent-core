import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import {
    Digest,
    JsonSchema,
    Revision,
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
    type OperationContext,
    type ProtectedOperationRequest
} from "../../src/facets";
import {
    AttemptReceipt,
    ApprovalId,
    AuditRecord,
    AuditRecordId,
    type CanonicalBatchInvoker,
    ClaimWorkerId,
    CorrelationId,
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
    auditEvidenceIdentity,
    cloneInvocationMediationMemoryState,
    createInvocationMediationMemoryState,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchItemResult,
    type InvocationMediationMemoryState,
    type InvocationTransactionPort,
    type Receipt,
    type ReceiptObservation
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
    test("memory audit evidence relations survive restart and remain actor-owned", () => {
        const persistence = new MemoryInvocationMediationPersistence();
        let state = createInvocationMediationMemoryState();
        const actor = new ActorRef("run", new ActorId("memory-evidence-actor"));
        const kind = {
            kind: "invocation" as const,
            id: new InvocationId("memory-evidence-invocation")
        };
        const record = new AuditRecord({
            id: new AuditRecordId("memory-evidence-audit"),
            actor,
            tenant: new TenantId("memory-evidence-tenant"),
            correlation: new CorrelationId("memory-evidence-correlation"),
            kind
        });
        persistence.appendAudit(state, record);
        state = cloneInvocationMediationMemoryState(state);

        expect(persistence.findAuditByEvidence(state, actor, kind)?.id.equals(record.id)).toBe(
            true
        );
        expect(
            persistence.findAuditByEvidence(
                state,
                new ActorRef("run", new ActorId("memory-evidence-other")),
                kind
            )
        ).toBeUndefined();
        expect(() =>
            persistence.appendAudit(
                state,
                new AuditRecord({
                    id: new AuditRecordId("memory-evidence-duplicate"),
                    actor,
                    tenant: record.tenant,
                    correlation: new CorrelationId("memory-evidence-duplicate"),
                    kind
                })
            )
        ).toThrow(/evidence relation/u);
        const corrupt = cloneInvocationMediationMemoryState(state);
        corrupt.auditByEvidence.set(corrupt.auditByEvidence.keys().next().value!, "missing-audit");
        expect(() => persistence.findAuditByEvidence(corrupt, actor, kind)).toThrow(
            /missing record/u
        );
        const missingProjection = cloneInvocationMediationMemoryState(state);
        missingProjection.auditByEvidence.clear();
        expect(() => persistence.findAuditByEvidence(missingProjection, actor, kind)).toThrow(
            /missing evidence projection/u
        );
        expect(() =>
            persistence.appendAudit(
                missingProjection,
                new AuditRecord({
                    id: new AuditRecordId("memory-evidence-hidden-duplicate"),
                    actor,
                    tenant: record.tenant,
                    correlation: new CorrelationId("memory-evidence-hidden-duplicate"),
                    kind
                })
            )
        ).toThrow(/missing evidence projection/u);
    });

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

describe("W6 replay operation invocation port", () => {
    test("returns direct contexts unchanged and requires a nonblank scope", { tags: "p1" }, () => {
        const { port, transactions, persistence, invocation } = replayHarness("direct-guards");
        const context = port.directContext(
            new OperationRequestKey("request:direct-guards"),
            0,
            { kind: "single" },
            "permit"
        );
        expect(context.invocation.value).toBe("direct-0");
        expect(context.attempt).toBeUndefined();
        expect(
            () =>
                new ReplayOperationInvocationPort(
                    "",
                    transactions,
                    persistence,
                    { invocation: () => invocation },
                    { context: (_key, itemIndex) => directContext(itemIndex) },
                    new SuccessfulBatch(invocation)
                )
        ).toThrow(/canonical/);
    });

    test("names the changed bound intent of a reused OperationRequestKey", { tags: "p2" }, async () => {
        const { port } = replayHarness("bound-intent");
        const request = preflight("bound-intent");
        await port.prepareMediated(request, () => ({
            inputs: [{ prepared: true }],
            interceptions: [[]]
        }));
        await expect(
            port.prepareMediated({ ...request, inputs: [{ raw: false }] }, () => {
                throw new TypeError("interceptor must not run");
            })
        ).rejects.toThrow(/changed its bound intent/);
    });

    test("returns the durable preparation when a concurrent actor prepares first", { tags: "p1" }, async () => {
        const { port, transactions, persistence, invocation } = replayHarness("concurrent-prepare");
        const request = preflight("concurrent-prepare");
        const result = await port.prepareMediated(request, () => {
            amendReplay(transactions, persistence, "concurrent-prepare", request.requestKey.value, (record) => [
                record.prepare(invocation, [{ concurrent: true }], [[trace("operation.before")]])
            ]);
            return { inputs: [{ mine: true }], interceptions: [[]] };
        });
        expect(result).toEqual({
            kind: "new",
            preparation: {
                inputs: [{ concurrent: true }],
                interceptions: [[trace("operation.before")]]
            }
        });
    });

    test("fails when the reservation disappears before preparation commits", { tags: "p1" }, async () => {
        const { port, transactions } = replayHarness("vanishing-reservation");
        await expect(
            port.prepareMediated(preflight("vanishing-reservation"), () => {
                transactions.transact((transaction) => {
                    transaction.replays.clear();
                    transaction.replayRevision.clear();
                    transaction.replayByRequest.clear();
                });
                return { inputs: [{ prepared: true }], interceptions: [[]] };
            })
        ).rejects.toThrow(/disappeared before preparation/);
    });

    test("names the before phase that changed either item cardinality", { tags: "p2" }, async () => {
        const { port } = replayHarness("count-mismatch");
        const request = preflight("count-mismatch");
        await expect(
            port.prepareMediated(request, () => ({ inputs: [], interceptions: [[]] }))
        ).rejects.toThrow(/changed the item count/);
        await expect(
            port.prepareMediated(request, () => ({
                inputs: [{ prepared: true }],
                interceptions: []
            }))
        ).rejects.toThrow(/changed the item count/);
    });

    test("authenticates every replay binding component before invocation", { tags: "p0" }, async () => {
        const { port } = replayHarness("binding-auth");
        const request = preflight("binding-auth");
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
        const { replayBinding: _omitted, ...unbound } = invocationRequest;
        await expect(port.invoke(unbound)).rejects.toThrow(
            /changed its authenticated replay binding/
        );
        const substitutions = [
            ...substitutedReplayBindings(request.replayBinding),
            {
                ...request.replayBinding,
                execution: { kind: "route" as const, digest: new Digest("c".repeat(64)) }
            }
        ];
        for (const replayBinding of substitutions) {
            await expect(port.invoke({ ...invocationRequest, replayBinding })).rejects.toThrow(
                /changed its authenticated replay binding/
            );
        }
    });

    test("resumes a partially recorded batch without repeating persisted effects", { tags: "p0" }, async () => {
        const invocation = new InvocationId("partial-batch");
        const batch = new SuccessfulBatch(invocation);
        const { port, transactions, persistence } = replayHarness("partial-batch", batch);
        const request = batchPreflight("partial-batch");
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: 0 }, { prepared: 1 }],
            interceptions: [[], []]
        }));
        amendReplay(transactions, persistence, "partial-batch", request.requestKey.value, (record) => [
            record.recordEffect(0, { effect: 0 }, new ReceiptId("receipt-0"))
        ]);
        const result = await port.invoke({
            ...request,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            execute: async (itemIndex) => ({ effect: itemIndex })
        });
        expect(result.outputs).toEqual([{ effect: 0 }, { effect: 1 }]);
        expect(result.evidence).toEqual({
            invocation: "partial-batch",
            receipts: ["receipt-0", "receipt-1"]
        });
        expect(batch.calls).toBe(1);
    });

    test("rejects canonical batch replays that change persisted evidence", { tags: "p0" }, async () => {
        const cases: readonly {
            readonly scope: string;
            readonly persisted: "effect" | "terminal";
            readonly item: CanonicalBatchItemResult;
        }[] = [
            {
                scope: "mismatch-output",
                persisted: "effect",
                item: {
                    kind: "succeeded",
                    itemIndex: 0,
                    output: { effect: 99 },
                    receipt: receiptWithId("receipt-0")
                }
            },
            {
                scope: "mismatch-receipt",
                persisted: "effect",
                item: {
                    kind: "succeeded",
                    itemIndex: 0,
                    output: { effect: 0 },
                    receipt: receiptWithId("receipt-substituted")
                }
            },
            {
                scope: "mismatch-succeeded-over-terminal",
                persisted: "terminal",
                item: {
                    kind: "succeeded",
                    itemIndex: 0,
                    output: { effect: 0 },
                    receipt: receiptWithId("receipt-0")
                }
            },
            {
                scope: "mismatch-terminal-over-effect",
                persisted: "effect",
                item: { kind: "terminal", itemIndex: 0, receipt: receiptWithId("receipt-0") }
            }
        ];
        for (const mismatch of cases) {
            const invocation = new InvocationId(mismatch.scope);
            const batch: CanonicalBatchInvoker<string> = {
                invoke: async () => ({
                    invocation,
                    items: [
                        mismatch.item,
                        {
                            kind: "succeeded",
                            itemIndex: 1,
                            output: { effect: 1 },
                            receipt: receiptWithId("receipt-1")
                        }
                    ]
                })
            };
            const { port, transactions, persistence } = replayHarness(mismatch.scope, batch);
            const request = batchPreflight(mismatch.scope);
            const prepared = await port.prepareMediated(request, () => ({
                inputs: [{ prepared: 0 }, { prepared: 1 }],
                interceptions: [[], []]
            }));
            amendReplay(transactions, persistence, mismatch.scope, request.requestKey.value, (record) => [
                mismatch.persisted === "effect"
                    ? record.recordEffect(0, { effect: 0 }, new ReceiptId("receipt-0"))
                    : record.recordTerminal(0, new ReceiptId("receipt-0"))
            ]);
            await expect(
                port.invoke({
                    ...request,
                    inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
                    interceptions:
                        prepared.kind === "new" ? prepared.preparation.interceptions : [],
                    execute: async () => ({ effect: true })
                })
            ).rejects.toThrow(/changed a persisted effect output/);
        }
    });

    test("rejects partially substituted canonical item indexes", { tags: "p1" }, async () => {
        const invocation = new InvocationId("substituted-partial-index");
        const batch: CanonicalBatchInvoker<string> = {
            invoke: async () => ({
                invocation,
                items: [
                    {
                        kind: "succeeded",
                        itemIndex: 0,
                        output: { effect: 0 },
                        receipt: receiptWithId("receipt-0")
                    },
                    {
                        kind: "succeeded",
                        itemIndex: 0,
                        output: { effect: 1 },
                        receipt: receiptWithId("receipt-1")
                    }
                ]
            })
        };
        const { port } = replayHarness("substituted-partial-index", batch);
        const request = batchPreflight("substituted-partial-index");
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: 0 }, { prepared: 1 }],
            interceptions: [[], []]
        }));
        await expect(
            port.invoke({
                ...request,
                inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
                interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
                execute: async () => ({ effect: true })
            })
        ).rejects.toThrow(/substituted item evidence/);
    });

    test("fails when the replay reservation disappears during mediation", { tags: "p1" }, async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const invocation = new InvocationId("vanishing-mediation");
        const batch: CanonicalBatchInvoker<string> = {
            invoke: async (batchRequest) => {
                transactions.transact((transaction) => {
                    transaction.replays.clear();
                    transaction.replayRevision.clear();
                    transaction.replayByRequest.clear();
                });
                return new SuccessfulBatch(invocation).invoke(batchRequest);
            }
        };
        const port = new ReplayOperationInvocationPort(
            "vanishing-mediation",
            transactions,
            persistence,
            { invocation: () => invocation },
            { context: (_key, itemIndex) => directContext(itemIndex) },
            batch
        );
        const request = preflight("vanishing-mediation");
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: true }],
            interceptions: [[]]
        }));
        await expect(
            port.invoke({
                ...request,
                inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
                interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
                execute: async () => ({ effect: true })
            })
        ).rejects.toThrow(/Mediated replay reservation disappeared/);
    });

    test("fails closed exactly once for terminal batch outcomes", { tags: "p0" }, async () => {
        const invocation = new InvocationId("terminal-once");
        let calls = 0;
        const terminalReceipt = new PreEffectReceipt(
            new ReceiptId("terminal-once-receipt"),
            invocation,
            0,
            "deniedPreEffect",
            new Date(5),
            "permit denied"
        );
        const batch: CanonicalBatchInvoker<string> = {
            invoke: async () => {
                calls += 1;
                return {
                    invocation,
                    items: [{ kind: "terminal", itemIndex: 0, receipt: terminalReceipt }]
                };
            }
        };
        const { port } = replayHarness("terminal-once", batch);
        const request = preflight("terminal-once");
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
        expect(calls).toBe(1);
    });

    test("rejects mixed batch outcomes while persisting their evidence", { tags: "p0" }, async () => {
        const invocation = new InvocationId("mixed-outcomes");
        let calls = 0;
        const batch: CanonicalBatchInvoker<string> = {
            invoke: async () => {
                calls += 1;
                return {
                    invocation,
                    items: [
                        {
                            kind: "succeeded" as const,
                            itemIndex: 0,
                            output: { effect: 0 },
                            receipt: receiptWithId("receipt-0")
                        },
                        {
                            kind: "terminal" as const,
                            itemIndex: 1,
                            receipt: receiptWithId("receipt-1")
                        }
                    ]
                };
            }
        };
        const { port, transactions, persistence } = replayHarness("mixed-outcomes", batch);
        const request = batchPreflight("mixed-outcomes");
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: 0 }, { prepared: 1 }],
            interceptions: [[], []]
        }));
        const invocationRequest = {
            ...request,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            execute: async () => ({ effect: true })
        };
        await expect(port.invoke(invocationRequest)).rejects.toMatchObject({
            code: "authority.denied",
            message: expect.stringMatching(/without one successful output per item/u)
        });
        await expect(port.invoke(invocationRequest)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(calls).toBe(1);
        const recorded = transactions.transact((transaction) =>
            persistence.replay(transaction, "mixed-outcomes", request.requestKey.value)
        );
        expect(recorded?.items[0]?.effectOutput).toEqual({ effect: 0 });
        expect(recorded?.items[1]?.receipt?.value).toBe("receipt-1");
        expect(recorded?.items[1]?.effectOutput).toBeUndefined();
    });

    test("binds mediated presentation to stored effect outputs", { tags: "p1" }, async () => {
        const invocation = new InvocationId("present-binding");
        const { port, transactions, persistence } = replayHarness(
            "present-binding",
            new SuccessfulBatch(invocation)
        );
        const request = batchPreflight("present-binding");
        await port.prepareMediated(request, () => ({
            inputs: [{ prepared: 0 }, { prepared: 1 }],
            interceptions: [[], []]
        }));
        amendReplay(transactions, persistence, "present-binding", request.requestKey.value, (record) => {
            const effected = record.recordEffect(0, { effect: 0 }, new ReceiptId("receipt-0"));
            return [effected, effected.recordTerminal(1, new ReceiptId("receipt-1"))];
        });
        const present = (_itemIndex: number, output: FacetData) => ({
            value: output,
            traces: []
        });
        const interception = {
            requestKey: request.requestKey,
            facet: request.facet,
            descriptor,
            shape: request.shape
        };
        await expect(port.presentMediated(null, [], present, interception)).rejects.toThrow(
            /does not identify its Invocation/
        );
        await expect(port.presentMediated({}, [], present, interception)).rejects.toThrow(
            /does not identify its Invocation/
        );
        await expect(
            port.presentMediated({ invocation: invocation.value }, [{ effect: 0 }, null], present, {
                ...interception,
                requestKey: new OperationRequestKey("request:present-binding-unknown")
            })
        ).rejects.toThrow(/does not bind its replay evidence/);
        await expect(
            port.presentMediated(
                { invocation: invocation.value },
                [{ effect: 0 }, null],
                present,
                interception
            )
        ).rejects.toThrow(/substituted an item output/);
    });

    test("replays a completed batch with its full presented output", { tags: "p0" }, async () => {
        const invocation = new InvocationId("batch-replay");
        const { port, transactions } = replayHarness("batch-replay", new SuccessfulBatch(invocation));
        const request = batchPreflight("batch-replay");
        const prepared = await port.prepareMediated(request, () => ({
            inputs: [{ prepared: 0 }, { prepared: 1 }],
            interceptions: [[], []]
        }));
        const result = await port.invoke({
            ...request,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            execute: async (itemIndex) => ({ effect: itemIndex })
        });
        await port.presentMediated(
            result.evidence,
            result.outputs,
            (_itemIndex, output) => ({
                value: { ...object(output), presented: true },
                traces: []
            }),
            {
                requestKey: request.requestKey,
                facet: request.facet,
                descriptor,
                shape: request.shape
            }
        );
        transactions.restart();
        const replay = await port.prepareMediated(request, () => {
            throw new TypeError("preparation must not rerun");
        });
        expect(replay).toEqual({
            kind: "replay",
            result: {
                kind: "mediated",
                output: [
                    { effect: 0, presented: true },
                    { effect: 1, presented: true }
                ],
                evidence: { invocation: "batch-replay", receipts: ["receipt-0", "receipt-1"] }
            }
        });
    });
});

describe("W6 invocation publication outbox", () => {
    test("rejects revisions that disagree with acknowledgement state", { tags: "p1" }, () => {
        const base = observation("revision-guard");
        expect(() => new InvocationPublicationOutbox(base, { kind: "pending" }, new Revision(1))).toThrow(
            /revision does not match its state/
        );
        expect(
            () =>
                new InvocationPublicationOutbox(
                    base,
                    {
                        kind: "pending",
                        eventPublishedAt: new Date(1),
                        commitAppendedAt: new Date(2)
                    },
                    new Revision(2)
                )
        ).toThrow(/revision does not match its state/);
    });

    test("orders publication lineage through follows", { tags: "p0" }, () => {
        const base = observation("follows");
        const pending = InvocationPublicationOutbox.pending(base);
        const event = pending.eventPublished(new Date(10));
        const published = event.commitAppended(new Date(20));
        expect(event.follows(pending)).toBe(true);
        expect(published.follows(event)).toBe(true);
        expect(published.follows(pending)).toBe(false);
        expect(pending.follows(pending)).toBe(false);
        const substitutedTime = new InvocationPublicationOutbox(
            base,
            { kind: "published", eventPublishedAt: new Date(99), commitAppendedAt: new Date(20) },
            new Revision(2)
        );
        expect(substitutedTime.follows(event)).toBe(false);
        const other = InvocationPublicationOutbox.pending(observation("follows-other"))
            .eventPublished(new Date(10));
        expect(other.follows(pending)).toBe(false);
    });

    test("acknowledges each sink once in either order", { tags: "p0" }, () => {
        const base = observation("acknowledge");
        const pending = InvocationPublicationOutbox.pending(base);
        expect(pending.state).toStrictEqual({ kind: "pending" });
        const commitFirst = pending.commitAppended(new Date(7));
        expect(commitFirst.state).toStrictEqual({
            kind: "pending",
            commitAppendedAt: new Date(7)
        });
        const published = commitFirst.eventPublished(new Date(9));
        expect(published.state).toStrictEqual({
            kind: "published",
            eventPublishedAt: new Date(9),
            commitAppendedAt: new Date(7)
        });
        expect(published.revision.value).toBe(2);
        expect(() => commitFirst.commitAppended(new Date(11))).toThrow(
            /commit publication acknowledgement is immutable/
        );
        const eventFirst = pending.eventPublished(new Date(3));
        expect(() => eventFirst.eventPublished(new Date(4))).toThrow(
            /event publication acknowledgement is immutable/
        );
        let failure: unknown;
        try {
            published.eventPublished(new Date(12));
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            code: "invocation.invalid",
            failure: "state.invalid-transition",
            message: expect.stringMatching(/event publication acknowledgement is immutable/u)
        });
    });

    test("rejects invalid acknowledgement times", { tags: "p2" }, () => {
        const base = observation("invalid-time");
        expect(
            () =>
                new InvocationPublicationOutbox(
                    base,
                    { kind: "pending", eventPublishedAt: new Date(Number.NaN) },
                    new Revision(1)
                )
        ).toThrow(/Event publication time must be a valid Date/);
        expect(
            () =>
                new InvocationPublicationOutbox(
                    base,
                    { kind: "pending", commitAppendedAt: new Date(Number.NaN) },
                    new Revision(1)
                )
        ).toThrow(/Commit append time must be a valid Date/);
    });

    test("round-trips acknowledgement states and rejects corrupted payloads", { tags: "p1" }, () => {
        const base = observation("publication-codec");
        const commitOnly = InvocationPublicationOutbox.pending(base).commitAppended(new Date(7));
        const bytes = InvocationPublicationOutbox.encode(commitOnly);
        expect(InvocationPublicationOutbox.encode(InvocationPublicationOutbox.decode(bytes))).toEqual(
            bytes
        );
        expect(() =>
            InvocationPublicationOutbox.decode(
                mutateRecord(bytes, (payload) => {
                    const state = payload["state"] as { [key: string]: JsonValue };
                    state["commitAppendedAt"] = 42;
                })
            )
        ).toThrow(/must be strings or null/);
        expect(() =>
            InvocationPublicationOutbox.decode(
                mutateRecord(bytes, (payload) => {
                    payload["id"] = "0".repeat(64);
                })
            )
        ).toThrow(/publication ID does not match its observation/);
        const publishedBytes = InvocationPublicationOutbox.encode(
            commitOnly.eventPublished(new Date(9))
        );
        let failure: unknown;
        try {
            InvocationPublicationOutbox.decode(
                mutateRecord(publishedBytes, (payload) => {
                    const state = payload["state"] as { [key: string]: JsonValue };
                    state["commitAppendedAt"] = null;
                })
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            code: "invocation.invalid",
            failure: "state.invalid-transition",
            message: expect.stringMatching(/publication state is invalid/u)
        });
    });
});

describe("W6 invocation publication drainer", () => {
    test("drains commit-first acknowledgements without re-appending the commit", { tags: "p0" }, async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const publication = InvocationPublicationOutbox.pending(observation("commit-first"));
        transactions.transact((transaction) => {
            persistence.appendPublication(transaction, publication);
            persistence.appendPublication(transaction, publication.commitAppended(new Date(3)));
        });
        const events: string[] = [];
        const commits: string[] = [];
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
                }
            },
            () => new Date(10)
        );
        await drainer.flush();
        expect(events).toEqual([publication.id.value]);
        expect(commits).toEqual([]);
        expect(
            transactions.transact(
                (transaction) => persistence.publication(transaction, publication.id)?.state
            )
        ).toEqual({ kind: "published", eventPublishedAt: new Date(10), commitAppendedAt: new Date(3) });
    });

    test("tolerates sinks that acknowledge their own publication", { tags: "p1" }, async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const publication = InvocationPublicationOutbox.pending(observation("self-acknowledged"));
        transactions.transact((transaction) =>
            persistence.appendPublication(transaction, publication)
        );
        const acknowledge = (outboxId: Digest, at: Date, sink: "event" | "commit") => {
            transactions.transact((transaction) => {
                const current = persistence.publication(transaction, outboxId);
                if (current === undefined) throw new TypeError("Expected a publication");
                persistence.appendPublication(
                    transaction,
                    sink === "event" ? current.eventPublished(at) : current.commitAppended(at)
                );
            });
        };
        let published = 0;
        let committed = 0;
        const drainer = new InvocationPublicationDrainer(
            transactions,
            persistence,
            {
                publish: async (outboxId) => {
                    published += 1;
                    acknowledge(outboxId, new Date(5), "event");
                }
            },
            {
                append: async (outboxId) => {
                    committed += 1;
                    acknowledge(outboxId, new Date(6), "commit");
                }
            },
            () => new Date(10)
        );
        await drainer.flush();
        expect(published).toBe(1);
        expect(committed).toBe(1);
        expect(
            transactions.transact(
                (transaction) => persistence.publication(transaction, publication.id)?.state
            )
        ).toEqual({ kind: "published", eventPublishedAt: new Date(5), commitAppendedAt: new Date(6) });
    });

    test("skips publications that vanish while draining", { tags: "p1" }, async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        transactions.transact((transaction) => {
            persistence.appendPublication(
                transaction,
                InvocationPublicationOutbox.pending(observation("vanish-a"))
            );
            persistence.appendPublication(
                transaction,
                InvocationPublicationOutbox.pending(observation("vanish-b"))
            );
        });
        const events: string[] = [];
        const drainer = new InvocationPublicationDrainer(
            transactions,
            persistence,
            {
                publish: async (outboxId) => {
                    events.push(outboxId.value);
                    transactions.transact((transaction) => {
                        for (const key of transaction.publications.keys()) {
                            if (key !== outboxId.value) transaction.publications.delete(key);
                        }
                    });
                }
            },
            { append: async () => {} },
            () => new Date(10)
        );
        await drainer.flush();
        expect(events).toHaveLength(1);
        expect(
            transactions.transact(
                (transaction) =>
                    persistence.publication(transaction, new Digest(events[0] ?? ""))?.state.kind
            )
        ).toBe("published");
    });

    test("surfaces publications that disappear during acknowledgement", { tags: "p1" }, async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        transactions.transact((transaction) =>
            persistence.appendPublication(
                transaction,
                InvocationPublicationOutbox.pending(observation("acknowledgement-loss"))
            )
        );
        const drainer = new InvocationPublicationDrainer(
            transactions,
            persistence,
            { publish: async () => {} },
            {
                append: async () => {
                    transactions.transact((transaction) => transaction.publications.clear());
                }
            },
            () => new Date(10)
        );
        await expect(drainer.flush()).rejects.toMatchObject({
            code: "invocation.invalid",
            message: expect.stringMatching(/Publication disappeared during acknowledgement/u)
        });
    });
});

describe("W6 mediation memory persistence", () => {
    test("verifies replay projections against their codec bytes", { tags: "p1" }, () => {
        const persistence = new MemoryInvocationMediationPersistence();
        const state = createInvocationMediationMemoryState();
        const record = MediatedReplayRecord.reserve(replayReservation("memory-replay"));
        expect(persistence.replayById(state, record.id)).toBeUndefined();
        persistence.appendReplay(state, record);
        const corruptIndex = cloneInvocationMediationMemoryState(state);
        corruptIndex.replays.clear();
        expect(() => persistence.replayById(corruptIndex, record.id)).toThrow(
            /Replay revision index is corrupt/
        );
        const mismatched = cloneInvocationMediationMemoryState(state);
        const other = MediatedReplayRecord.reserve(replayReservation("memory-replay-other"));
        for (const key of mismatched.replays.keys()) {
            mismatched.replays.set(key, MediatedReplayRecord.encode(other));
        }
        expect(() => persistence.replayById(mismatched, record.id)).toThrow(
            /Replay projection does not match codec bytes/
        );
    });

    test("guards replay append lineage", { tags: "p0" }, () => {
        const persistence = new MemoryInvocationMediationPersistence();
        const record = MediatedReplayRecord.reserve(replayReservation("memory-lineage"));
        const state = createInvocationMediationMemoryState();
        persistence.appendReplay(state, record);
        expect(() => persistence.appendReplay(state, record)).toThrow(/Replay reservation exists/);
        const residue = createInvocationMediationMemoryState();
        residue.replayRevision.set(record.id.value, 0);
        expect(() => persistence.appendReplay(residue, record)).toThrow(
            /Replay reservation exists/
        );
        const prepared = record.prepare(new InvocationId("memory-lineage-invocation"), [{}], [[]]);
        persistence.appendReplay(state, prepared);
        expect(() => persistence.appendReplay(state, prepared)).toThrow(
            /Replay revision is not the next reserved transition/
        );
        const rewound = cloneInvocationMediationMemoryState(state);
        rewound.replayRevision.set(record.id.value, 0);
        expect(() => persistence.appendReplay(rewound, prepared)).toThrow(
            /Replay revision exists/
        );
    });

    test("verifies audit projections against their codec bytes", { tags: "p1" }, () => {
        const persistence = new MemoryInvocationMediationPersistence();
        const state = createInvocationMediationMemoryState();
        const actor = new ActorRef("run", new ActorId("memory-audit-actor"));
        const kind = {
            kind: "invocation" as const,
            id: new InvocationId("memory-audit-invocation")
        };
        const record = new AuditRecord({
            id: new AuditRecordId("memory-audit"),
            actor,
            tenant: new TenantId("memory-audit-tenant"),
            correlation: new CorrelationId("memory-audit-correlation"),
            kind
        });
        persistence.appendAudit(state, record);
        expect(() => persistence.appendAudit(state, record)).toThrow(/Audit record exists/);
        const misfiled = cloneInvocationMediationMemoryState(state);
        misfiled.audits.set("memory-audit-other", AuditRecord.encode(record));
        expect(() => persistence.audit(misfiled, new AuditRecordId("memory-audit-other"))).toThrow(
            /Audit projection does not match codec bytes/
        );
        const scan = createInvocationMediationMemoryState();
        scan.audits.set("memory-audit-misfiled", AuditRecord.encode(record));
        expect(() => persistence.findAuditByEvidence(scan, actor, kind)).toThrow(
            /Audit projection does not match codec bytes/
        );
        const cross = cloneInvocationMediationMemoryState(state);
        const otherKind = {
            kind: "invocation" as const,
            id: new InvocationId("memory-audit-other-invocation")
        };
        cross.auditByEvidence.set(auditEvidenceIdentity(actor, otherKind).value, record.id.value);
        expect(() => persistence.findAuditByEvidence(cross, actor, otherKind)).toThrow(
            /Audit evidence projection does not match codec bytes/
        );
    });

    test("orders pending publications and guards publication lineage", { tags: "p1" }, () => {
        const persistence = new MemoryInvocationMediationPersistence();
        const state = createInvocationMediationMemoryState();
        const pendings = ["a", "b", "c"].map((suffix) =>
            InvocationPublicationOutbox.pending(observation(`memory-order-${suffix}`))
        );
        const [low, middle, high] = [...pendings].sort((left, right) =>
            left.id.value.localeCompare(right.id.value)
        );
        if (low === undefined || middle === undefined || high === undefined) {
            throw new TypeError("Expected three publications");
        }
        persistence.appendPublication(state, high);
        persistence.appendPublication(state, middle);
        persistence.appendPublication(state, low);
        persistence.appendPublication(state, middle.eventPublished(new Date(1)));
        persistence.appendPublication(
            state,
            middle.eventPublished(new Date(1)).commitAppended(new Date(2))
        );
        expect(persistence.pendingPublications(state).map((record) => record.id.value)).toEqual([
            low.id.value,
            high.id.value
        ]);
        expect(() => persistence.appendPublication(state, low)).toThrow(
            /Publication revision is not the next transition/
        );
        const orphan = InvocationPublicationOutbox.pending(
            observation("memory-orphan")
        ).eventPublished(new Date(1));
        expect(() => persistence.appendPublication(state, orphan)).toThrow(
            /Publication revision is not the next transition/
        );
        const misfiled = createInvocationMediationMemoryState();
        misfiled.publications.set("0".repeat(64), InvocationPublicationOutbox.encode(low));
        expect(() => persistence.publication(misfiled, new Digest("0".repeat(64)))).toThrow(
            /Publication projection does not match codec bytes/
        );
        const snapshot = cloneInvocationMediationMemoryState(state);
        for (const bytes of state.publications.values()) {
            bytes.fill(0);
        }
        expect(persistence.publication(snapshot, low.id)?.id.equals(low.id)).toBe(true);
    });
});

describe("W6 profile mediation port", () => {
    test("dispatches exactly one canonical item with empty interceptions", { tags: "p1" }, async () => {
        const invocation = new InvocationId("profile-shape");
        const request = profileRequest();
        const receipt = attemptReceipt("profile-shape", 0);
        let observed: CanonicalBatchInvocationRequest<ProtectedOperationRequest> | undefined;
        const port = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            {
                invoke: async (batchRequest) => {
                    observed = batchRequest;
                    return {
                        invocation,
                        items: [{ kind: "succeeded", itemIndex: 0, receipt, output: { value: 2 } }]
                    };
                }
            }
        );
        await expect(port.invoke(request)).resolves.toEqual({
            kind: "output",
            output: { value: 2 },
            receipt
        });
        expect(observed?.request.requestKey.value).toBe(`profile:${invocation.value}`);
        expect(observed?.request.interceptions).toEqual([[]]);
        expect(observed?.request.inputs).toEqual([{ value: 1 }]);
        expect(observed?.request.shape).toEqual({ kind: "single" });

        const doubled = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            {
                invoke: async () => ({
                    invocation,
                    items: [
                        { kind: "succeeded", itemIndex: 0, receipt, output: {} },
                        { kind: "succeeded", itemIndex: 1, receipt, output: {} }
                    ]
                })
            }
        );
        await expect(doubled.invoke(request)).rejects.toThrow(
            /substituted canonical item result/
        );
        const misindexed = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            {
                invoke: async () => ({
                    invocation,
                    items: [{ kind: "succeeded", itemIndex: 5, receipt, output: {} }]
                })
            }
        );
        await expect(misindexed.invoke(request)).rejects.toThrow(
            /substituted canonical item result/
        );
    });

    test("maps terminal profile receipts to precise failures", { tags: "p2" }, async () => {
        const invocation = new InvocationId("profile-failures");
        const request = profileRequest();
        const portFor = (receipt: Receipt) =>
            new InvocationProtectedOperationPort(
                { invocation: () => invocation },
                {
                    invoke: async () => ({
                        invocation,
                        items: [{ kind: "terminal", itemIndex: 0, receipt }]
                    })
                }
            );
        await expect(
            portFor(
                new PreEffectReceipt(
                    new ReceiptId("profile-denied"),
                    invocation,
                    0,
                    "deniedPreEffect",
                    new Date(1),
                    "profile denied"
                )
            ).invoke(request)
        ).rejects.toMatchObject({ code: "authority.denied", message: "profile denied" });
        await expect(
            portFor(
                new AttemptReceipt(
                    new ReceiptId("profile-indeterminate"),
                    new EffectAttemptId("profile-indeterminate-attempt"),
                    "indeterminate",
                    undefined,
                    new Date(1),
                    undefined
                )
            ).invoke(request)
        ).rejects.toMatchObject({
            code: "invocation.invalid",
            message: expect.stringMatching(/outcome is indeterminate/u)
        });
        await expect(
            portFor(
                new AttemptReceipt(
                    new ReceiptId("profile-failed"),
                    new EffectAttemptId("profile-failed-attempt"),
                    "failed",
                    undefined,
                    new Date(1),
                    undefined
                )
            ).invoke(request)
        ).rejects.toThrow(/did not produce a successful output/);
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

function batchPreflight(id: string) {
    return {
        requestKey: new OperationRequestKey(`request:${id}`),
        facet: new FacetRef("workspace:target"),
        descriptor,
        shape: { kind: "batch" as const, itemCount: 2 },
        inputs: [{ raw: 0 }, { raw: 1 }],
        authorization: "permit",
        replayBinding: replayReservationBinding()
    };
}

function receiptWithId(id: string): AttemptReceipt {
    return new AttemptReceipt(
        new ReceiptId(id),
        new EffectAttemptId(`attempt:${id}`),
        "succeeded",
        undefined,
        new Date(5),
        undefined
    );
}

function observation(id: string): ReceiptObservation {
    return Object.freeze({
        invocation: new InvocationId(`${id}-invocation`),
        receipt: new ReceiptId(`${id}-receipt`),
        audit: new AuditRecordId(`${id}-audit`)
    });
}

function profileRequest(): ProtectedOperationRequest {
    return {
        facet: new FacetRef("workspace:target"),
        binding: {} as never,
        operation: {
            descriptor,
            execute: async (_context: OperationContext, input: FacetData) => input
        },
        input: { value: 1 },
        resultMode: "output"
    };
}

function amendReplay(
    transactions: MemoryTransactions,
    persistence: MemoryInvocationMediationPersistence,
    scope: string,
    requestKey: string,
    amend: (record: MediatedReplayRecord) => readonly MediatedReplayRecord[]
): void {
    transactions.transact((transaction) => {
        const record = persistence.replay(transaction, scope, requestKey);
        if (record === undefined) throw new TypeError("Expected a stored replay record");
        for (const next of amend(record)) {
            persistence.appendReplay(transaction, next);
        }
    });
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
