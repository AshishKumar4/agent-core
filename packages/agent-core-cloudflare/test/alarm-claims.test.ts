import { AlarmOutboxReconciler, DurableAlarmClaims, ReconciliationOutboxId } from "../src/index.js";
import { SqliteApplicationMigrator } from "../src/migration.js";
import { FakeAlarmStorage, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

/** A real database: the claim ledger's value is in the SQL it runs. */
function claims() {
    const database = new NodeSqlite();
    new SqliteApplicationMigrator(database, fakeErrors).migrate();
    return { claims: new DurableAlarmClaims(database, fakeErrors), alarms: new FakeAlarmStorage() };
}

describe("DurableAlarmClaims", () => {
    test("tracks the earliest live claim across owners", async () => {
        const { claims: ledger, alarms } = claims();
        const first = ledger.owner("outbox", alarms);
        const second = ledger.owner("driver", alarms);

        await first.setAlarm(500);
        expect(alarms.scheduledAt).toBe(500);
        await second.setAlarm(200);
        expect(alarms.scheduledAt).toBe(200);

        // Each owner still reads back exactly its own claim.
        expect(await first.getAlarm()).toBe(500);
        expect(await second.getAlarm()).toBe(200);
    });

    test("releasing one owner leaves the other owner's wakeup armed", async () => {
        const { claims: ledger, alarms } = claims();
        const first = ledger.owner("outbox", alarms);
        const second = ledger.owner("driver", alarms);
        await first.setAlarm(500);
        await second.setAlarm(200);

        await second.deleteAlarm();
        expect(alarms.scheduledAt).toBe(500);
        expect(await second.getAlarm()).toBeNull();

        await first.deleteAlarm();
        expect(alarms.scheduledAt).toBeNull();
    });

    test("an outbox reconciler and a second scheduler share one physical alarm", async () => {
        const { claims: ledger, alarms } = claims();
        const outbox = new FakeReconciliationOutboxLike();
        const reconciler = new AlarmOutboxReconciler(
            ledger.owner("outbox", alarms),
            outbox,
            async () => undefined,
            fakeErrors,
            { clock: { now: () => 100 } }
        );
        const driver = ledger.owner("driver", alarms);
        await driver.setAlarm(1_000);

        outbox.enqueue("a", 50);
        await reconciler.armAlarm();
        expect(alarms.scheduledAt).toBe(50);

        // Draining the outbox must not delete the other scheduler's wakeup.
        await reconciler.handleAlarm();
        expect(alarms.scheduledAt).toBe(1_000);
        expect(await driver.getAlarm()).toBe(1_000);
    });

    test("rejects blank owner names", () => {
        const { claims: ledger, alarms } = claims();
        expect(() => ledger.owner(" ", alarms)).toThrow();
        expect(() => ledger.owner("", alarms)).toThrow();
    });

    // The platform deletes the physical alarm before `alarm()` runs, while the claim row
    // survives in SQLite. So a sweep that leaves work due at the same schedule finds the
    // claim already equal to its target. Production wires the reconciler to a claimed
    // view (durable-object.ts), and every other case in this suite hands it raw storage,
    // which is why the object could be left with due work and no wakeup.
    test("re-arms a physical alarm the platform consumed while the claim is unchanged", async () => {
        const { claims: ledger, alarms } = claims();
        const owned = ledger.owner("runtime", alarms);
        const outbox = new FakeReconciliationOutboxLike();
        outbox.enqueue("due", 10);
        const reconciler = new AlarmOutboxReconciler(
            owned,
            outbox,
            async () => undefined,
            fakeErrors
        );

        await reconciler.armAlarm();
        expect(alarms.scheduledAt).toBe(10);

        alarms.scheduledAt = null;
        await reconciler.repairAlarm();

        expect(alarms.scheduledAt).toBe(10);
    });

    // Two owners synchronising concurrently: the second claims an earlier wakeup while the
    // first is awaiting its physical read. If the first decided on a claim set captured
    // before that await, it would arm 500 and the 200 wakeup would be lost.
    test("an earlier claim registered during a physical read is not clobbered", async () => {
        const { claims: ledger } = claims();
        const alarms = new FakeAlarmStorage();
        const first = ledger.owner("first", {
            getAlarm: async () => {
                await second.setAlarm(200);
                return alarms.getAlarm();
            },
            setAlarm: (scheduledTime) => alarms.setAlarm(scheduledTime),
            deleteAlarm: () => alarms.deleteAlarm()
        });
        const second = ledger.owner("second", alarms);

        await first.setAlarm(500);

        expect(alarms.scheduledAt).toBe(200);
    });
});

class FakeReconciliationOutboxLike {
    readonly #scheduled = new Map<string, number>();

    public enqueue(id: string, scheduledAt: number): void {
        this.#scheduled.set(id, scheduledAt);
    }

    public async dueIds(
        now: number,
        limit: number
    ): Promise<readonly { readonly id: ReconciliationOutboxId; readonly scheduledAt: number }[]> {
        return [...this.#scheduled]
            .filter(([, scheduledAt]) => scheduledAt <= now)
            .slice(0, limit)
            .map(([id, scheduledAt]) => ({ id: new ReconciliationOutboxId(id), scheduledAt }));
    }

    public async nextDueAt(): Promise<number | null> {
        if (this.#scheduled.size === 0) return null;
        return Math.min(...this.#scheduled.values());
    }

    public async acknowledge(due: {
        readonly id: ReconciliationOutboxId;
        readonly scheduledAt: number;
    }): Promise<void> {
        if (this.#scheduled.get(due.id.value) !== due.scheduledAt) return;
        this.#scheduled.delete(due.id.value);
    }

    public async reschedule(
        due: { readonly id: ReconciliationOutboxId; readonly scheduledAt: number },
        scheduledAt: number
    ): Promise<void> {
        if (this.#scheduled.get(due.id.value) !== due.scheduledAt) return;
        this.#scheduled.set(due.id.value, scheduledAt);
    }
}
