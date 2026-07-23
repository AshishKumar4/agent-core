import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { ContentRef, Digest } from "../../src/core";
import type { OperationContext } from "../../src/facets";
import {
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    EffectAttempt,
    EffectAttemptId,
    InvocationReconciler,
    ReceiptCodec,
    auditEvidenceIdentity,
    type EffectReconciliationPort,
    type InvocationReconciliationRecordPort
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../src/operations";
import {
    CanonicalBatchHarness,
    type CanonicalBatchHarnessState,
    canonicalBatchDescriptor,
    canonicalBatchFacet
} from "../integration/canonical-batch-harness";
import { invocationCodecs } from "./fixture";

describe("InvocationReconciler", () => {
    test(
        "rejects a persisted attempt audit substituted onto an unrelated invocation root",
        { tags: "p0" },
        async () => {
            const harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("reconcile-substituted-root");
            await harness.port.invoke({
                invocation,
                request: {
                    requestKey: new OperationRequestKey("request:reconcile-substituted-root"),
                    facet: canonicalBatchFacet,
                    descriptor: canonicalBatchDescriptor,
                    shape: { kind: "batch", itemCount: 1 },
                    inputs: [{ value: 1 }],
                    authorization: "authorization",
                    interceptions: [[]],
                    execute: async () => {
                        throw new TypeError("provider response was lost");
                    }
                }
            });
            const attempt = harness.transactions.transact(
                (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
            );
            harness.transactions.transact((transaction) => {
                const invocationRoot = harness.evidence.audit(transaction, attempt.auditCause)!;
                const attemptAudit = harness.evidence.findAuditByEvidence(
                    transaction,
                    invocationRoot.actor,
                    { kind: "attempt", id: attempt.id }
                )!;
                const unrelatedRoot = new AuditRecord({
                    id: new AuditRecordId("reconcile-unrelated-root-audit"),
                    actor: invocationRoot.actor,
                    tenant: invocationRoot.tenant,
                    correlation: invocationRoot.correlation,
                    kind: {
                        kind: "invocation",
                        id: new InvocationId("reconcile-unrelated-root")
                    }
                });
                harness.evidence.appendAudit(transaction, unrelatedRoot);
                transaction.attempts.set(
                    attempt.id.value,
                    invocationCodecs.attempt.encode(
                        new EffectAttempt(
                            attempt.id,
                            attempt.invocation,
                            attempt.itemIndex,
                            attempt.ordinal,
                            attempt.claim,
                            attempt.token,
                            attempt.admission,
                            attempt.startedAt,
                            attempt.idempotencyKey,
                            unrelatedRoot.id
                        )
                    )
                );
                transaction.audits.set(
                    attemptAudit.id.value,
                    AuditRecord.encode(
                        new AuditRecord({
                            id: attemptAudit.id,
                            actor: attemptAudit.actor,
                            tenant: attemptAudit.tenant,
                            correlation: attemptAudit.correlation,
                            kind: attemptAudit.kind,
                            cause: unrelatedRoot.id
                        })
                    )
                );
            });

            let queries = 0;
            const reconciler = new InvocationReconciler<
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                harness.transactions,
                harness.persistence,
                harness.ledger,
                {
                    async query() {
                        queries += 1;
                        return { kind: "unknown" as const };
                    }
                },
                harness.records,
                harness.evidence,
                harness.now
            );
            await expect(reconciler.reconcile(attempt.id)).rejects.toMatchObject({
                code: "invocation.invalid",
                failure: "audit.evidence-mismatch"
            });
            expect(queries).toBe(0);
        }
    );

    test(
        "[C13-EFFECT-SUPERSEDING-RECEIPT] restart and redelivery never regenerate existing audit identifiers",
        { tags: "p0" },
        async () => {
            const harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("nondeterministic-audit-factory");
            await harness.port.invoke({
                invocation,
                request: {
                    requestKey: new OperationRequestKey("request:nondeterministic-audit-factory"),
                    facet: canonicalBatchFacet,
                    descriptor: canonicalBatchDescriptor,
                    shape: { kind: "batch", itemCount: 1 },
                    inputs: [{ value: 1 }],
                    authorization: "authorization",
                    interceptions: [[]],
                    execute: async () => {
                        throw new TypeError("provider response was lost");
                    }
                }
            });
            const attempt = harness.transactions.transact(
                (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
            );
            const result = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            const firstCalls: string[] = [];
            const first = new InvocationReconciler<
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                harness.transactions,
                harness.persistence,
                harness.ledger,
                {
                    async query(_candidate, intentDigest) {
                        expect(
                            intentDigest.equals(
                                harness.transactions.transact(
                                    (transaction) =>
                                        harness.persistence.prepared(transaction, invocation)!
                                            .intentDigest
                                )
                            )
                        ).toBe(true);
                        return { kind: "succeeded" as const, result: result.ref };
                    }
                },
                nondeterministicAuditRecords(harness, "first", firstCalls),
                harness.evidence,
                harness.now
            );
            const final = await first.reconcile(attempt.id);
            expect(firstCalls).toEqual(["receipt", "supersession"]);

            harness.transactions.restart();
            const replayCalls: string[] = [];
            const replay = new InvocationReconciler<
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                harness.transactions,
                harness.persistence,
                harness.ledger,
                {
                    async query() {
                        throw new TypeError("final Receipt must not query");
                    }
                },
                nondeterministicAuditRecords(harness, "replay", replayCalls),
                harness.evidence,
                harness.now
            );
            expect((await replay.reconcile(attempt.id))?.id.equals(final!.id)).toBe(true);
            expect(replayCalls).toEqual([]);
        }
    );

    test(
        "persists the exact attempt before the provider and atomically finalizes complete reconciliation evidence",
        { tags: "p0" },
        async () => {
            const harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("reconcile-driver");
            const prepared = harness.preparation.create(invocation, [{ value: 1 }]);
            const request = {
                invocation,
                request: {
                    requestKey: new OperationRequestKey("request:reconcile-driver"),
                    facet: canonicalBatchFacet,
                    descriptor: canonicalBatchDescriptor,
                    shape: { kind: "batch" as const, itemCount: 1 },
                    inputs: [{ value: 1 }],
                    authorization: "authorization",
                    interceptions: [[]],
                    execute: async (_itemIndex: number, context: OperationContext) => {
                        const attemptContext = context.attempt;
                        if (attemptContext === undefined) {
                            throw new TypeError("Mediated provider context has no EffectAttempt");
                        }
                        const writeAhead = harness.transactions.transact((transaction) => {
                            const persisted = harness.persistence.attempt(
                                transaction,
                                attemptContext.id
                            );
                            return {
                                persisted,
                                audit:
                                    persisted === undefined
                                        ? undefined
                                        : harness.evidence.audit(
                                              transaction,
                                              harness.records.attemptAudit(prepared, persisted).id
                                          )
                            };
                        });
                        expect(writeAhead.persisted?.id.equals(attemptContext.id)).toBe(true);
                        expect(writeAhead.audit?.kind).toMatchObject({
                            kind: "attempt",
                            id: attemptContext.id
                        });
                        throw new TypeError("provider response was lost");
                    }
                }
            };
            const indeterminate = await harness.port.invoke(request);
            const previous = indeterminate.items[0]!.receipt;
            expect(previous).toBeInstanceOf(AttemptReceipt);
            const attempt = harness.transactions.transact(
                (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
            );
            expect(indeterminate.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "indeterminate" }
            });

            let queries = 0;
            const result = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            const provider: EffectReconciliationPort<string, string> = {
                async query(candidate) {
                    queries += 1;
                    expect(candidate.id.equals(attempt.id)).toBe(true);
                    expect(candidate.idempotencyKey).toBe(attempt.idempotencyKey);
                    if (queries === 1) return { kind: "unknown" } as const;
                    return { kind: "succeeded", result: result.ref } as const;
                }
            };
            const reconciler = () =>
                new InvocationReconciler<
                    CanonicalBatchHarnessState,
                    string,
                    string,
                    string,
                    string,
                    string
                >(
                    harness.transactions,
                    harness.persistence,
                    harness.ledger,
                    provider,
                    harness.records,
                    harness.evidence,
                    harness.now
                );

            expect(await reconciler().reconcile(attempt.id)).toBeUndefined();
            expect(
                harness.transactions.transact((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation, 0)
                )
            ).toMatchObject({ outcome: "indeterminate" });

            harness.transactions.restart();
            const final = await reconciler().reconcile(attempt.id);
            harness.transactions.restart();
            const replayed = await reconciler().reconcile(attempt.id);

            expect(final).toMatchObject({
                outcome: "succeeded",
                previous: previous.id,
                result: result.ref
            });
            expect(replayed?.id.equals(final!.id)).toBe(true);
            expect(queries).toBe(2);
            const attemptAudit = harness.records.attemptAudit(prepared, attempt);
            const previousAudit = harness.records.receiptAudit(prepared, attemptAudit, previous);
            const finalAudit = harness.records.receiptAudit(prepared, attemptAudit, final!);
            const supersessionAudit = harness.records.receiptSupersessionAudit(
                prepared,
                previousAudit,
                previous as AttemptReceipt,
                final!
            );
            const durable = harness.transactions.transact((transaction) => ({
                finalAudit: harness.evidence.audit(transaction, finalAudit.id),
                supersessionAudit: harness.evidence.audit(transaction, supersessionAudit.id),
                outcome: harness.ledger.batchOutcome(transaction, invocation),
                publications: harness.evidence.pendingPublications(transaction)
            }));
            expect(durable.finalAudit).toEqual(finalAudit);
            expect(durable.supersessionAudit).toEqual(supersessionAudit);
            expect(durable.outcome).toBe("succeeded");
            expect(durable.publications).toHaveLength(2);
            expect(durable.publications[1]?.observation).toMatchObject({
                invocation,
                receipt: final?.id
            });
        }
    );

    test(
        "generated restart and response-loss schedules converge without duplicating the effect",
        // Generated schedules run hundreds of reconciliations; instrumented runs
        // (mutation sandboxes) need far more than the default budget.
        { tags: "p0", timeout: 120_000 },
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 0, max: 5 }),
                    fc.constantFrom("succeeded" as const, "failed" as const),
                    fc.boolean(),
                    async (unknownQueries, finalOutcome, loseCommitResponse) => {
                        const harness = new CanonicalBatchHarness(false);
                        const invocation = new InvocationId("generated-reconciliation");
                        let logicalEffects = 0;
                        const request = {
                            invocation,
                            request: {
                                requestKey: new OperationRequestKey(
                                    "request:generated-reconciliation"
                                ),
                                facet: canonicalBatchFacet,
                                descriptor: canonicalBatchDescriptor,
                                shape: { kind: "batch" as const, itemCount: 1 },
                                inputs: [{ value: 1 }],
                                authorization: "authorization",
                                interceptions: [[]],
                                execute: async () => {
                                    logicalEffects += 1;
                                    throw new TypeError("provider accepted effect; response lost");
                                }
                            }
                        };
                        await harness.port.invoke(request);
                        const attempt = harness.transactions.transact(
                            (transaction) =>
                                harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
                        );
                        const content = await harness.content.put(
                            new TextEncoder().encode('{"value":1}')
                        );
                        let queries = 0;
                        let responseLossArmed = false;
                        const provider: EffectReconciliationPort<string, string> = {
                            async query(candidate) {
                                expect(candidate.id.equals(attempt.id)).toBe(true);
                                queries += 1;
                                if (queries <= unknownQueries) return { kind: "unknown" };
                                if (loseCommitResponse && !responseLossArmed) {
                                    responseLossArmed = true;
                                    harness.transactions.loseNextCommittedResponse();
                                }
                                return finalOutcome === "succeeded"
                                    ? { kind: "succeeded", result: content.ref }
                                    : { kind: "failed" };
                            }
                        };
                        const reconciler = () =>
                            new InvocationReconciler<
                                CanonicalBatchHarnessState,
                                string,
                                string,
                                string,
                                string,
                                string
                            >(
                                harness.transactions,
                                harness.persistence,
                                harness.ledger,
                                provider,
                                harness.records,
                                harness.evidence,
                                harness.now
                            );

                        for (let index = 0; index < unknownQueries; index += 1) {
                            expect(await reconciler().reconcile(attempt.id)).toBeUndefined();
                            harness.transactions.restart();
                        }
                        if (loseCommitResponse) {
                            await expect(reconciler().reconcile(attempt.id)).rejects.toThrow(
                                "transaction response was lost after commit"
                            );
                        } else {
                            await expect(reconciler().reconcile(attempt.id)).resolves.toMatchObject(
                                {
                                    outcome: finalOutcome
                                }
                            );
                        }

                        harness.transactions.restart();
                        const recovered = await reconciler().reconcile(attempt.id);
                        expect(recovered).toMatchObject({ outcome: finalOutcome });
                        expect(queries).toBe(unknownQueries + 1);
                        expect(logicalEffects).toBe(1);
                        const durable = harness.transactions.transact((transaction) => ({
                            attempts: harness.persistence.attemptsForItem(
                                transaction,
                                invocation,
                                0
                            ),
                            receipts: harness.persistence.receiptsForAttempt(
                                transaction,
                                attempt.id
                            ),
                            current: harness.ledger.currentReceipt(transaction, invocation, 0),
                            publications: harness.evidence.pendingPublications(transaction)
                        }));
                        expect(durable.attempts).toHaveLength(1);
                        expect(durable.receipts).toHaveLength(2);
                        expect(durable.current?.id.equals(recovered!.id)).toBe(true);
                        expect(durable.publications).toHaveLength(2);
                    }
                ),
                { numRuns: 100 }
            );
        }
    );

    test(
        "concurrent reconciliation records one authoritative final lineage",
        { tags: "p0" },
        async () => {
            for (const contradictory of [false, true]) {
                const { harness, invocation, attempt } = await indeterminateInvocation(
                    `concurrent-${contradictory}`
                );
                const result = await harness.content.put(new TextEncoder().encode('{"value":1}'));
                let releaseQueries!: () => void;
                const released = new Promise<void>((resolve) => {
                    releaseQueries = resolve;
                });
                let query = 0;
                const reconciler = new InvocationReconciler<
                    CanonicalBatchHarnessState,
                    string,
                    string,
                    string,
                    string,
                    string
                >(
                    harness.transactions,
                    harness.persistence,
                    harness.ledger,
                    {
                        async query() {
                            const index = query;
                            query += 1;
                            await released;
                            return contradictory && index === 1
                                ? ({ kind: "failed" } as const)
                                : ({ kind: "succeeded", result: result.ref } as const);
                        }
                    },
                    harness.records,
                    harness.evidence,
                    harness.now
                );
                const first = reconciler.reconcile(attempt.id);
                const second = reconciler.reconcile(attempt.id);
                releaseQueries();
                const outcomes = await Promise.allSettled([first, second]);

                expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
                    contradictory ? 1 : 2
                );
                if (contradictory) {
                    expect(
                        outcomes.filter((outcome) => outcome.status === "rejected")[0]
                    ).toMatchObject({ reason: { code: "invocation.invalid" } });
                } else {
                    const [left, right] = outcomes.flatMap((outcome) =>
                        outcome.status === "fulfilled" && outcome.value !== undefined
                            ? [outcome.value]
                            : []
                    );
                    expect(left?.id.equals(right!.id)).toBe(true);
                }
                const durable = harness.transactions.transact((transaction) => ({
                    receipts: harness.persistence.receiptsForAttempt(transaction, attempt.id),
                    publications: harness.evidence.pendingPublications(transaction),
                    current: harness.ledger.currentReceipt(transaction, invocation, 0)
                }));
                expect(durable.receipts).toHaveLength(2);
                expect(durable.publications).toHaveLength(2);
                expect(durable.current).toMatchObject({ outcome: "succeeded" });
            }
        }
    );

    test("rejects reconciling an unknown effect attempt", { tags: "p1" }, async () => {
        const harness = new CanonicalBatchHarness(false);
        const reconciler = createReconciler(harness, unqueriedProvider());

        await expect(
            reconciler.reconcile(new EffectAttemptId("reconcile-missing"))
        ).rejects.toMatchObject({
            code: "invocation.invalid",
            message: "Reconciliation EffectAttempt does not exist"
        });
    });

    test("requires the prepared invocation behind a reconciled attempt", { tags: "p1" }, async () => {
        const { harness, invocation, attempt } = await indeterminateInvocation(
            "reconcile-missing-prepared"
        );
        harness.transactions.transact((transaction) => {
            transaction.prepared.delete(invocation.value);
        });

        await expect(
            createReconciler(harness, unqueriedProvider()).reconcile(attempt.id)
        ).rejects.toMatchObject({
            code: "invocation.invalid",
            message: "Reconciliation EffectAttempt has no PreparedInvocation"
        });
    });

    test(
        "requires the persisted audit cause behind a reconciled attempt",
        { tags: "p1" },
        async () => {
            const { harness, attempt } = await indeterminateInvocation("reconcile-missing-cause");
            harness.transactions.transact((transaction) => {
                transaction.audits.delete(attempt.auditCause.value);
                for (const [identity, id] of transaction.auditByEvidence) {
                    if (id === attempt.auditCause.value) {
                        transaction.auditByEvidence.delete(identity);
                    }
                }
            });

            await expect(
                createReconciler(harness, unqueriedProvider()).reconcile(attempt.id)
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Reconciliation EffectAttempt has no persisted audit cause"
            });
        }
    );

    test(
        "requires the current attempted receipt when reconciling a superseded ordinal",
        { tags: "p0" },
        async () => {
            const harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("reconcile-superseded-ordinal");
            let executions = 0;
            const request = {
                invocation,
                request: {
                    requestKey: new OperationRequestKey("request:reconcile-superseded-ordinal"),
                    facet: canonicalBatchFacet,
                    descriptor: canonicalBatchDescriptor,
                    shape: { kind: "batch" as const, itemCount: 1 },
                    inputs: [{ value: 1 }],
                    authorization: "authorization",
                    interceptions: [[]],
                    execute: async () => {
                        executions += 1;
                        if (executions === 1) {
                            throw new ConfirmedOperationFailure(
                                "first attempt failed",
                                ContentRef.fromDigest(contentDigest("first attempt failed"))
                            );
                        }
                        return { value: 1 };
                    }
                }
            };
            const failed = await harness.port.invoke(request);
            expect(failed.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            const retried = await harness.port.invoke(request);
            expect(retried.items[0]).toMatchObject({ kind: "succeeded" });
            const first = harness.transactions.transact(
                (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]
            );
            if (first === undefined) throw new TypeError("First EffectAttempt is missing");

            await expect(
                createReconciler(harness, unqueriedProvider()).reconcile(first.id)
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Reconciliation requires the current attempted Receipt"
            });
        }
    );

    test(
        "rejects reconciling a directly final receipt with no indeterminate predecessor",
        { tags: "p0" },
        async () => {
            const harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("reconcile-direct-final");
            const result = await harness.port.invoke({
                invocation,
                request: {
                    requestKey: new OperationRequestKey("request:reconcile-direct-final"),
                    facet: canonicalBatchFacet,
                    descriptor: canonicalBatchDescriptor,
                    shape: { kind: "batch", itemCount: 1 },
                    inputs: [{ value: 1 }],
                    authorization: "authorization",
                    interceptions: [[]],
                    execute: async () => ({ value: 1 })
                }
            });
            expect(result.items[0]).toMatchObject({ kind: "succeeded" });
            const attempt = harness.transactions.transact(
                (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]
            );
            if (attempt === undefined) throw new TypeError("EffectAttempt is missing");

            await expect(
                createReconciler(harness, unqueriedProvider()).reconcile(attempt.id)
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Final reconciliation Receipt has no indeterminate predecessor"
            });
        }
    );

    test(
        "rejects a records receipt that contradicts the authoritative result",
        { tags: "p1" },
        async () => {
            const { harness, invocation, attempt } = await indeterminateInvocation(
                "reconcile-mismatched-records"
            );
            const content = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            const reconciler = createReconciler(
                harness,
                {
                    async query() {
                        return { kind: "succeeded", result: content.ref };
                    }
                },
                contradictingRecords(harness)
            );

            await expect(reconciler.reconcile(attempt.id)).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Reconciliation Receipt does not match the authoritative result"
            });
            expect(
                harness.transactions.transact((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation, 0)
                )
            ).toMatchObject({ outcome: "indeterminate" });
        }
    );

    test(
        "requires exact publication evidence for a persisted final reconciled receipt",
        { tags: "p0" },
        async () => {
            const { harness, attempt } = await indeterminateInvocation(
                "reconcile-missing-publication"
            );
            const content = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            let queries = 0;
            const reconciler = () =>
                createReconciler(harness, {
                    async query() {
                        queries += 1;
                        return { kind: "succeeded", result: content.ref };
                    }
                });
            const final = await reconciler().reconcile(attempt.id);
            expect(final).toMatchObject({ outcome: "succeeded" });
            expect(queries).toBe(1);

            harness.transactions.restart();
            harness.transactions.transact((transaction) => {
                transaction.publications.clear();
            });
            await expect(reconciler().reconcile(attempt.id)).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Final reconciliation Receipt has no exact publication evidence"
            });
            expect(queries).toBe(1);
        }
    );

    test(
        "requires the exact indeterminate predecessor behind a final reconciled receipt",
        { tags: "p1" },
        async () => {
            const { harness, attempt } = await indeterminateInvocation(
                "reconcile-corrupt-predecessor"
            );
            const content = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            let queries = 0;
            const reconciler = () =>
                createReconciler(harness, {
                    async query() {
                        queries += 1;
                        return { kind: "succeeded", result: content.ref };
                    }
                });
            const final = await reconciler().reconcile(attempt.id);
            if (final === undefined || final.previous === undefined) {
                throw new TypeError("Final reconciled Receipt is missing its predecessor");
            }
            const previousId = final.previous;
            harness.transactions.transact((transaction) => {
                const previous = harness.persistence.receipt(transaction, previousId);
                if (!(previous instanceof AttemptReceipt)) {
                    throw new TypeError("Predecessor AttemptReceipt is missing");
                }
                transaction.receipts.set(
                    previousId.value,
                    ReceiptCodec.encode(
                        new AttemptReceipt(
                            previous.id,
                            previous.attempt,
                            "failed",
                            undefined,
                            previous.recordedAt,
                            undefined
                        )
                    )
                );
            });

            await expect(reconciler().reconcile(attempt.id)).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Final reconciliation Receipt has no indeterminate predecessor"
            });
            expect(queries).toBe(1);
        }
    );

    test(
        "rejects a provider that contradicts persisted final result content",
        { tags: "p0" },
        async () => {
            const { harness, attempt } = await indeterminateInvocation(
                "reconcile-content-contradiction"
            );
            const first = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            const second = await harness.content.put(new TextEncoder().encode('{"value":2}'));
            let releaseQueries!: () => void;
            const released = new Promise<void>((resolve) => {
                releaseQueries = resolve;
            });
            let query = 0;
            const reconciler = createReconciler(harness, {
                async query() {
                    const index = query;
                    query += 1;
                    await released;
                    return index === 0
                        ? { kind: "succeeded", result: first.ref }
                        : { kind: "succeeded", result: second.ref };
                }
            });
            const left = reconciler.reconcile(attempt.id);
            const right = reconciler.reconcile(attempt.id);
            releaseQueries();
            const outcomes = await Promise.allSettled([left, right]);

            const fulfilled = outcomes.flatMap((outcome) =>
                outcome.status === "fulfilled" ? [outcome.value] : []
            );
            expect(fulfilled).toHaveLength(1);
            expect(fulfilled[0]).toMatchObject({ outcome: "succeeded", result: first.ref });
            expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
                reason: {
                    code: "invocation.invalid",
                    message: "Reconciliation provider contradicted the persisted final Receipt"
                }
            });
        }
    );

    test(
        "rejects a provider outcome flip that preserves the final result content",
        { tags: "p0" },
        async () => {
            const { harness, invocation, attempt } = await indeterminateInvocation(
                "reconcile-outcome-contradiction"
            );
            const shared = await harness.content.put(new TextEncoder().encode('{"value":1}'));
            let releaseQueries!: () => void;
            const released = new Promise<void>((resolve) => {
                releaseQueries = resolve;
            });
            let query = 0;
            const reconciler = createReconciler(harness, {
                async query() {
                    const index = query;
                    query += 1;
                    await released;
                    return index === 0
                        ? { kind: "failed", result: shared.ref }
                        : { kind: "succeeded", result: shared.ref };
                }
            });
            const left = reconciler.reconcile(attempt.id);
            const right = reconciler.reconcile(attempt.id);
            releaseQueries();
            const outcomes = await Promise.allSettled([left, right]);

            const fulfilled = outcomes.flatMap((outcome) =>
                outcome.status === "fulfilled" ? [outcome.value] : []
            );
            expect(fulfilled).toHaveLength(1);
            expect(fulfilled[0]).toMatchObject({ outcome: "failed", result: shared.ref });
            expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
                reason: {
                    code: "invocation.invalid",
                    message: "Reconciliation provider contradicted the persisted final Receipt"
                }
            });
            expect(
                harness.transactions.transact((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation, 0)
                )
            ).toMatchObject({ outcome: "failed" });
        }
    );

    test("requires exact attempt audit evidence for reconciliation", { tags: "p1" }, async () => {
        const { harness, attempt } = await indeterminateInvocation(
            "reconcile-missing-attempt-audit"
        );
        harness.transactions.transact((transaction) => {
            const root = requireAudit(harness.evidence.audit(transaction, attempt.auditCause));
            const identity = auditEvidenceIdentity(root.actor, {
                kind: "attempt",
                id: attempt.id
            });
            const id = transaction.auditByEvidence.get(identity.value);
            if (id === undefined) throw new TypeError("Attempt audit projection is missing");
            transaction.audits.delete(id);
            transaction.auditByEvidence.delete(identity.value);
        });

        await expect(
            createReconciler(harness, unqueriedProvider()).reconcile(attempt.id)
        ).rejects.toMatchObject({
            code: "invocation.invalid",
            message: "Reconciliation EffectAttempt has no exact audit evidence"
        });
    });

    test(
        "rejects attempt audit evidence with a foreign or absent cause",
        { tags: "p1" },
        async () => {
            const foreign = await indeterminateInvocation("reconcile-foreign-attempt-cause");
            foreign.harness.transactions.transact((transaction) => {
                const root = requireAudit(
                    foreign.harness.evidence.audit(transaction, foreign.attempt.auditCause)
                );
                const attemptAudit = requireAudit(
                    foreign.harness.evidence.findAuditByEvidence(transaction, root.actor, {
                        kind: "attempt",
                        id: foreign.attempt.id
                    })
                );
                const unrelatedRoot = new AuditRecord({
                    id: new AuditRecordId("reconcile-foreign-cause-root"),
                    actor: root.actor,
                    tenant: root.tenant,
                    correlation: root.correlation,
                    kind: {
                        kind: "invocation",
                        id: new InvocationId("reconcile-foreign-cause")
                    }
                });
                foreign.harness.evidence.appendAudit(transaction, unrelatedRoot);
                transaction.audits.set(
                    attemptAudit.id.value,
                    AuditRecord.encode(
                        new AuditRecord({
                            id: attemptAudit.id,
                            actor: attemptAudit.actor,
                            tenant: attemptAudit.tenant,
                            correlation: attemptAudit.correlation,
                            cause: unrelatedRoot.id,
                            kind: attemptAudit.kind
                        })
                    )
                );
            });
            await expect(
                createReconciler(foreign.harness, unqueriedProvider()).reconcile(
                    foreign.attempt.id
                )
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Reconciliation EffectAttempt has no exact audit evidence"
            });

            const absent = await indeterminateInvocation("reconcile-absent-attempt-cause");
            absent.harness.transactions.transact((transaction) => {
                const root = requireAudit(
                    absent.harness.evidence.audit(transaction, absent.attempt.auditCause)
                );
                const attemptAudit = requireAudit(
                    absent.harness.evidence.findAuditByEvidence(transaction, root.actor, {
                        kind: "attempt",
                        id: absent.attempt.id
                    })
                );
                transaction.audits.set(
                    attemptAudit.id.value,
                    AuditRecord.encode(
                        new AuditRecord({
                            id: attemptAudit.id,
                            actor: attemptAudit.actor,
                            tenant: attemptAudit.tenant,
                            correlation: attemptAudit.correlation,
                            kind: attemptAudit.kind
                        })
                    )
                );
            });
            await expect(
                createReconciler(absent.harness, unqueriedProvider()).reconcile(absent.attempt.id)
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Reconciliation EffectAttempt has no exact audit evidence"
            });
        }
    );
});

async function indeterminateInvocation(id: string) {
    const harness = new CanonicalBatchHarness(false);
    const invocation = new InvocationId(id);
    await harness.port.invoke({
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${id}`),
            facet: canonicalBatchFacet,
            descriptor: canonicalBatchDescriptor,
            shape: { kind: "batch", itemCount: 1 },
            inputs: [{ value: 1 }],
            authorization: "authorization",
            interceptions: [[]],
            execute: async () => {
                throw new TypeError("provider response was lost");
            }
        }
    });
    const attempt = harness.transactions.transact(
        (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
    );
    return { harness, invocation, attempt };
}

function nondeterministicAuditRecords(
    harness: CanonicalBatchHarness,
    session: string,
    calls: string[]
) {
    return {
        reconciledReceipt: harness.records.reconciledReceipt.bind(harness.records),
        receiptAudit(...parameters: Parameters<typeof harness.records.receiptAudit>) {
            calls.push("receipt");
            return withAuditId(
                harness.records.receiptAudit(...parameters),
                new AuditRecordId(`${session}-receipt-audit-${calls.length}`)
            );
        },
        receiptSupersessionAudit(
            ...parameters: Parameters<typeof harness.records.receiptSupersessionAudit>
        ) {
            calls.push("supersession");
            return withAuditId(
                harness.records.receiptSupersessionAudit(...parameters),
                new AuditRecordId(`${session}-supersession-audit-${calls.length}`)
            );
        }
    };
}

function withAuditId(record: AuditRecord, id: AuditRecordId): AuditRecord {
    return new AuditRecord({
        id,
        actor: record.actor,
        tenant: record.tenant,
        correlation: record.correlation,
        ...(record.cause === undefined ? {} : { cause: record.cause }),
        kind: record.kind
    });
}

function createReconciler(
    harness: CanonicalBatchHarness,
    provider: EffectReconciliationPort<string, string>,
    records: InvocationReconciliationRecordPort<
        string,
        string,
        string,
        string,
        string
    > = harness.records
): InvocationReconciler<CanonicalBatchHarnessState, string, string, string, string, string> {
    return new InvocationReconciler<
        CanonicalBatchHarnessState,
        string,
        string,
        string,
        string,
        string
    >(
        harness.transactions,
        harness.persistence,
        harness.ledger,
        provider,
        records,
        harness.evidence,
        harness.now
    );
}

function unqueriedProvider(): EffectReconciliationPort<string, string> {
    return {
        async query() {
            throw new TypeError("Reconciliation provider must not be queried");
        }
    };
}

function contradictingRecords(
    harness: CanonicalBatchHarness
): InvocationReconciliationRecordPort<string, string, string, string, string> {
    return {
        receiptAudit: harness.records.receiptAudit.bind(harness.records),
        receiptSupersessionAudit: harness.records.receiptSupersessionAudit.bind(harness.records),
        reconciledReceipt(...parameters: Parameters<typeof harness.records.reconciledReceipt>) {
            const [candidate, previous, , recordedAt] = parameters;
            return harness.records.reconciledReceipt(
                candidate,
                previous,
                { kind: "failed" },
                recordedAt
            );
        }
    };
}

function requireAudit(record: AuditRecord | undefined): AuditRecord {
    if (record === undefined) throw new TypeError("AuditRecord is missing");
    return record;
}

function contentDigest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}
