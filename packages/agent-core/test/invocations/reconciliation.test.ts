import { describe, expect, test } from "vitest";
import fc from "fast-check";
import type { OperationContext } from "../../src/facets";
import {
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    EffectAttempt,
    InvocationReconciler,
    type EffectReconciliationPort
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { OperationRequestKey } from "../../src/operations";
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
