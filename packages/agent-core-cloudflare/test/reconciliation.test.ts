import { AlarmOutboxReconciler, ReconciliationOutboxId } from "../src/index.js";
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

        await outbox.acknowledge(outboxId("first"));
        await outbox.acknowledge(outboxId("later"));
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
            succeededIds: [outboxId("effect-1")],
            failedIds: []
        });
        expect(await driver.handleAlarm()).toEqual({ succeededIds: [], failedIds: [] });
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

        expect(await driver.handleAlarm()).toEqual({
            succeededIds: [outboxId("b")],
            failedIds: [outboxId("a")]
        });
        expect(alarms.scheduledAt).toBe(125);
        expect(outbox.rescheduled).toEqual([{ id: "a", scheduledAt: 125 }]);

        fail = false;
        now = 125;
        expect(await driver.handleAlarm()).toEqual({
            succeededIds: [outboxId("a")],
            failedIds: []
        });
        expect(calls).toEqual(["a", "b", "a"]);
        expect(alarms.scheduledAt).toBeNull();
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

        expect(await beforeRestart.handleAlarm()).toEqual({
            succeededIds: [],
            failedIds: [outboxId("effect-id")]
        });
        expect(externalEffects.size).toBe(1);
        expect(alarms.scheduledAt).toBe(80);

        now = 80;
        const afterRestart = new AlarmOutboxReconciler(alarms, outbox, reconcile, fakeErrors, {
            retryDelayMs: 10,
            clock: { now: () => now }
        });
        expect(await afterRestart.handleAlarm()).toEqual({
            succeededIds: [outboxId("effect-id")],
            failedIds: []
        });
        expect(attempts).toEqual(["effect-id", "effect-id"]);
        expect(externalEffects).toEqual(new Set(["effect-id"]));
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
