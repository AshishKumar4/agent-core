import { describe, expect, test } from "vitest";
import type { FacetData, OperationContext } from "../../src/facets";
import {
    AdmittedInvocationItem,
    AttemptCancellationObservation,
    AttemptReceipt,
    DetachedEffectExecution,
    DetachedEffectExecutionCodec,
    DetachedEffectExecutionState,
    deriveBatchOutcome,
    EffectAttemptId,
    PreEffectReceipt,
    type CanonicalBatchInvocationRequest,
    type ReconciliationSchedulePort
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import { InvocationId } from "../../src/interaction-references";
import {
    CanonicalBatchHarness as Harness,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet
} from "../integration/canonical-batch-harness";

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
