import {
    AlarmOutboxReconciler,
    DurableOperationJournal,
    ReconciliationOutboxId,
    SqliteApplicationMigrator,
    SqliteReconciliationOutbox,
    cloudflareRuntimeMigrations,
    type ResumableAttempt,
    type ResumableWork,
    type ResumptionSchedule,
    type SqliteRow,
    type SynchronousResultGuard,
    type SynchronousSqlitePort
} from "../src/index.js";
import { expectOperationalFailure, malformedInput } from "./assertions.js";
import { FakeAlarmStorage, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

const NOW = 1_000;
const RETRY_DELAY_MS = 5_000;

/**
 * One Durable Object's durable storage, outliving every isolate built over it. Every test
 * here rebuilds the journal and the driver against the same database, which is what a
 * reset actually is: the isolate goes away, the storage does not.
 */
function storage(): NodeSqlite {
    const database = new NodeSqlite();
    new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
    return database;
}

/** One isolate over durable storage: fresh journal, fresh driver, same rows. */
function isolate(
    database: NodeSqlite,
    work: Readonly<Record<string, ResumableWork>>,
    alarms: FakeAlarmStorage,
    clock = { now: () => NOW }
) {
    const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
    const journal = new DurableOperationJournal(database, outbox, work, fakeErrors);
    const reconciler = new AlarmOutboxReconciler(
        alarms,
        outbox,
        (id) => journal.resume(id),
        fakeErrors,
        { retryDelayMs: RETRY_DELAY_MS, clock }
    );
    return { outbox, journal, reconciler };
}

function operationId(value = "operation-1"): ReconciliationOutboxId {
    return new ReconciliationOutboxId(value);
}

/**
 * A substrate that reports a row it cannot hand over. Real SQLite counts only rows it
 * produces, so the journal reading a counted-but-absent row as an absent operation —
 * rather than decoding a hole into a record — is only reachable through this port.
 */
class MiscountingSqlite implements SynchronousSqlitePort {
    public all(): readonly SqliteRow[] {
        return malformedInput([undefined]);
    }

    public run(): void {}

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

/** The journal never reaches its schedule in the tests that use the miscounting port. */
class NoSchedule implements ResumptionSchedule {
    public enqueue(): void {}
}

describe("DurableOperationJournal", () => {
    test("[C13-CLOUDFLARE-ALARM-DURABILITY] arms a begun operation from durable state alone after a reset", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();

        const first = isolate(database, { settle: async () => undefined }, alarms);
        first.journal.begin(id, "settle", NOW + 100);
        // The isolate dies before it ever armed the alarm: nothing outside the object has
        // touched anything, and the schedule is the only surviving trace of the work.
        expect(alarms.scheduledAt).toBeNull();

        const restarted = isolate(database, { settle: async () => undefined }, alarms);
        await restarted.reconciler.repairAlarm();

        expect(alarms.scheduledAt).toBe(NOW + 100);
        expect(restarted.journal.record(id)).toEqual({
            work: "settle",
            attempts: 0,
            claimed: false
        });
    });

    test("does not repeat a committed checkpoint after the attempt that follows it fails", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        const applied: string[] = [];
        let failSecondStep = true;
        const work: ResumableWork = async (attempt) => {
            attempt.checkpoint("first", () => {
                applied.push("first");
                database.run("INSERT INTO probe (step) VALUES (?)", ["first"]);
            });
            if (failSecondStep) {
                failSecondStep = false;
                throw new TypeError("downstream unavailable");
            }
            attempt.checkpoint("second", () => {
                applied.push("second");
                database.run("INSERT INTO probe (step) VALUES (?)", ["second"]);
            });
        };
        database.run("CREATE TABLE probe (step TEXT PRIMARY KEY) STRICT", []);

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        const failed = await running.reconciler.handleAlarm();
        expect(failed.failures).toHaveLength(1);
        expect(failed.failures[0]?.cause.code).toBe("protocol.invalid-state");
        // A failed attempt is released, not lost: the next one is a retry, not a recovery.
        expect(running.journal.record(id)).toEqual({
            work: "settle",
            attempts: 1,
            claimed: false
        });

        const settled = await isolate(database, { settle: work }, alarms, {
            now: () => NOW + RETRY_DELAY_MS
        }).reconciler.handleAlarm();

        expect(settled.succeededIds.map((settledId) => settledId.value)).toEqual([id.value]);
        expect(applied).toEqual(["first", "second"]);
        expect(database.all("SELECT step FROM probe ORDER BY step", [])).toEqual([
            { step: "first" },
            { step: "second" }
        ]);
    });

    test("commits a checkpoint's writes and its marker together or not at all", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        let failInsideCheckpoint = true;
        let bodies = 0;
        const work: ResumableWork = async (attempt) => {
            attempt.checkpoint("write", () => {
                bodies += 1;
                database.run("INSERT INTO probe (step) VALUES (?)", ["write"]);
                if (failInsideCheckpoint) {
                    failInsideCheckpoint = false;
                    throw new TypeError("reset partway through the step");
                }
            });
        };
        database.run("CREATE TABLE probe (step TEXT PRIMARY KEY) STRICT", []);

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        await running.reconciler.handleAlarm();

        // Neither the row nor the marker survived, so the next attempt redoes exactly it.
        expect(database.all("SELECT step FROM probe", [])).toEqual([]);
        expect(bodies).toBe(1);

        await isolate(database, { settle: work }, alarms, {
            now: () => NOW + RETRY_DELAY_MS
        }).reconciler.handleAlarm();

        expect(bodies).toBe(2);
        expect(database.all("SELECT step FROM probe", [])).toEqual([{ step: "write" }]);
        expect(running.journal.record(id)).toBeUndefined();
    });

    test("[C13-CLOUDFLARE-ALARM-DURABILITY] reports an attempt whose isolate went away mid-flight as interrupted", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        const seen: Array<{ attempt: number; interrupted: boolean }> = [];
        let reachedStall = (): void => undefined;
        const stalled = new Promise<void>((settle) => {
            reachedStall = settle;
        });
        const observe: ResumableWork = async (attempt) => {
            seen.push({ attempt: attempt.attempt, interrupted: attempt.interrupted });
            attempt.checkpoint("first", () =>
                database.run("INSERT INTO probe (step) VALUES (?)", ["first"])
            );
        };
        const lost: ResumableWork = async (attempt) => {
            await observe(attempt);
            reachedStall();
            await new Promise<void>(() => undefined);
        };
        database.run("CREATE TABLE probe (step TEXT PRIMARY KEY) STRICT", []);

        const dying = isolate(database, { settle: lost }, alarms);
        dying.journal.begin(id, "settle", NOW);
        // Never awaited: the sweep is still inside the work body when the isolate ends.
        void dying.reconciler.handleAlarm();
        await stalled;
        expect(dying.journal.record(id)).toEqual({
            work: "settle",
            attempts: 1,
            claimed: true
        });

        const restarted = isolate(database, { settle: observe }, alarms, {
            now: () => NOW + 1
        });
        await restarted.reconciler.repairAlarm();
        expect(alarms.scheduledAt).toBe(NOW);
        const settled = await restarted.reconciler.handleAlarm();

        expect(settled.succeededIds.map((settledId) => settledId.value)).toEqual([id.value]);
        expect(seen).toEqual([
            { attempt: 1, interrupted: false },
            { attempt: 2, interrupted: true }
        ]);
        // The interrupted attempt's committed step is not redone.
        expect(database.all("SELECT step FROM probe", [])).toEqual([{ step: "first" }]);
    });

    test("replays an external effect under one stable key until it is recorded", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        const keys: string[] = [];
        let failAfterEffect = true;
        const work: ResumableWork = async (attempt) => {
            await attempt.once("upload", async (key) => {
                keys.push(key);
            });
            if (failAfterEffect) {
                failAfterEffect = false;
                throw new TypeError("lost the response");
            }
        };

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        await running.reconciler.handleAlarm();
        await isolate(database, { settle: work }, alarms, {
            now: () => NOW + RETRY_DELAY_MS
        }).reconciler.handleAlarm();

        // Recorded after the effect, so the effect ran once and the retry skipped it.
        expect(keys).toEqual([`${id.value}/upload`]);
    });

    test("clears the operation, its steps and its schedule when it completes", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        const work: ResumableWork = async (attempt) => {
            attempt.checkpoint("only", () => undefined);
        };

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        await running.reconciler.armAlarm();
        expect(alarms.scheduledAt).toBe(NOW);

        await running.reconciler.handleAlarm();

        expect(running.journal.record(id)).toBeUndefined();
        expect(
            database.all("SELECT step FROM agent_core_resumable_steps WHERE operation_id = ?", [
                id.value
            ])
        ).toEqual([]);
        expect(await running.outbox.nextDueAt()).toBeNull();
        expect(alarms.scheduledAt).toBeNull();
    });

    test("settles a redelivered entry for an operation it no longer holds", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        let bodies = 0;
        const work: ResumableWork = async () => {
            bodies += 1;
        };

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        await running.reconciler.handleAlarm();
        expect(bodies).toBe(1);

        // The platform redelivers the entry the sweep already drained.
        running.outbox.enqueue(id, NOW);
        await running.reconciler.handleAlarm();

        expect(bodies).toBe(1);
        expect(await running.outbox.nextDueAt()).toBeNull();
    });

    test("keeps an operation whose work the running release does not declare", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();

        const declaring = isolate(database, { settle: async () => undefined }, alarms);
        declaring.journal.begin(id, "settle", NOW);

        const withdrawn = isolate(database, { other: async () => undefined }, alarms, {
            now: () => NOW + 1
        });
        const result = await withdrawn.reconciler.handleAlarm();

        expect(result.succeededIds).toEqual([]);
        expect(result.failures[0]?.cause.message).toContain("Reconciliation failed");
        // Never acknowledged, and never claimed either: a release that cannot read the
        // work leaves it exactly as it found it, due again under its retry.
        expect(withdrawn.journal.record(id)).toEqual({
            work: "settle",
            attempts: 0,
            claimed: false
        });
        expect(await withdrawn.outbox.nextDueAt()).toBe(NOW + 1 + RETRY_DELAY_MS);
    });

    test("refuses a second concurrent attempt at one operation in the same isolate", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        let release = (): void => undefined;
        const work: ResumableWork = async () => {
            await new Promise<void>((settle) => {
                release = settle;
            });
        };

        const running = isolate(database, { settle: work }, alarms);
        running.journal.begin(id, "settle", NOW);
        const first = running.journal.resume(id);
        await Promise.resolve();

        await expect(running.journal.resume(id)).rejects.toThrow(
            `Resumable operation ${id.value} is already running in this isolate`
        );

        release();
        await first;
        expect(running.journal.record(id)).toBeUndefined();
    });

    test("reschedules the same unit of work rather than starting a second one", async () => {
        const database = storage();
        const alarms = new FakeAlarmStorage();
        const id = operationId();
        const journal = isolate(database, { settle: async () => undefined }, alarms).journal;

        journal.begin(id, "settle", NOW + 100);
        journal.begin(id, "settle", NOW + 500);

        expect(
            database.all("SELECT id, scheduled_at FROM agent_core_reconciliation_outbox", [])
        ).toEqual([{ id: id.value, scheduled_at: NOW + 500 }]);
        expect(database.all("SELECT id FROM agent_core_resumable_operations", [])).toEqual([
            { id: id.value }
        ]);
    });

    test("refuses to reuse one operation ID for a different unit of work", () => {
        const database = storage();
        const journal = isolate(
            database,
            { settle: async () => undefined, other: async () => undefined },
            new FakeAlarmStorage()
        ).journal;
        const id = operationId();

        journal.begin(id, "settle", NOW);

        expect(() => journal.begin(id, "other", NOW)).toThrow(
            `Resumable operation ${id.value} is already begun as settle`
        );
    });

    test("refuses to begin work this release does not declare", () => {
        const journal = isolate(
            storage(),
            { settle: async () => undefined },
            new FakeAlarmStorage()
        ).journal;

        expect(() => journal.begin(operationId(), "absent", NOW)).toThrow(
            "Resumable work absent is not declared by this runtime"
        );
    });

    test.each([
        ["empty", ""],
        ["padded", " first "],
        ["carrying the effect-key separator", "upload/part"]
    ])("refuses a step name that is %s", async (_case, step) => {
        const database = storage();
        const id = operationId();
        const journal = isolate(
            database,
            {
                settle: async (attempt: ResumableAttempt) =>
                    attempt.checkpoint(step, () => undefined)
            },
            new FakeAlarmStorage()
        ).journal;

        journal.begin(id, "settle", NOW);

        await expect(journal.resume(id)).rejects.toThrow(
            "Resumable step name must be nonempty canonical text without /"
        );
    });

    test("refuses a corrupt stored work name instead of resuming on it", async () => {
        const database = storage();
        const id = operationId();
        const journal = isolate(
            database,
            { settle: async () => undefined },
            new FakeAlarmStorage()
        ).journal;

        journal.begin(id, "settle", NOW);
        // STRICT keeps the representation of every column but the emptiness of text.
        database.run("UPDATE agent_core_resumable_operations SET work = ? WHERE id = ?", [
            "",
            id.value
        ]);

        await expect(journal.resume(id)).rejects.toThrow(
            "Stored resumable operation column work is corrupt"
        );
    });

    test("reads a counted-but-absent row as no record rather than a corrupt one", { tags: "p1" }, () => {
        const journal = new DurableOperationJournal(
            new MiscountingSqlite(),
            new NoSchedule(),
            { settle: async () => undefined },
            fakeErrors
        );

        expect(journal.record(operationId())).toBeUndefined();
    });

    test("refuses an operation ID that only looks like one", { tags: "p1" }, () => {
        const journal = isolate(
            storage(),
            { settle: async () => undefined },
            new FakeAlarmStorage()
        ).journal;

        // An operation ID is the unit of work's identity; a bare record carrying the same
        // text is not that identity, and reading one as an ID would let unvalidated text
        // claim, resume and clear another operation's journal.
        expectOperationalFailure(
            () => journal.record(malformedInput({ value: "operation-1" })),
            "operation.invalid-input"
        );
        expect(() => journal.begin(malformedInput({ value: "operation-1" }), "settle", NOW)).toThrow(
            "Resumable operation ID must be a ReconciliationOutboxId"
        );
    });

    test("refuses a work name that is not nonempty canonical text", { tags: "p1" }, () => {
        const database = storage();
        const outbox = new SqliteReconciliationOutbox(database, fakeErrors);

        // A padded key is a different name from the one a resumed attempt would look up.
        expect(
            () =>
                new DurableOperationJournal(
                    database,
                    outbox,
                    { " settle ": async () => undefined },
                    fakeErrors
                )
        ).toThrow("Resumable work name must be nonempty canonical text");
        const journal = new DurableOperationJournal(
            database,
            outbox,
            { settle: async () => undefined },
            fakeErrors
        );
        expect(() => journal.begin(operationId(), "", NOW)).toThrow(
            "Resumable work name must be nonempty canonical text"
        );
    });

    test("refuses a schedule it cannot wake at and records nothing", { tags: "p1" }, () => {
        const database = storage();
        const journal = isolate(database, { settle: async () => undefined }, new FakeAlarmStorage())
            .journal;

        for (const scheduledAt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => journal.begin(operationId(), "settle", scheduledAt)).toThrow(
                "Resumable operation schedule must be a nonnegative safe integer"
            );
        }

        // The guard runs before the transaction, so a refused begin leaves no operation
        // the driver would later find with an unusable wakeup.
        expect(database.all("SELECT id FROM agent_core_resumable_operations", [])).toEqual([]);
        expect(database.all("SELECT id FROM agent_core_reconciliation_outbox", [])).toEqual([]);
    });
});
