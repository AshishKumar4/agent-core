import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import { Revision } from "../../src/core";
import type { FacetData, OperationContext } from "../../src/facets";
import {
    AdmittedInvocationItem,
    AttemptCancellationObservation,
    AttemptCompletion,
    AttemptReceipt,
    DetachedEffectExecution,
    DetachedEffectExecutionCodec,
    DetachedEffectExecutionState,
    deriveBatchOutcome,
    EffectAttempt,
    EffectAttemptId,
    ItemClaimId,
    MemoryDetachedEffectTarget,
    PreEffectReceipt,
    type CanonicalBatchInvocationRequest,
    type ReconciliationSchedulePort
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import { AuditRecordId, InvocationId } from "../../src/interaction-references";
import {
    CanonicalBatchHarness as Harness,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet
} from "../integration/canonical-batch-harness";
import { forged, tamperedRecord } from "../definition/record-data";
import { admissionFor } from "./fixture";

const INTERVAL_MS = 30_000;

describe("detached effect admission", () => {
    test(
        "[C13-TURN-HANDLE-DETACHMENT] admits a durable EffectAttempt with no Receipt and no result before any execution",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-admission-durable");

            const admission = await harness.port.admitDetachedItem(
                request(harness, invocation, [{ value: 1 }]),
                0
            );

            if (admission.kind !== "admitted") {
                throw new TypeError("Expected the item to be admitted");
            }
            expect(admission.item.invocation.equals(invocation)).toBe(true);
            expect(admission.item.itemIndex).toBe(0);
            expect("receipt" in admission).toBe(false);
            expect(harness.executions).toEqual([]);
            const stored = harness.transactions.transact((transaction) => ({
                attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
                receipt: harness.ledger.currentReceipt(transaction, invocation, 0),
                detachment: harness.detachedExecutions.detachedExecution(
                    transaction,
                    admission.item.attempt
                )
            }));
            expect(stored.attempts).toHaveLength(1);
            expect(stored.receipt).toBeUndefined();
            expect(stored.detachment?.state.kind).toBe("awaitingPublication");
            expect(stored.detachment?.state.executable).toBe(false);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] the admitted item and its detachment survive a restart",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-admission-restart");
            const admission = await harness.port.admitDetachedItem(
                request(harness, invocation, [{ value: 1 }]),
                0
            );
            if (admission.kind !== "admitted") {
                throw new TypeError("Expected the item to be admitted");
            }

            harness.restartRuntime();

            const stored = harness.transactions.transact((transaction) => ({
                detachment: harness.detachedExecutions.detachedExecution(
                    transaction,
                    admission.item.attempt
                ),
                receipt: harness.ledger.currentReceipt(transaction, invocation, 0),
                prepared: harness.persistence.prepared(transaction, invocation),
                attempt: harness.persistence.attempt(transaction, admission.item.attempt)
            }));
            expect(stored.receipt).toBeUndefined();
            expect(stored.detachment?.state.kind).toBe("awaitingPublication");
            if (stored.prepared === undefined || stored.attempt === undefined) {
                throw new TypeError("Expected the admitted records to survive the restart");
            }
            // The item a rebuilt host derives is the same item the admitting host published.
            expect(
                AdmittedInvocationItem.derive(stored.prepared, stored.attempt).equals(
                    admission.item
                )
            ).toBe(true);
        }
    );

    test(
        "[C13-RECEIPT-PRE-EFFECT] pre-admission cancellation yields cancelledPreEffect with no EffectAttempt",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-pre-effect-cancelled");
            harness.finalAdmissions.result = {
                kind: "cancelled",
                reason: "the owning Run was cancelled before effect admission"
            };

            const admission = await harness.port.admitDetachedItem(
                request(harness, invocation, [{ value: 1 }]),
                0
            );

            if (admission.kind !== "terminal") {
                throw new TypeError("Expected the item to be refused before its effect");
            }
            expect(admission.receipt).toBeInstanceOf(PreEffectReceipt);
            expect(admission.receipt.outcome).toBe("cancelledPreEffect");
            const stored = harness.transactions.transact((transaction) => ({
                attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
                detachments: harness.detachedExecutions.releasedDetachedExecutions(transaction, 8)
            }));
            expect(stored.attempts).toEqual([]);
            expect(stored.detachments).toEqual([]);
            expect(harness.executions).toEqual([]);
        }
    );
});

describe("detached effect delivery", () => {
    test(
        "[C13-TURN-HANDLE-DETACHMENT] the exact admission delivery releases the item once and a duplicate executes nothing twice",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-release-once");
            const item = await admitted(harness, invocation);

            const first = harness.deliveries.release(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            const second = harness.deliveries.release(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );

            expect(first.kind).toBe("released");
            expect(first.executable).toBe(true);
            expect(second.kind).toBe("alreadyReleased");
            expect(second.executable).toBe(false);
            // Acceptance never executes: releasing twice leaves exactly one released record and
            // no effect at all until a driver runs it.
            expect(harness.executions).toEqual([]);
            const released = harness.transactions.transact((transaction) =>
                harness.detachedExecutions.releasedDetachedExecutions(transaction, 8)
            );
            expect(released).toHaveLength(1);
            expect(released[0]?.revision.value).toBe(1);

            const result = await harness.deliveries.execute(item);
            const replay = await harness.deliveries.execute(item);
            expect(result).toMatchObject({ kind: "succeeded", output: { value: 1 } });
            expect(replay).toMatchObject({ kind: "succeeded", output: { value: 1 } });
            expect(harness.executions).toEqual([0]);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] refuses a delivery naming the wrong Invocation, item key, or EffectAttempt",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-release-mismatch");
            const item = await admitted(harness, invocation);

            expect(() =>
                harness.deliveries.release(
                    new InvocationId("detached-release-other"),
                    item.itemIndex,
                    item.itemKey,
                    item.attempt
                )
            ).toThrowError(/names no PreparedInvocation/);
            expect(() =>
                harness.deliveries.release(
                    invocation,
                    item.itemIndex,
                    `${item.itemKey}-drifted`,
                    item.attempt
                )
            ).toThrowError(/exact admitted item/);
            expect(() =>
                harness.deliveries.release(
                    invocation,
                    item.itemIndex,
                    item.itemKey,
                    new EffectAttemptId("attempt:someone-elses")
                )
            ).toThrowError(/latest EffectAttempt/);

            // A refused delivery changes nothing, so the Run may redeliver the exact message.
            const stored = harness.transactions.transact((transaction) =>
                harness.detachedExecutions.detachedExecution(transaction, item.attempt)
            );
            expect(stored?.state.kind).toBe("awaitingPublication");
            expect(stored?.revision.value).toBe(0);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] a redelivered admission for a settled item reports its Receipt instead of releasing it",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-release-settled");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
            await harness.deliveries.execute(item);

            const outcome = harness.deliveries.release(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );

            expect(outcome.kind).toBe("settled");
            expect(outcome.executable).toBe(false);
            expect(outcome.receipt?.outcome).toBe("succeeded");
            expect(harness.executions).toEqual([0]);
        }
    );
});

describe("detached effect cancellation", () => {
    test(
        "[C13-RECEIPT-FAILURE-KIND] cancellation that reaches the exact live attempt classifies as aborted",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cancel-reached");
            const started = deferred<undefined>();
            const never = deferred<void>();
            const item = await admitted(harness, invocation, {
                started: () => started.resolve(undefined),
                held: never.promise
            });
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);

            const running = harness.deliveries.execute(item);
            await started.promise;
            const outcome = await harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            const result = await running;

            // The port asked the target, the target aborted its own controller, and the
            // ordinary classification path — not the request — named the failure kind.
            expect(outcome.kind).toBe("reached");
            expect(outcome.receipt).toBeUndefined();
            expect(result).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            const receipt = harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)
            );
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("Expected an attempted Receipt");
            }
            expect(receipt.failure?.kind).toBe("aborted");
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] [C13-RECEIPT-FAILURE-KIND] the whole cross-plane journey ends in the BatchOutcome the target observed",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cross-plane-journey");
            const started = deferred<undefined>();
            const never = deferred<void>();
            // One admitted item, held open by its handler. Every step below is a public
            // surface: the W6 port admits, the W5 delivery releases, the target observes
            // the abort, and the Receipt a later reader derives the BatchOutcome from is
            // the only durable word on how the attempt ended.
            const item = await admitted(harness, invocation, {
                started: () => started.resolve(undefined),
                held: never.promise
            });
            expect(
                harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt)
                    .kind
            ).toBe("released");

            const running = harness.deliveries.execute(item);
            await started.promise;
            const outcome = await harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            const result = await running;

            // The target observed its own controller firing, which is the only thing that
            // makes `aborted` available; nothing in the request carried one.
            expect(outcome.kind).toBe("reached");
            expect(result).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });

            const receipt = harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, item.itemIndex)
            );
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("Expected an attempted Receipt");
            }
            expect(receipt.failure?.kind).toBe("aborted");

            // The journey's terminal answer: the batch outcome reads the Receipt the
            // target's observation produced, not anything the requesting Run asked for.
            expect(deriveBatchOutcome(1, [receipt])).toBe("failed");
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] a cancellation naming another attempt never aborts this one",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cancel-wrong-attempt");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
            const live = harness.target.controller(item.attempt);

            await expect(
                harness.deliveries.cancel(
                    invocation,
                    item.itemIndex,
                    item.itemKey,
                    new EffectAttemptId("attempt:someone-elses")
                )
            ).rejects.toThrowError(/latest EffectAttempt/);

            expect(live.signal.aborted).toBe(false);
            const stored = harness.transactions.transact((transaction) => ({
                detachment: harness.detachedExecutions.detachedExecution(transaction, item.attempt),
                receipt: harness.ledger.currentReceipt(transaction, invocation, 0)
            }));
            expect(stored.detachment?.state.kind).toBe("released");
            expect(stored.receipt).toBeUndefined();
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION] cancellation after a restart with no live controller records indeterminate rather than aborted",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cancel-after-restart");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);

            harness.restartRuntime();
            const observation = await harness.target.cancel(item.attempt);
            const outcome = await harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );

            expect(observation.equals(AttemptCancellationObservation.absent)).toBe(true);
            expect(outcome.kind).toBe("recorded");
            const receipt = harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)
            );
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("Expected an attempted Receipt");
            }
            // Nothing observed the effect, so the outcome is unknown and reconciliation owns it.
            expect(receipt.outcome).toBe("indeterminate");
            expect(receipt.failure).toBeUndefined();
            expect(harness.executions).toEqual([]);
        }
    );
});

describe("detached effect driver", () => {
    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] a driver rebuilt after a restart executes the released item from durable records alone",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-driver-restart");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
            const schedule = new MemorySchedule();
            harness.createDriver(schedule, INTERVAL_MS).arm();

            harness.restartRuntime();
            const rebuilt = harness.createDriver(schedule, INTERVAL_MS);
            const repaired = rebuilt.repair();
            const report = await rebuilt.sweep();

            expect(repaired).toBeDefined();
            expect(report).toEqual({ queried: 1, executed: 1, remaining: false });
            expect(harness.executions).toEqual([0]);
            const receipt = harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)
            );
            expect(receipt?.outcome).toBe("succeeded");
            // No released work remains, so the driver leaves nothing armed.
            expect(schedule.scheduled()).toBeUndefined();
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] an unreleased item is not driver work and arms nothing",
        { tags: "p1" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-driver-unreleased");
            await admitted(harness, invocation);
            const schedule = new MemorySchedule();
            const driver = harness.createDriver(schedule, INTERVAL_MS);

            const repaired = driver.repair();
            const report = await driver.sweep();

            expect(repaired).toBeUndefined();
            expect(report).toEqual({ queried: 0, executed: 0, remaining: false });
            expect(harness.executions).toEqual([]);
            expect(schedule.scheduled()).toBeUndefined();
        }
    );
});

describe("detached effect execution record", () => {
    test(
        "[C13-CODEC-VERSIONING] the record round-trips through its codec and keeps one identity across transitions",
        { tags: "p1" },
        () => {
            const item = new AdmittedInvocationItem({
                invocation: new InvocationId("detached-record-codec"),
                itemIndex: 2,
                itemKey: "item-key",
                attempt: new EffectAttemptId("attempt:detached-record-codec")
            });
            const awaiting = DetachedEffectExecution.awaiting(item);
            const released = awaiting.released();

            const decoded = DetachedEffectExecutionCodec.decode(
                DetachedEffectExecutionCodec.encode(released)
            );
            expect(DetachedEffectExecutionCodec.kind).toBe("invocation.detached-effect-execution");
            expect(DetachedEffectExecutionCodec.version.major).toBe(1);
            expect(decoded.id.equals(awaiting.id)).toBe(true);
            expect(decoded.state.kind).toBe("released");
            expect(decoded.revision.value).toBe(1);
            expect(decoded.follows(awaiting)).toBe(true);
            expect(decoded.itemIndex).toBe(2);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] a release after a cancellation request never revives the item",
        { tags: "p1" },
        () => {
            const cancelled = DetachedEffectExecutionState.cancellationRequested;

            expect(cancelled.release().equals(cancelled)).toBe(true);
            expect(cancelled.executable).toBe(false);
            expect(
                DetachedEffectExecutionState.released.requestCancellation().equals(cancelled)
            ).toBe(true);
            expect(
                DetachedEffectExecutionState.awaitingPublication
                    .release()
                    .equals(DetachedEffectExecutionState.released)
            ).toBe(true);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] the record carries no Receipt, no result, and no terminal state",
        { tags: "p1" },
        () => {
            const record = DetachedEffectExecution.awaiting(
                new AdmittedInvocationItem({
                    invocation: new InvocationId("detached-record-shape"),
                    itemIndex: 0,
                    itemKey: "item-key",
                    attempt: new EffectAttemptId("attempt:detached-record-shape")
                })
            );

            expect(Reflect.ownKeys(record).sort()).toEqual([
                "attempt",
                "id",
                "invocation",
                "itemIndex",
                "revision",
                "state"
            ]);
            expect(Object.isFrozen(record)).toBe(true);
        }
    );
});

describe("detached effect delivery ordering", () => {
    test(
        "[C13-TURN-HANDLE-DETACHMENT] an admission message that arrives after the Run's cancellation never releases the item",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-release-after-cancel");
            const started = deferred<undefined>();
            const never = deferred<void>();
            const item = await admitted(harness, invocation, {
                started: () => started.resolve(undefined),
                held: never.promise
            });
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
            const running = harness.deliveries.execute(item);
            await started.promise;

            // Delivery is unordered: the cancellation's durable request commits in `cancel`'s
            // own synchronous span, and the Run's older admission message lands before the
            // target has answered. Neither ordering may hand the item back to a driver.
            const cancelling = harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            const late = harness.deliveries.release(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            const cancelled = await cancelling;
            const result = await running;

            expect(late.kind).toBe("cancellationRequested");
            expect(late.executable).toBe(false);
            expect(late.receipt).toBeUndefined();
            expect(cancelled.kind).toBe("reached");
            expect(result).toMatchObject({ kind: "terminal", receipt: { outcome: "failed" } });
            // The late message is discharged, not applied: the record stays cancelled and the
            // driver's released set is empty, so nothing runs the item a second time.
            const stored = harness.transactions.transact((transaction) => ({
                detachment: harness.detachedExecutions.detachedExecution(transaction, item.attempt),
                released: harness.detachedExecutions.releasedDetachedExecutions(transaction, 8)
            }));
            expect(stored.detachment?.state.kind).toBe("cancellationRequested");
            expect(stored.released).toEqual([]);
            expect(harness.executions).toEqual([0]);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] a cancellation redelivered after the item settled reports its Receipt and asks the target nothing",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cancel-settled");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
            await harness.deliveries.execute(item);
            const live = harness.target.controller(item.attempt);

            const outcome = await harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );

            expect(outcome.kind).toBe("settled");
            expect(outcome.receipt?.outcome).toBe("succeeded");
            // A finished item discharges the message by itself. Asking the target anyway would
            // abort whatever now holds that attempt's controller and record a second outcome.
            expect(live.signal.aborted).toBe(false);
            const stored = harness.transactions.transact((transaction) =>
                harness.detachedExecutions.detachedExecution(transaction, item.attempt)
            );
            expect(stored?.state.kind).toBe("released");
            expect(stored?.revision.value).toBe(1);
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION] a Receipt that lands while the target is being asked is reported instead of an indeterminate one",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-cancel-raced-receipt");
            const item = await admitted(harness, invocation);
            harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);

            const cancelling = harness.deliveries.cancel(
                invocation,
                item.itemIndex,
                item.itemKey,
                item.attempt
            );
            // The effect's own Receipt commits between the durable cancellation request and the
            // target's answer — the window the second read exists for. Nothing here awaits, so
            // the write is ordered before the port resumes.
            harness.transactions.transact((transaction) => {
                const attempt = harness.persistence.attempt(transaction, item.attempt);
                if (attempt === undefined) throw new TypeError("Expected the stored attempt");
                harness.ledger.recordAttemptReceipt(
                    transaction,
                    harness.records.attemptReceipt(
                        attempt,
                        AttemptCompletion.succeeded,
                        harness.now(),
                        undefined
                    )
                );
            });
            const outcome = await cancelling;

            expect(outcome.kind).toBe("settled");
            expect(outcome.receipt?.outcome).toBe("succeeded");
            // The observed outcome stands: no `indeterminate` Receipt was written over it.
            const receipt = harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, item.itemIndex)
            );
            expect(receipt?.outcome).toBe("succeeded");
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] refuses a delivery for an item this host executed inline and an execution that is not an admitted item",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("detached-delivery-not-detached");
            const result = await harness.port.invoke(request(harness, invocation, [{ value: 1 }]));
            expect(result.items[0]).toMatchObject({ kind: "succeeded" });
            const attempt = harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0).at(-1)
            );
            if (attempt === undefined) throw new TypeError("Expected the inline attempt");

            // The item ran under its own Turn and was never detached, so there is no record for
            // a Run message to name — and acknowledging one would claim this host owns work it
            // never took.
            expect(() =>
                harness.deliveries.release(invocation, 0, attempt.idempotencyKey, attempt.id)
            ).toThrowError(/did not detach/);
            await expect(
                harness.deliveries.cancel(invocation, 0, attempt.idempotencyKey, attempt.id)
            ).rejects.toThrowError(/did not detach/);

            // The execution step names its own admitted item; a look-alike is refused before
            // the target is asked to rebuild anything.
            // SAFETY: the four scalar facts alone are not an AdmittedInvocationItem. Only the
            // guard asserted to reject it ever sees this value.
            const lookAlike = {
                invocation,
                itemIndex: 0,
                itemKey: attempt.idempotencyKey,
                attempt: attempt.id
            } as AdmittedInvocationItem;
            await expect(harness.deliveries.execute(lookAlike)).rejects.toThrowError(
                /requires its admitted item/
            );
        }
    );
});

describe("detached effect driver budget", () => {
    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] a sweep bounded by its batch limit re-arms while released work remains",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const schedule = new MemorySchedule();
            const items: AdmittedInvocationItem[] = [];
            for (const name of ["detached-driver-budget-a", "detached-driver-budget-b"]) {
                const invocation = new InvocationId(name);
                const item = await admitted(harness, invocation);
                harness.deliveries.release(invocation, item.itemIndex, item.itemKey, item.attempt);
                items.push(item);
            }
            const driver = harness.createDriver(schedule, INTERVAL_MS, 1);

            const first = await driver.sweep();
            const armed = schedule.scheduled();
            const second = await driver.sweep();

            expect(first).toEqual({ queried: 1, executed: 1, remaining: true });
            // Work is left over, so the firing that just ran must leave the next one scheduled:
            // clearing here would strand the second item until some unrelated delivery armed it.
            expect(armed?.getTime()).toBeGreaterThanOrEqual(INTERVAL_MS);
            expect(second).toEqual({ queried: 1, executed: 1, remaining: false });
            expect(schedule.scheduled()).toBeUndefined();
            expect(harness.executions).toEqual([0, 0]);
            const receipts = harness.transactions.transact((transaction) =>
                items.map((item) =>
                    harness.ledger.currentReceipt(transaction, item.invocation, item.itemIndex)
                )
            );
            expect(receipts.map((receipt) => receipt?.outcome)).toEqual(["succeeded", "succeeded"]);
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] refuses a schedule interval or batch limit that bounds nothing",
        { tags: "p1" },
        () => {
            const harness = new Harness(false);
            const schedule = new MemorySchedule();

            for (const interval of [0, -1, 1.5, Number.NaN]) {
                expect(() => harness.createDriver(schedule, interval)).toThrowError(
                    /interval must be a positive safe integer/
                );
            }
            for (const limit of [0, -1, 2.5]) {
                expect(() => harness.createDriver(schedule, INTERVAL_MS, limit)).toThrowError(
                    /batch limit must be a positive safe integer/
                );
            }
            expect(schedule.scheduled()).toBeUndefined();
        }
    );
});

describe("detached effect target", () => {
    test(
        "[C13-RECEIPT-FAILURE-KIND] the reference target answers by default and refuses a cancellation that does not name an exact EffectAttempt",
        { tags: "p1" },
        async () => {
            const item = new AdmittedInvocationItem({
                invocation: new InvocationId("detached-target-default"),
                itemIndex: 0,
                itemKey: "item-key",
                attempt: new EffectAttemptId("attempt:detached-target-default")
            });
            const target = new MemoryDetachedEffectTarget({
                descriptor,
                execute: () => ({ value: 1 }),
                content: new MemoryContentStore()
            });

            const execution = await target.execution(item);

            // A target that names no protection domain still has to be classifiable: §7.4 reads
            // `domainLost` off the domain, so the default answers rather than leaving every
            // attempt of a plain target unclassifiable.
            expect(execution.resources.target.answering()).toBe(true);
            expect(execution.resources.deadline).toBeUndefined();
            expect(execution.resources.signal.aborted).toBe(false);

            class WiderAttemptId extends EffectAttemptId {}
            expect(() =>
                target.cancel(new WiderAttemptId("attempt:detached-target-default"))
            ).toThrowError(/names its exact EffectAttempt/);
            // The exact attempt still has its live controller: the refusal aborted nothing.
            expect(execution.resources.signal.aborted).toBe(false);
            expect(
                (await target.cancel(item.attempt)).equals(AttemptCancellationObservation.reached)
            ).toBe(true);
            expect(execution.resources.signal.aborted).toBe(true);
        }
    );
});

describe("detached effect execution record exactness", () => {
    test(
        "[C13-TURN-HANDLE-DETACHMENT] every transition is idempotent and a duplicate mints no revision",
        { tags: "p1" },
        () => {
            const record = DetachedEffectExecution.awaiting(
                new AdmittedInvocationItem({
                    invocation: new InvocationId("detached-record-idempotent"),
                    itemIndex: 0,
                    itemKey: "item-key",
                    attempt: new EffectAttemptId("attempt:detached-record-idempotent")
                })
            );
            const released = record.released();
            const cancelled = released.cancellationRequested();

            // A duplicate message returns the very same record, so a store that appends what it
            // is given cannot be handed a second revision that says nothing new.
            expect(released.released()).toBe(released);
            expect(cancelled.cancellationRequested()).toBe(cancelled);
            expect(cancelled.released()).toBe(cancelled);
            expect(record.cancellationRequested().state.kind).toBe("cancellationRequested");
            expect(
                DetachedEffectExecutionState.awaitingPublication
                    .requestCancellation()
                    .equals(DetachedEffectExecutionState.cancellationRequested)
            ).toBe(true);
            expect(
                DetachedEffectExecutionState.cancellationRequested
                    .requestCancellation()
                    .equals(DetachedEffectExecutionState.cancellationRequested)
            ).toBe(true);
            expect(cancelled.revision.value).toBe(2);
            expect(cancelled.follows(released)).toBe(true);
            expect(cancelled.follows(record)).toBe(false);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] refuses a record that is not named by its exact identifiers, index, state and revision",
        { tags: "p1" },
        () => {
            class WiderInvocationId extends InvocationId {}
            class WiderAttemptId extends EffectAttemptId {}
            class WiderRevision extends Revision {}
            const invocation = new InvocationId("detached-record-guards");
            const attempt = new EffectAttemptId("attempt:detached-record-guards");
            const base = {
                invocation,
                itemIndex: 0,
                attempt,
                state: DetachedEffectExecutionState.awaitingPublication,
                revision: Revision.initial()
            };

            expect(
                () =>
                    new DetachedEffectExecution({
                        ...base,
                        invocation: new WiderInvocationId("detached-record-guards")
                    })
            ).toThrowError(/exact context identifiers/);
            expect(
                () =>
                    new DetachedEffectExecution({
                        ...base,
                        attempt: new WiderAttemptId("attempt:detached-record-guards")
                    })
            ).toThrowError(/exact context identifiers/);
            for (const itemIndex of [-1, 1.5, Number.NaN]) {
                expect(() => new DetachedEffectExecution({ ...base, itemIndex })).toThrowError(
                    /item index is invalid/
                );
            }
            // SAFETY: a structural look-alike is the only way to reach the closed-state guard,
            // which no real state can fail. It is handed straight to the constructor asserted
            // to reject it.
            const openState = {
                kind: "released",
                executable: true
            } as DetachedEffectExecutionState;
            expect(() => new DetachedEffectExecution({ ...base, state: openState })).toThrowError(
                /requires one closed state/
            );
            expect(
                () => new DetachedEffectExecution({ ...base, revision: new WiderRevision(0) })
            ).toThrowError(/requires its exact revision/);
            // SAFETY: the same four facts without the derivation that proves the attempt is
            // this item's. `awaiting` refuses it before it can build a record.
            const underived = {
                invocation,
                itemIndex: 0,
                itemKey: "item-key",
                attempt
            } as AdmittedInvocationItem;
            expect(() => DetachedEffectExecution.awaiting(underived)).toThrowError(
                /requires its admitted item/
            );
        }
    );

    test(
        "[C13-CODEC-VERSIONING] the decoder refuses a stored state outside the closed set and an ID that is not the record's own",
        { tags: "p1" },
        () => {
            const record = DetachedEffectExecution.awaiting(
                new AdmittedInvocationItem({
                    invocation: new InvocationId("detached-record-decode"),
                    itemIndex: 0,
                    itemKey: "item-key",
                    attempt: new EffectAttemptId("attempt:detached-record-decode")
                })
            );
            const other = DetachedEffectExecution.awaiting(
                new AdmittedInvocationItem({
                    invocation: new InvocationId("detached-record-decode"),
                    itemIndex: 1,
                    itemKey: "item-key",
                    attempt: new EffectAttemptId("attempt:detached-record-decode-other")
                })
            );

            expect(() =>
                DetachedEffectExecution.decode(
                    DetachedEffectExecution.encode(
                        tamperedRecord(record, {
                            // SAFETY: the encoder writes `state.kind` verbatim, so this is how a
                            // label no transition can produce reaches the decoder asserted to
                            // refuse it.
                            state: forged<DetachedEffectExecutionState>({ kind: "detached" })
                        })
                    )
                )
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(() =>
                DetachedEffectExecution.decode(
                    DetachedEffectExecution.encode(tamperedRecord(record, { id: other.id }))
                )
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            // The untampered record still round-trips, so the refusals above are about the
            // tampering and not about the fixture.
            expect(
                DetachedEffectExecutionCodec.decode(
                    DetachedEffectExecutionCodec.encode(record)
                ).id.equals(record.id)
            ).toBe(true);
        }
    );
});

describe("admitted Invocation item", () => {
    test(
        "[C13-TURN-HANDLE-DETACHMENT] derives from the records that own its facts and refuses an attempt that is not this item's",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("admitted-item-derivation");
            const item = await admitted(harness, invocation);
            const stored = harness.transactions.transact((transaction) => ({
                prepared: harness.persistence.prepared(transaction, invocation),
                attempt: harness.persistence.attempt(transaction, item.attempt)
            }));
            const prepared = stored.prepared;
            const attempt = stored.attempt;
            if (prepared === undefined || attempt === undefined) {
                throw new TypeError("Expected the prepared Invocation and its attempt");
            }

            expect(AdmittedInvocationItem.derive(prepared, attempt).equals(item)).toBe(true);
            expect(item.names(invocation, item.itemIndex, item.itemKey, item.attempt)).toBe(true);

            // An EffectAttempt that names another Invocation, or an idempotency key the prepared
            // item does not carry, describes work this PreparedInvocation never admitted.
            const foreignInvocation = new InvocationId("admitted-item-other");
            expect(() =>
                AdmittedInvocationItem.derive(
                    prepared,
                    attemptLike(attempt, { invocation: foreignInvocation })
                )
            ).toThrowError(/does not belong to its PreparedInvocation item/);
            expect(() =>
                AdmittedInvocationItem.derive(
                    prepared,
                    attemptLike(attempt, { idempotencyKey: `${attempt.idempotencyKey}-drifted` })
                )
            ).toThrowError(/does not belong to its PreparedInvocation item/);

            // Each of the four facts is load-bearing on its own.
            expect(item.names(foreignInvocation, item.itemIndex, item.itemKey, item.attempt)).toBe(
                false
            );
            expect(item.names(invocation, item.itemIndex + 1, item.itemKey, item.attempt)).toBe(
                false
            );
            expect(
                item.names(invocation, item.itemIndex, `${item.itemKey}-drifted`, item.attempt)
            ).toBe(false);
            expect(
                item.names(
                    invocation,
                    item.itemIndex,
                    item.itemKey,
                    new EffectAttemptId("attempt:someone-elses")
                )
            ).toBe(false);
        }
    );

    test(
        "[C13-TURN-HANDLE-DETACHMENT] refuses an item whose four facts are not canonical",
        { tags: "p1" },
        () => {
            class WiderAttemptId extends EffectAttemptId {}
            const base = {
                invocation: new InvocationId("admitted-item-guards"),
                itemIndex: 0,
                itemKey: "item-key",
                attempt: new EffectAttemptId("attempt:admitted-item-guards")
            };

            expect(
                () =>
                    new AdmittedInvocationItem({
                        ...base,
                        attempt: new WiderAttemptId("attempt:admitted-item-guards")
                    })
            ).toThrowError(/names its exact EffectAttempt/);
            for (const itemIndex of [-1, 0.5, Number.NaN]) {
                expect(() => new AdmittedInvocationItem({ ...base, itemIndex })).toThrowError(
                    /item index is invalid/
                );
            }
            for (const itemKey of ["", " padded ", "trailing "]) {
                expect(() => new AdmittedInvocationItem({ ...base, itemKey })).toThrowError(
                    /item key must be canonical/
                );
            }
            expect(new AdmittedInvocationItem(base).equals(new AdmittedInvocationItem(base))).toBe(
                true
            );
        }
    );
});

/** A durable-enough schedule for one driver: the row a substrate would keep. */
class MemorySchedule implements ReconciliationSchedulePort {
    #at: Date | undefined;

    public scheduled(): Date | undefined {
        return this.#at;
    }

    public schedule(at: Date): void {
        this.#at = at;
    }

    public clear(): void {
        this.#at = undefined;
    }
}

/** How one detached item's handler behaves while a suite drives it. */
interface DetachedHandler {
    /** Called as the handler starts, before it waits for anything. */
    readonly started?: () => void;
    /** Held open until this settles; omitted means the handler returns at once. */
    readonly held?: Promise<void>;
}

/** Admits one detached item and registers the request a rebuilt execution runs. */
async function admitted(
    harness: Harness,
    invocation: InvocationId,
    handler: DetachedHandler = {}
): Promise<AdmittedInvocationItem> {
    const value = request(harness, invocation, [{ value: 1 }], handler);
    const admission = await harness.port.admitDetachedItem(value, 0);
    if (admission.kind !== "admitted") {
        throw new TypeError("Expected the item to be admitted");
    }
    return admission.item;
}

/**
 * The request under test, plus the rebuilt handler a detached execution runs. A real host
 * rebuilds the handler from the PreparedInvocation's pinned Operation; the suite registers the
 * same behavior it invoked with so it can observe which items ran and hold them open.
 */
function request(
    harness: Harness,
    invocation: InvocationId,
    inputs: readonly FacetData[],
    handler: DetachedHandler = {}
): CanonicalBatchInvocationRequest<string> {
    const execute = async (itemIndex: number, context: OperationContext): Promise<FacetData> => {
        harness.executions.push(itemIndex);
        handler.started?.();
        if (handler.held !== undefined) {
            await Promise.race([handler.held, untilAborted(context.signal)]);
        }
        const input = inputs[context.itemIndex];
        if (input === undefined) throw new TypeError("Canonical test input is missing");
        return input;
    };
    // The rebuilt handler runs under the target's own item index and context, so the signal it
    // races is the controller a cancellation fires. A fabricated context would leave an
    // in-flight attempt unreachable by the abort that is supposed to end it.
    harness.detachedExecution = (_item, itemIndex, context) => execute(itemIndex, context);
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${invocation.value}`),
            facet,
            descriptor,
            cardinality: { kind: "batch", itemCount: inputs.length },
            inputs,
            authorization: "authorization",
            interceptions: inputs.map(() => []),
            execute
        }
    };
}

/**
 * Rejects exactly when the attempt's own cancellation fires, and never settles otherwise. The
 * handler races it against whatever the suite holds the attempt open with, so an in-flight
 * attempt ends on the signal it was given rather than after a guessed delay.
 */
function untilAborted(signal: AbortSignal): Promise<never> {
    // The executor form is required here: `lib` is ES2023, which has no Promise.withResolvers.
    return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new TypeError("the attempt was aborted"));
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
    });
}

/** A promise handed out before the code that settles it runs. */
interface Deferred<Value> {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    // Same reason as above: the resolver has to escape the executor under ES2023.
    const promise = new Promise<Value>((fulfill) => {
        resolve = fulfill;
    });
    return { promise, resolve };
}

/**
 * A real EffectAttempt for the same claim with one fact moved. Both facts below are ones a
 * host could only produce by pairing an attempt with the wrong PreparedInvocation, which is
 * exactly what `AdmittedInvocationItem.derive` exists to refuse.
 */
function attemptLike(
    attempt: EffectAttempt<string, string>,
    overrides: { readonly invocation?: InvocationId; readonly idempotencyKey?: string }
): EffectAttempt<string, string> {
    const invocation = overrides.invocation ?? attempt.invocation;
    return new EffectAttempt<string, string>(
        attempt.id,
        invocation,
        attempt.itemIndex,
        attempt.ordinal,
        new ItemClaimId(`claim:${invocation.value}:${attempt.itemIndex}:${attempt.ordinal}`),
        undefined,
        admissionFor(invocation.value, attempt.itemIndex, attempt.ordinal),
        attempt.startedAt,
        overrides.idempotencyKey ?? attempt.idempotencyKey,
        new AuditRecordId(`audit:${invocation.value}`)
    );
}
