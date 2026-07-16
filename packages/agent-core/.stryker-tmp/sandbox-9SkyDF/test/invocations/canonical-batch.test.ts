// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import { PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    EffectAttemptId,
    PreEffectReceipt,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../src/operations";
import {
    CanonicalBatchHarness as Harness,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet
} from "../integration/canonical-batch-harness";

describe("CanonicalBatchInvocationPort", () => {
    test("[C13-CLAIM-INITIAL-ATOMIC] claims before async permit issuance and returns one output only for success", async () => {
        const harness = new Harness(true);
        const invocation = new InvocationId("canonical-batch");
        const prepared = harness.preparation.create(invocation, [{ item: 0 }, { item: 1 }]);
        const pending = Approval.pending(
            new ApprovalId("canonical-batch-approval"),
            invocation,
            prepared.intentDigest,
            time(1),
            time(20)
        );
        harness.transactions.transact((transaction) => {
            harness.ledger.prepare(transaction, prepared);
            harness.ledger.requestApproval(transaction, pending);
            harness.ledger.appendApprovalRevision(
                transaction,
                pending.approve(new PrincipalId("approver"), time(2))
            );
        });
        harness.permits.invalidItems.add(0);

        const result = await harness.port.invoke(
            request(invocation, [{ item: 0 }, { item: 1 }], (index) =>
                harness.executions.push(index)
            )
        );

        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toMatchObject({ kind: "terminal", itemIndex: 0 });
        expect(result.items[0]!.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(result.items[1]).toMatchObject({
            kind: "succeeded",
            itemIndex: 1,
            output: { item: 1 }
        });
        expect(harness.permits.claimedBeforeIssue).toEqual([0, 1]);
        expect(harness.permits.issuedInsideTargetTransaction).toBe(false);
        expect(harness.executions).toEqual([1]);

        const evidence = harness.transactions.transact((transaction) => ({
            approval: harness.persistence.approval(transaction, pending.id),
            continuation: harness.persistence.continuation(transaction, invocation),
            attempts0: harness.persistence.attemptsForItem(transaction, invocation, 0),
            attempts1: harness.persistence.attemptsForItem(transaction, invocation, 1),
            audits: transaction.audits.size,
            publications: harness.evidence.pendingPublications(transaction)
        }));
        expect(evidence.approval?.state).toMatchObject({
            kind: "consumed",
            firstAttempt: new EffectAttemptId("attempt:canonical-batch:1:0")
        });
        expect(evidence.continuation?.firstItemIndex).toBe(1);
        expect(evidence.attempts0).toEqual([]);
        expect(evidence.attempts1).toHaveLength(1);
        expect(evidence.audits).toBe(3);
        expect(evidence.publications).toHaveLength(2);
    });

    test("[C13-EFFECT-IDEMPOTENCY] reuses a durable claim after permit-call crash and never repeats the effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("canonical-crash");
        harness.permits.crashOnce = true;

        await expect(
            harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            )
        ).rejects.toThrow("permit transport crash");
        expect(harness.records.createdClaims).toBe(1);
        expect(harness.executions).toEqual([]);

        harness.transactions.restart();
        const first = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        harness.transactions.restart();
        const replay = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );

        expect(first.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
        expect(replay.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
        expect(harness.records.createdClaims).toBe(1);
        expect(harness.executions).toEqual([0]);
    });

    test("concurrent duplicates converge without terminalizing a live attempt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("concurrent-after-permit");
        const issued = deferred<void>();
        const release = deferred<void>();
        harness.permits.onIssue = async () => {
            issued.resolve(undefined);
            await release.promise;
        };
        const value = request(invocation, [{ value: 1 }], (index) =>
            harness.executions.push(index)
        );

        const first = harness.port.invoke(value);
        await issued.promise;
        const duplicate = harness.port.invoke(value);
        release.resolve(undefined);
        const [winner, replay] = await Promise.all([first, duplicate]);

        expect(winner.items[0]).toMatchObject({ kind: "succeeded" });
        expect(replay.items[0]).toMatchObject({ kind: "succeeded" });
        expect(harness.permits.claimedBeforeIssue).toEqual([0]);
        expect(harness.executions).toEqual([0]);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(1);
    });

    test("[C13-CLAIM-RECOVERY-NEW-OWNER] rejects empty, inexact, and substituted canonical batch preparation before claiming", async () => {
        const empty = new Harness(false);
        await expect(
            empty.port.invoke(request(new InvocationId("empty-batch"), [], () => undefined))
        ).rejects.toThrow(/nonempty exact payload shape/);
        expect(empty.records.createdClaims).toBe(0);

        const inexact = new Harness(false);
        const one = request(new InvocationId("inexact-batch"), [{ value: 1 }], () => undefined);
        await expect(
            inexact.port.invoke({
                ...one,
                request: { ...one.request, shape: { kind: "batch", itemCount: 2 } }
            })
        ).rejects.toThrow(/nonempty exact payload shape/);

        const substituted = new Harness(false);
        substituted.preparation.override = (_request, prepared) =>
            substituted.preparation.create(
                new InvocationId("substituted-prepared-identity"),
                prepared.payload.kind === "batch"
                    ? prepared.payload.items.map((item) => item.arguments)
                    : [prepared.payload.item.arguments]
            );
        await expect(
            substituted.port.invoke(
                request(
                    new InvocationId("expected-prepared-identity"),
                    [{ value: 1 }],
                    () => undefined
                )
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);
        expect(substituted.records.createdClaims).toBe(0);
    });

    test("[C13-RECEIPT-PRE-EFFECT] records permit denial before effect and replays its terminal Receipt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("permit-denied");
        harness.permits.deniedItems.add(0);
        const first = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        harness.transactions.restart();
        const replayed = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );

        expect(first.items[0]).toMatchObject({ kind: "terminal", itemIndex: 0 });
        expect(first.items[0]!.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(replayed.items[0]!.receipt.id.equals(first.items[0]!.receipt.id)).toBe(true);
        expect(harness.executions).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-ABSENT] records final target-admission denial with no EffectAttempt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-denied");
        harness.finalAdmissions.result = {
            kind: "denied",
            reason: "Live device consent is absent"
        };

        const result = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        const evidence = harness.transactions.transact((transaction) => ({
            attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
            receipt: harness.ledger.currentReceipt(transaction, invocation, 0)
        }));

        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "deniedPreEffect", reason: "Live device consent is absent" }
        });
        expect(evidence.attempts).toEqual([]);
        expect(evidence.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(harness.executions).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-REVOCATION] linearizes a revocation after permit issue but before final target admission", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-race");
        const issued = deferred<void>();
        const release = deferred<void>();
        harness.permits.onIssue = async () => {
            issued.resolve(undefined);
            await release.promise;
        };

        const running = harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        await issued.promise;
        harness.finalAdmissions.result = { kind: "denied", reason: "Consent revoked" };
        release.resolve(undefined);
        const result = await running;

        expect(result.items[0]).toMatchObject({ kind: "terminal" });
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toEqual([]);
        expect(harness.executions).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-ADMITTED] does not let post-admission revocation cancel an admitted effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-committed");
        const admission = Object.freeze({ pair: "device:agent" });
        const started = deferred<void>();
        const completion = deferred<void>();
        harness.finalAdmissions.result = { kind: "admitted", evidence: admission };
        const value = request(invocation, [{ value: 1 }], () => undefined);
        const running = harness.port.invoke({
            ...value,
            request: {
                ...value.request,
                execute: async (_itemIndex, context) => {
                    expect(context.targetAdmission).toBe(admission);
                    started.resolve(undefined);
                    await completion.promise;
                    return { value: 1 };
                }
            }
        });

        await started.promise;
        harness.finalAdmissions.result = { kind: "denied", reason: "Consent revoked" };
        completion.resolve(undefined);

        await expect(running).resolves.toMatchObject({
            items: [{ kind: "succeeded", output: { value: 1 } }]
        });
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(1);
    });

    test("[C13-CLAIM-RECOVERY-SAME-ORDINAL] recovers an expired permit-stage claim under a new worker at the same ordinal", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("expired-claim");
        harness.permits.crashOnce = true;
        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow("permit transport crash");

        harness.setTime(4_000);
        const recovered = await harness.port.invoke(
            request(invocation, [{ value: 1 }], () => undefined)
        );
        expect(recovered.items[0]).toMatchObject({ kind: "succeeded" });
        expect(harness.records.createdClaims).toBe(2);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence
                    .claimsForItem(transaction, invocation, 0)
                    .map((claim) => claim.attemptOrdinal)
            )
        ).toEqual([0, 0]);
    });

    test("[C13-EFFECT-RECONCILIATION] terminalizes a crash-recovered admitted attempt without repeating the effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("admitted-crash");
        harness.failResourcesOnce = true;
        await expect(
            harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            )
        ).rejects.toThrow("resource crash");
        const recovered = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        expect(recovered.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "indeterminate" }
        });
        expect(harness.executions).toEqual([]);
    });

    test("[C13-RECEIPT-ID-NAMESPACE] turns an operation failure into one final failed Receipt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("effect-failed");
        const result = await harness.port.invoke(
            request(invocation, [{ value: 1 }], () => {
                throw new ConfirmedOperationFailure(
                    "effect failed",
                    ContentRef.fromDigest(digest("effect failed"))
                );
            })
        );
        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: {
                outcome: "failed",
                result: ContentRef.fromDigest(digest("effect failed"))
            }
        });
    });

    test("post-admission untyped throws are indeterminate", async () => {
        const harness = new Harness(false);
        const result = await harness.port.invoke(
            request(new InvocationId("effect-indeterminate"), [{ value: 1 }], () => {
                throw new TypeError("effect may already have happened");
            })
        );
        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "indeterminate" }
        });
    });

    test("rejects a Receipt audit whose cause is not the exact attempt audit", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("receipt-cause-substitution");
        harness.records.substituteReceiptCause = true;
        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow(/does not bind the attempted effect/);
        expect(
            harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)
            )
        ).toBeUndefined();
    });
});

function request(
    invocation: InvocationId,
    inputs: readonly Record<string, number>[],
    onExecute: (itemIndex: number) => void
): CanonicalBatchInvocationRequest<string> {
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${invocation.value}`),
            facet,
            descriptor,
            shape: { kind: "batch", itemCount: inputs.length },
            inputs,
            authorization: "authorization",
            interceptions: inputs.map(() => []),
            execute: async (itemIndex, context) => {
                onExecute(itemIndex);
                return inputs[context.itemIndex]!;
            }
        }
    };
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function time(second: number): Date {
    return new Date(second * 1_000);
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((fulfill) => {
        resolve = fulfill;
    });
    return { promise, resolve };
}
