// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../src/actors";
import { SqliteWorkspaceEventRecords } from "../../../src/substrates/sqlite/events/records";
import { TransactionalSqlite } from "../../../src/substrates/sqlite/sqlite";
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
