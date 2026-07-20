import { afterEach, describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { ContentRef, Digest } from "../../src/core";
import { PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecordId,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationError,
    InvocationId,
    PreparedInvocation,
    ItemClaim,
    ItemClaimId,
    PreEffectReceipt,
    ReceiptId
} from "../../src/invocations";
import {
    admissionFor,
    operationPin,
    prepared,
    preparedReferenceCodecs,
    type InvocationHarness
} from "./fixture";

export function invocationLedgerContract<Transaction>(
    name: string,
    create: () => InvocationHarness<Transaction>
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

        test("[invocation.prepared] persists preparation and derives stable shape-sensitive identities", () => {
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
        });

        test("[invocation.approval] [invocation.continuation] consumes one exact Approval with the first admitted attempt", () => {
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
        });

        test("restores the consumed Approval continuation before admitting another batch item", () => {
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
        });

        test("rejects an expired approved continuation without consuming or attempting", () => {
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
            const attempt = effectAttempt(invocation, claim, "attempt:expired-approval", time(3));
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
        });

        test("[invocation.item-claim] recovers only an expired no-attempt claim at the same ordinal under a new worker", () => {
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
        });

        test("recovers an unattempted retry claim despite a prior failed ordinal", () => {
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
        });

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

        test("records pre-effect terminal evidence only before any attempt", () => {
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

        test("[C13-ADV-RECEIPT-SUPERSESSION] [invocation.receipt] supersedes one indeterminate Receipt exactly once and derives batch outcomes", () => {
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
        });

        test("[invocation.effect-attempt] rejects substituted AuthorityAdmission before persisting an attempt", () => {
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
        });

        test("covers lease-free system admission and defensive Receipt rejection paths", () => {
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
        });

        test("derives Approval requirements and forbids out-of-band consumption", () => {
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
            const fakeConsumption = approved.consume(new EffectAttemptId("fake-attempt"), time(3));
            expect(() =>
                harness.transaction((transaction) =>
                    harness.ledger.appendApprovalRevision(transaction, fakeConsumption)
                )
            ).toThrow();
            harness.transaction((transaction) =>
                harness.ledger.admitAttempt(transaction, attempt, time(3))
            );
        });

        test("prevents claim terminalization races and superseded-claim resurrection", () => {
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
        });

        test("binds system and recovered executor claims to the Prepared owner", () => {
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
                { kind: "executor", token: "lease:wrong", worker: new ClaimWorkerId("worker:1") },
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
        });

        test("rejects duplicate preparation and malformed Approval revisions", () => {
            const harness = open();
            const invocation = prepared("duplicate-preparation");
            harness.transaction((transaction) => harness.ledger.prepare(transaction, invocation));
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
        });

        test("fails closed when cross-wave preparation evidence rejects ownership", () => {
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
                harness.transaction((transaction) => harness.ledger.prepare(transaction, invalid))
            ).toThrow(/evidence is invalid/);
            expect(
                harness.transaction((transaction) =>
                    harness.persistence.prepared(transaction, invalid.header.id)
                )
            ).toBeUndefined();
        });

        test("rejects live, unresolved, and wrong-ordinal claims", () => {
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

        test("rejects altered recovery identity and invalid attempt ownership", () => {
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
        });

        test("rejects token-bearing system attempts and orphaned consumed approvals", () => {
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

            const approvedInvocation = prepared("orphaned-consumption", {}, { lease: "lease:1" });
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
        });

        test("rejects expired approvals, invalid reconciliation, and nonfailed retries", () => {
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
            const attempt = effectAttempt(invocation, claim, "attempt:expired-approval", time(3));
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
        });

        test("rolls back partial preparation across restart", () => {
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

        test("rolls back Approval consumption when first-attempt append conflicts", () => {
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
            const attempt = effectAttempt(invocation, claim, "attempt:approval-atomicity", time(3));
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
        });

        test("fails closed on contradictory pre-effect and attempted histories", () => {
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
        });

        test("[C13-ADV-COMPETING-CLAIMS] admits only one current item claim", () => {
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
        });

        test("[C13-ADV-NONFUTURE-CLAIM] rejects equal and past claim expiries", () => {
            const harness = open();
            const invocation = prepared("nonfuture-claim", {}, { lease: "lease:1" });
            harness.transaction((transaction) => harness.ledger.prepare(transaction, invocation));

            for (const [id, expiry] of [
                ["claim:equal-expiry", time(5)],
                ["claim:past-expiry", time(4)]
            ] as const) {
                const claim = executorClaim(invocation.header.id, 0, 0, id, `worker:${id}`, expiry);
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
        });

        test("[C13-ADV-PREMATURE-RECOVERY] rejects recovery before the current claim expires", () => {
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
        });

        test("[C13-ADV-POST-ATTEMPT-RECOVERY] rejects recovery after an attempt was admitted", () => {
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
        });

        test("[C13-ADV-RECOVERY-ORDINAL] rejects recovery that advances an unattempted ordinal", () => {
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
        });

        test("[C13-ADV-RECEIPT-DENIED] keeps denied pre-effect Receipts outside attempted lineage", () => {
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
                    harness.persistence.attemptsForItem(transaction, deniedInvocation.header.id, 0)
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
        });

        test("[C13-CLAIM-FUTURE-EXPIRY] durably admits a claim only with future expiry", () => {
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
        });

        test("[C13-CLAIM-RECOVERY-FUTURE-EXPIRY] requires a recovered claim to expire in the future", () => {
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
        });

        test("[C13-CLAIM-RECOVERY-NO-ATTEMPT] recovers only claims with no admitted attempt", () => {
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
        });

        test("[C13-EFFECT-ATTEMPT-IMMUTABLE] preserves the first EffectAttempt append", () => {
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
        });

        test("[C13-PREPARED-APPROVAL-SINGLE-USE] consumes one Approval only on the first admitted attempt", () => {
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
                expect(harness.persistence.approval(transaction, pending.id)?.revision.value).toBe(
                    2
                );
                expect(
                    harness.persistence.approvalRevision(transaction, pending.id, 3)
                ).toBeUndefined();
            });
        });

        test("[C13-PREPARED-APPROVAL-UNIQUE] reserves one Approval identity per invocation", () => {
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
                    harness.persistence.approvalForInvocation(transaction, invocation.header.id)?.id
                        .value
                ).toBe(first.id.value);
                expect(harness.persistence.approval(transaction, competing.id)).toBeUndefined();
            });
        });

        test("[C13-PREPARED-CONTINUATION-ABSENT] rejects consumed Approval admission without its continuation", () => {
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
        });

        test("[C13-PREPARED-OPTIONAL-LEASE] admits exact leased and lease-free ownership modes", () => {
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
            const leasedInvocation = prepared("optional-lease-executor", {}, { lease: "lease:1" });
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
                expect(harness.persistence.attempt(transaction, executorAttempt.id)?.token).toBe(
                    "lease:1"
                );
            });
        });

        test("[C13-RECEIPT-INDETERMINATE-SUPERSESSION] persists one final supersession exactly once", () => {
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
        });

        test("rejects a stale authenticated worker after claim ownership changes", () => {
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
        });
    });
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

function content(value: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(value)));
}

function time(second: number): Date {
    return new Date(second * 1000);
}
