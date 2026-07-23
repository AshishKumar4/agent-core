import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../src/actors";
import { SqliteWorkspaceEventRecords } from "../../../src/substrates/sqlite/events/records";
import {
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite/sqlite";
import { WorkspacePersistence } from "../../../src/workspaces";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";
import { eventFixture, eventRetention, sourceActor, tenant } from "../../workspaces/fixtures";
import {
    workspacePersistenceContract,
    type WorkspacePersistenceHarness
} from "../../events/persistence-contract";

workspacePersistenceContract("SQLite", createSqliteHarness);

test("file-backed SQLite records survive a database close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-events-"));
    const path = join(directory, "events.sqlite");
    const event = eventFixture("sqlite-file-restart");
    let database: FileSqlite | undefined;
    try {
        database = new FileSqlite(path);
        let records = new SqliteWorkspaceEventRecords(database);
        let persistence = new WorkspacePersistence<TransactionalSqlite>(
            () => records,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        database.transaction(() =>
            persistence.appendEvent(database!, event, eventRetention(event))
        );
        database.close();

        database = new FileSqlite(path);
        records = new SqliteWorkspaceEventRecords(database);
        persistence = new WorkspacePersistence<TransactionalSqlite>(
            () => records,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        database.transaction(() => {
            expect(persistence.findEvent(database!, event.id)?.id).toEqual(event.id);
        });
    } finally {
        database?.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects preexisting lax workspace event tables", () => {
    const database = new TestSqlite();
    database.run(
        "CREATE TABLE workspace_event_records (kind TEXT, id TEXT, bytes BLOB) STRICT",
        []
    );

    expect(() => new SqliteWorkspaceEventRecords(database)).toThrow(/schema is incompatible/);
});

test("verifies initial pointer compare-and-set postconditions", () => {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceEventRecords(database);
    database.run(
        `CREATE TRIGGER ignore_workspace_pointer
         BEFORE INSERT ON workspace_event_pointers
         BEGIN SELECT RAISE(IGNORE); END`,
        []
    );

    expect(() =>
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "surface",
                recordKey: "surface@0"
            },
            undefined
        )
    ).toThrow(/lost a concurrent race/);
});

test("duplicate records are rejected before the insert executes", { tags: "p1" }, () => {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceEventRecords(database);
    database.run(
        `CREATE TRIGGER ignore_duplicate_records
         BEFORE INSERT ON workspace_event_records
         WHEN EXISTS (
             SELECT 1 FROM workspace_event_records
             WHERE kind = NEW.kind AND id = NEW.id
         )
         BEGIN SELECT RAISE(IGNORE); END`,
        []
    );
    records.insertRecord({ kind: "event", id: "append-once", bytes: Uint8Array.of(1, 2) });

    expect(() =>
        records.insertRecord({ kind: "event", id: "append-once", bytes: Uint8Array.of(9) })
    ).toThrow(
        expect.objectContaining({
            code: "protocol.duplicate",
            message: "Workspace records are append-only"
        })
    );
    expect(records.findRecord("event", "append-once")?.bytes).toEqual(Uint8Array.of(1, 2));
});

test("record insert failures surface the exact append-only error", { tags: "p1" }, () => {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceEventRecords(database);
    database.run(
        `CREATE TRIGGER fail_workspace_records
         BEFORE INSERT ON workspace_event_records
         BEGIN SELECT RAISE(ABORT, 'injected record fault'); END`,
        []
    );

    expect(() =>
        records.insertRecord({ kind: "event", id: "faulted", bytes: Uint8Array.of(1) })
    ).toThrow(
        expect.objectContaining({
            code: "protocol.duplicate",
            message: "Workspace records are append-only"
        })
    );
    expect(records.findRecord("event", "faulted")).toBeUndefined();
});

test(
    "duplicate unique reservations are rejected before the insert executes",
    { tags: "p1" },
    () => {
        const database = new TestSqlite();
        const records = new SqliteWorkspaceEventRecords(database);
        database.run(
            `CREATE TRIGGER ignore_duplicate_uniques
             BEFORE INSERT ON workspace_event_uniques
             WHEN EXISTS (
                 SELECT 1 FROM workspace_event_uniques
                 WHERE namespace = NEW.namespace AND key = NEW.key
             )
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );
        records.insertUnique({
            namespace: "event.idempotency",
            key: "reserved",
            recordKey: "first"
        });

        expect(() =>
            records.insertUnique({
                namespace: "event.idempotency",
                key: "reserved",
                recordKey: "second"
            })
        ).toThrow(
            expect.objectContaining({
                code: "protocol.duplicate",
                message: "Workspace unique key is already reserved"
            })
        );
        expect(records.findUnique("event.idempotency", "reserved")?.recordKey).toBe("first");
    }
);

test("pointer compare-and-set reports a stale expectation exactly", { tags: "p0" }, () => {
    const records = new SqliteWorkspaceEventRecords(new TestSqlite());
    records.compareAndSetPointer(
        { namespace: "view.current", key: "surface", recordKey: "surface@0" },
        undefined
    );

    expect(() =>
        records.compareAndSetPointer(
            { namespace: "view.current", key: "surface", recordKey: "surface@2" },
            "surface@1"
        )
    ).toThrow(
        expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "Workspace pointer compare-and-set failed"
        })
    );
    expect(records.findPointer("view.current", "surface")?.recordKey).toBe("surface@0");
});

test("schema comparison tolerates whitespace layout but not content drift", { tags: "p1" }, () => {
    const reference = new TestSqlite();
    new SqliteWorkspaceEventRecords(reference);
    const tables = [
        "workspace_event_records",
        "workspace_event_uniques",
        "workspace_event_pointers"
    ];

    const collapsed = new TestSqlite();
    for (const table of tables) {
        collapsed.run(tableSql(reference, table).replaceAll(/\s+/gu, " "), []);
    }
    const collapsedRecords = new SqliteWorkspaceEventRecords(collapsed);
    collapsedRecords.insertRecord({ kind: "event", id: "normalized", bytes: Uint8Array.of(3) });
    expect(collapsedRecords.findRecord("event", "normalized")?.bytes).toEqual(Uint8Array.of(3));

    const padded = new TestSqlite();
    for (const table of tables) {
        padded.run(`${tableSql(reference, table)}\n    `, []);
    }
    expect(new SqliteWorkspaceEventRecords(padded).findRecord("event", "missing")).toBeUndefined();

    const drifted = new TestSqlite();
    drifted.run(tableSql(reference, "workspace_event_records").replace("'event'", "'even t'"), []);
    expect(() => new SqliteWorkspaceEventRecords(drifted)).toThrow(
        "SQLite schema is incompatible: workspace_event_records"
    );
});

test("record reads return defensive byte copies of reused rows", { tags: "p1" }, () => {
    const records = new SqliteWorkspaceEventRecords(new RecordCachingSqlite());
    records.insertRecord({ kind: "event", id: "shared", bytes: Uint8Array.of(1, 2, 3) });

    const found = records.findRecord("event", "shared");
    expect(found?.bytes).toEqual(Uint8Array.of(1, 2, 3));
    if (found !== undefined) found.bytes[0] = 9;
    expect(records.findRecord("event", "shared")?.bytes).toEqual(Uint8Array.of(1, 2, 3));

    const listed = records.listRecords("event")[0];
    if (listed !== undefined) listed.bytes[1] = 9;
    expect(records.listRecords("event")[0]?.bytes).toEqual(Uint8Array.of(1, 2, 3));
});

function tableSql(database: TestSqlite, table: string): string {
    const sql = database.all("SELECT sql FROM sqlite_master WHERE name = ?", [table])[0]?.["sql"];
    if (typeof sql !== "string") throw new TypeError(`Missing SQLite DDL for ${table}`);
    return sql;
}

class RecordCachingSqlite extends TestSqlite {
    readonly #cache = new Map<string, readonly SqliteRow[]>();

    public override all(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        if (!statement.includes("FROM workspace_event_records")) {
            return super.all(statement, bindings);
        }
        const key = `${statement} ${JSON.stringify(bindings)}`;
        const cached = this.#cache.get(key);
        if (cached !== undefined) return cached;
        const rows = super.all(statement, bindings);
        if (rows.length > 0) this.#cache.set(key, rows);
        return rows;
    }
}

function createSqliteHarness(): WorkspacePersistenceHarness<TransactionalSqlite> {
    const database = new TestSqlite();
    let records = new SqliteWorkspaceEventRecords(database);
    const persistence = new WorkspacePersistence<TransactionalSqlite>(
        () => records,
        { verify: () => true, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );
    return {
        persistence,
        transaction<Result>(
            operation: (transaction: TransactionalSqlite) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return database.transaction(() => operation(database), ...guard);
        },
        restart(): void {
            records = new SqliteWorkspaceEventRecords(database);
        },
        dispose(): void {}
    };
}
