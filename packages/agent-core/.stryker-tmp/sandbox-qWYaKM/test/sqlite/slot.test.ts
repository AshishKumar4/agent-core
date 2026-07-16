// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JsonSchema } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { WorkspaceId } from "../../src/identity";
import { SlotDeclaration, SlotEntry, SlotEntryId, SlotName } from "../../src/facets";
import { SqliteWorkspaceSlotStore } from "../../src/substrates/sqlite/slot";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import {
    contribute,
    entry,
    install,
    slot,
    workspaceSlotStoreContract
} from "../w3/slot-store-contract";

workspaceSlotStoreContract(
    "SQLite",
    (owner) => new SqliteWorkspaceSlotStore(owner, new TestSqlite())
);

describe("SqliteWorkspaceSlotStore persistence", () => {
    test("survives adapter recreation and rejects a different Workspace owner", () => {
        const database = new TestSqlite();
        const owner = new WorkspaceId("workspace");
        const store = new SqliteWorkspaceSlotStore(owner, database);
        install(store, slot());
        contribute(store, entry("workspace:facet", 1, { title: "Card" }));

        const restarted = new SqliteWorkspaceSlotStore(owner, database);
        expect(restarted.entries(slot().name)).toHaveLength(1);
        expect(restarted.slot(slot().name)).toBeDefined();
        expect(restarted.revision().value).toBe(2);
        expect(() => new SqliteWorkspaceSlotStore(new WorkspaceId("foreign"), database)).toThrow(
            /different Workspace/
        );
    });

    test("survives file close and reopen", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-slot-"));
        const path = join(directory, "slot.sqlite");
        try {
            const owner = new WorkspaceId("workspace");
            const firstDatabase = new FileSqlite(path);
            const first = new SqliteWorkspaceSlotStore(owner, firstDatabase);
            install(first, slot());
            contribute(first, entry("workspace:facet", 1, { title: "Card" }));
            firstDatabase.close();

            const reopenedDatabase = new FileSqlite(path);
            const reopened = new SqliteWorkspaceSlotStore(owner, reopenedDatabase);
            expect(
                reopened.transaction((transaction) =>
                    reopened.listEntries(transaction, slot().name)
                )
            ).toHaveLength(1);
            reopenedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("fails closed on projection corruption", () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
        install(store, slot());
        const candidate = entry("workspace:facet", 1, { title: "Card" });
        contribute(store, candidate);
        database.run("UPDATE facet_slot_entries SET contributor = ? WHERE id = ?", [
            "workspace:forged",
            candidate.id.value
        ]);

        expect(() =>
            store.transaction((transaction) => store.listEntries(transaction, slot().name))
        ).toThrow(/projection/);
    });

    test("rejects a transaction from another database", () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
        expect(() => store.loadRevision(new TestSqlite())).toThrow(/owning transaction/);
        expect(() => store.loadRevision(database)).toThrow(/owning transaction/);
    });

    test("rejects precreated weak schemas and broken entry closure", () => {
        const weak = new TestSqlite();
        weak.run("CREATE TABLE facet_slot_schema (singleton, version, workspace)", []);
        expect(() => new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), weak)).toThrow(
            /malformed/
        );

        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
        install(store, slot());
        contribute(store, entry("workspace:facet", 1, { title: "Card" }));
        database.run("DELETE FROM facet_slots WHERE name = ?", [slot().name.value]);
        expect(() => store.entries(slot().name)).toThrow(/violates/);
    });

    test("rejects nested access, revision conflicts, immutable declarations, and invalid entries with typed codes", () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
        const declaration = slot();
        store.install(declaration);

        expectAgentCoreError(
            () => store.transaction(() => store.transaction(() => true)),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                store.transaction((transaction) =>
                    store.saveRevision(transaction, store.loadRevision(transaction).next().next())
                ),
            "protocol.revision-conflict"
        );
        expectAgentCoreError(
            () =>
                store.install(
                    new SlotDeclaration(
                        declaration.name,
                        new JsonSchema({ type: "string" }),
                        declaration.authority
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () => store.contribute(entry("workspace:bad", 2, { bad: true })),
            "operation.invalid-input"
        );
        expect(
            store.transaction((transaction) =>
                store.loadEntry(transaction, entry("workspace:missing", 9, { title: "Missing" }).id)
            )
        ).toBeUndefined();
        expect(entry("workspace:typed", 10, { title: "Typed" }).id).toBeInstanceOf(SlotEntryId);
        expect(store.slot(new SlotName("missing"))).toBeUndefined();
    });

    test("rejects partial schemas, missing singleton state, and unexpected protected objects on restart", () => {
        const owner = new WorkspaceId("workspace");
        const partial = new TestSqlite();
        partial.run("CREATE TABLE facet_slots (name TEXT PRIMARY KEY, record BLOB) STRICT", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, partial)).toThrow(/malformed/);

        const missingRevision = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, missingRevision);
        missingRevision.run("DELETE FROM facet_slot_revision", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, missingRevision)).toThrow(/singleton/);

        const unexpectedIndex = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, unexpectedIndex);
        unexpectedIndex.run("CREATE INDEX hostile_slot_index ON facet_slots (name)", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, unexpectedIndex)).toThrow(
            /Unexpected SQLite index/
        );

        const unexpectedTrigger = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, unexpectedTrigger);
        unexpectedTrigger.run(
            "CREATE TRIGGER hostile_slot_trigger AFTER INSERT ON facet_slots BEGIN SELECT 1; END",
            []
        );
        expect(() => new SqliteWorkspaceSlotStore(owner, unexpectedTrigger)).toThrow(
            /Unexpected SQLite trigger/
        );

        const wrongRevision = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, wrongRevision);
        wrongRevision.run("UPDATE facet_slot_revision SET revision = 99", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, wrongRevision)).toThrow(/revision/);

        const corruptRecord = new TestSqlite();
        const corruptStore = new SqliteWorkspaceSlotStore(owner, corruptRecord);
        corruptStore.install(slot());
        corruptRecord.run("UPDATE facet_slots SET record = ?", [new Uint8Array([1, 2, 3])]);
        expect(() => new SqliteWorkspaceSlotStore(owner, corruptRecord)).toThrow();

        const orphan = new TestSqlite();
        const orphanStore = new SqliteWorkspaceSlotStore(owner, orphan);
        orphanStore.install(slot());
        orphanStore.contribute(entry("workspace:facet", 0, { title: "Card" }));
        orphan.run("DELETE FROM facet_slots", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, orphan)).toThrow(/violates/);

        const invalidEntryDatabase = new TestSqlite();
        const invalidEntryStore = new SqliteWorkspaceSlotStore(owner, invalidEntryDatabase);
        invalidEntryStore.install(slot());
        const invalid = entry("workspace:invalid", 0, { invalid: true });
        invalidEntryDatabase.run(
            `INSERT INTO facet_slot_entries (id, slot, contributor, ordinal, record)
             VALUES (?, ?, ?, ?, ?)`,
            [
                invalid.id.value,
                invalid.slot.value,
                invalid.contributor.value,
                invalid.ordinal,
                SlotEntry.encode(invalid)
            ]
        );
        invalidEntryDatabase.run("UPDATE facet_slot_revision SET revision = 2", []);
        expect(() => new SqliteWorkspaceSlotStore(owner, invalidEntryDatabase)).toThrow(/violates/);
    });

    test("fails closed when a hostile SQLite adapter returns invalid projected types", () => {
        const revisionDatabase = new TestSqlite();
        const revisionStore = new SqliteWorkspaceSlotStore(
            new WorkspaceId("workspace"),
            revisionDatabase
        );
        const revisionAll = revisionDatabase.all.bind(revisionDatabase);
        revisionDatabase.all = (statement, bindings) =>
            statement.includes("SELECT revision FROM facet_slot_revision")
                ? [{ revision: "invalid" }]
                : revisionAll(statement, bindings);
        expect(() => revisionStore.revision()).toThrow(/integer/);

        const recordDatabase = new TestSqlite();
        const recordStore = new SqliteWorkspaceSlotStore(
            new WorkspaceId("workspace"),
            recordDatabase
        );
        recordStore.install(slot());
        const recordAll = recordDatabase.all.bind(recordDatabase);
        recordDatabase.all = (statement, bindings) => {
            const rows = recordAll(statement, bindings);
            return statement.includes("FROM facet_slots WHERE name") && rows[0] !== undefined
                ? [{ ...rows[0], record: "invalid" }]
                : rows;
        };
        expect(() => recordStore.slot(slot().name)).toThrow(/bytes/);
    });
});

function expectAgentCoreError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
