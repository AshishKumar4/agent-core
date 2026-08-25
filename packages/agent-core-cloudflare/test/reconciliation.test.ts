import { AgentCoreError } from "@agent-core/core";
import {
    AlarmOutboxReconciler,
    ReconciliationOutboxId,
    type ReconciliationOutbox
} from "../src/index.js";
import { FakeAlarmStorage, FakeReconciliationOutbox, fakeErrors } from "./fakes.js";

describe("AlarmOutboxReconciler", () => {
    test("repairs missing, stale, and orphaned physical alarms", async () => {
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("later", 20);
        outbox.enqueue("first", 10);
        const driver = new AlarmOutboxReconciler(alarms, outbox, async () => undefined, fakeErrors);

        await driver.armAlarm();
        expect(alarms.scheduledAt).toBe(10);
        await driver.repairAlarm();
        expect(alarms.setCalls).toEqual([10]);
        alarms.scheduledAt = 99;
        await driver.repairAlarm();
        expect(alarms.scheduledAt).toBe(10);

        await outbox.acknowledge({ id: outboxId("first"), scheduledAt: 10 });
        await outbox.acknowledge({ id: outboxId("later"), scheduledAt: 20 });
        await driver.repairAlarm();
        expect(alarms.scheduledAt).toBeNull();
        expect(alarms.deleteCalls).toBe(1);
    });

    test("repairs a crash or failure between durable enqueue and physical arming", async () => {
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("durable-first", 30);
        alarms.failNextSet();
        const beforeRestart = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async () => undefined,
            fakeErrors
        );

        await expect(beforeRestart.armAlarm()).rejects.toThrow("Physical alarm write failed");
        expect(alarms.scheduledAt).toBeNull();

        const afterRestart = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async () => undefined,
            fakeErrors
        );
        await afterRestart.repairAlarm();
        expect(alarms.scheduledAt).toBe(30);
    });

    test("deduplicates one alarm sweep and duplicate alarm delivery", async () => {
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("effect-1", 5);
        outbox.duplicateDueIds = true;
        const calls: string[] = [];
        const driver = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async (id) => {
                calls.push(id.value);
            },
            fakeErrors,
            { clock: { now: () => 5 } }
        );

        expect(await driver.handleAlarm()).toEqual({
            exhausted: false,
            succeededIds: [outboxId("effect-1")],
            failures: []
        });
        expect(await driver.handleAlarm()).toEqual({
            exhausted: false,
            succeededIds: [],
            failures: []
        });
        expect(calls).toEqual(["effect-1"]);
        expect(alarms.scheduledAt).toBeNull();
    });

    test("isolates failures, persists retries, and rearms the alarm", async () => {
        let now = 100;
        let fail = true;
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("a", now);
        outbox.enqueue("b", now);
        const calls: string[] = [];
        const driver = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async (id) => {
                calls.push(id.value);
                if (id.value === "a" && fail) throw new TypeError("provider failed");
            },
            fakeErrors,
            { retryDelayMs: 25, clock: { now: () => now } }
        );

        expect(await driver.handleAlarm()).toMatchObject({
            succeededIds: [outboxId("b")],
            failures: [{ id: outboxId("a") }]
        });
        expect(alarms.scheduledAt).toBe(125);
        expect(outbox.rescheduled).toEqual([{ id: "a", scheduledAt: 125 }]);

        fail = false;
        now = 125;
        expect(await driver.handleAlarm()).toEqual({
            exhausted: false,
            succeededIds: [outboxId("a")],
            failures: []
        });
        expect(calls).toEqual(["a", "b", "a"]);
        expect(alarms.scheduledAt).toBeNull();
    });

    test("keeps a schedule re-enqueued while reconciliation was in flight", async () => {
        // Durable Object input gates are open across the reconcile await, so a request
        // can reschedule the entry mid-flight; acknowledgement must not discard it.
        const now = 100;
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("a", now);
        const driver = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async () => {
                outbox.enqueue("a", now + 500);
            },
            fakeErrors,
            { clock: { now: () => now } }
        );

        // Reconciliation itself succeeded; the acknowledgement is fenced out, so the
        // newer schedule and its physical alarm survive.
        expect(await driver.handleAlarm()).toEqual({
            exhausted: false,
            succeededIds: [outboxId("a")],
            failures: []
        });
        expect(outbox.acknowledgedIds).toEqual([]);
        expect(await outbox.nextDueAt()).toBe(now + 500);
        expect(alarms.scheduledAt).toBe(now + 500);
    });

    test("keeps a re-enqueued schedule when reconciliation fails in flight", async () => {
        const now = 100;
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("a", now);
        const driver = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async () => {
                outbox.enqueue("a", now + 500);
                throw new TypeError("provider failed");
            },
            fakeErrors,
            { retryDelayMs: 25, clock: { now: () => now } }
        );

        // The retry reschedule is fenced out, so it cannot push the newer schedule back.
        expect(await driver.handleAlarm()).toMatchObject({
            succeededIds: [],
            failures: [{ id: outboxId("a") }]
        });
        expect(outbox.rescheduled).toEqual([]);
        expect(await outbox.nextDueAt()).toBe(now + 500);
    });

    test("recovers from restart using only durable outbox IDs", async () => {
        let now = 40;
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("receipt-query-7", 50);

        const beforeRestart = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async () => undefined,
            fakeErrors,
            { clock: { now: () => now } }
        );
        await beforeRestart.repairAlarm();
        expect(alarms.scheduledAt).toBe(50);

        alarms.scheduledAt = null;
        const recoveredIds: string[] = [];
        const afterRestart = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async (id) => {
                recoveredIds.push(id.value);
            },
            fakeErrors,
            { clock: { now: () => now } }
        );
        await afterRestart.repairAlarm();
        expect(alarms.scheduledAt).toBe(50);

        now = 50;
        await afterRestart.handleAlarm();
        expect(recoveredIds).toEqual(["receipt-query-7"]);
        expect(alarms.scheduledAt).toBeNull();
    });

    test("safely repeats an idempotent effect after reconcile-before-ack failure", async () => {
        let now = 70;
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("effect-id", now);
        outbox.failAcknowledgeOnce("effect-id");
        const externalEffects = new Set<string>();
        const attempts: string[] = [];
        const reconcile = async (id: ReconciliationOutboxId): Promise<void> => {
            attempts.push(id.value);
            externalEffects.add(id.value);
        };
        const beforeRestart = new AlarmOutboxReconciler(alarms, outbox, reconcile, fakeErrors, {
            retryDelayMs: 10,
            clock: { now: () => now }
        });

        expect(await beforeRestart.handleAlarm()).toMatchObject({
            succeededIds: [],
            failures: [{ id: outboxId("effect-id") }]
        });
        expect(externalEffects.size).toBe(1);
        expect(alarms.scheduledAt).toBe(80);

        now = 80;
        const afterRestart = new AlarmOutboxReconciler(alarms, outbox, reconcile, fakeErrors, {
            retryDelayMs: 10,
            clock: { now: () => now }
        });
        expect(await afterRestart.handleAlarm()).toEqual({
            exhausted: false,
            succeededIds: [outboxId("effect-id")],
            failures: []
        });
        expect(attempts).toEqual(["effect-id", "effect-id"]);
        expect(externalEffects).toEqual(new Set(["effect-id"]));
        expect(alarms.scheduledAt).toBeNull();
    });

    test(
        "reports the mapped cause of every entry it could not reconcile",
        { tags: "p1" },
        async () => {
            const alarms = new FakeAlarmStorage();
            const outbox = new FakeReconciliationOutbox();
            outbox.enqueue("a", 100);
            outbox.enqueue("b", 100);
            const driver = new AlarmOutboxReconciler(
                alarms,
                outbox,
                async (id) => {
                    if (id.value === "a") throw new TypeError("provider failed");
                },
                fakeErrors,
                { retryDelayMs: 25, clock: { now: () => 100 } }
            );

            const result = await driver.handleAlarm();
            expect(result.succeededIds).toEqual([outboxId("b")]);
            expect(result.failures.map((failure) => failure.id)).toEqual([outboxId("a")]);
            expect(result.failures[0]?.cause).toBeInstanceOf(AgentCoreError);
            expect(result.failures[0]?.cause).toMatchObject({
                code: "protocol.invalid-state",
                cause: new TypeError("provider failed")
            });
            expect(outbox.rescheduled).toEqual([{ id: "a", scheduledAt: 125 }]);
        }
    );

    test(
        "backs a failed sweep off instead of rearming at a past due time",
        { tags: "p1" },
        async () => {
            const alarms = new FakeAlarmStorage();
            const driver = new AlarmOutboxReconciler(
                alarms,
                failingDueIds(100),
                async () => undefined,
                fakeErrors,
                { retryDelayMs: 25, clock: { now: () => 100 } }
            );

            await expect(driver.handleAlarm()).rejects.toMatchObject({
                code: "protocol.invalid-state",
                message: "Reconciliation outbox due query failed"
            });
            // Rearming at the outbox schedule (100) would refire the alarm immediately.
            expect(alarms.scheduledAt).toBe(125);
        }
    );

    test("keeps the sweep failure when the alarm repair fails too", { tags: "p1" }, async () => {
        const alarms = new FakeAlarmStorage();
        alarms.failNextSet();
        const driver = new AlarmOutboxReconciler(
            alarms,
            failingDueIds(100),
            async () => undefined,
            fakeErrors,
            { retryDelayMs: 25, clock: { now: () => 100 } }
        );

        let failure: unknown;
        try {
            await driver.handleAlarm();
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AgentCoreError);
        expect(failure).toMatchObject({
            code: "protocol.invalid-state",
            message: "Reconciliation outbox due query failed",
            cause: new TypeError("outbox unavailable")
        });
        expect(alarms.scheduledAt).toBeNull();
    });

    test("rearms an early alarm without dispatching future IDs", async () => {
        const alarms = new FakeAlarmStorage();
        const outbox = new FakeReconciliationOutbox();
        outbox.enqueue("future", 200);
        const calls: string[] = [];
        const driver = new AlarmOutboxReconciler(
            alarms,
            outbox,
            async (id) => {
                calls.push(id.value);
            },
            fakeErrors,
            { clock: { now: () => 150 } }
        );

        await driver.handleAlarm();
        expect(calls).toEqual([]);
        expect(alarms.scheduledAt).toBe(200);
    });
});

function outboxId(value: string): ReconciliationOutboxId {
    return new ReconciliationOutboxId(value);
}

/** An outbox whose entries stay durably due while the sweep query keeps failing. */
function failingDueIds(dueAt: number): ReconciliationOutbox {
    return {
        dueIds: async () => {
            throw new TypeError("outbox unavailable");
        },
        nextDueAt: async () => dueAt,
        acknowledge: async () => undefined,
        reschedule: async () => undefined
    };
}
