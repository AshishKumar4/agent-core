import { AlarmOutboxReconciler, DurableAlarmClaims, ReconciliationOutboxId } from "../src/index.js";
import { DatabaseSync } from "node:sqlite";
import type { SqliteRow, SqliteValue, SynchronousSqlitePort } from "../src/migration.js";
import { SqliteApplicationMigrator } from "../src/migration.js";
import { FakeAlarmStorage, fakeErrors } from "./fakes.js";

/** A real database: the claim ledger's value is in the SQL it runs. */
class NodeSqlite implements SynchronousSqlitePort {
    readonly #database = new DatabaseSync(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.prepare(statement).all(...(bindings as never[])) as SqliteRow[];
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.prepare(statement).run(...(bindings as never[]));
    }

    public transaction<Result>(operation: () => Result): Result {
        this.#database.exec("BEGIN");
        try {
            const result = operation();
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
}

function claims(): { readonly claims: DurableAlarmClaims; readonly alarms: FakeAlarmStorage } {
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
