import {
    AlarmOutboxReconciler,
    PERMIT_PRUNE_LIMIT,
    PERMIT_RETENTION_INTERVAL_MILLISECONDS,
    PERMIT_RETENTION_MILLISECONDS,
    PERMIT_RETENTION_PAGE_DELAY_MILLISECONDS,
    PermitRetentionSweep,
    ReconciliationOutboxId,
    ScheduledPermitRetention,
    SqliteReconciliationOutbox,
    cloudflareRuntimeMigrations,
    type SynchronousResultGuard,
    type SynchronousSqlitePort
} from "../src/index.js";
import { SqliteApplicationMigrator } from "../src/migration.js";
import { expectOperationalFailure } from "./assertions.js";
import { FakeAlarmStorage, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

const RETENTION_ENTRY = new ReconciliationOutboxId("agent-core.permit-retention");
const OWNER = "agent-core.permit-retention";
const PAGE = 2;

/**
 * A store whose pages are scripted, so the driver is what this file tests rather than the
 * prune predicate. Each page reports what a real backlog reports: a full page while work
 * remains, a short page at the end, and a cursor that advances past everything examined.
 */
class ScriptedPermitStore {
    public readonly cursors: string[] = [];
    /** What each page was asked for, so the window and the bound are observable. */
    public readonly pages: { readonly before: Date; readonly limit: number }[] = [];
    #remaining: number;

    public constructor(rows: number) {
        this.#remaining = rows;
    }

    public transaction<Result>(operation: (transaction: never) => Result): Result {
        // SAFETY: the scripted store's prune never reads its transaction, so the driver's
        // pass-through value is unobserved; `never` keeps every other use a type error.
        return operation(undefined as never);
    }

    public prune(_transaction: never, before: Date, limit: number, after: string) {
        this.cursors.push(after);
        this.pages.push({ before, limit });
        const examined = Math.min(limit, this.#remaining);
        this.#remaining -= examined;
        return Object.freeze({
            removed: examined,
            examined,
            more: examined >= limit,
            cursor: `row-${this.cursors.length}`
        });
    }
}

function retention(rows: number) {
    const database = new NodeSqlite();
    new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
    const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
    const store = new ScriptedPermitStore(rows);
    let clock = 1_000;
    const driver = new ScheduledPermitRetention({
        sweep: new PermitRetentionSweep({
            store,
            errors: fakeErrors,
            now: () => clock,
            limit: PAGE
        }),
        database,
        outbox,
        entry: RETENTION_ENTRY,
        owner: OWNER,
        errors: fakeErrors,
        now: () => clock,
        intervalMilliseconds: 60_000,
        pageDelayMilliseconds: 10
    });
    const alarms = new FakeAlarmStorage();
    const reconciler = new AlarmOutboxReconciler(
        alarms,
        outbox,
        async (id) => {
            if (driver.owns(id)) await driver.reconcile();
        },
        fakeErrors
    );
    return {
        store,
        outbox,
        driver,
        alarms,
        reconciler,
        advance: (to: number) => {
            clock = to;
        }
    };
}

describe("scheduled permit retention", () => {
    test(
        "a scheduled sweep drains a multi-page backlog across alarm fires and re-arms while more remains",
        { tags: "p0" },
        async () => {
            // Five rows at two per page: two full pages, then a short one that ends the pass.
            const { store, outbox, driver, alarms, reconciler, advance } = retention(5);
            outbox.enqueue(driver.entry, 1_000);
            await reconciler.armAlarm();
            expect(alarms.scheduledAt).toBe(1_000);

            const fires: number[] = [];
            for (let fire = 0; fire < 3; fire += 1) {
                advance(1_000 + fire * 100);
                const result = await reconciler.handleAlarm();
                expect(result.failures).toEqual([]);
                if (alarms.scheduledAt !== null) fires.push(alarms.scheduledAt);
            }

            // Every page ran, and each resumed from the cursor the previous one reported
            // rather than restarting at the head of the ordering.
            expect(store.cursors).toEqual(["", "row-1", "row-2"]);

            // While the backlog remained the alarm was re-armed at the short page delay; the
            // pass that drained it fell back to the long interval, so retention keeps running
            // without spinning once there is nothing to do.
            expect(fires[0]).toBe(1_000 + 10);
            expect(fires[1]).toBe(1_100 + 10);
            expect(fires[2]).toBe(1_200 + 60_000);

            // The cursor resets once the pass completes, so the next pass starts fresh.
            const nextPass = await reconciler.handleAlarm();
            expect(nextPass.failures).toEqual([]);
            expect(store.cursors[3]).toBe("");
        }
    );

    test(
        "a retention entry stays armed rather than being acknowledged away",
        { tags: "p0" },
        async () => {
            const { outbox, driver, alarms, reconciler, advance } = retention(4);
            outbox.enqueue(driver.entry, 1_000);
            await reconciler.armAlarm();

            advance(1_000);
            await reconciler.handleAlarm();

            // Re-enqueuing inside the sweep moves the entry's schedule forward, and the
            // acknowledgement fences on the schedule the sweep observed, so the newer schedule
            // survives and the alarm still points at it.
            expect(await outbox.nextDueAt()).toBe(1_010);
            expect(alarms.scheduledAt).toBe(1_010);
        }
    );

    test("the driver only answers for its own outbox entry", { tags: "p1" }, async () => {
        const { store, driver } = retention(4);

        expect(driver.owns(driver.entry)).toBe(true);
        expect(driver.owns(new ReconciliationOutboxId("some-other-work"))).toBe(false);
        // An entry it does not own must not consume a retention page.
        expect(store.cursors).toEqual([]);
    });

    test(
        "a repeated delivery re-reads the durable cursor rather than advancing twice",
        { tags: "p0" },
        async () => {
            const database = new NodeSqlite();
            new SqliteApplicationMigrator(
                database,
                fakeErrors,
                cloudflareRuntimeMigrations
            ).migrate();
            const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
            const store = new ScriptedPermitStore(6);
            const driver = new ScheduledPermitRetention({
                sweep: new PermitRetentionSweep({
                    store,
                    errors: fakeErrors,
                    now: () => 1_000,
                    limit: PAGE
                }),
                database,
                outbox,
                entry: RETENTION_ENTRY,
                owner: OWNER,
                errors: fakeErrors,
                now: () => 1_000
            });

            await driver.reconcile();
            const afterFirst = store.cursors.length;
            // At-least-once delivery: the same entry arrives again. The cursor is durable, so the
            // repeat resumes from where the first run left off instead of skipping a page.
            await driver.reconcile();

            expect(store.cursors).toHaveLength(afterFirst + 1);
            expect(store.cursors[1]).toBe("row-1");
        }
    );
});

describe("permit retention bounds", () => {
    test(
        "prunes only past the retention window, and never past the epoch",
        { tags: "p0" },
        () => {
            const store = new ScriptedPermitStore(1);
            let clock = PERMIT_RETENTION_MILLISECONDS + 5_000;
            const sweep = new PermitRetentionSweep({
                store,
                errors: fakeErrors,
                now: () => clock
            });

            sweep.sweep();
            // A settled permit's rows are kept past expiry for the retention window, so
            // the sweep may only remove what fell out of it: a sweep that passed `now`
            // would delete rows still inside their window.
            expect(store.pages[0]?.before.getTime()).toBe(5_000);
            // Nothing was overridden, so the page is the exported default bound: the
            // sweep exists to remove an unbounded scan, not to become one.
            expect(store.pages[0]?.limit).toBe(PERMIT_PRUNE_LIMIT);

            // A clock inside the window has nothing expired behind it, and the window
            // clamps at the epoch rather than reaching back before time.
            clock = 10;
            sweep.sweep("row-1");
            expect(store.pages[1]?.before.getTime()).toBe(0);
            expect(store.cursors).toEqual(["", "row-1"]);
        }
    );

    test("refuses a clock that cannot name an instant", { tags: "p0" }, () => {
        for (const reading of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
            const store = new ScriptedPermitStore(4);
            const sweep = new PermitRetentionSweep({
                store,
                errors: fakeErrors,
                now: () => reading
            });

            // A retention window derived from a clock like this would delete rows by
            // accident, so the sweep refuses before it opens a transaction.
            expectOperationalFailure(() => sweep.sweep(), "operation.invalid-output");
            expect(store.cursors).toEqual([]);
        }
    });

    test("refuses a bound that does not bound anything", { tags: "p1" }, () => {
        const store = new ScriptedPermitStore(4);
        const now = () => 1_000;
        for (const unbounded of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(
                () => new PermitRetentionSweep({ store, errors: fakeErrors, now, limit: unbounded })
            ).toThrow(TypeError);
            expect(
                () =>
                    new PermitRetentionSweep({
                        store,
                        errors: fakeErrors,
                        now,
                        retentionMilliseconds: unbounded
                    })
            ).toThrow(TypeError);

            const sweep = new PermitRetentionSweep({ store, errors: fakeErrors, now });
            const database = new NodeSqlite();
            new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
            const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
            const options = {
                sweep,
                database,
                outbox,
                entry: RETENTION_ENTRY,
                owner: OWNER,
                errors: fakeErrors,
                now
            };
            expect(
                () =>
                    new ScheduledPermitRetention({ ...options, intervalMilliseconds: unbounded })
            ).toThrow(TypeError);
            expect(
                () => new ScheduledPermitRetention({ ...options, pageDelayMilliseconds: unbounded })
            ).toThrow(TypeError);
        }
    });

    test(
        "rearms a drained pass at the exported interval and a backlog at the page delay",
        { tags: "p1" },
        async () => {
            const database = new NodeSqlite();
            new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
            const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
            const store = new ScriptedPermitStore(PERMIT_PRUNE_LIMIT + 1);
            const driver = new ScheduledPermitRetention({
                sweep: new PermitRetentionSweep({ store, errors: fakeErrors, now: () => 1_000 }),
                database,
                outbox,
                entry: RETENTION_ENTRY,
                owner: OWNER,
                errors: fakeErrors,
                now: () => 1_000
            });

            // A full page leaves more to do, so the next one is scheduled at the short
            // delay rather than spending a whole alarm here.
            await driver.reconcile();
            expect(await outbox.nextDueAt()).toBe(1_000 + PERMIT_RETENTION_PAGE_DELAY_MILLISECONDS);

            // The pass that drains the backlog falls back to the long interval, so
            // retention keeps running without spinning once there is nothing to do.
            await driver.reconcile();
            expect(await outbox.nextDueAt()).toBe(1_000 + PERMIT_RETENTION_INTERVAL_MILLISECONDS);
            expect(store.cursors).toEqual(["", "row-1"]);
        }
    );

    test("refuses a stored cursor that is not text", { tags: "p0" }, async () => {
        const database = new NodeSqlite();
        new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
        const outbox = new SqliteReconciliationOutbox(database, fakeErrors);
        const store = new ScriptedPermitStore(4);
        // The runtime table is STRICT, so a live deployment's own rows cannot hold this.
        // The driver reads its cursor through the port seam, whose contract admits any
        // stored value, which is the reason the read validates rather than assumes.
        const corrupt: SynchronousSqlitePort = {
            all: (statement, bindings) =>
                statement.includes("FROM agent_core_permit_retention")
                    ? [{ cursor: 42 }]
                    : database.all(statement, bindings),
            run: (statement, bindings) => {
                database.run(statement, bindings);
            },
            transaction: <Result>(
                operation: () => Result,
                ...guard: SynchronousResultGuard<Result>
            ): Result => database.transaction(operation, ...guard)
        };
        const driver = new ScheduledPermitRetention({
            sweep: new PermitRetentionSweep({ store, errors: fakeErrors, now: () => 1_000 }),
            database: corrupt,
            outbox,
            entry: RETENTION_ENTRY,
            owner: OWNER,
            errors: fakeErrors,
            now: () => 1_000
        });

        // A cursor that is not text would resume the keyset from a value no row can be
        // compared against, so the pass refuses instead of sweeping from nowhere.
        await expect(driver.reconcile()).rejects.toMatchObject({ code: "codec.invalid" });
        expect(store.cursors).toEqual([]);
    });
});
