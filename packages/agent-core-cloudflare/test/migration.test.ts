import {
    SqliteApplicationMigrator,
    ReconciliationOutboxId,
    SqliteReconciliationOutbox,
    cloudflareRuntimeMigrations,
    type SqliteRow
} from "../src/index.js";
import { FakeRuntimeSqlite, fakeErrors } from "./fakes.js";
import { expectOperationalFailure } from "./assertions.js";

describe("SQLite application durability", () => {
    test("applies ordered synchronous migrations once and records markers last", () => {
        const database = new FakeRuntimeSqlite();
        const migrations = [
            { version: 1, name: "first", statements: ["CREATE TABLE first (id INTEGER)"] },
            { version: 2, name: "second", statements: ["CREATE TABLE second (id INTEGER)"] }
        ];
        const migrator = new SqliteApplicationMigrator(database, fakeErrors, migrations);

        expect(migrator.migrate()).toEqual([1, 2]);
        const callsAfterFirstRun = database.calls.length;
        expect(migrator.migrate()).toEqual([1, 2]);
        expect(database.calls.slice(callsAfterFirstRun).map((call) => call.statement)).toEqual([
            expect.stringContaining("CREATE TABLE IF NOT EXISTS agent_core_migrations"),
            "SELECT version, name FROM agent_core_migrations ORDER BY version"
        ]);
        expect([...database.migrationMarkers()]).toEqual([
            [1, "first"],
            [2, "second"]
        ]);
        const markerIndex = database.calls.findIndex((call) =>
            call.statement.startsWith("INSERT INTO agent_core_migrations")
        );
        expect(markerIndex).toBeGreaterThan(
            database.calls.findIndex((call) => call.statement.startsWith("CREATE TABLE first"))
        );
    });

    test("ships only view, outbox-ID, and migration-marker schema", () => {
        const statements = cloudflareRuntimeMigrations.flatMap((migration) => migration.statements);
        expect(statements.join("\n")).toContain("agent_core_view_snapshots");
        expect(statements.join("\n")).toContain("agent_core_view_deltas");
        expect(statements.join("\n")).toContain("agent_core_reconciliation_outbox");
        expect(statements.join("\n")).not.toMatch(/receipt|authority|grant/i);
    });

    test("[C13-CLOUDFLARE-ROLLBACK-WINDOW] rejects invalid migration declarations and mismatched durable markers", () => {
        const database = new FakeRuntimeSqlite();
        expect(
            () =>
                new SqliteApplicationMigrator(database, fakeErrors, [
                    { version: 0, name: "bad", statements: ["SELECT 1"] }
                ])
        ).toThrow(TypeError);
        expect(
            () =>
                new SqliteApplicationMigrator(database, fakeErrors, [
                    { version: 2, name: "gap", statements: ["SELECT 1"] }
                ])
        ).toThrow(TypeError);
        expect(
            () =>
                new SqliteApplicationMigrator(database, fakeErrors, [
                    { version: 1, name: "", statements: ["SELECT 1"] }
                ])
        ).toThrow(TypeError);
        expect(
            () =>
                new SqliteApplicationMigrator(database, fakeErrors, [
                    { version: 1, name: "bad", statements: [" "] }
                ])
        ).toThrow(TypeError);

        new SqliteApplicationMigrator(database, fakeErrors, [
            { version: 1, name: "original", statements: ["SELECT 1"] }
        ]).migrate();
        expectOperationalFailure(
            () =>
                new SqliteApplicationMigrator(database, fakeErrors, [
                    { version: 1, name: "changed", statements: ["SELECT 1"] }
                ]).migrate(),
            "schema.unreadable"
        );
        expectOperationalFailure(
            () => new SqliteApplicationMigrator(database, fakeErrors, []).migrate(),
            "schema.unreadable"
        );

        const corruptMarkers = (rows: readonly SqliteRow[]) => ({
            all: () => rows,
            run: () => {},
            transaction: <Result>(
                operation: () => Result,
                ..._guard: import("../src/index.js").SynchronousResultGuard<Result>
            ): Result => operation()
        });
        expectOperationalFailure(
            () =>
                new SqliteApplicationMigrator(
                    corruptMarkers([{ version: "bad", name: "name" }]),
                    fakeErrors,
                    []
                ).migrate(),
            "schema.unreadable"
        );
        expectOperationalFailure(
            () =>
                new SqliteApplicationMigrator(
                    corruptMarkers([
                        { version: 1, name: "one" },
                        { version: 1, name: "one" }
                    ]),
                    fakeErrors,
                    []
                ).migrate(),
            "schema.unreadable"
        );
    });

    test("persists only reconciliation IDs and scheduling metadata", async () => {
        const outbox = new SqliteReconciliationOutbox(new FakeRuntimeSqlite(), fakeErrors);
        outbox.enqueue(new ReconciliationOutboxId("later"), 20);
        outbox.enqueue(new ReconciliationOutboxId("first"), 10);
        expect(await outbox.nextDueAt()).toBe(10);
        expect(await outbox.dueIds(10, 5)).toEqual([
            { id: new ReconciliationOutboxId("first"), scheduledAt: 10 }
        ]);
        await outbox.reschedule({ id: new ReconciliationOutboxId("first"), scheduledAt: 10 }, 30);
        expect(await outbox.dueIds(20, 5)).toEqual([
            { id: new ReconciliationOutboxId("later"), scheduledAt: 20 }
        ]);
        await outbox.acknowledge({ id: new ReconciliationOutboxId("later"), scheduledAt: 20 });
        expect(await outbox.nextDueAt()).toBe(30);
        await outbox.acknowledge({ id: new ReconciliationOutboxId("first"), scheduledAt: 30 });
        expect(await outbox.nextDueAt()).toBeNull();
    });
});
