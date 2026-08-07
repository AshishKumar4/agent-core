import fc, { type Command } from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { ContentRef, Digest } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { PrincipalId, TenantId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationContinuation,
    InvocationError,
    InvocationId,
    InvocationPublicationOutbox,
    PreparedInvocation,
    ItemClaim,
    ItemClaimId,
    PreEffectReceipt,
    ReceiptId,
    RouteProjectionId,
    RouteReservationId,
    auditEvidenceIdentity,
    validateAuditAppend,
    type AttemptReceiptOutcome,
    type AuditAppendContext,
    type AuditKind,
    type BatchOutcome,
    type InvocationEvidencePersistence,
    type PreEffectReceiptOutcome
} from "../../src/invocations";
import {
    admissionFor,
    digest,
    operationPin,
    prepared,
    preparedReferenceCodecs,
    type InvocationHarness
} from "./fixture";

export function invocationLedgerContract<Transaction>(
    name: string,
    create: () => InvocationHarness<Transaction>,
    // How the backend upholds receipt-lineage integrity: memory stores whatever it
    // is handed and the ledger reports the corruption at read; SQLite's constraints
    // exclude the corrupt append outright. Both make a broken lineage unobservable.
    corruptLineage: "reported" | "excluded" = "reported"
): void {
    describe(`[invocation-persistence] InvocationLedger (${name})`, () => {
        const harnesses = new Set<InvocationHarness<Transaction>>();
        const open = (): InvocationHarness<Transaction> => {
            const harness = create();
            harnesses.add(harness);
            return harness;
        };
        afterEach(() => {
            for (const harness of harnesses) harness.dispose();
            harnesses.clear();
        });

        test(
            "[invocation.prepared] persists preparation and derives stable shape-sensitive identities",
            { tags: "p0" },
            () => {
                const harness = open();
                const single = prepared("identity-single", { a: 1 });
                const batch = prepared("identity-batch", [{ a: 1 }]);
                expect(single.item(0).idempotencyKey).not.toBe(batch.item(0).idempotencyKey);
                expect(single.intentDigest.equals(batch.intentDigest)).toBe(false);

                harness.transaction((transaction) => harness.ledger.prepare(transaction, single));
                harness.restart();
                const restored = harness.transaction((transaction) =>
                    harness.persistence.prepared(transaction, single.header.id)
                );
                expect(restored?.intentDigest.value).toBe(single.intentDigest.value);
                expect(restored?.item(0).idempotencyKey).toBe(single.item(0).idempotencyKey);
            }
        );

        test(
            "[invocation.approval] [invocation.continuation] consumes one exact Approval with the first admitted attempt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("approved", [{ send: 0 }, { send: 1 }], {
                    lease: "lease:1"
                });
                const requested = Approval.pending(
                    new ApprovalId("approval:approved"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = requested.approve(new PrincipalId("approver"), time(2));
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:approved",
                    "worker:1",
                    time(10)
                );
                const attempt = effectAttempt(invocation, claim, "attempt:approved", time(3));
                const nextClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:approved:next",
                    "worker:2",
                    time(10)
                );
                const nextAttempt = effectAttempt(
                    invocation,
                    nextClaim,
                    "attempt:approved:next",
                    time(4)
                );

                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, requested);
                    harness.ledger.appendApprovalRevision(transaction, approved);
                    harness.ledger.claimItem(transaction, claim, time(2));
                    const consumed = harness.ledger.admitAttempt(transaction, attempt, time(3));
                    expect(consumed?.state.kind).toBe("consumed");
                    expect(
                        harness.persistence.continuation(transaction, invocation.header.id)
                    ).toMatchObject({ firstItemIndex: 0, firstOrdinal: 0 });
                    harness.ledger.claimItem(transaction, nextClaim, time(3));
                    expect(
                        harness.ledger.admitAttempt(transaction, nextAttempt, time(4))
                    ).toBeUndefined();
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow();
            }
        );

        test(
            "restores the consumed Approval continuation before admitting another batch item",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("continued-after-restart", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1",
                    approvalRequired: true
                });
                const pending = Approval.pending(
                    new ApprovalId("approval:continued-after-restart"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const firstClaim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:continued:first",
                    "worker:first",
                    time(10)
                );
                const firstAttempt = effectAttempt(
                    invocation,
                    firstClaim,
                    "attempt:continued:first",
                    time(3)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(
                        transaction,
                        pending.approve(new PrincipalId("approver"), time(2))
                    );
                    harness.ledger.claimItem(transaction, firstClaim, time(2));
                    harness.ledger.admitAttempt(transaction, firstAttempt, time(3));
                });

                harness.restart();
                const secondClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:continued:second",
                    "worker:second",
                    time(10)
                );
                const secondAttempt = effectAttempt(
                    invocation,
                    secondClaim,
                    "attempt:continued:second",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.claimItem(transaction, secondClaim, time(3));
                    expect(
                        harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                    ).toBeUndefined();
                    expect(
                        harness.persistence.continuation(transaction, invocation.header.id)
                    ).toMatchObject({ firstAttempt: firstAttempt.id, firstClaim: firstClaim.id });
                });
            }
        );

        test(
            "rejects an expired approved continuation without consuming or attempting",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared(
                    "expired-approval",
                    {},
                    {
                        lease: "lease:1",
                        approvalRequired: true
                    }
                );
                const pending = Approval.pending(
                    new ApprovalId("approval:expired"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(3)
                );
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:expired-approval",
                    "worker:expired-approval",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:expired-approval",
                    time(3)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(
                        transaction,
                        pending.approve(new PrincipalId("approver"), time(2))
                    );
                    harness.ledger.claimItem(transaction, claim, time(2));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow(/expired/);
                harness.transaction((transaction) => {
                    expect(harness.persistence.attempt(transaction, attempt.id)).toBeUndefined();
                    expect(
                        harness.persistence.continuation(transaction, invocation.header.id)
                    ).toBeUndefined();
                    expect(harness.persistence.approval(transaction, pending.id)?.state.kind).toBe(
                        "approved"
                    );
                });
            }
        );

        test(
            "[invocation.item-claim] recovers only an expired no-attempt claim at the same ordinal under a new worker",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("recover", { run: true }, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:first",
                    "worker:1",
                    time(5)
                );
                const replacement = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:replacement",
                    "worker:2",
                    time(20)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, replacement, time(4))
                    )
                ).toThrow();
                harness.transaction((transaction) =>
                    harness.ledger.recoverClaim(transaction, first.id, replacement, time(5))
                );
                expect(
                    harness.transaction(
                        (transaction) =>
                            harness.persistence.claim(transaction, replacement.id)?.attemptOrdinal
                    )
                ).toBe(0);
            }
        );

        test(
            "recovers an unattempted retry claim despite a prior failed ordinal",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("retry-recover", { run: true }, { lease: "lease:1" });
                const claim0 = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:0",
                    "worker:0",
                    time(10)
                );
                const attempt0 = effectAttempt(invocation, claim0, "attempt:0", time(2));
                const failed = new AttemptReceipt(
                    new ReceiptId("receipt:failed"),
                    attempt0.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                const claim1 = executorClaim(
                    invocation.header.id,
                    0,
                    1,
                    "claim:1",
                    "worker:1",
                    time(5)
                );
                const recovered = executorClaim(
                    invocation.header.id,
                    0,
                    1,
                    "claim:1r",
                    "worker:2",
                    time(20)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim0, time(1));
                    harness.ledger.admitAttempt(transaction, attempt0, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, failed);
                    harness.ledger.claimItem(transaction, claim1, time(4));
                    harness.ledger.recoverClaim(transaction, claim1.id, recovered, time(5));
                });
                expect(
                    harness.transaction(
                        (transaction) =>
                            harness.persistence.claim(transaction, recovered.id)?.attemptOrdinal
                    )
                ).toBe(1);
            }
        );

        test(
            "admits the next ordinal only after the current attempt has a final failed Receipt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("retry-attempt", { run: true }, { lease: "lease:1" });
                const claim0 = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:retry-attempt:0",
                    "worker:retry-attempt:0",
                    time(10)
                );
                const attempt0 = effectAttempt(
                    invocation,
                    claim0,
                    "attempt:retry-attempt:0",
                    time(2)
                );
                const failed = new AttemptReceipt(
                    new ReceiptId("receipt:retry-attempt:failed"),
                    attempt0.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                const claim1 = executorClaim(
                    invocation.header.id,
                    0,
                    1,
                    "claim:retry-attempt:1",
                    "worker:retry-attempt:1",
                    time(20)
                );
                const attempt1 = effectAttempt(
                    invocation,
                    claim1,
                    "attempt:retry-attempt:1",
                    time(5)
                );

                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim0, time(1));
                    harness.ledger.admitAttempt(transaction, attempt0, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, failed);
                    harness.ledger.claimItem(transaction, claim1, time(4));
                    harness.ledger.admitAttempt(transaction, attempt1, time(5));
                });

                expect(
                    harness
                        .transaction((transaction) =>
                            harness.persistence.attemptsForItem(
                                transaction,
                                invocation.header.id,
                                0
                            )
                        )
                        .map((attempt) => attempt.ordinal)
                ).toEqual([0, 1]);
            }
        );

        test("records pre-effect terminal evidence only before any attempt", { tags: "p0" }, () => {
            const harness = open();
            const invocation = prepared("denied");
            const denied = new PreEffectReceipt(
                new ReceiptId("receipt:denied"),
                invocation.header.id,
                0,
                "deniedPreEffect",
                time(2),
                "authority stale"
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.recordPreEffect(transaction, denied);
            });
            expect(
                harness.transaction((transaction) =>
                    harness.ledger.batchOutcome(transaction, invocation.header.id)
                )
            ).toBe("denied");
        });

        test(
            "[C13-ADV-RECEIPT-SUCCEEDED] [invocation.receipt] rejects succeeded attempted Receipts without the exact initial attempt lineage",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("succeeded-lineage", [{ index: 0 }], {
                    lease: "lease:1"
                });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:succeeded-lineage",
                    "worker:succeeded-lineage",
                    time(20)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:succeeded-lineage",
                    time(2)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });

                const missingAttempt = new AttemptReceipt(
                    new ReceiptId("receipt:succeeded-missing-attempt"),
                    new EffectAttemptId("attempt:succeeded-missing"),
                    "succeeded",
                    undefined,
                    time(3),
                    content("succeeded-missing-attempt")
                );
                const substitutedPredecessor = new AttemptReceipt(
                    new ReceiptId("receipt:succeeded-substituted-predecessor"),
                    attempt.id,
                    "succeeded",
                    new ReceiptId("receipt:succeeded-unrelated-predecessor"),
                    time(3),
                    content("succeeded-substituted-predecessor")
                );
                for (const receipt of [missingAttempt, substitutedPredecessor]) {
                    expect(() =>
                        harness.transaction((transaction) =>
                            harness.ledger.recordAttemptReceipt(transaction, receipt)
                        )
                    ).toThrow();
                }
                harness.restart();
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.receiptsForAttempt(transaction, attempt.id)
                    )
                ).toHaveLength(0);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.receipt(transaction, missingAttempt.id)
                    )
                ).toBeUndefined();
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.receipt(transaction, substitutedPredecessor.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[C13-ADV-RECEIPT-SUPERSESSION] [invocation.receipt] supersedes one indeterminate Receipt exactly once and derives batch outcomes",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("batch", [{ index: 0 }, { index: 1 }], {
                    lease: "lease:1"
                });
                const claim0 = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:b0",
                    "worker:b0",
                    time(20)
                );
                const claim1 = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:b1",
                    "worker:b1",
                    time(20)
                );
                const attempt0 = effectAttempt(invocation, claim0, "attempt:b0", time(2));
                const attempt1 = effectAttempt(invocation, claim1, "attempt:b1", time(2));
                const unknown = new AttemptReceipt(
                    new ReceiptId("receipt:unknown"),
                    attempt0.id,
                    "indeterminate",
                    undefined,
                    time(3),
                    undefined
                );
                const success1 = new AttemptReceipt(
                    new ReceiptId("receipt:success1"),
                    attempt1.id,
                    "succeeded",
                    undefined,
                    time(3),
                    content("success1")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim0, time(1));
                    harness.ledger.claimItem(transaction, claim1, time(1));
                    harness.ledger.admitAttempt(transaction, attempt0, time(2));
                    harness.ledger.admitAttempt(transaction, attempt1, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, unknown);
                    harness.ledger.recordAttemptReceipt(transaction, success1);
                });
                expect(
                    harness.transaction((transaction) =>
                        harness.ledger.batchOutcome(transaction, invocation.header.id)
                    )
                ).toBe("indeterminate");

                const final = new AttemptReceipt(
                    new ReceiptId("receipt:final"),
                    attempt0.id,
                    "failed",
                    unknown.id,
                    time(4),
                    undefined
                );
                harness.transaction((transaction) =>
                    harness.ledger.supersedeReceipt(transaction, final)
                );
                expect(final.previous?.equals(unknown.id)).toBe(true);
                expect(
                    harness.transaction((transaction) =>
                        harness.ledger.batchOutcome(transaction, invocation.header.id)
                    )
                ).toBe("partiallySucceeded");
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.supersedeReceipt(transaction, final)
                    )
                ).toThrow();
            }
        );

        test(
            "[invocation.effect-attempt] rejects substituted AuthorityAdmission before persisting an attempt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("authority", { send: true }, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:authority",
                    "worker",
                    time(10)
                );
                const attempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:authority"),
                    invocation.header.id,
                    0,
                    0,
                    claim.id,
                    "lease:1",
                    admissionFor("wrong", 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:attempt:authority")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(2))
                    )
                ).toThrow();
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, attempt.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "covers lease-free system admission and defensive Receipt rejection paths",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared("system");
                const claim = new ItemClaim<string>(
                    new ItemClaimId("claim:system"),
                    invocation.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: invocation.header.actor,
                        worker: new ClaimWorkerId("worker:system")
                    },
                    time(10)
                );
                const attempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:system"),
                    invocation.header.id,
                    0,
                    0,
                    claim.id,
                    undefined,
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:attempt:system")
                );
                const unknown = new AttemptReceipt(
                    new ReceiptId("receipt:system:unknown"),
                    attempt.id,
                    "indeterminate",
                    undefined,
                    time(3),
                    undefined
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    expect(
                        harness.ledger.currentReceipt(transaction, invocation.header.id, 0)
                    ).toBeUndefined();
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                    expect(() =>
                        harness.ledger.recordAttemptReceipt(
                            transaction,
                            new AttemptReceipt(
                                new ReceiptId("receipt:illegal-previous"),
                                attempt.id,
                                "failed",
                                new ReceiptId("previous"),
                                time(3),
                                undefined
                            )
                        )
                    ).toThrow();
                    harness.ledger.recordAttemptReceipt(transaction, unknown);
                    expect(
                        harness.ledger.currentReceipt(transaction, invocation.header.id, 0)?.id
                    ).toEqual(unknown.id);
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recordAttemptReceipt(
                            transaction,
                            new AttemptReceipt(
                                new ReceiptId("receipt:duplicate"),
                                attempt.id,
                                "failed",
                                undefined,
                                time(4),
                                undefined
                            )
                        )
                    )
                ).toThrow();
            }
        );

        test(
            "derives Approval requirements and forbids out-of-band consumption",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared(
                    "approval-guard",
                    { send: true },
                    { lease: "lease:1", approvalRequired: true }
                );
                const pending = Approval.pending(
                    new ApprovalId("approval:guard"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:guard",
                    "worker:guard",
                    time(10)
                );
                const attempt = effectAttempt(invocation, claim, "attempt:guard", time(3));
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow(/requires Approval/);
                harness.transaction((transaction) =>
                    harness.ledger.requestApproval(transaction, pending)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow(/approved continuation/);
                harness.transaction((transaction) =>
                    harness.ledger.appendApprovalRevision(transaction, approved)
                );
                const fakeConsumption = approved.consume(
                    new EffectAttemptId("fake-attempt"),
                    time(3)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.appendApprovalRevision(transaction, fakeConsumption)
                    )
                ).toThrow();
                harness.transaction((transaction) =>
                    harness.ledger.admitAttempt(transaction, attempt, time(3))
                );
            }
        );

        test(
            "prevents claim terminalization races and superseded-claim resurrection",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("claim-race", { send: true }, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:race:0",
                    "worker:0",
                    time(3)
                );
                const replacement = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:race:1",
                    "worker:1",
                    time(10)
                );
                const attempt = effectAttempt(invocation, replacement, "attempt:race", time(4));
                const denied = new PreEffectReceipt(
                    new ReceiptId("receipt:claim-race"),
                    invocation.header.id,
                    0,
                    "deniedPreEffect",
                    time(2),
                    "denied"
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recordPreEffect(transaction, denied)
                    )
                ).toThrow(/untouched/);
                harness.transaction((transaction) => {
                    harness.ledger.recoverClaim(transaction, first.id, replacement, time(3));
                    harness.ledger.admitAttempt(transaction, attempt, time(4));
                });
                const resurrected = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:race:2",
                    "worker:2",
                    time(20)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, resurrected, time(11))
                    )
                ).toThrow(/current no-attempt/);
            }
        );

        test(
            "binds system and recovered executor claims to the Prepared owner",
            { tags: "p0" },
            () => {
                const harness = open();
                const systemInvocation = prepared("wrong-system");
                const foreignSystem = new ItemClaim<string>(
                    new ItemClaimId("claim:foreign-system"),
                    systemInvocation.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: new ActorRef("run", new ActorId("foreign")),
                        worker: new ClaimWorkerId("worker:foreign")
                    },
                    time(10)
                );
                harness.transaction((transaction) =>
                    harness.ledger.prepare(transaction, systemInvocation)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.claimItem(transaction, foreignSystem, time(1))
                    )
                ).toThrow(/exact owning Actor/);

                const leased = prepared("wrong-recovery", {}, { lease: "lease:1" });
                const original = executorClaim(
                    leased.header.id,
                    0,
                    0,
                    "claim:lease:0",
                    "worker:0",
                    time(3)
                );
                const wrongLease = new ItemClaim(
                    new ItemClaimId("claim:lease:1"),
                    leased.header.id,
                    0,
                    0,
                    {
                        kind: "executor",
                        token: "lease:wrong",
                        worker: new ClaimWorkerId("worker:1")
                    },
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, leased);
                    harness.ledger.claimItem(transaction, original, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, original.id, wrongLease, time(3))
                    )
                ).toThrow(/exact PreparedInvocation lease/);
            }
        );

        test(
            "rejects duplicate preparation and malformed Approval revisions",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("duplicate-preparation");
                harness.transaction((transaction) =>
                    harness.ledger.prepare(transaction, invocation)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.prepare(transaction, invocation)
                    )
                ).toThrow(/already exists/);

                const missing = Approval.pending(
                    new ApprovalId("missing-prepared-approval"),
                    new InvocationId("missing-prepared"),
                    Digest.sha256(new TextEncoder().encode("missing")),
                    time(1)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.requestApproval(transaction, missing)
                    )
                ).toThrow(/does not exist/);

                const wrongDigest = Approval.pending(
                    new ApprovalId("wrong-digest-approval"),
                    invocation.header.id,
                    Digest.sha256(new TextEncoder().encode("wrong")),
                    time(1)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.requestApproval(transaction, wrongDigest)
                    )
                ).toThrow(/does not bind/);

                const orphan = Approval.pending(
                    new ApprovalId("orphan-revision"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(10)
                ).approve(new PrincipalId("approver"), time(2));
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.appendApprovalRevision(transaction, orphan)
                    )
                ).toThrow(/next legal/);
            }
        );

        test(
            "fails closed when cross-wave preparation evidence rejects ownership",
            { tags: "p0" },
            () => {
                const harness = open();
                const invalid = PreparedInvocation.create(
                    {
                        id: new InvocationId("invalid-preparation-owner"),
                        operation: operationPin("invalid-preparation-owner"),
                        domain: "domain:invalid-preparation-owner",
                        actor: new ActorRef("run", new ActorId("foreign-actor")),
                        authority: "authority:invalid-preparation-owner",
                        pathEpochs: "epochs:invalid-preparation-owner",
                        auditCause: new AuditRecordId("audit:invalid-preparation-owner"),
                        idempotencySeed: "seed:invalid-preparation-owner"
                    },
                    { kind: "single", item: {} },
                    preparedReferenceCodecs
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.prepare(transaction, invalid)
                    )
                ).toThrow(/evidence is invalid/);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.prepared(transaction, invalid.header.id)
                    )
                ).toBeUndefined();
            }
        );

        test("rejects live, unresolved, and wrong-ordinal claims", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("claim-guards", {}, { lease: "lease:1" });
            const first = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:guards:0",
                "worker:0",
                time(20)
            );
            const competing = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:guards:1",
                "worker:1",
                time(20)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.claimItem(transaction, first, time(1));
            });
            expect(() =>
                harness.transaction((transaction) =>
                    harness.ledger.claimItem(transaction, competing, time(2))
                )
            ).toThrow(/already has/);

            const attempt = effectAttempt(invocation, first, "attempt:claim-guards", time(2));
            harness.transaction((transaction) =>
                harness.ledger.admitAttempt(transaction, attempt, time(2))
            );
            expect(() =>
                harness.transaction((transaction) =>
                    harness.ledger.claimItem(transaction, competing, time(3))
                )
            ).toThrow(/unresolved EffectAttempt/);

            const fresh = prepared("wrong-ordinal", {}, { lease: "lease:1" });
            const wrongOrdinal = executorClaim(
                fresh.header.id,
                0,
                1,
                "claim:wrong-ordinal",
                "worker",
                time(20)
            );
            harness.transaction((transaction) => harness.ledger.prepare(transaction, fresh));
            expect(() =>
                harness.transaction((transaction) =>
                    harness.ledger.claimItem(transaction, wrongOrdinal, time(1))
                )
            ).toThrow(/wrong attempt ordinal/);
        });

        test(
            "rejects altered recovery identity and invalid attempt ownership",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("attempt-guards", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:attempt-guards",
                    "worker:0",
                    time(3)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                const altered = new ItemClaim(
                    new ItemClaimId("claim:altered"),
                    new InvocationId("other-invocation"),
                    0,
                    0,
                    { kind: "executor", token: "lease:1", worker: new ClaimWorkerId("worker:1") },
                    time(10)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, claim.id, altered, time(3))
                    )
                ).toThrow(/changed immutable/);

                const missingToken = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:missing-token"),
                    invocation.header.id,
                    0,
                    0,
                    claim.id,
                    undefined,
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:missing-token")
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, missingToken, time(2))
                    )
                ).toThrow(/token/);
                const expired = effectAttempt(invocation, claim, "attempt:expired-claim", time(3));
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, expired, time(3))
                    )
                ).toThrow(/live current claim/);
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, expired, new Date(Number.NaN))
                    )
                ).toThrow(/valid Date/);
            }
        );

        test(
            "rejects token-bearing system attempts and orphaned consumed approvals",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("system-token");
                const claim = new ItemClaim<string>(
                    new ItemClaimId("claim:system-token"),
                    invocation.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: invocation.header.actor,
                        worker: new ClaimWorkerId("system-worker")
                    },
                    time(10)
                );
                const attempt = new EffectAttempt(
                    new EffectAttemptId("attempt:system-token"),
                    invocation.header.id,
                    0,
                    0,
                    claim.id,
                    "unexpected-token",
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:system-token")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(2))
                    )
                ).toThrow(/System EffectAttempt/);

                const approvedInvocation = prepared(
                    "orphaned-consumption",
                    {},
                    { lease: "lease:1" }
                );
                const pending = Approval.pending(
                    new ApprovalId("orphaned-consumption"),
                    approvedInvocation.header.id,
                    approvedInvocation.intentDigest,
                    time(1),
                    time(10)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const consumed = approved.consume(
                    new EffectAttemptId("missing-first-attempt"),
                    time(3)
                );
                const executor = executorClaim(
                    approvedInvocation.header.id,
                    0,
                    0,
                    "claim:orphaned-consumption",
                    "worker",
                    time(10)
                );
                const next = effectAttempt(
                    approvedInvocation,
                    executor,
                    "attempt:orphaned-consumption",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, approvedInvocation);
                    harness.persistence.appendApproval(transaction, pending);
                    harness.persistence.appendApproval(transaction, approved);
                    harness.persistence.appendApproval(transaction, consumed);
                    harness.ledger.claimItem(transaction, executor, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, next, time(4))
                    )
                ).toThrow(/no matching InvocationContinuation/);
            }
        );

        test(
            "rejects expired approvals, invalid reconciliation, and nonfailed retries",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared(
                    "expired-approval",
                    {},
                    {
                        lease: "lease:1",
                        approvalRequired: true
                    }
                );
                const pending = Approval.pending(
                    new ApprovalId("expired-approval"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(3)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:expired-approval",
                    "worker",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:expired-approval",
                    time(3)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(transaction, approved);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow(/expired/);
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.supersedeReceipt(
                            transaction,
                            new AttemptReceipt(
                                new ReceiptId("unused"),
                                attempt.id,
                                "failed",
                                new ReceiptId("missing-reconciliation"),
                                time(4),
                                undefined
                            )
                        )
                    )
                ).toThrow(/current indeterminate/);

                const deniedInvocation = prepared("nonfailed-retry");
                const denied = new PreEffectReceipt(
                    new ReceiptId("nonfailed-retry"),
                    deniedInvocation.header.id,
                    0,
                    "deniedPreEffect",
                    time(2),
                    "denied"
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, deniedInvocation);
                    harness.ledger.recordPreEffect(transaction, denied);
                });
                const retry = new ItemClaim<string>(
                    new ItemClaimId("claim:nonfailed-retry"),
                    deniedInvocation.header.id,
                    0,
                    1,
                    {
                        kind: "system",
                        actor: deniedInvocation.header.actor,
                        worker: new ClaimWorkerId("retry-worker")
                    },
                    time(10)
                );
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.claimItem(transaction, retry, time(3))
                    )
                ).toThrow(/final failed/);
            }
        );

        test("rolls back partial preparation across restart", { tags: "p0" }, () => {
            const harness = open();
            const invocation = prepared("rollback-preparation");
            expect(() =>
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    throw new InvocationError("state.invalid-transition", "force rollback");
                })
            ).toThrow(/force rollback/);
            harness.restart();
            expect(
                harness.transaction((transaction) =>
                    harness.persistence.prepared(transaction, invocation.header.id)
                )
            ).toBeUndefined();
        });

        test(
            "rolls back Approval consumption when first-attempt append conflicts",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("approval-atomicity", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1",
                    approvalRequired: true
                });
                const pending = Approval.pending(
                    new ApprovalId("approval-atomicity"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:approval-atomicity",
                    "worker:approval-atomicity",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:approval-atomicity",
                    time(3)
                );
                const conflicting = new EffectAttempt(
                    attempt.id,
                    invocation.header.id,
                    1,
                    0,
                    new ItemClaimId("claim:conflicting"),
                    "lease:1",
                    admissionFor(invocation.header.id.value, 1, 0),
                    time(2),
                    invocation.item(1).idempotencyKey,
                    new AuditRecordId("audit:conflicting")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(transaction, approved);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.persistence.appendAttempt(transaction, conflicting);
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(3))
                    )
                ).toThrow();
                harness.restart();
                expect(
                    harness.transaction(
                        (transaction) =>
                            harness.persistence.approval(transaction, pending.id)?.state.kind
                    )
                ).toBe("approved");
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attemptsForItem(transaction, invocation.header.id, 0)
                    )
                ).toEqual([]);
            }
        );

        test(
            "fails closed on contradictory pre-effect and attempted histories",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("contradictory-history");
                const attempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:contradictory-history"),
                    invocation.header.id,
                    0,
                    0,
                    new ItemClaimId("claim:contradictory-history"),
                    undefined,
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:contradictory-history")
                );
                const denied = new PreEffectReceipt(
                    new ReceiptId("receipt:contradictory-history"),
                    invocation.header.id,
                    0,
                    "deniedPreEffect",
                    time(1),
                    "denied"
                );
                harness.transaction((transaction) => {
                    harness.persistence.insertPrepared(transaction, invocation);
                    harness.persistence.appendReceipt(transaction, denied);
                    harness.persistence.appendAttempt(transaction, attempt);
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.currentReceipt(transaction, invocation.header.id, 0)
                    )
                ).toThrow(/contradictory/);
            }
        );

        test(
            "[C13-ADV-COMPETING-CLAIMS] admits only one current item claim",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("competing-claims", {}, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:competing:first",
                    "worker:first",
                    time(10)
                );
                const competing = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:competing:second",
                    "worker:second",
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.claimItem(transaction, competing, time(2))
                    )
                ).toThrow(/already has/);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claimsForItem(transaction, invocation.header.id, 0)
                    )
                ).toHaveLength(1);
            }
        );

        test(
            "[C13-ADV-NONFUTURE-CLAIM] rejects equal and past claim expiries",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("nonfuture-claim", {}, { lease: "lease:1" });
                harness.transaction((transaction) =>
                    harness.ledger.prepare(transaction, invocation)
                );

                for (const [id, expiry] of [
                    ["claim:equal-expiry", time(5)],
                    ["claim:past-expiry", time(4)]
                ] as const) {
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        id,
                        `worker:${id}`,
                        expiry
                    );
                    expect(() =>
                        harness.transaction((transaction) =>
                            harness.ledger.claimItem(transaction, claim, time(5))
                        )
                    ).toThrow(/future expiry/);
                }
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claimsForItem(transaction, invocation.header.id, 0)
                    )
                ).toEqual([]);
            }
        );

        test(
            "[C13-ADV-PREMATURE-RECOVERY] rejects recovery before the current claim expires",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("premature-recovery", {}, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:premature:first",
                    "worker:first",
                    time(5)
                );
                const replacement = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:premature:replacement",
                    "worker:replacement",
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, replacement, time(4))
                    )
                ).toThrow(/expired claim/);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claim(transaction, replacement.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[C13-ADV-POST-ATTEMPT-RECOVERY] rejects recovery after an attempt was admitted",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("post-attempt-recovery", {}, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:post-attempt:first",
                    "worker:first",
                    time(3)
                );
                const attempt = effectAttempt(invocation, first, "attempt:post-attempt", time(2));
                const replacement = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:post-attempt:replacement",
                    "worker:replacement",
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, replacement, time(3))
                    )
                ).toThrow(/current no-attempt/);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claim(transaction, replacement.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[C13-ADV-RECOVERY-ORDINAL] rejects recovery that advances an unattempted ordinal",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("recovery-ordinal", {}, { lease: "lease:1" });
                const current = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-ordinal:current",
                    "worker:current",
                    time(3)
                );
                const advanced = executorClaim(
                    invocation.header.id,
                    0,
                    1,
                    "claim:recovery-ordinal:advanced",
                    "worker:replacement",
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, current, time(1));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, current.id, advanced, time(3))
                    )
                ).toThrow(/immutable scheduling identity/);
                expect(
                    harness.transaction((transaction) => ({
                        advanced: harness.persistence.claim(transaction, advanced.id),
                        current: harness.persistence.claim(transaction, current.id)
                    }))
                ).toEqual({ advanced: undefined, current });
            }
        );

        test(
            "[C13-ADV-RECEIPT-DENIED] keeps denied pre-effect Receipts outside attempted lineage",
            { tags: "p0" },
            () => {
                const harness = open();
                const deniedInvocation = prepared("denied-lineage");
                const denied = new PreEffectReceipt(
                    new ReceiptId("receipt:denied-lineage"),
                    deniedInvocation.header.id,
                    0,
                    "deniedPreEffect",
                    time(2),
                    "denied"
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, deniedInvocation);
                    harness.ledger.recordPreEffect(transaction, denied);
                });
                harness.restart();
                harness.transaction((transaction) => {
                    expect(
                        harness.ledger.currentReceipt(transaction, deniedInvocation.header.id, 0)
                    ).toBeInstanceOf(PreEffectReceipt);
                    expect(
                        harness.persistence.attemptsForItem(
                            transaction,
                            deniedInvocation.header.id,
                            0
                        )
                    ).toEqual([]);
                });

                const attemptedInvocation = prepared("denied-after-attempt");
                const claim = new ItemClaim<string>(
                    new ItemClaimId("claim:denied-after-attempt"),
                    attemptedInvocation.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: attemptedInvocation.header.actor,
                        worker: new ClaimWorkerId("worker:denied-after-attempt")
                    },
                    time(10)
                );
                const attempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:denied-after-attempt"),
                    attemptedInvocation.header.id,
                    0,
                    0,
                    claim.id,
                    undefined,
                    admissionFor(attemptedInvocation.header.id.value, 0, 0),
                    time(2),
                    attemptedInvocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:denied-after-attempt")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, attemptedInvocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recordPreEffect(
                            transaction,
                            new PreEffectReceipt(
                                new ReceiptId("receipt:invalid-denied-after-attempt"),
                                attemptedInvocation.header.id,
                                0,
                                "deniedPreEffect",
                                time(3),
                                "too late"
                            )
                        )
                    )
                ).toThrow(/untouched item/);
            }
        );

        test(
            "[C13-CLAIM-FUTURE-EXPIRY] durably admits a claim only with future expiry",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("future-expiry", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:future-expiry",
                    "worker:future-expiry",
                    time(5)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(4));
                });
                harness.restart();

                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claim(transaction, claim.id)?.expiresAt.getTime()
                    )
                ).toBe(time(5).getTime());
            }
        );

        test(
            "[C13-CLAIM-RECOVERY-FUTURE-EXPIRY] requires a recovered claim to expire in the future",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("recovery-future-expiry", {}, { lease: "lease:1" });
                const first = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-future:first",
                    "worker:first",
                    time(3)
                );
                const nonfuture = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-future:nonfuture",
                    "worker:nonfuture",
                    time(3)
                );
                const future = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-future:future",
                    "worker:future",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, first, time(1));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, nonfuture, time(3))
                    )
                ).toThrow(/future expiry/);
                harness.transaction((transaction) =>
                    harness.ledger.recoverClaim(transaction, first.id, future, time(3))
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.claim(transaction, future.id)?.expiresAt.getTime()
                    )
                ).toBe(time(4).getTime());
            }
        );

        test(
            "[C13-CLAIM-RECOVERY-NO-ATTEMPT] recovers only claims with no admitted attempt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("recovery-no-attempt", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-no-attempt",
                    "worker:first",
                    time(3)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:recovery-no-attempt",
                    time(2)
                );
                const replacement = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:recovery-no-attempt:replacement",
                    "worker:replacement",
                    time(5)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });
                harness.restart();

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, claim.id, replacement, time(3))
                    )
                ).toThrow(/no-attempt/);
            }
        );

        test(
            "[C13-EFFECT-ATTEMPT-IMMUTABLE] preserves the first EffectAttempt append",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("immutable-attempt", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:immutable-attempt",
                    "worker:immutable-attempt",
                    time(10)
                );
                const attempt = effectAttempt(invocation, claim, "attempt:immutable", time(2));
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });
                const replacement = new EffectAttempt<string, string>(
                    attempt.id,
                    attempt.invocation,
                    attempt.itemIndex,
                    attempt.ordinal,
                    attempt.claim,
                    attempt.token,
                    attempt.admission,
                    time(3),
                    attempt.idempotencyKey,
                    new AuditRecordId("audit:immutable:replacement")
                );

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.persistence.appendAttempt(transaction, replacement)
                    )
                ).toThrow();
                harness.restart();
                expect(
                    harness.transaction(
                        (transaction) =>
                            harness.persistence.attempt(transaction, attempt.id)?.auditCause.value
                    )
                ).toBe(attempt.auditCause.value);
            }
        );

        test(
            "[C13-PREPARED-APPROVAL-SINGLE-USE] consumes one Approval only on the first admitted attempt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("approval-single-use", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1",
                    approvalRequired: true
                });
                const pending = Approval.pending(
                    new ApprovalId("approval:single-use"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const firstClaim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:approval-single-use:first",
                    "worker:first",
                    time(10)
                );
                const secondClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:approval-single-use:second",
                    "worker:second",
                    time(10)
                );
                const firstAttempt = effectAttempt(
                    invocation,
                    firstClaim,
                    "attempt:approval-single-use:first",
                    time(3)
                );
                const secondAttempt = effectAttempt(
                    invocation,
                    secondClaim,
                    "attempt:approval-single-use:second",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(
                        transaction,
                        pending.approve(new PrincipalId("approver"), time(2))
                    );
                    harness.ledger.claimItem(transaction, firstClaim, time(2));
                    expect(
                        harness.ledger.admitAttempt(transaction, firstAttempt, time(3))?.state.kind
                    ).toBe("consumed");
                    harness.ledger.claimItem(transaction, secondClaim, time(3));
                    expect(
                        harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                    ).toBeUndefined();
                    expect(
                        harness.persistence.approval(transaction, pending.id)?.revision.value
                    ).toBe(2);
                    expect(
                        harness.persistence.approvalRevision(transaction, pending.id, 3)
                    ).toBeUndefined();
                });
            }
        );

        test(
            "[C13-PREPARED-APPROVAL-UNIQUE] reserves one Approval identity per invocation",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("approval-unique", {}, { approvalRequired: true });
                const first = Approval.pending(
                    new ApprovalId("approval:unique:first"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1)
                );
                const competing = Approval.pending(
                    new ApprovalId("approval:unique:competing"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, first);
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.requestApproval(transaction, competing)
                    )
                ).toThrow(/fresh exact/);
                harness.restart();
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.approvalForInvocation(transaction, invocation.header.id)
                            ?.id.value
                    ).toBe(first.id.value);
                    expect(harness.persistence.approval(transaction, competing.id)).toBeUndefined();
                });
            }
        );

        test(
            "[C13-PREPARED-CONTINUATION-ABSENT] rejects consumed Approval admission without its continuation",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("continuation-absent", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1",
                    approvalRequired: true
                });
                const pending = Approval.pending(
                    new ApprovalId("approval:continuation-absent"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const firstClaim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:continuation-absent:first",
                    "worker:first",
                    time(10)
                );
                const firstAttempt = effectAttempt(
                    invocation,
                    firstClaim,
                    "attempt:continuation-absent:first",
                    time(3)
                );
                const secondClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:continuation-absent:second",
                    "worker:second",
                    time(10)
                );
                const secondAttempt = effectAttempt(
                    invocation,
                    secondClaim,
                    "attempt:continuation-absent:second",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.persistence.insertPrepared(transaction, invocation);
                    harness.persistence.appendApproval(transaction, pending);
                    harness.persistence.appendApproval(transaction, approved);
                    harness.persistence.appendApproval(
                        transaction,
                        approved.consume(firstAttempt.id, time(3))
                    );
                    harness.persistence.appendClaim(transaction, firstClaim);
                    harness.persistence.appendAttempt(transaction, firstAttempt);
                    harness.ledger.claimItem(transaction, secondClaim, time(3));
                });

                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                    )
                ).toThrow(/no matching InvocationContinuation/);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, secondAttempt.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[C13-PREPARED-OPTIONAL-LEASE] admits exact leased and lease-free ownership modes",
            { tags: "p0" },
            () => {
                const harness = open();
                const systemInvocation = prepared("optional-lease-system");
                const systemClaim = new ItemClaim<string>(
                    new ItemClaimId("claim:optional-lease-system"),
                    systemInvocation.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: systemInvocation.header.actor,
                        worker: new ClaimWorkerId("worker:optional-lease-system")
                    },
                    time(10)
                );
                const systemAttempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:optional-lease-system"),
                    systemInvocation.header.id,
                    0,
                    0,
                    systemClaim.id,
                    undefined,
                    admissionFor(systemInvocation.header.id.value, 0, 0),
                    time(2),
                    systemInvocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:optional-lease-system")
                );
                const leasedInvocation = prepared(
                    "optional-lease-executor",
                    {},
                    { lease: "lease:1" }
                );
                const executor = executorClaim(
                    leasedInvocation.header.id,
                    0,
                    0,
                    "claim:optional-lease-executor",
                    "worker:optional-lease-executor",
                    time(10)
                );
                const executorAttempt = effectAttempt(
                    leasedInvocation,
                    executor,
                    "attempt:optional-lease-executor",
                    time(2)
                );

                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, systemInvocation);
                    harness.ledger.claimItem(transaction, systemClaim, time(1));
                    harness.ledger.admitAttempt(transaction, systemAttempt, time(2));
                    harness.ledger.prepare(transaction, leasedInvocation);
                    harness.ledger.claimItem(transaction, executor, time(1));
                    harness.ledger.admitAttempt(transaction, executorAttempt, time(2));
                });
                harness.restart();
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.attempt(transaction, systemAttempt.id)?.token
                    ).toBeUndefined();
                    expect(
                        harness.persistence.attempt(transaction, executorAttempt.id)?.token
                    ).toBe("lease:1");
                });
            }
        );

        test(
            "[C13-RECEIPT-INDETERMINATE-SUPERSESSION] persists one final supersession exactly once",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("indeterminate-supersession", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:indeterminate-supersession",
                    "worker:indeterminate-supersession",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:indeterminate-supersession",
                    time(2)
                );
                const indeterminate = new AttemptReceipt(
                    new ReceiptId("receipt:indeterminate-supersession"),
                    attempt.id,
                    "indeterminate",
                    undefined,
                    time(3),
                    undefined
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, indeterminate);
                    harness.ledger.supersedeReceipt(
                        transaction,
                        new AttemptReceipt(
                            new ReceiptId("receipt:indeterminate-final"),
                            attempt.id,
                            "failed",
                            indeterminate.id,
                            time(4),
                            undefined
                        )
                    );
                });
                harness.restart();
                const current = harness.transaction((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation.header.id, 0)
                );
                expect(current).toMatchObject({ outcome: "failed", previous: indeterminate.id });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.supersedeReceipt(
                            transaction,
                            new AttemptReceipt(
                                new ReceiptId("receipt:indeterminate-second-final"),
                                attempt.id,
                                "succeeded",
                                indeterminate.id,
                                time(5),
                                content("second-final")
                            )
                        )
                    )
                ).toThrow(/only a current indeterminate/i);
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.receiptsForAttempt(transaction, attempt.id)
                    )
                ).toHaveLength(2);
            }
        );

        test(
            "rejects a stale authenticated worker after claim ownership changes",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("stale-worker", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:stale-worker",
                    "stale-worker",
                    time(10)
                );
                const attempt = effectAttempt(invocation, claim, "attempt:stale-worker", time(2));
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(2))
                    )
                ).toThrow(/does not own/);
            }
        );

        test(
            "[invocation.audit] prepareWithAudit persists a local preparation with its root AuditRecord",
            { tags: "p0" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = prepared("audit-local");
                const root = preparationAudit(invocation);
                harness.transaction((transaction) =>
                    harness.ledger.prepareWithAudit(transaction, invocation, root, evidence)
                );
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.prepared(transaction, invocation.header.id)
                    ).toBeDefined();
                    expect(evidence.audit(transaction, root.id)?.id.value).toBe(root.id.value);
                });
            }
        );

        test(
            "[invocation.audit] rejects preparation AuditRecords that do not bind the PreparedInvocation",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const local = prepared("audit-binding-local");
                const routed = routedPrepared("audit-binding-routed");
                const cases: ReadonlyArray<
                    readonly [PreparedInvocation<string, string, string, string>, AuditRecord]
                > = [
                    [
                        local,
                        auditRecord("audit:binding-unrelated", local.header.actor, {
                            kind: "invocation",
                            id: local.header.id
                        })
                    ],
                    [
                        local,
                        auditRecord(
                            local.header.auditCause.value,
                            new ActorRef("run", new ActorId("actor:binding-foreign")),
                            { kind: "invocation", id: local.header.id }
                        )
                    ],
                    [
                        local,
                        auditRecord(local.header.auditCause.value, local.header.actor, {
                            kind: "invocation",
                            id: new InvocationId("audit-binding-other")
                        })
                    ],
                    [
                        routed,
                        auditRecord(routed.header.auditCause.value, routed.header.actor, {
                            kind: "invocation",
                            id: routed.header.id
                        })
                    ],
                    [
                        routed,
                        auditRecord(routed.header.auditCause.value, routed.header.actor, {
                            kind: "routeProjected",
                            projection: new RouteProjectionId("projection:audit-binding-routed"),
                            reservation: new RouteReservationId("route:elsewhere")
                        })
                    ],
                    [
                        routed,
                        auditRecord(
                            routed.header.auditCause.value,
                            routed.header.actor,
                            {
                                kind: "routeProjected",
                                projection: new RouteProjectionId(
                                    "projection:audit-binding-routed"
                                ),
                                reservation: new RouteReservationId("route:audit-binding-routed")
                            },
                            new AuditRecordId("audit:binding-cause")
                        )
                    ]
                ];
                for (const [invocation, audit] of cases) {
                    expectAgentCoreError(
                        () =>
                            harness.transaction((transaction) =>
                                harness.ledger.prepareWithAudit(
                                    transaction,
                                    invocation,
                                    audit,
                                    evidence
                                )
                            ),
                        /does not bind the PreparedInvocation|exact preparation AuditRecord/
                    );
                    expect(
                        harness.transaction((transaction) =>
                            harness.persistence.prepared(transaction, invocation.header.id)
                        )
                    ).toBeUndefined();
                }
            }
        );

        test(
            "[invocation.audit] binds a routed preparation to its exact persisted routeProjected AuditRecord",
            { tags: "p0" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = routedPrepared("audit-routed");
                const routed = auditRecord(
                    invocation.header.auditCause.value,
                    invocation.header.actor,
                    {
                        kind: "routeProjected",
                        projection: new RouteProjectionId("projection:audit-routed"),
                        reservation: new RouteReservationId("route:audit-routed")
                    }
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.prepareWithAudit(
                                transaction,
                                invocation,
                                routed,
                                evidence
                            )
                        ),
                    /exact preparation AuditRecord/
                );

                const forged = routedPrepared("audit-forged");
                const forgedAudit = auditRecord(
                    forged.header.auditCause.value,
                    forged.header.actor,
                    {
                        kind: "routeProjected",
                        projection: new RouteProjectionId("projection:audit-forged"),
                        reservation: new RouteReservationId("route:audit-forged")
                    }
                );
                const impostorEvidence = new ContractEvidence<Transaction>();
                impostorEvidence.seed(
                    auditRecord(
                        forged.header.auditCause.value,
                        forged.header.actor,
                        {
                            kind: "routeProjected",
                            projection: new RouteProjectionId("projection:audit-forged"),
                            reservation: new RouteReservationId("route:audit-forged")
                        },
                        undefined,
                        "tenant:contracT"
                    )
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.prepareWithAudit(
                                transaction,
                                forged,
                                forgedAudit,
                                impostorEvidence
                            )
                        ),
                    /exact preparation AuditRecord/
                );

                evidence.seed(routed);
                harness.transaction((transaction) =>
                    harness.ledger.prepareWithAudit(transaction, invocation, routed, evidence)
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.prepared(transaction, invocation.header.id)
                    )
                ).toBeDefined();
            }
        );

        test(
            "rejects Approval revisions that alter request or expiry identity",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared("approval-immutable");
                const pending = Approval.pending(
                    new ApprovalId("approval:immutable"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                });
                const approver = new PrincipalId("approver");
                const drifted = [
                    Approval.pending(
                        pending.id,
                        invocation.header.id,
                        invocation.intentDigest,
                        time(2),
                        time(20)
                    ).approve(approver, time(3)),
                    Approval.pending(
                        pending.id,
                        invocation.header.id,
                        invocation.intentDigest,
                        time(1),
                        time(30)
                    ).approve(approver, time(2)),
                    Approval.pending(
                        pending.id,
                        invocation.header.id,
                        invocation.intentDigest,
                        time(1)
                    ).approve(approver, time(2))
                ];
                for (const next of drifted) {
                    expectAgentCoreError(
                        () =>
                            harness.transaction((transaction) =>
                                harness.ledger.appendApprovalRevision(transaction, next)
                            ),
                        /next legal transition/
                    );
                }

                const openEnded = prepared("approval-immutable-open");
                const openPending = Approval.pending(
                    new ApprovalId("approval:immutable-open"),
                    openEnded.header.id,
                    openEnded.intentDigest,
                    time(1)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, openEnded);
                    harness.ledger.requestApproval(transaction, openPending);
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.appendApprovalRevision(
                                transaction,
                                Approval.pending(
                                    openPending.id,
                                    openEnded.header.id,
                                    openEnded.intentDigest,
                                    time(1),
                                    time(30)
                                ).approve(approver, time(2))
                            )
                        ),
                    /next legal transition/
                );
            }
        );

        test("appends denied and expired Approval revisions from pending", { tags: "p1" }, () => {
            const harness = open();
            const deniedInvocation = prepared("approval-denied");
            const deniedPending = Approval.pending(
                new ApprovalId("approval:denied"),
                deniedInvocation.header.id,
                deniedInvocation.intentDigest,
                time(1),
                time(20)
            );
            const expiredInvocation = prepared("approval-expired-revision");
            const expiredPending = Approval.pending(
                new ApprovalId("approval:expired-revision"),
                expiredInvocation.header.id,
                expiredInvocation.intentDigest,
                time(1),
                time(3)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, deniedInvocation);
                harness.ledger.requestApproval(transaction, deniedPending);
                harness.ledger.appendApprovalRevision(
                    transaction,
                    deniedPending.deny(new PrincipalId("approver"), time(2), "not allowed")
                );
                harness.ledger.prepare(transaction, expiredInvocation);
                harness.ledger.requestApproval(transaction, expiredPending);
                harness.ledger.appendApprovalRevision(transaction, expiredPending.expire(time(3)));
            });
            harness.transaction((transaction) => {
                expect(
                    harness.persistence.approval(transaction, deniedPending.id)?.state.kind
                ).toBe("denied");
                expect(
                    harness.persistence.approval(transaction, expiredPending.id)?.state.kind
                ).toBe("expired");
            });
        });

        test("returns each persisted Approval revision exactly", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("approval-revisions");
            const pending = Approval.pending(
                new ApprovalId("approval:revisions"),
                invocation.header.id,
                invocation.intentDigest,
                time(1),
                time(20)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.requestApproval(transaction, pending);
                harness.ledger.appendApprovalRevision(
                    transaction,
                    pending.approve(new PrincipalId("approver"), time(2))
                );
            });
            harness.transaction((transaction) => {
                expect(
                    harness.persistence.approvalRevision(transaction, pending.id, 0)?.state.kind
                ).toBe("pending");
                expect(
                    harness.persistence.approvalRevision(transaction, pending.id, 1)?.state.kind
                ).toBe("approved");
                expect(
                    harness.persistence.approvalRevision(transaction, pending.id, 2)
                ).toBeUndefined();
                expect(harness.persistence.approval(transaction, pending.id)?.revision.value).toBe(
                    1
                );
            });
        });

        test(
            "rejects a repeated attempt ordinal after the final failed Receipt",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("ordinal-repeat", { run: true }, { lease: "lease:1" });
                const claim0 = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:ordinal-repeat:0",
                    "worker:0",
                    time(10)
                );
                const attempt0 = effectAttempt(
                    invocation,
                    claim0,
                    "attempt:ordinal-repeat:0",
                    time(2)
                );
                const failed = new AttemptReceipt(
                    new ReceiptId("receipt:ordinal-repeat:failed"),
                    attempt0.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                const stale = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:ordinal-repeat:stale",
                    "worker:stale",
                    time(30)
                );
                const staleAttempt = effectAttempt(
                    invocation,
                    stale,
                    "attempt:ordinal-repeat:stale",
                    time(5)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim0, time(1));
                    harness.ledger.admitAttempt(transaction, attempt0, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, failed);
                    harness.persistence.appendClaim(transaction, stale);
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, staleAttempt, time(5))
                        ),
                    /final failed attempt ordinal/
                );
            }
        );

        test("rejects attempts that do not bind the live current claim", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("live-claim", [{ item: 0 }, { item: 1 }], {
                lease: "lease:1"
            });
            const claimA = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:live-claim:a",
                "worker:a",
                time(10)
            );
            const claimB = executorClaim(
                invocation.header.id,
                1,
                0,
                "claim:live-claim:b",
                "worker:b",
                time(10)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.claimItem(transaction, claimA, time(1));
                harness.ledger.claimItem(transaction, claimB, time(1));
            });
            const attempts = [
                new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:live-claim:ghost"),
                    invocation.header.id,
                    0,
                    0,
                    new ItemClaimId("claim:live-claim:ghost"),
                    "lease:1",
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:live-claim:ghost")
                ),
                new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:live-claim:cross"),
                    invocation.header.id,
                    0,
                    0,
                    claimB.id,
                    "lease:1",
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:live-claim:cross")
                ),
                new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:live-claim:ordinal"),
                    invocation.header.id,
                    0,
                    1,
                    claimA.id,
                    "lease:1",
                    admissionFor(invocation.header.id.value, 0, 1),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:live-claim:ordinal")
                )
            ];
            for (const attempt of attempts) {
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, attempt, time(2))
                        ),
                    /live current claim/
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, attempt.id)
                    )
                ).toBeUndefined();
            }
        });

        test("rejects executor-claimed attempts on a lease-free invocation", { tags: "p2" }, () => {
            const harness = open();
            const invocation = prepared("lease-free-token");
            const claim = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:lease-free-token",
                "worker:lease-free-token",
                time(10)
            );
            const attempt = effectAttempt(invocation, claim, "attempt:lease-free-token", time(2));
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.persistence.appendClaim(transaction, claim);
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttempt(transaction, attempt, time(2))
                    ),
                /token does not match its executor claim/
            );
        });

        test(
            "rejects attempts when a continuation exists without its Approval",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared("continuation-orphan", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:continuation-orphan",
                    "worker:continuation-orphan",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:continuation-orphan",
                    time(2)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.persistence.insertContinuation(
                        transaction,
                        new InvocationContinuation<string>(
                            invocation.header.id,
                            invocation.intentDigest,
                            new ApprovalId("approval:continuation-orphan"),
                            new EffectAttemptId("attempt:continuation-orphan-first"),
                            0,
                            0,
                            new ItemClaimId("claim:continuation-orphan-first"),
                            {
                                kind: "executor",
                                token: "lease:1",
                                worker: new ClaimWorkerId("worker:continuation-orphan-first")
                            },
                            invocation.item(0).idempotencyKey,
                            time(1)
                        )
                    );
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, attempt, time(2))
                        ),
                    /InvocationContinuation requires its exact Approval/
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, attempt.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "rejects an Approval that does not bind the prepared intent digest",
            { tags: "p2" },
            () => {
                const harness = open();
                const invocation = prepared("approval-digest", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:approval-digest",
                    "worker:approval-digest",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:approval-digest",
                    time(2)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.persistence.appendApproval(
                        transaction,
                        Approval.pending(
                            new ApprovalId("approval:approval-digest"),
                            invocation.header.id,
                            digest("foreign-intent"),
                            time(1),
                            time(20)
                        )
                    );
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, attempt, time(2))
                        ),
                    /Approval does not bind the PreparedInvocation/
                );
            }
        );

        test(
            "rejects approved admission when a continuation already exists",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared(
                    "approved-continuation",
                    {},
                    { lease: "lease:1", approvalRequired: true }
                );
                const pending = Approval.pending(
                    new ApprovalId("approval:approved-continuation"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:approved-continuation",
                    "worker:approved-continuation",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:approved-continuation",
                    time(3)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(
                        transaction,
                        pending.approve(new PrincipalId("approver"), time(2))
                    );
                    harness.persistence.insertContinuation(
                        transaction,
                        new InvocationContinuation<string>(
                            invocation.header.id,
                            invocation.intentDigest,
                            pending.id,
                            new EffectAttemptId("attempt:approved-continuation-prior"),
                            0,
                            0,
                            new ItemClaimId("claim:approved-continuation-prior"),
                            {
                                kind: "executor",
                                token: "lease:1",
                                worker: new ClaimWorkerId("worker:approved-continuation-prior")
                            },
                            invocation.item(0).idempotencyKey,
                            time(2)
                        )
                    );
                    harness.ledger.claimItem(transaction, claim, time(2));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, attempt, time(3))
                        ),
                    /cannot already have a continuation/
                );
            }
        );

        test("consumes an Approval without an expiry deadline", { tags: "p0" }, () => {
            const harness = open();
            const invocation = prepared(
                "approval-open-ended",
                {},
                { lease: "lease:1", approvalRequired: true }
            );
            const pending = Approval.pending(
                new ApprovalId("approval:open-ended"),
                invocation.header.id,
                invocation.intentDigest,
                time(1)
            );
            const claim = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:approval-open-ended",
                "worker:approval-open-ended",
                time(10)
            );
            const attempt = effectAttempt(
                invocation,
                claim,
                "attempt:approval-open-ended",
                time(3)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.requestApproval(transaction, pending);
                harness.ledger.appendApprovalRevision(
                    transaction,
                    pending.approve(new PrincipalId("approver"), time(2))
                );
                harness.ledger.claimItem(transaction, claim, time(2));
                expect(harness.ledger.admitAttempt(transaction, attempt, time(3))?.state.kind).toBe(
                    "consumed"
                );
            });
        });

        test(
            "[invocation.audit] records an authority denial with bound receipt, audit, and publication",
            { tags: "p0" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = prepared("denial-audit", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1"
                });
                const root = preparationAudit(invocation);
                const deniedClaim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:denial-audit:denied",
                    "worker:denied",
                    time(10)
                );
                const deniedAttempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:denial-audit:denied"),
                    invocation.header.id,
                    0,
                    0,
                    deniedClaim.id,
                    "lease:1",
                    admissionFor("substituted", 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    root.id
                );
                const deniedAttemptAudit = auditRecord(
                    "audit:denial-audit:denied-attempt",
                    invocation.header.actor,
                    { kind: "attempt", id: deniedAttempt.id },
                    root.id
                );
                const receipt = new PreEffectReceipt(
                    new ReceiptId("receipt:denial-audit"),
                    invocation.header.id,
                    0,
                    "deniedPreEffect",
                    time(3),
                    "authority denied"
                );
                const denialAudit = auditRecord(
                    "audit:denial-audit:receipt",
                    invocation.header.actor,
                    { kind: "receipt", id: receipt.id, outcome: "deniedPreEffect" },
                    root.id
                );
                const publication = InvocationPublicationOutbox.pending({
                    invocation: invocation.header.id,
                    receipt: receipt.id,
                    audit: denialAudit.id
                });
                harness.transaction((transaction) => {
                    harness.ledger.prepareWithAudit(transaction, invocation, root, evidence);
                    harness.ledger.claimItem(transaction, deniedClaim, time(1));
                });
                expect(
                    harness.transaction((transaction) =>
                        harness.ledger.admitAttemptOrRecordAuthorityDenialWithAudit(
                            transaction,
                            deniedAttempt,
                            time(3),
                            deniedAttemptAudit,
                            { claim: deniedClaim, receipt, audit: denialAudit, publication },
                            evidence
                        )
                    )
                ).toBe(false);
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.attempt(transaction, deniedAttempt.id)
                    ).toBeUndefined();
                    expect(
                        harness.ledger.currentReceipt(transaction, invocation.header.id, 0)?.id
                            .value
                    ).toBe(receipt.id.value);
                    expect(evidence.audit(transaction, denialAudit.id)).toBeDefined();
                    expect(evidence.audit(transaction, deniedAttemptAudit.id)).toBeUndefined();
                    expect(evidence.publication(transaction, publication.id)?.state.kind).toBe(
                        "pending"
                    );
                });

                const admittedClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:denial-audit:admitted",
                    "worker:admitted",
                    time(10)
                );
                const admittedAttempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:denial-audit:admitted"),
                    invocation.header.id,
                    1,
                    0,
                    admittedClaim.id,
                    "lease:1",
                    admissionFor(invocation.header.id.value, 1, 0),
                    time(4),
                    invocation.item(1).idempotencyKey,
                    root.id
                );
                const admittedAudit = auditRecord(
                    "audit:denial-audit:admitted-attempt",
                    invocation.header.actor,
                    { kind: "attempt", id: admittedAttempt.id },
                    root.id
                );
                const unusedReceipt = new PreEffectReceipt(
                    new ReceiptId("receipt:denial-audit:unused"),
                    invocation.header.id,
                    1,
                    "deniedPreEffect",
                    time(4),
                    "unused"
                );
                const unusedAudit = auditRecord(
                    "audit:denial-audit:unused",
                    invocation.header.actor,
                    { kind: "receipt", id: unusedReceipt.id, outcome: "deniedPreEffect" },
                    root.id
                );
                harness.transaction((transaction) => {
                    harness.ledger.claimItem(transaction, admittedClaim, time(3));
                    expect(
                        harness.ledger.admitAttemptOrRecordAuthorityDenialWithAudit(
                            transaction,
                            admittedAttempt,
                            time(4),
                            admittedAudit,
                            {
                                claim: admittedClaim,
                                receipt: unusedReceipt,
                                audit: unusedAudit,
                                publication: InvocationPublicationOutbox.pending({
                                    invocation: invocation.header.id,
                                    receipt: unusedReceipt.id,
                                    audit: unusedAudit.id
                                })
                            },
                            evidence
                        )
                    ).toBe(true);
                });
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.attempt(transaction, admittedAttempt.id)
                    ).toBeDefined();
                    expect(evidence.audit(transaction, admittedAudit.id)).toBeDefined();
                    expect(evidence.audit(transaction, unusedAudit.id)).toBeUndefined();
                });
            }
        );

        test(
            "rejects authority denial evidence that does not bind the claimed item",
            { tags: "p2" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = prepared("denial-guards", [{ item: 0 }, { item: 1 }], {
                    lease: "lease:1"
                });
                const root = preparationAudit(invocation);
                const claimA = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:denial-guards:a",
                    "worker:a",
                    time(10)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepareWithAudit(transaction, invocation, root, evidence);
                    harness.ledger.claimItem(transaction, claimA, time(1));
                });
                const parts = (
                    suffix: string,
                    itemIndex: number,
                    outcome: "deniedPreEffect" | "cancelledPreEffect" = "deniedPreEffect"
                ) => {
                    const receipt = new PreEffectReceipt(
                        new ReceiptId(`receipt:denial-guards:${suffix}`),
                        invocation.header.id,
                        itemIndex,
                        outcome,
                        time(3),
                        "denied"
                    );
                    const audit = auditRecord(
                        `audit:denial-guards:${suffix}`,
                        invocation.header.actor,
                        { kind: "receipt", id: receipt.id, outcome },
                        root.id
                    );
                    const publication = InvocationPublicationOutbox.pending({
                        invocation: invocation.header.id,
                        receipt: receipt.id,
                        audit: audit.id
                    });
                    return { receipt, audit, publication };
                };
                const record = (
                    claim: ItemClaim<string>,
                    denial: ReturnType<typeof parts>
                ): void => {
                    harness.transaction((transaction) =>
                        harness.ledger.recordClaimedAuthorityDenialWithAudit(
                            transaction,
                            claim,
                            denial.receipt,
                            denial.audit,
                            denial.publication,
                            evidence
                        )
                    );
                };

                const unclaimed = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:denial-guards:unclaimed",
                    "worker:unclaimed",
                    time(10)
                );
                expectAgentCoreError(
                    () => record(unclaimed, parts("unclaimed", 1)),
                    /does not bind the current claimed item/
                );
                const other = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:denial-guards:other",
                    "worker:other",
                    time(10)
                );
                expectAgentCoreError(
                    () => record(other, parts("other", 0)),
                    /does not bind the current claimed item/
                );
                expectAgentCoreError(
                    () => record(claimA, parts("cancelled", 0, "cancelledPreEffect")),
                    /does not bind the current claimed item/
                );
                expectAgentCoreError(
                    () => record(claimA, parts("cross", 1)),
                    /does not bind the current claimed item/
                );
                const published = parts("published", 0);
                expectAgentCoreError(
                    () =>
                        record(claimA, {
                            ...published,
                            publication: published.publication
                                .eventPublished(time(4))
                                .commitAppended(time(4))
                        }),
                    /does not bind the current claimed item/
                );

                record(claimA, parts("recorded", 0));
                const retry = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:denial-guards:retry",
                    "worker:retry",
                    time(10)
                );
                harness.transaction((transaction) =>
                    harness.persistence.appendClaim(transaction, retry)
                );
                expectAgentCoreError(
                    () => record(retry, parts("repeat", 0)),
                    /does not bind the current claimed item/
                );
            }
        );

        test(
            "[invocation.audit] records an attempt receipt with bound audit and publication",
            { tags: "p0" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const setup = auditedAttempt(harness, evidence, "receipt-audit");
                const receipt = new AttemptReceipt(
                    new ReceiptId("receipt:receipt-audit"),
                    setup.attempt.id,
                    "succeeded",
                    undefined,
                    time(3),
                    content("receipt-audit")
                );
                const receiptAudit = auditRecord(
                    "audit:receipt-audit:receipt",
                    setup.invocation.header.actor,
                    { kind: "receipt", id: receipt.id, outcome: "succeeded" },
                    setup.attemptAudit.id
                );
                const publication = InvocationPublicationOutbox.pending({
                    invocation: setup.invocation.header.id,
                    receipt: receipt.id,
                    audit: receiptAudit.id
                });
                harness.transaction((transaction) =>
                    harness.ledger.recordAttemptReceiptWithAudit(
                        transaction,
                        receipt,
                        setup.attemptAudit,
                        receiptAudit,
                        publication,
                        evidence
                    )
                );
                harness.transaction((transaction) => {
                    expect(
                        harness.ledger.currentReceipt(transaction, setup.invocation.header.id, 0)
                            ?.id.value
                    ).toBe(receipt.id.value);
                    expect(evidence.audit(transaction, receiptAudit.id)).toBeDefined();
                    expect(evidence.publication(transaction, publication.id)?.state.kind).toBe(
                        "pending"
                    );
                });
            }
        );

        test(
            "rejects attempt receipt audits that do not bind the attempted effect",
            { tags: "p2" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const setup = auditedAttempt(harness, evidence, "receipt-guards");
                const actor = setup.invocation.header.actor;
                const record = (
                    receipt: AttemptReceipt,
                    attemptAudit: AuditRecord,
                    publication: InvocationPublicationOutbox
                ): void => {
                    const receiptAudit = auditRecord(
                        `audit:receipt-guards:${receipt.id.value}`,
                        actor,
                        { kind: "receipt", id: receipt.id, outcome: receipt.outcome },
                        attemptAudit.id
                    );
                    harness.transaction((transaction) =>
                        harness.ledger.recordAttemptReceiptWithAudit(
                            transaction,
                            receipt,
                            attemptAudit,
                            receiptAudit,
                            publication,
                            evidence
                        )
                    );
                };
                const receiptFor = (suffix: string, attempt: EffectAttemptId): AttemptReceipt =>
                    new AttemptReceipt(
                        new ReceiptId(`receipt:receipt-guards:${suffix}`),
                        attempt,
                        "failed",
                        undefined,
                        time(3),
                        undefined
                    );
                const publicationFor = (receipt: AttemptReceipt): InvocationPublicationOutbox =>
                    InvocationPublicationOutbox.pending({
                        invocation: setup.invocation.header.id,
                        receipt: receipt.id,
                        audit: new AuditRecordId(`audit:receipt-guards:${receipt.id.value}`)
                    });

                const ghost = receiptFor("ghost", new EffectAttemptId("attempt:receipt-ghost"));
                expectAgentCoreError(
                    () => record(ghost, setup.attemptAudit, publicationFor(ghost)),
                    /does not bind the attempted effect/
                );

                const unpersisted = auditRecord(
                    "audit:receipt-guards:unpersisted",
                    actor,
                    { kind: "attempt", id: setup.attempt.id },
                    setup.root.id
                );
                const unpersistedReceipt = receiptFor("unpersisted", setup.attempt.id);
                expectAgentCoreError(
                    () =>
                        record(unpersistedReceipt, unpersisted, publicationFor(unpersistedReceipt)),
                    /does not bind the attempted effect/
                );

                const forged = auditRecord(
                    setup.attemptAudit.id.value,
                    actor,
                    { kind: "attempt", id: setup.attempt.id },
                    setup.root.id,
                    "tenant:contracT"
                );
                const forgedReceipt = receiptFor("forged", setup.attempt.id);
                expectAgentCoreError(
                    () => record(forgedReceipt, forged, publicationFor(forgedReceipt)),
                    /does not bind the attempted effect/
                );

                const publishedReceipt = receiptFor("published", setup.attempt.id);
                expectAgentCoreError(
                    () =>
                        record(
                            publishedReceipt,
                            setup.attemptAudit,
                            publicationFor(publishedReceipt)
                                .eventPublished(time(4))
                                .commitAppended(time(4))
                        ),
                    /does not bind the attempted effect/
                );
            }
        );

        test(
            "[invocation.audit] supersedes an indeterminate receipt with bound supersession evidence",
            { tags: "p0" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const setup = auditedAttempt(harness, evidence, "supersession-audit");
                const actor = setup.invocation.header.actor;
                const indeterminate = new AttemptReceipt(
                    new ReceiptId("receipt:supersession-audit:indeterminate"),
                    setup.attempt.id,
                    "indeterminate",
                    undefined,
                    time(3),
                    undefined
                );
                const indeterminateAudit = auditRecord(
                    "audit:supersession-audit:indeterminate",
                    actor,
                    { kind: "receipt", id: indeterminate.id, outcome: "indeterminate" },
                    setup.attemptAudit.id
                );
                harness.transaction((transaction) =>
                    harness.ledger.recordAttemptReceiptWithAudit(
                        transaction,
                        indeterminate,
                        setup.attemptAudit,
                        indeterminateAudit,
                        InvocationPublicationOutbox.pending({
                            invocation: setup.invocation.header.id,
                            receipt: indeterminate.id,
                            audit: indeterminateAudit.id
                        }),
                        evidence
                    )
                );

                const final = new AttemptReceipt(
                    new ReceiptId("receipt:supersession-audit:final"),
                    setup.attempt.id,
                    "failed",
                    indeterminate.id,
                    time(4),
                    undefined
                );
                const supersessionAudit = auditRecord(
                    "audit:supersession-audit:superseded",
                    actor,
                    {
                        kind: "receiptSuperseded",
                        previous: indeterminate.id,
                        next: final.id
                    },
                    indeterminateAudit.id
                );
                const finalReceiptAudit = auditRecord(
                    "audit:supersession-audit:final",
                    actor,
                    { kind: "receipt", id: final.id, outcome: "failed" },
                    setup.attemptAudit.id
                );
                const publication = InvocationPublicationOutbox.pending({
                    invocation: setup.invocation.header.id,
                    receipt: final.id,
                    audit: supersessionAudit.id
                });

                const ghost = new AttemptReceipt(
                    new ReceiptId("receipt:supersession-audit:ghost"),
                    new EffectAttemptId("attempt:supersession-ghost"),
                    "failed",
                    indeterminate.id,
                    time(4),
                    undefined
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.supersedeReceiptWithAudit(
                                transaction,
                                ghost,
                                {
                                    finalReceiptAudit,
                                    supersessionAudit,
                                    publication: InvocationPublicationOutbox.pending({
                                        invocation: setup.invocation.header.id,
                                        receipt: ghost.id,
                                        audit: supersessionAudit.id
                                    })
                                },
                                evidence
                            )
                        ),
                    /supersession evidence does not bind the attempted effect/
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.supersedeReceiptWithAudit(
                                transaction,
                                final,
                                {
                                    finalReceiptAudit,
                                    supersessionAudit,
                                    publication: publication
                                        .eventPublished(time(5))
                                        .commitAppended(time(5))
                                },
                                evidence
                            )
                        ),
                    /supersession evidence does not bind the attempted effect/
                );

                harness.transaction((transaction) =>
                    harness.ledger.supersedeReceiptWithAudit(
                        transaction,
                        final,
                        { finalReceiptAudit, supersessionAudit, publication },
                        evidence
                    )
                );
                harness.transaction((transaction) => {
                    expect(
                        harness.ledger.currentReceipt(transaction, setup.invocation.header.id, 0)
                    ).toMatchObject({ outcome: "failed", previous: indeterminate.id });
                    expect(evidence.audit(transaction, supersessionAudit.id)).toBeDefined();
                    expect(evidence.audit(transaction, finalReceiptAudit.id)).toBeDefined();
                    expect(evidence.publication(transaction, publication.id)?.state.kind).toBe(
                        "pending"
                    );
                });
            }
        );

        test(
            "rejects consumed-Approval continuations with tampered first-attempt identity",
            { tags: "p1" },
            () => {
                const admitAfterContinuation = (
                    invocation: PreparedInvocation<string, string, string, string>,
                    state: {
                        readonly firstClaim?: ItemClaim<string>;
                        readonly firstAttempt: EffectAttempt<string, string>;
                        readonly persistFirstAttempt?: false;
                        readonly continuation: InvocationContinuation<string>;
                        readonly secondItemIndex: number;
                    }
                ): (() => void) => {
                    const harness = open();
                    const id = invocation.header.id.value;
                    const pending = Approval.pending(
                        new ApprovalId(`approval:${id}`),
                        invocation.header.id,
                        invocation.intentDigest,
                        time(1),
                        time(20)
                    );
                    const approved = pending.approve(new PrincipalId("approver"), time(2));
                    const secondClaim = executorClaim(
                        invocation.header.id,
                        state.secondItemIndex,
                        0,
                        `claim:${id}:second`,
                        "worker:second",
                        time(10)
                    );
                    const secondAttempt = effectAttempt(
                        invocation,
                        secondClaim,
                        `attempt:${id}:second`,
                        time(4)
                    );
                    harness.transaction((transaction) => {
                        harness.ledger.prepare(transaction, invocation);
                        harness.persistence.appendApproval(transaction, pending);
                        harness.persistence.appendApproval(transaction, approved);
                        harness.persistence.appendApproval(
                            transaction,
                            approved.consume(state.firstAttempt.id, time(3))
                        );
                        if (state.firstClaim !== undefined) {
                            harness.persistence.appendClaim(transaction, state.firstClaim);
                        }
                        if (state.persistFirstAttempt !== false) {
                            harness.persistence.appendAttempt(transaction, state.firstAttempt);
                        }
                        harness.persistence.insertContinuation(transaction, state.continuation);
                        harness.ledger.claimItem(transaction, secondClaim, time(3));
                    });
                    return () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                        );
                };
                const firstAttemptFor = (
                    invocation: PreparedInvocation<string, string, string, string>,
                    claim: ItemClaim<string>,
                    overrides: {
                        readonly itemIndex?: number;
                        readonly ordinal?: number;
                        readonly key?: string;
                        readonly claimId?: ItemClaimId;
                    } = {}
                ): EffectAttempt<string, string> => {
                    const itemIndex = overrides.itemIndex ?? claim.itemIndex;
                    const ordinal = overrides.ordinal ?? 0;
                    return new EffectAttempt<string, string>(
                        new EffectAttemptId(`attempt:${invocation.header.id.value}:first`),
                        invocation.header.id,
                        itemIndex,
                        ordinal,
                        overrides.claimId ?? claim.id,
                        "lease:1",
                        admissionFor(invocation.header.id.value, itemIndex, ordinal),
                        time(2),
                        overrides.key ?? invocation.item(itemIndex).idempotencyKey,
                        new AuditRecordId(`audit:${invocation.header.id.value}:first`)
                    );
                };
                const continuationFor = (
                    invocation: PreparedInvocation<string, string, string, string>,
                    attempt: EffectAttempt<string, string>,
                    claim: ItemClaim<string>,
                    overrides: {
                        readonly firstItemIndex?: number;
                        readonly firstOrdinal?: number;
                        readonly firstClaim?: ItemClaimId;
                        readonly owner?: ItemClaim<string>["owner"];
                        readonly firstItemKey?: string;
                    } = {}
                ): InvocationContinuation<string> =>
                    new InvocationContinuation<string>(
                        invocation.header.id,
                        invocation.intentDigest,
                        new ApprovalId(`approval:${invocation.header.id.value}`),
                        attempt.id,
                        overrides.firstItemIndex ?? attempt.itemIndex,
                        overrides.firstOrdinal ?? attempt.ordinal,
                        overrides.firstClaim ?? claim.id,
                        overrides.owner ?? claim.owner,
                        overrides.firstItemKey ?? attempt.idempotencyKey,
                        time(3)
                    );
                const twoItems = [{ item: 0 }, { item: 1 }] as const;

                {
                    const invocation = prepared("continuation-missing-attempt", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim);
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            persistFirstAttempt: false,
                            continuation: continuationFor(invocation, attempt, claim),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-ghost-claim", twoItems, {
                        lease: "lease:1"
                    });
                    const ghost = new ItemClaimId(`claim:${invocation.header.id.value}:ghost`);
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, { claimId: ghost });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                firstClaim: ghost
                            }),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared(
                        "continuation-item-forged",
                        [{ item: 0 }, { item: 1 }, { item: 2 }],
                        { lease: "lease:1" }
                    );
                    const claim = executorClaim(
                        invocation.header.id,
                        1,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, {
                        itemIndex: 0,
                        key: invocation.item(1).idempotencyKey
                    });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                firstItemIndex: 1
                            }),
                            secondItemIndex: 2
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-ordinal-forged", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        1,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, { ordinal: 0 });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                firstOrdinal: 1
                            }),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-claim-ordinal", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        1,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, { ordinal: 0 });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-key-forged", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, { key: "forged-key" });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                firstItemKey: invocation.item(0).idempotencyKey
                            }),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-key-both", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim, { key: "forged-key" });
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-owner-worker", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim);
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                owner: {
                                    kind: "executor",
                                    token: "lease:1",
                                    worker: new ClaimWorkerId("worker:forged")
                                }
                            }),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
                {
                    const invocation = prepared("continuation-owner-kind", twoItems, {
                        lease: "lease:1"
                    });
                    const claim = executorClaim(
                        invocation.header.id,
                        0,
                        0,
                        `claim:${invocation.header.id.value}:first`,
                        "worker:first",
                        time(10)
                    );
                    const attempt = firstAttemptFor(invocation, claim);
                    expectAgentCoreError(
                        admitAfterContinuation(invocation, {
                            firstClaim: claim,
                            firstAttempt: attempt,
                            continuation: continuationFor(invocation, attempt, claim, {
                                owner: {
                                    kind: "system",
                                    actor: invocation.header.actor,
                                    worker: new ClaimWorkerId("worker:first")
                                }
                            }),
                            secondItemIndex: 1
                        }),
                        /first EffectAttempt identity is invalid/
                    );
                }
            }
        );

        test("continues a consumed Approval with system-owned claims", { tags: "p0" }, () => {
            const harness = open();
            const invocation = prepared("system-continuation", [{ item: 0 }, { item: 1 }], {
                approvalRequired: true
            });
            const pending = Approval.pending(
                new ApprovalId("approval:system-continuation"),
                invocation.header.id,
                invocation.intentDigest,
                time(1),
                time(20)
            );
            const claim0 = systemClaim(
                invocation,
                0,
                0,
                "claim:system-continuation:0",
                "worker:system-continuation:0",
                time(10)
            );
            const attempt0 = systemAttempt(
                invocation,
                claim0,
                "attempt:system-continuation:0",
                time(3)
            );
            const claim1 = systemClaim(
                invocation,
                1,
                0,
                "claim:system-continuation:1",
                "worker:system-continuation:1",
                time(10)
            );
            const attempt1 = systemAttempt(
                invocation,
                claim1,
                "attempt:system-continuation:1",
                time(4)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.requestApproval(transaction, pending);
                harness.ledger.appendApprovalRevision(
                    transaction,
                    pending.approve(new PrincipalId("approver"), time(2))
                );
                harness.ledger.claimItem(transaction, claim0, time(2));
                expect(
                    harness.ledger.admitAttempt(transaction, attempt0, time(3))?.state.kind
                ).toBe("consumed");
                harness.ledger.claimItem(transaction, claim1, time(3));
                expect(harness.ledger.admitAttempt(transaction, attempt1, time(4))).toBeUndefined();
            });
        });

        test("recovers an expired system claim under a new worker", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("system-recovery");
            const first = systemClaim(
                invocation,
                0,
                0,
                "claim:system-recovery:first",
                "worker:system-recovery:first",
                time(3)
            );
            const replacement = systemClaim(
                invocation,
                0,
                0,
                "claim:system-recovery:second",
                "worker:system-recovery:second",
                time(10)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.claimItem(transaction, first, time(1));
            });
            harness.transaction((transaction) =>
                harness.ledger.recoverClaim(transaction, first.id, replacement, time(3))
            );
            expect(
                harness.transaction(
                    (transaction) =>
                        harness.persistence.claim(transaction, replacement.id)?.owner.kind
                )
            ).toBe("system");
        });

        test("rejects recovery that moves a claim to another item", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("recovery-item", [{ item: 0 }, { item: 1 }], {
                lease: "lease:1"
            });
            const first = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:recovery-item:first",
                "worker:first",
                time(3)
            );
            const moved = executorClaim(
                invocation.header.id,
                1,
                0,
                "claim:recovery-item:moved",
                "worker:moved",
                time(10)
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.claimItem(transaction, first, time(1));
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(transaction, first.id, moved, time(3))
                    ),
                /immutable scheduling identity/
            );
            expect(
                harness.transaction((transaction) =>
                    harness.persistence.claim(transaction, moved.id)
                )
            ).toBeUndefined();
        });

        test("rejects recovery of an unknown claim", { tags: "p2" }, () => {
            const harness = open();
            const invocation = prepared("recovery-unknown", {}, { lease: "lease:1" });
            const replacement = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:recovery-unknown",
                "worker:recovery-unknown",
                time(10)
            );
            harness.transaction((transaction) => harness.ledger.prepare(transaction, invocation));
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) =>
                        harness.ledger.recoverClaim(
                            transaction,
                            new ItemClaimId("claim:recovery-unknown-previous"),
                            replacement,
                            time(5)
                        )
                    ),
                /exact current no-attempt claim/
            );
        });

        test("rejects a pre-effect Receipt once the item has a receipt", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("pre-effect-receipted");
            const first = new PreEffectReceipt(
                new ReceiptId("receipt:pre-effect-receipted:first"),
                invocation.header.id,
                0,
                "deniedPreEffect",
                time(2),
                "denied"
            );
            const second = new PreEffectReceipt(
                new ReceiptId("receipt:pre-effect-receipted:second"),
                invocation.header.id,
                0,
                "cancelledPreEffect",
                time(3),
                "cancelled"
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.recordPreEffect(transaction, first);
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) =>
                        harness.ledger.recordPreEffect(transaction, second)
                    ),
                /untouched item/
            );
        });

        test("refuses retries once the attempt ordinal space is exhausted", { tags: "p1" }, () => {
            const harness = open();
            const invocation = prepared("ordinal-exhausted", {}, { lease: "lease:1" });
            const claim = executorClaim(
                invocation.header.id,
                0,
                Number.MAX_SAFE_INTEGER,
                "claim:ordinal-exhausted",
                "worker:ordinal-exhausted",
                time(10)
            );
            const attempt = effectAttempt(invocation, claim, "attempt:ordinal-exhausted", time(2));
            const failed = new AttemptReceipt(
                new ReceiptId("receipt:ordinal-exhausted"),
                attempt.id,
                "failed",
                undefined,
                time(3),
                undefined
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.persistence.appendClaim(transaction, claim);
                harness.persistence.appendAttempt(transaction, attempt);
                harness.ledger.recordAttemptReceipt(transaction, failed);
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) =>
                        harness.ledger.claimItem(
                            transaction,
                            executorClaim(
                                invocation.header.id,
                                0,
                                0,
                                "claim:ordinal-exhausted:next",
                                "worker:next",
                                time(20)
                            ),
                            time(5)
                        )
                    ),
                /unavailable or ordinal is exhausted/
            );
        });

        test("rejects illegal receipt supersessions", { tags: "p2" }, () => {
            const harness = open();
            const invocation = prepared("supersession-guards", [{ item: 0 }, { item: 1 }], {
                lease: "lease:1"
            });
            const claim0 = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:supersession-guards:0",
                "worker:0",
                time(10)
            );
            const claim1 = executorClaim(
                invocation.header.id,
                1,
                0,
                "claim:supersession-guards:1",
                "worker:1",
                time(10)
            );
            const attempt0 = effectAttempt(
                invocation,
                claim0,
                "attempt:supersession-guards:0",
                time(2)
            );
            const attempt1 = effectAttempt(
                invocation,
                claim1,
                "attempt:supersession-guards:1",
                time(2)
            );
            const indeterminate = new AttemptReceipt(
                new ReceiptId("receipt:supersession-guards:indeterminate"),
                attempt0.id,
                "indeterminate",
                undefined,
                time(3),
                undefined
            );
            const failed = new AttemptReceipt(
                new ReceiptId("receipt:supersession-guards:failed"),
                attempt1.id,
                "failed",
                undefined,
                time(3),
                undefined
            );
            harness.transaction((transaction) => {
                harness.ledger.prepare(transaction, invocation);
                harness.ledger.claimItem(transaction, claim0, time(1));
                harness.ledger.claimItem(transaction, claim1, time(1));
                harness.ledger.admitAttempt(transaction, attempt0, time(2));
                harness.ledger.admitAttempt(transaction, attempt1, time(2));
                harness.ledger.recordAttemptReceipt(transaction, indeterminate);
                harness.ledger.recordAttemptReceipt(transaction, failed);
            });
            const illegal = [
                new AttemptReceipt(
                    new ReceiptId("receipt:supersession-guards:no-previous"),
                    attempt0.id,
                    "failed",
                    undefined,
                    time(4),
                    undefined
                ),
                new AttemptReceipt(
                    new ReceiptId("receipt:supersession-guards:nonindeterminate"),
                    attempt1.id,
                    "succeeded",
                    failed.id,
                    time(4),
                    content("supersession-guards")
                ),
                new AttemptReceipt(
                    new ReceiptId("receipt:supersession-guards:still-indeterminate"),
                    attempt0.id,
                    "indeterminate",
                    indeterminate.id,
                    time(4),
                    undefined
                )
            ];
            for (const receipt of illegal) {
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.supersedeReceipt(transaction, receipt)
                        ),
                    /current indeterminate Receipt may be superseded once/
                );
            }
        });

        test("names the invocation transition time in invalid time errors", { tags: "p2" }, () => {
            const harness = open();
            const invocation = prepared("invalid-time", {}, { lease: "lease:1" });
            const claim = executorClaim(
                invocation.header.id,
                0,
                0,
                "claim:invalid-time",
                "worker:invalid-time",
                time(10)
            );
            harness.transaction((transaction) => harness.ledger.prepare(transaction, invocation));
            expect(() =>
                harness.transaction((transaction) =>
                    harness.ledger.claimItem(transaction, claim, new Date(Number.NaN))
                )
            ).toThrow(/Invocation transition time must be a valid Date/);
        });

        test(
            "[invocation.audit] validates persisted audit relations through ledger evidence",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = prepared("audit-relations", {}, { lease: "lease:1" });
                const root = preparationAudit(invocation);
                const actor = invocation.header.actor;
                const pending = Approval.pending(
                    new ApprovalId("approval:audit-relations"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepareWithAudit(transaction, invocation, root, evidence);
                    harness.ledger.requestApproval(transaction, pending);
                    harness.ledger.appendApprovalRevision(
                        transaction,
                        pending.approve(new PrincipalId("approver"), time(2))
                    );
                });

                harness.transaction((transaction) =>
                    harness.ledger.requirePersistedAuditRelation(
                        transaction,
                        auditRecord(
                            "audit:relations:approved",
                            actor,
                            { kind: "approval", id: pending.id, phase: "approved" },
                            root.id
                        ),
                        evidence
                    )
                );

                const rejected: readonly AuditRecord[] = [
                    auditRecord(
                        "audit:relations:pending",
                        actor,
                        { kind: "approval", id: pending.id, phase: "pending" },
                        root.id
                    ),
                    auditRecord(
                        "audit:relations:ghost-approval",
                        actor,
                        {
                            kind: "approval",
                            id: new ApprovalId("approval:relations-ghost"),
                            phase: "approved"
                        },
                        root.id
                    ),
                    auditRecord(
                        "audit:relations:ghost-attempt",
                        actor,
                        { kind: "attempt", id: new EffectAttemptId("attempt:relations-ghost") },
                        root.id
                    )
                ];
                for (const audit of rejected) {
                    expectAgentCoreError(
                        () =>
                            harness.transaction((transaction) =>
                                harness.ledger.requirePersistedAuditRelation(
                                    transaction,
                                    audit,
                                    evidence
                                )
                            ),
                        /is not permitted/
                    );
                }
            }
        );

        test(
            "[invocation.audit] refuses a routeProjected AuditRecord for an unrouted preparation",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = prepared("audit-local-routed");
                const projected = auditRecord(
                    invocation.header.auditCause.value,
                    invocation.header.actor,
                    {
                        kind: "routeProjected",
                        projection: new RouteProjectionId("projection:audit-local-routed"),
                        reservation: new RouteReservationId("route:audit-local-routed")
                    }
                );
                evidence.seed(projected);
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.requirePreparedAudit(
                                transaction,
                                invocation,
                                projected,
                                evidence
                            )
                        ),
                    /Preparation AuditRecord does not bind the PreparedInvocation/
                );
            }
        );

        test(
            "[invocation.audit] refuses a caused preparation AuditRecord that otherwise binds",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const invocation = routedPrepared("audit-caused-root");
                const projection = new RouteProjectionId("projection:audit-caused-root");
                const reservation = new RouteReservationId("route:audit-caused-root");
                const caused = auditRecord(
                    invocation.header.auditCause.value,
                    invocation.header.actor,
                    { kind: "routeProjected", projection, reservation },
                    new AuditRecordId("audit:audit-caused-root:cause")
                );
                evidence.seed(caused);
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.requirePreparedAudit(
                                transaction,
                                invocation,
                                caused,
                                evidence
                            )
                        ),
                    /Preparation AuditRecord does not bind the PreparedInvocation/
                );

                const bound = auditRecord(
                    invocation.header.auditCause.value,
                    invocation.header.actor,
                    { kind: "routeProjected", projection, reservation }
                );
                evidence.seed(bound);
                harness.transaction((transaction) =>
                    harness.ledger.requirePreparedAudit(transaction, invocation, bound, evidence)
                );
            }
        );

        test(
            "[invocation.effect-attempt] names the unauthorized EffectAttempt in AuthorityAdmission denials",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("authority-message", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:authority-message",
                    "worker:authority-message",
                    time(10)
                );
                const attempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:authority-message"),
                    invocation.header.id,
                    0,
                    0,
                    claim.id,
                    "lease:1",
                    admissionFor("substituted", 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:authority-message")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, attempt, time(2))
                        ),
                    /AuthorityAdmission does not authorize this exact EffectAttempt/
                );
            }
        );

        test(
            "[invocation.audit] refuses receipt evidence whose attempt AuditRecord is not an attempt",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const setup = auditedAttempt(harness, evidence, "receipt-audit-kind");
                const receipt = new AttemptReceipt(
                    new ReceiptId("receipt:receipt-audit-kind"),
                    setup.attempt.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                const projected = auditRecord(
                    "audit:receipt-audit-kind:projected",
                    setup.invocation.header.actor,
                    {
                        kind: "routeProjected",
                        projection: new RouteProjectionId("projection:receipt-audit-kind"),
                        reservation: new RouteReservationId("route:receipt-audit-kind")
                    }
                );
                evidence.seed(projected);
                const receiptAudit = auditRecord(
                    "audit:receipt-audit-kind:receipt",
                    setup.invocation.header.actor,
                    { kind: "receipt", id: receipt.id, outcome: "failed" },
                    projected.id
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.recordAttemptReceiptWithAudit(
                                transaction,
                                receipt,
                                projected,
                                receiptAudit,
                                InvocationPublicationOutbox.pending({
                                    invocation: setup.invocation.header.id,
                                    receipt: receipt.id,
                                    audit: receiptAudit.id
                                }),
                                evidence
                            )
                        ),
                    /Receipt AuditRecord or publication does not bind the attempted effect/
                );
            }
        );

        test(
            "[invocation.audit] refuses receipt evidence whose attempt AuditRecord names no cause",
            { tags: "p1" },
            () => {
                const harness = open();
                const evidence = new ContractEvidence<Transaction>();
                const setup = auditedAttempt(harness, evidence, "receipt-audit-cause");
                const receipt = new AttemptReceipt(
                    new ReceiptId("receipt:receipt-audit-cause"),
                    setup.attempt.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                const rootless = auditRecord(
                    "audit:receipt-audit-cause:attempt",
                    setup.invocation.header.actor,
                    { kind: "attempt", id: setup.attempt.id }
                );
                evidence.seed(rootless);
                const receiptAudit = auditRecord(
                    "audit:receipt-audit-cause:receipt",
                    setup.invocation.header.actor,
                    { kind: "receipt", id: receipt.id, outcome: "failed" },
                    rootless.id
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.recordAttemptReceiptWithAudit(
                                transaction,
                                receipt,
                                rootless,
                                receiptAudit,
                                InvocationPublicationOutbox.pending({
                                    invocation: setup.invocation.header.id,
                                    receipt: receipt.id,
                                    audit: receiptAudit.id
                                }),
                                evidence
                            )
                        ),
                    /Receipt AuditRecord or publication does not bind the attempted effect/
                );
            }
        );

        test(
            "[invocation.continuation] rejects a continuation whose first claim holds another item",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared(
                    "continuation-claim-item",
                    [{ item: 0 }, { item: 1 }, { item: 2 }],
                    { lease: "lease:1" }
                );
                const firstClaim = executorClaim(
                    invocation.header.id,
                    1,
                    0,
                    "claim:continuation-claim-item:first",
                    "worker:first",
                    time(10)
                );
                const firstAttempt = new EffectAttempt<string, string>(
                    new EffectAttemptId("attempt:continuation-claim-item:first"),
                    invocation.header.id,
                    0,
                    0,
                    firstClaim.id,
                    "lease:1",
                    admissionFor(invocation.header.id.value, 0, 0),
                    time(2),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("audit:continuation-claim-item:first")
                );
                const pending = Approval.pending(
                    new ApprovalId("approval:continuation-claim-item"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const secondClaim = executorClaim(
                    invocation.header.id,
                    2,
                    0,
                    "claim:continuation-claim-item:second",
                    "worker:second",
                    time(10)
                );
                const secondAttempt = effectAttempt(
                    invocation,
                    secondClaim,
                    "attempt:continuation-claim-item:second",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.persistence.appendApproval(transaction, pending);
                    harness.persistence.appendApproval(transaction, approved);
                    harness.persistence.appendApproval(
                        transaction,
                        approved.consume(firstAttempt.id, time(3))
                    );
                    harness.persistence.appendClaim(transaction, firstClaim);
                    harness.persistence.appendAttempt(transaction, firstAttempt);
                    harness.persistence.insertContinuation(
                        transaction,
                        new InvocationContinuation<string>(
                            invocation.header.id,
                            invocation.intentDigest,
                            pending.id,
                            firstAttempt.id,
                            0,
                            0,
                            firstClaim.id,
                            firstClaim.owner,
                            invocation.item(0).idempotencyKey,
                            time(3)
                        )
                    );
                    harness.ledger.claimItem(transaction, secondClaim, time(3));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                        ),
                    /InvocationContinuation first EffectAttempt identity is invalid/
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, secondAttempt.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[invocation.continuation] rejects a system continuation owner that names another Actor",
            { tags: "p0" },
            () => {
                const harness = open();
                const invocation = prepared("continuation-owner-actor", [{ item: 0 }, { item: 1 }]);
                const firstClaim = systemClaim(
                    invocation,
                    0,
                    0,
                    "claim:continuation-owner-actor:first",
                    "worker:first",
                    time(10)
                );
                const firstAttempt = systemAttempt(
                    invocation,
                    firstClaim,
                    "attempt:continuation-owner-actor:first",
                    time(2)
                );
                const pending = Approval.pending(
                    new ApprovalId("approval:continuation-owner-actor"),
                    invocation.header.id,
                    invocation.intentDigest,
                    time(1),
                    time(20)
                );
                const approved = pending.approve(new PrincipalId("approver"), time(2));
                const secondClaim = systemClaim(
                    invocation,
                    1,
                    0,
                    "claim:continuation-owner-actor:second",
                    "worker:second",
                    time(10)
                );
                const secondAttempt = systemAttempt(
                    invocation,
                    secondClaim,
                    "attempt:continuation-owner-actor:second",
                    time(4)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.persistence.appendApproval(transaction, pending);
                    harness.persistence.appendApproval(transaction, approved);
                    harness.persistence.appendApproval(
                        transaction,
                        approved.consume(firstAttempt.id, time(3))
                    );
                    harness.persistence.appendClaim(transaction, firstClaim);
                    harness.persistence.appendAttempt(transaction, firstAttempt);
                    harness.persistence.insertContinuation(
                        transaction,
                        new InvocationContinuation<string>(
                            invocation.header.id,
                            invocation.intentDigest,
                            pending.id,
                            firstAttempt.id,
                            0,
                            0,
                            firstClaim.id,
                            {
                                kind: "system",
                                actor: new ActorRef(
                                    "run",
                                    new ActorId("actor:continuation-owner-actor:foreign")
                                ),
                                worker: new ClaimWorkerId("worker:first")
                            },
                            invocation.item(0).idempotencyKey,
                            time(3)
                        )
                    );
                    harness.ledger.claimItem(transaction, secondClaim, time(3));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.admitAttempt(transaction, secondAttempt, time(4))
                        ),
                    /InvocationContinuation first EffectAttempt identity is invalid/
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.persistence.attempt(transaction, secondAttempt.id)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "[invocation.receipt] names the initial AttemptReceipt lineage rule it enforces",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared("initial-receipt-message", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:initial-receipt-message",
                    "worker:initial-receipt-message",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:initial-receipt-message",
                    time(2)
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.recordAttemptReceipt(
                                transaction,
                                new AttemptReceipt(
                                    new ReceiptId("receipt:initial-receipt-message"),
                                    attempt.id,
                                    "failed",
                                    new ReceiptId("receipt:initial-receipt-message:previous"),
                                    time(3),
                                    undefined
                                )
                            )
                        ),
                    /Initial AttemptReceipt cannot name previous/
                );
            }
        );

        test(
            "[invocation.receipt] names the unreceipted EffectAttempt requirement it enforces",
            { tags: "p1" },
            () => {
                const harness = open();
                const invocation = prepared("unreceipted-message", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:unreceipted-message",
                    "worker:unreceipted-message",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:unreceipted-message",
                    time(2)
                );
                const recorded = new AttemptReceipt(
                    new ReceiptId("receipt:unreceipted-message"),
                    attempt.id,
                    "failed",
                    undefined,
                    time(3),
                    undefined
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                });
                const rejected: readonly AttemptReceipt[] = [
                    new AttemptReceipt(
                        new ReceiptId("receipt:unreceipted-message:ghost"),
                        new EffectAttemptId("attempt:unreceipted-message:ghost"),
                        "failed",
                        undefined,
                        time(3),
                        undefined
                    ),
                    new AttemptReceipt(
                        new ReceiptId("receipt:unreceipted-message:repeat"),
                        attempt.id,
                        "failed",
                        undefined,
                        time(4),
                        undefined
                    )
                ];
                harness.transaction((transaction) =>
                    harness.ledger.recordAttemptReceipt(transaction, recorded)
                );
                for (const receipt of rejected) {
                    expectAgentCoreError(
                        () =>
                            harness.transaction((transaction) =>
                                harness.ledger.recordAttemptReceipt(transaction, receipt)
                            ),
                        /AttemptReceipt requires one existing unreceipted EffectAttempt/
                    );
                }
            }
        );

        test(
            "[invocation.receipt] reports a missing predecessor before counting lineage heads",
            { tags: "p1" },
            () => {
                const harness = open();
                const lineage = attemptLineage(harness, "lineage-missing");
                harness.transaction((transaction) => {
                    harness.persistence.appendReceipt(
                        transaction,
                        lineageReceipt("lineage-missing:head", lineage.attempt.id, undefined)
                    );
                    harness.persistence.appendReceipt(
                        transaction,
                        lineageReceipt(
                            "lineage-missing:orphan",
                            lineage.attempt.id,
                            new ReceiptId("receipt:lineage-missing:absent")
                        )
                    );
                });
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.currentReceipt(
                                transaction,
                                lineage.invocation.header.id,
                                0
                            )
                        ),
                    /Attempt Receipt history has a missing predecessor/
                );
            }
        );

        test(
            "[invocation.receipt] never yields an attempt Receipt history with two current heads",
            { tags: "p1" },
            () => {
                const harness = open();
                const lineage = attemptLineage(harness, "lineage-heads");
                const appendSecondHead = (): void =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendReceipt(
                            transaction,
                            lineageReceipt("lineage-heads:first", lineage.attempt.id, undefined)
                        );
                        harness.persistence.appendReceipt(
                            transaction,
                            lineageReceipt("lineage-heads:second", lineage.attempt.id, undefined)
                        );
                    });
                if (corruptLineage === "excluded") {
                    expectAgentCoreError(appendSecondHead, /append conflicted/);
                    return;
                }
                appendSecondHead();
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.currentReceipt(
                                transaction,
                                lineage.invocation.header.id,
                                0
                            )
                        ),
                    /Attempt Receipt history does not have one current head/
                );
            }
        );

        test(
            "[invocation.receipt] never yields a Receipt lineage containing a cycle",
            { tags: "p1" },
            () => {
                const harness = open();
                const lineage = attemptLineage(harness, "lineage-cycle");
                const left = new ReceiptId("receipt:lineage-cycle:left");
                const right = new ReceiptId("receipt:lineage-cycle:right");
                const appendCycle = (): void =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendReceipt(
                            transaction,
                            lineageReceipt("lineage-cycle:head", lineage.attempt.id, left)
                        );
                        harness.persistence.appendReceipt(
                            transaction,
                            new AttemptReceipt(
                                left,
                                lineage.attempt.id,
                                "failed",
                                right,
                                time(4),
                                undefined
                            )
                        );
                        harness.persistence.appendReceipt(
                            transaction,
                            new AttemptReceipt(
                                right,
                                lineage.attempt.id,
                                "failed",
                                left,
                                time(5),
                                undefined
                            )
                        );
                    });
                if (corruptLineage === "excluded") {
                    expectAgentCoreError(appendCycle, /append conflicted/);
                    return;
                }
                appendCycle();
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.ledger.currentReceipt(
                                transaction,
                                lineage.invocation.header.id,
                                0
                            )
                        ),
                    /Attempt Receipt history contains a cycle/
                );
            }
        );

        test(
            "[invocation.item-claim] rejects claim owner kinds that contradict the Prepared lease mode",
            { tags: "p0" },
            () => {
                const harness = open();
                const leaseFree = prepared("owner-kind-lease-free");
                const leased = prepared("owner-kind-leased", {}, { lease: "lease:1" });
                const rejected: readonly ItemClaim<string>[] = [
                    executorClaim(
                        leaseFree.header.id,
                        0,
                        0,
                        "claim:owner-kind:executor",
                        "worker:owner-kind:executor",
                        time(10)
                    ),
                    systemClaim(
                        leased,
                        0,
                        0,
                        "claim:owner-kind:system",
                        "worker:owner-kind:system",
                        time(10)
                    )
                ];
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, leaseFree);
                    harness.ledger.prepare(transaction, leased);
                });
                for (const claim of rejected) {
                    let failure: unknown;
                    try {
                        harness.transaction((transaction) =>
                            harness.ledger.claimItem(transaction, claim, time(1))
                        );
                    } catch (error) {
                        failure = error;
                    }
                    expect(failure).toBeInstanceOf(AgentCoreError);
                    expect(failure).toMatchObject({ code: "invocation.invalid" });
                    expect(
                        harness.transaction((transaction) =>
                            harness.persistence.claim(transaction, claim.id)
                        )
                    ).toBeUndefined();
                }
            }
        );

        test(
            "[invocation.receipt] resolves the current head for opaque Receipt identifier text",
            { tags: "p2" },
            () => {
                const harness = open();
                const invocation = prepared("opaque-receipt-id", {}, { lease: "lease:1" });
                const claim = executorClaim(
                    invocation.header.id,
                    0,
                    0,
                    "claim:opaque-receipt-id",
                    "worker:opaque-receipt-id",
                    time(10)
                );
                const attempt = effectAttempt(
                    invocation,
                    claim,
                    "attempt:opaque-receipt-id",
                    time(2)
                );
                const receipt = new AttemptReceipt(
                    new ReceiptId("Stryker was here"),
                    attempt.id,
                    "succeeded",
                    undefined,
                    time(3),
                    content("opaque-receipt-id")
                );
                harness.transaction((transaction) => {
                    harness.ledger.prepare(transaction, invocation);
                    harness.ledger.claimItem(transaction, claim, time(1));
                    harness.ledger.admitAttempt(transaction, attempt, time(2));
                    harness.ledger.recordAttemptReceipt(transaction, receipt);
                });
                expect(
                    harness.transaction(
                        (transaction) =>
                            harness.ledger.currentReceipt(transaction, invocation.header.id, 0)?.id
                                .value
                    )
                ).toBe("Stryker was here");
            }
        );

        test(
            "generated approval, claim, recovery, attempt and Receipt histories preserve every item lineage",
            // Long generated histories re-resolve every record after every step;
            // instrumented runs need far more than the interactive budget.
            { tags: "p0", timeout: 180_000 },
            () => {
                const index = fc.constantFrom<ItemIndex>(0, 1);
                const attemptOutcome = fc.constantFrom<AttemptReceiptOutcome>(
                    "succeeded",
                    "failed",
                    "indeterminate"
                );
                const commands = fc.commands<LedgerModel, LedgerSystem<Transaction>>(
                    [
                        fc.constant(new PrepareInvocation()),
                        fc.constant(new RequestApproval()),
                        fc.constant(new RejectSecondApprovalRequest()),
                        fc
                            .constantFrom<ApprovalDecision>("approve", "deny", "expire")
                            .map((decision) => new SettleApproval(decision)),
                        fc.constant(new RejectReplayedApprovalRevision()),
                        index.map((slot) => new ClaimItem(slot)),
                        index.map((slot) => new RejectContendedClaim(slot)),
                        index.map((slot) => new RejectPrematureRetry(slot)),
                        index.map((slot) => new RecoverClaim(slot)),
                        index.map((slot) => new RejectPrematureRecovery(slot)),
                        index.map((slot) => new RejectPostAttemptRecovery(slot)),
                        index.map((slot) => new AdmitAttempt(slot)),
                        index.map((slot) => new RejectDisplacedClaimAttempt(slot)),
                        index.map((slot) => new RejectUnapprovedAttempt(slot)),
                        fc
                            .tuple(index, attemptOutcome)
                            .map(([slot, outcome]) => new RecordReceipt(slot, outcome)),
                        index.map((slot) => new RejectReplayedReceipt(slot)),
                        fc
                            .tuple(index, fc.constantFrom<FinalOutcome>("succeeded", "failed"))
                            .map(([slot, outcome]) => new SupersedeReceipt(slot, outcome)),
                        index.map((slot) => new RejectFinalSupersession(slot)),
                        fc
                            .tuple(
                                index,
                                fc.constantFrom<PreEffectReceiptOutcome>(
                                    "deniedPreEffect",
                                    "cancelledPreEffect"
                                )
                            )
                            .map(([slot, outcome]) => new RecordPreEffect(slot, outcome)),
                        fc.integer({ min: 1, max: 5 }).map((seconds) => new AdvanceClock(seconds)),
                        fc.constant(new Restart()),
                        fc.constant(new Probe())
                    ],
                    { maxCommands: 400, size: "max" }
                );

                fc.assert(
                    fc.property(commands, (history) => {
                        const harness = open();
                        fc.modelRun(
                            () => ({ model: emptyLedgerModel(), real: { harness } }),
                            history
                        );
                    }),
                    // A pinned seed keeps the recorded mutation survivors stable across runs.
                    { numRuns: 60, seed: 20_260_806 }
                );
            }
        );
    });
}

const modelInvocation = prepared("model-run", [{ item: 0 }, { item: 1 }], { lease: "lease:1" });
const modelApprovalId = new ApprovalId("approval:model-run");
const modelClaimSeconds = 3;
const modelApprovalExpirySeconds = 15;

type ItemIndex = 0 | 1;
type ApprovalDecision = "approve" | "deny" | "expire";
type FinalOutcome = Exclude<AttemptReceiptOutcome, "indeterminate">;

interface LedgerModel {
    prepared: boolean;
    now: number;
    sequence: number;
    approval: Approval | undefined;
    continuation: EffectAttemptId | undefined;
    readonly items: readonly [ItemModel, ItemModel];
}

interface ItemModel {
    readonly claims: ItemClaim<string>[];
    readonly attempts: EffectAttempt<string, string>[];
    readonly receipts: (AttemptReceipt | PreEffectReceipt)[];
    live: ItemClaim<string> | undefined;
    displaced: ItemClaim<string> | undefined;
}

interface LedgerSystem<Transaction> {
    readonly harness: InvocationHarness<Transaction>;
}

class PrepareInvocation<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public check(model: Readonly<LedgerModel>): boolean {
        return !model.prepared;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        system.harness.transaction((transaction) => {
            system.harness.ledger.prepare(transaction, modelInvocation);
        });
        model.prepared = true;
        assertResolvable(model, system);
    }

    public toString(): string {
        return "prepare";
    }
}

class RequestApproval<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public check(model: Readonly<LedgerModel>): boolean {
        return model.prepared && model.approval === undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const approval = Approval.pending(
            modelApprovalId,
            modelInvocation.header.id,
            modelInvocation.intentDigest,
            time(0),
            time(modelApprovalExpirySeconds)
        );
        system.harness.transaction((transaction) => {
            system.harness.ledger.requestApproval(transaction, approval);
        });
        model.approval = approval;
        assertResolvable(model, system);
    }

    public toString(): string {
        return "requestApproval";
    }
}

class RejectSecondApprovalRequest<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public check(model: Readonly<LedgerModel>): boolean {
        return model.approval !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const contender = Approval.pending(
            new ApprovalId("approval:model-run:contender"),
            modelInvocation.header.id,
            modelInvocation.intentDigest,
            time(0),
            time(modelApprovalExpirySeconds)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.requestApproval(transaction, contender);
                }),
            /fresh exact PreparedInvocation/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return "rejectSecondApprovalRequest";
    }
}

class SettleApproval<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly decision: ApprovalDecision) {}

    public check(model: Readonly<LedgerModel>): boolean {
        if (model.approval?.state.kind !== "pending") return false;
        return this.decision === "expire"
            ? model.now >= modelApprovalExpirySeconds
            : model.now < modelApprovalExpirySeconds;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const current = present(model.approval, "a pending Approval");
        const at = time(model.now);
        const approver = new PrincipalId("approver:model-run");
        const next =
            this.decision === "approve"
                ? current.approve(approver, at)
                : this.decision === "deny"
                  ? current.deny(approver, at, "generated denial")
                  : current.expire(at);
        system.harness.transaction((transaction) => {
            system.harness.ledger.appendApprovalRevision(transaction, next);
        });
        model.approval = next;
        assertResolvable(model, system);
    }

    public toString(): string {
        return `settleApproval(${this.decision})`;
    }
}

class RejectReplayedApprovalRevision<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public check(model: Readonly<LedgerModel>): boolean {
        return model.approval !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const current = present(model.approval, "an Approval");
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.appendApprovalRevision(transaction, current);
                }),
            /next legal transition/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return "rejectReplayedApprovalRevision";
    }
}

class ClaimItem<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return model.prepared && claimable(model.items[this.index]);
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const claim = nextClaim(model, this.index, item.attempts.length);
        system.harness.transaction((transaction) => {
            system.harness.ledger.claimItem(transaction, claim, time(model.now));
        });
        item.claims.push(claim);
        item.live = claim;
        item.displaced = undefined;
        assertResolvable(model, system);
    }

    public toString(): string {
        return `claim(${this.index})`;
    }
}

class RejectContendedClaim<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return model.items[this.index].live !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const live = present(model.items[this.index].live, "a live ItemClaim");
        const contender = executorClaim(
            modelInvocation.header.id,
            this.index,
            live.attemptOrdinal,
            `claim:contended:${this.index}`,
            `worker:contended:${this.index}`,
            time(model.now + modelClaimSeconds)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.claimItem(transaction, contender, time(model.now));
                }),
            /already has an unattempted claim/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectContendedClaim(${this.index})`;
    }
}

// A new ordinal is claimable only after the prior ordinal carries a final failed
// Receipt: an outstanding attempt or a nonfailed current Receipt refuses it.
class RejectPrematureRetry<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const item = model.items[this.index];
        return model.prepared && item.live === undefined && !claimable(item);
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const retry = executorClaim(
            modelInvocation.header.id,
            this.index,
            item.attempts.length,
            `claim:premature:${this.index}`,
            `worker:premature:${this.index}`,
            time(model.now + modelClaimSeconds)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.claimItem(transaction, retry, time(model.now));
                }),
            /unresolved EffectAttempt|final failed Receipt/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectPrematureRetry(${this.index})`;
    }
}

class RecoverClaim<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return expired(model.items[this.index].live, model.now);
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const previous = present(item.live, "an expired ItemClaim");
        const replacement = nextClaim(model, this.index, previous.attemptOrdinal);
        system.harness.transaction((transaction) => {
            system.harness.ledger.recoverClaim(
                transaction,
                previous.id,
                replacement,
                time(model.now)
            );
        });
        item.claims.push(replacement);
        item.live = replacement;
        item.displaced = previous;
        assertResolvable(model, system);
    }

    public toString(): string {
        return `recoverClaim(${this.index})`;
    }
}

class RejectPrematureRecovery<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const live = model.items[this.index].live;
        return live !== undefined && !expired(live, model.now);
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const previous = present(model.items[this.index].live, "a live ItemClaim");
        const replacement = executorClaim(
            modelInvocation.header.id,
            this.index,
            previous.attemptOrdinal,
            `claim:early:${this.index}`,
            `worker:early:${this.index}`,
            time(model.now + modelClaimSeconds)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.recoverClaim(
                        transaction,
                        previous.id,
                        replacement,
                        time(model.now)
                    );
                }),
            /Only an expired claim may be recovered/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectPrematureRecovery(${this.index})`;
    }
}

// Recovery is scoped to the ordinal: once the ordinal carries an EffectAttempt its
// claim leaves the recovery path and follows Receipt reconciliation instead.
class RejectPostAttemptRecovery<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return model.items[this.index].attempts.length !== 0;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const attempt = present(
            model.items[this.index].attempts.at(-1),
            "an admitted EffectAttempt"
        );
        const replacement = executorClaim(
            modelInvocation.header.id,
            this.index,
            attempt.ordinal,
            `claim:attempted:${this.index}`,
            `worker:attempted:${this.index}`,
            time(model.now + modelClaimSeconds)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.recoverClaim(
                        transaction,
                        attempt.claim,
                        replacement,
                        time(model.now)
                    );
                }),
            /exact current no-attempt claim/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectPostAttemptRecovery(${this.index})`;
    }
}

class AdmitAttempt<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const live = model.items[this.index].live;
        return live !== undefined && !expired(live, model.now) && approvalAdmits(model);
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const claim = present(item.live, "a live ItemClaim");
        model.sequence += 1;
        const attempt = effectAttempt(
            modelInvocation,
            claim,
            `attempt:${model.sequence}`,
            time(model.now)
        );
        const consumed = system.harness.transaction((transaction) =>
            system.harness.ledger.admitAttempt(transaction, attempt, time(model.now))
        );
        if (model.approval?.state.kind === "approved") {
            expect(consumed?.state.kind).toBe("consumed");
            model.approval = present(consumed, "the consumed Approval");
            model.continuation = attempt.id;
        } else {
            expect(consumed).toBeUndefined();
        }
        item.attempts.push(attempt);
        item.live = undefined;
        item.displaced = undefined;
        assertResolvable(model, system);
    }

    public toString(): string {
        return `admitAttempt(${this.index})`;
    }
}

// Only the current claim owner may append the ordinal's one EffectAttempt, so an
// attempt bound to a claim a recovery displaced is refused.
class RejectDisplacedClaimAttempt<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return model.items[this.index].displaced !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const displaced = present(model.items[this.index].displaced, "a displaced ItemClaim");
        const attempt = effectAttempt(
            modelInvocation,
            displaced,
            `attempt:displaced:${this.index}`,
            time(model.now)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) =>
                    system.harness.ledger.admitAttempt(transaction, attempt, time(model.now))
                ),
            /does not match the live current claim/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectDisplacedClaimAttempt(${this.index})`;
    }
}

class RejectUnapprovedAttempt<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const live = model.items[this.index].live;
        return (
            live !== undefined &&
            !expired(live, model.now) &&
            model.approval !== undefined &&
            !approvalAdmits(model)
        );
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const claim = present(model.items[this.index].live, "a live ItemClaim");
        const attempt = effectAttempt(
            modelInvocation,
            claim,
            `attempt:unapproved:${this.index}`,
            time(model.now)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) =>
                    system.harness.ledger.admitAttempt(transaction, attempt, time(model.now))
                ),
            /[Aa]pproved continuation/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectUnapprovedAttempt(${this.index})`;
    }
}

class RecordReceipt<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(
        private readonly index: ItemIndex,
        private readonly outcome: AttemptReceiptOutcome
    ) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return unreceiptedAttempt(model.items[this.index]) !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const attempt = present(unreceiptedAttempt(item), "an unreceipted EffectAttempt");
        const receipt = nextReceipt(model, attempt.id, this.outcome, undefined);
        system.harness.transaction((transaction) => {
            system.harness.ledger.recordAttemptReceipt(transaction, receipt);
        });
        item.receipts.push(receipt);
        assertResolvable(model, system);
    }

    public toString(): string {
        return `recordReceipt(${this.index}, ${this.outcome})`;
    }
}

class RejectReplayedReceipt<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const item = model.items[this.index];
        return item.attempts.length !== 0 && unreceiptedAttempt(item) === undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const attempt = present(
            model.items[this.index].attempts.at(-1),
            "a receipted EffectAttempt"
        );
        const replay = new AttemptReceipt(
            new ReceiptId(`receipt:replayed:${this.index}`),
            attempt.id,
            "succeeded",
            undefined,
            time(model.now),
            content(`receipt:replayed:${this.index}`)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.recordAttemptReceipt(transaction, replay);
                }),
            /one existing unreceipted EffectAttempt/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectReplayedReceipt(${this.index})`;
    }
}

class SupersedeReceipt<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(
        private readonly index: ItemIndex,
        private readonly outcome: FinalOutcome
    ) {}

    public check(model: Readonly<LedgerModel>): boolean {
        return indeterminateHead(model.items[this.index]) !== undefined;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        const previous = present(indeterminateHead(item), "an indeterminate Receipt");
        const receipt = nextReceipt(model, previous.attempt, this.outcome, previous.id);
        system.harness.transaction((transaction) => {
            system.harness.ledger.supersedeReceipt(transaction, receipt);
        });
        item.receipts.push(receipt);
        assertResolvable(model, system);
    }

    public toString(): string {
        return `supersedeReceipt(${this.index}, ${this.outcome})`;
    }
}

class RejectFinalSupersession<Transaction> implements Command<
    LedgerModel,
    LedgerSystem<Transaction>
> {
    public constructor(private readonly index: ItemIndex) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const current = currentReceiptOf(model.items[this.index]);
        return current instanceof AttemptReceipt && current.outcome !== "indeterminate";
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const current = currentReceiptOf(model.items[this.index]);
        if (!(current instanceof AttemptReceipt))
            throw new Error("Expected a final AttemptReceipt");
        const successor = new AttemptReceipt(
            new ReceiptId(`receipt:successor:${this.index}`),
            current.attempt,
            "succeeded",
            current.id,
            time(model.now),
            content(`receipt:successor:${this.index}`)
        );
        expectAgentCoreError(
            () =>
                system.harness.transaction((transaction) => {
                    system.harness.ledger.supersedeReceipt(transaction, successor);
                }),
            /current indeterminate Receipt may be superseded once/
        );
        assertResolvable(model, system);
    }

    public toString(): string {
        return `rejectFinalSupersession(${this.index})`;
    }
}

class RecordPreEffect<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(
        private readonly index: ItemIndex,
        private readonly outcome: PreEffectReceiptOutcome
    ) {}

    public check(model: Readonly<LedgerModel>): boolean {
        const item = model.items[this.index];
        return model.prepared && item.claims.length === 0 && item.receipts.length === 0;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        const item = model.items[this.index];
        model.sequence += 1;
        const receipt = new PreEffectReceipt(
            new ReceiptId(`receipt:${model.sequence}`),
            modelInvocation.header.id,
            this.index,
            this.outcome,
            time(model.now),
            "generated pre-effect policy decision"
        );
        system.harness.transaction((transaction) => {
            system.harness.ledger.recordPreEffect(transaction, receipt);
        });
        item.receipts.push(receipt);
        assertResolvable(model, system);
    }

    public toString(): string {
        return `recordPreEffect(${this.index}, ${this.outcome})`;
    }
}

class AdvanceClock<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public constructor(private readonly seconds: number) {}

    public check(): boolean {
        return true;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        model.now += this.seconds;
        assertResolvable(model, system);
    }

    public toString(): string {
        return `advanceClock(${this.seconds})`;
    }
}

class Restart<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public check(): boolean {
        return true;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        system.harness.restart();
        assertResolvable(model, system);
    }

    public toString(): string {
        return "restart";
    }
}

class Probe<Transaction> implements Command<LedgerModel, LedgerSystem<Transaction>> {
    public check(): boolean {
        return true;
    }

    public run(model: LedgerModel, system: LedgerSystem<Transaction>): void {
        assertResolvable(model, system);
    }

    public toString(): string {
        return "probe";
    }
}

function assertResolvable<Transaction>(
    model: Readonly<LedgerModel>,
    system: LedgerSystem<Transaction>
): void {
    const invocation = modelInvocation.header.id;
    system.harness.transaction((transaction) => {
        const { persistence, ledger } = system.harness;
        const stored = persistence.prepared(transaction, invocation);
        if (!model.prepared) {
            expect(stored).toBeUndefined();
            return;
        }
        expect(stored?.intentDigest.value).toBe(modelInvocation.intentDigest.value);

        const approval = persistence.approvalForInvocation(transaction, invocation);
        expect(approval?.id.value).toBe(model.approval?.id.value);
        expect(approval?.state.kind).toBe(model.approval?.state.kind);
        expect(persistence.approval(transaction, modelApprovalId)?.revision.value).toBe(
            model.approval?.revision.value
        );
        expect(persistence.continuation(transaction, invocation)?.firstAttempt.value).toBe(
            model.continuation?.value
        );

        for (const [index, item] of model.items.entries()) {
            expect(
                persistence
                    .claimsForItem(transaction, invocation, index)
                    .map((claim) => [
                        claim.id.value,
                        claim.attemptOrdinal,
                        claim.owner.worker.value
                    ])
            ).toEqual(
                item.claims.map((claim) => [
                    claim.id.value,
                    claim.attemptOrdinal,
                    claim.owner.worker.value
                ])
            );
            for (const claim of item.claims) {
                expect(persistence.claim(transaction, claim.id)?.expiresAt.getTime()).toBe(
                    claim.expiresAt.getTime()
                );
                expect(persistence.attemptForClaim(transaction, claim.id)?.id.value).toBe(
                    item.attempts.find((attempt) => attempt.claim.equals(claim.id))?.id.value
                );
            }

            expect(
                persistence
                    .attemptsForItem(transaction, invocation, index)
                    .map((attempt) => [attempt.id.value, attempt.ordinal])
            ).toEqual(item.attempts.map((attempt, ordinal) => [attempt.id.value, ordinal]));

            expect(
                persistence
                    .receiptsForItem(transaction, invocation, index)
                    .map((receipt) => receipt.id.value)
                    .sort()
            ).toEqual(item.receipts.map((receipt) => receipt.id.value).sort());

            const current = currentReceiptOf(item);
            const resolved = ledger.currentReceipt(transaction, invocation, index);
            expect(resolved?.id.value).toBe(current?.id.value);
            expect(resolved?.outcome).toBe(current?.outcome);
        }

        expect(ledger.batchOutcome(transaction, invocation)).toBe(modelBatchOutcome(model));
    });
}

function emptyLedgerModel(): LedgerModel {
    const item = (): ItemModel => ({
        claims: [],
        attempts: [],
        receipts: [],
        live: undefined,
        displaced: undefined
    });
    return {
        prepared: false,
        now: 1,
        sequence: 0,
        approval: undefined,
        continuation: undefined,
        items: [item(), item()]
    };
}

function nextClaim(model: LedgerModel, index: ItemIndex, ordinal: number): ItemClaim<string> {
    model.sequence += 1;
    return executorClaim(
        modelInvocation.header.id,
        index,
        ordinal,
        `claim:${model.sequence}`,
        `worker:${model.sequence}`,
        time(model.now + modelClaimSeconds)
    );
}

function nextReceipt(
    model: LedgerModel,
    attempt: EffectAttemptId,
    outcome: AttemptReceiptOutcome,
    previous: ReceiptId | undefined
): AttemptReceipt {
    model.sequence += 1;
    const id = `receipt:${model.sequence}`;
    return new AttemptReceipt(
        new ReceiptId(id),
        attempt,
        outcome,
        previous,
        time(model.now),
        outcome === "succeeded" ? content(id) : undefined
    );
}

function currentReceiptOf(item: ItemModel): AttemptReceipt | PreEffectReceipt | undefined {
    const head = item.receipts.at(-1);
    if (head === undefined || head instanceof PreEffectReceipt) return head;
    const attempt = item.attempts.at(-1);
    return attempt !== undefined && head.attempt.equals(attempt.id) ? head : undefined;
}

function indeterminateHead(item: ItemModel): AttemptReceipt | undefined {
    const current = currentReceiptOf(item);
    return current instanceof AttemptReceipt && current.outcome === "indeterminate"
        ? current
        : undefined;
}

function unreceiptedAttempt(item: ItemModel): EffectAttempt<string, string> | undefined {
    return currentReceiptOf(item) === undefined ? item.attempts.at(-1) : undefined;
}

function claimable(item: ItemModel): boolean {
    if (item.live !== undefined) return false;
    const current = currentReceiptOf(item);
    return current === undefined
        ? item.attempts.length === 0
        : current instanceof AttemptReceipt && current.outcome === "failed";
}

function expired(claim: ItemClaim<string> | undefined, now: number): boolean {
    return claim !== undefined && claim.expiresAt.getTime() <= time(now).getTime();
}

function approvalAdmits(model: Readonly<LedgerModel>): boolean {
    const state = model.approval?.state.kind;
    if (state === undefined || state === "consumed") return true;
    return state === "approved" && model.now < modelApprovalExpirySeconds;
}

function modelBatchOutcome(model: Readonly<LedgerModel>): BatchOutcome | undefined {
    const receipts = model.items.map(currentReceiptOf);
    if (receipts.some((receipt) => receipt === undefined)) return undefined;
    const outcomes = receipts.map((receipt) => receipt?.outcome);
    if (outcomes.includes("indeterminate")) return "indeterminate";
    if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
    if (outcomes.includes("succeeded")) return "partiallySucceeded";
    if (outcomes.includes("failed")) return "failed";
    if (outcomes.includes("cancelledPreEffect")) return "cancelled";
    return "denied";
}

function present<Value>(value: Value | undefined, subject: string): Value {
    if (value === undefined) throw new Error(`Generated history requires ${subject}`);
    return value;
}

function attemptLineage<Transaction>(
    harness: InvocationHarness<Transaction>,
    id: string
): {
    readonly invocation: PreparedInvocation<string, string, string, string>;
    readonly attempt: EffectAttempt<string, string>;
} {
    const invocation = prepared(id, {}, { lease: "lease:1" });
    const claim = executorClaim(
        invocation.header.id,
        0,
        0,
        `claim:${id}`,
        `worker:${id}`,
        time(10)
    );
    const attempt = effectAttempt(invocation, claim, `attempt:${id}`, time(2));
    harness.transaction((transaction) => {
        harness.ledger.prepare(transaction, invocation);
        harness.ledger.claimItem(transaction, claim, time(1));
        harness.ledger.admitAttempt(transaction, attempt, time(2));
    });
    return { invocation, attempt };
}

function lineageReceipt(
    id: string,
    attempt: EffectAttemptId,
    previous: ReceiptId | undefined
): AttemptReceipt {
    return new AttemptReceipt(
        new ReceiptId(`receipt:${id}`),
        attempt,
        "failed",
        previous,
        time(3),
        undefined
    );
}

function executorClaim(
    invocation: InvocationId,
    itemIndex: number,
    ordinal: number,
    id: string,
    worker: string,
    expiresAt: Date
): ItemClaim<string> {
    return new ItemClaim(
        new ItemClaimId(id),
        invocation,
        itemIndex,
        ordinal,
        { kind: "executor", token: "lease:1", worker: new ClaimWorkerId(worker) },
        expiresAt
    );
}

function effectAttempt(
    invocation: ReturnType<typeof prepared>,
    claim: ItemClaim<string>,
    id: string,
    startedAt: Date
): EffectAttempt<string, string> {
    return new EffectAttempt(
        new EffectAttemptId(id),
        invocation.header.id,
        claim.itemIndex,
        claim.attemptOrdinal,
        claim.id,
        "lease:1",
        admissionFor(invocation.header.id.value, claim.itemIndex, claim.attemptOrdinal),
        startedAt,
        invocation.item(claim.itemIndex).idempotencyKey,
        new AuditRecordId(`audit:${id}`)
    );
}

function systemClaim(
    invocation: ReturnType<typeof prepared>,
    itemIndex: number,
    ordinal: number,
    id: string,
    worker: string,
    expiresAt: Date
): ItemClaim<string> {
    return new ItemClaim(
        new ItemClaimId(id),
        invocation.header.id,
        itemIndex,
        ordinal,
        { kind: "system", actor: invocation.header.actor, worker: new ClaimWorkerId(worker) },
        expiresAt
    );
}

function systemAttempt(
    invocation: ReturnType<typeof prepared>,
    claim: ItemClaim<string>,
    id: string,
    startedAt: Date
): EffectAttempt<string, string> {
    return new EffectAttempt<string, string>(
        new EffectAttemptId(id),
        invocation.header.id,
        claim.itemIndex,
        claim.attemptOrdinal,
        claim.id,
        undefined,
        admissionFor(invocation.header.id.value, claim.itemIndex, claim.attemptOrdinal),
        startedAt,
        invocation.item(claim.itemIndex).idempotencyKey,
        new AuditRecordId(`audit:${id}`)
    );
}

function routedPrepared(id: string): PreparedInvocation<string, string, string, string> {
    return PreparedInvocation.create(
        {
            id: new InvocationId(id),
            operation: operationPin(id),
            domain: `domain:${id}`,
            actor: new ActorRef("run", new ActorId(`actor:${id}`)),
            authority: `authority:${id}`,
            pathEpochs: `epochs:${id}`,
            route: new RouteReservationId(`route:${id}`),
            projectionDigest: digest(`projection:${id}`),
            auditCause: new AuditRecordId(`audit:${id}`),
            idempotencySeed: `seed:${id}`
        },
        { kind: "single", item: { value: id } },
        { ...preparedReferenceCodecs }
    );
}

function auditRecord(
    id: string,
    actor: ActorRef,
    kind: AuditKind,
    cause?: AuditRecordId,
    tenant = "tenant:contract"
): AuditRecord {
    return new AuditRecord({
        id: new AuditRecordId(id),
        actor,
        tenant: new TenantId(tenant),
        correlation: new CorrelationId("correlation:contract"),
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}

function preparationAudit(invocation: ReturnType<typeof prepared>): AuditRecord {
    return auditRecord(invocation.header.auditCause.value, invocation.header.actor, {
        kind: "invocation",
        id: invocation.header.id
    });
}

function auditedAttempt<Transaction>(
    harness: InvocationHarness<Transaction>,
    evidence: ContractEvidence<Transaction>,
    id: string
): {
    readonly invocation: PreparedInvocation<string, string, string, string>;
    readonly root: AuditRecord;
    readonly attempt: EffectAttempt<string, string>;
    readonly attemptAudit: AuditRecord;
} {
    const invocation = prepared(id, { value: id }, { lease: "lease:1" });
    const root = preparationAudit(invocation);
    const claim = executorClaim(
        invocation.header.id,
        0,
        0,
        `claim:${id}`,
        `worker:${id}`,
        time(10)
    );
    const attempt = new EffectAttempt<string, string>(
        new EffectAttemptId(`attempt:${id}`),
        invocation.header.id,
        0,
        0,
        claim.id,
        "lease:1",
        admissionFor(invocation.header.id.value, 0, 0),
        time(2),
        invocation.item(0).idempotencyKey,
        root.id
    );
    const attemptAudit = auditRecord(
        `audit:${id}:attempt`,
        invocation.header.actor,
        { kind: "attempt", id: attempt.id },
        root.id
    );
    harness.transaction((transaction) => {
        harness.ledger.prepareWithAudit(transaction, invocation, root, evidence);
        harness.ledger.claimItem(transaction, claim, time(1));
        harness.ledger.admitAttemptWithAudit(transaction, attempt, time(2), attemptAudit, evidence);
    });
    return { invocation, root, attempt, attemptAudit };
}

class ContractEvidence<Transaction> implements InvocationEvidencePersistence<Transaction> {
    private readonly audits = new Map<string, AuditRecord>();
    private readonly publications = new Map<string, InvocationPublicationOutbox>();

    public seed(record: AuditRecord): void {
        this.audits.set(record.id.value, record);
    }

    public audit(_transaction: Transaction, id: AuditRecordId): AuditRecord | undefined {
        return this.audits.get(id.value);
    }

    public findAuditByEvidence(
        _transaction: Transaction,
        actor: ActorRef,
        kind: AuditKind
    ): AuditRecord | undefined {
        const identity = auditEvidenceIdentity(actor, kind);
        for (const record of this.audits.values()) {
            if (auditEvidenceIdentity(record.actor, record.kind).equals(identity)) return record;
        }
        return undefined;
    }

    public appendAudit(
        transaction: Transaction,
        record: AuditRecord,
        context?: AuditAppendContext
    ): void {
        validateAuditAppend(
            record,
            { get: (id) => this.audit(transaction, id) },
            context?.rootAdmission,
            context?.evidence
        );
        this.audits.set(record.id.value, record);
    }

    public publication(
        _transaction: Transaction,
        id: Digest
    ): InvocationPublicationOutbox | undefined {
        return this.publications.get(id.value);
    }

    public pendingPublications(_transaction: Transaction): readonly InvocationPublicationOutbox[] {
        return [...this.publications.values()].filter((record) => record.state.kind === "pending");
    }

    public appendPublication(_transaction: Transaction, record: InvocationPublicationOutbox): void {
        this.publications.set(record.id.value, record);
    }
}

function expectAgentCoreError(operation: () => unknown, message: RegExp): void {
    let failure: unknown;
    try {
        operation();
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).toMatchObject({
        code: "invocation.invalid",
        message: expect.stringMatching(message)
    });
}

function content(value: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(value)));
}

function time(second: number): Date {
    return new Date(second * 1000);
}
