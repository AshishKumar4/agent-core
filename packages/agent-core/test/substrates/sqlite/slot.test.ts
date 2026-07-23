import { describe, expect, test } from "vitest";
import { JsonSchema } from "../../../src/core";
import { SlotAuthorityPolicy, SlotDeclaration, SlotName } from "../../../src/facets";
import { WorkspaceId } from "../../../src/identity";
import { SqliteWorkspaceSlotStore } from "../../../src/substrates/sqlite/slot";
import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite";
import { TestSqlite } from "../../helpers/sqlite";
import { entry, slot } from "../../w3/slot-store-contract";

const owner = new WorkspaceId("slot-owner-mutants");
const slotName = new SlotName("dashboard.card");

describe("SQLite Workspace Slot store exact failure and schema behavior", () => {
    test("reopens its own schema with state intact", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const first = new SqliteWorkspaceSlotStore(owner, database);
        first.install(slot());
        first.contribute(entry("workspace:reopen", 1, { title: "Reopen" }));

        const reopened = new SqliteWorkspaceSlotStore(owner, database);
        expect(reopened.revision().value).toBe(2);
        expect(reopened.entries(slotName)).toHaveLength(1);
        expect(reopened.slot(slotName)?.name.value).toBe("dashboard.card");
    });

    test("accepts an equivalently formatted out-of-band schema", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const statements = [
            `create table facet_slot_schema (singleton integer primary key check(singleton = 1),
                version integer not null check(version = 1),
                workspace text not null check(length(workspace) > 0)) strict`,
            `create table facet_slot_revision (singleton integer primary key check(singleton = 1),
                revision integer not null check(revision >= 0)) strict`,
            `create table facet_slots (name text primary key check(length(name) > 0),
                record blob not null) strict`,
            `create table facet_slot_entries (id text primary key check(length(id) > 0),
                slot text not null check(length(slot) > 0),
                contributor text not null check(length(contributor) > 0),
                ordinal integer not null check(ordinal >= 0),
                record blob not null, unique(slot, contributor, ordinal)) strict`,
            `create index facet_slot_entries_query
                on facet_slot_entries (slot, ordinal, contributor, id)`
        ];
        for (const statement of statements) {
            database.run(statement.replaceAll(/\s+/gu, " "), []);
        }
        database.run(
            "insert into facet_slot_schema (singleton, version, workspace) values (1, 1, ?)",
            [owner.value]
        );
        database.run("insert into facet_slot_revision (singleton, revision) values (1, 0)", []);

        const store = new SqliteWorkspaceSlotStore(owner, database);
        expect(store.revision().value).toBe(0);
        expect(store.install(slot()).value).toBe(1);
    });

    test("rejects a drifted expected schema object with the exact error", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, database);
        database.run("DROP INDEX facet_slot_entries_query", []);
        database.run("CREATE INDEX facet_slot_entries_query ON facet_slot_entries (slot)", []);

        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot schema object facet_slot_entries_query is malformed"
            })
        );
    });

    test("rejects a lost schema marker as exact malformed singleton state", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteWorkspaceSlotStore(owner, database);
        database.run("DELETE FROM facet_slot_schema", []);

        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot singleton state is malformed"
            })
        );
    });

    test("rejects marker rows tampered at the read seam with exact errors", { tags: "p1" }, () => {
        const database = new MarkerTamperSqlite();
        new SqliteWorkspaceSlotStore(owner, database);

        database.marker = "missing";
        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot schema belongs to a different Workspace or version"
            })
        );

        database.marker = { version: 2 };
        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot schema belongs to a different Workspace or version"
            })
        );

        database.marker = { workspace: "other-workspace" };
        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot schema belongs to a different Workspace or version"
            })
        );

        database.marker = { workspace: 7 };
        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot column workspace must be text"
            })
        );
    });

    test("rejects nested transactions with the exact invalid-state error", { tags: "p1" }, () => {
        const store = new SqliteWorkspaceSlotStore(owner, new TestSqlite());

        expect(() => store.transaction(() => store.transaction(() => 0))).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Nested SQLite Slot transactions are not supported"
            })
        );
        expect(store.revision().value).toBe(0);
    });

    test("requires the owning transaction for direct access", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(owner, database);

        expect(() => store.loadRevision(database)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "SQLite Slot access requires its owning transaction"
            })
        );
    });

    test("keeps installed declarations immutable with the exact error", { tags: "p0" }, () => {
        const store = new SqliteWorkspaceSlotStore(owner, new TestSqlite());
        store.install(slot());
        const conflicting = new SlotDeclaration(
            slotName,
            new JsonSchema({
                type: "object",
                required: ["heading"],
                properties: { heading: { type: "string" } },
                additionalProperties: false
            }),
            new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
        );

        expect(() => store.install(conflicting)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slot declaration dashboard.card is immutable"
            })
        );
        expect(store.revision().value).toBe(1);
        const stored = store.slot(slotName);
        expect(stored?.entrySchema.accepts({ title: "kept" })).toBe(true);
        expect(stored?.entrySchema.accepts({ heading: "replaced" })).toBe(false);
    });

    test("rejects contributions to uninstalled slots with the exact error", { tags: "p1" }, () => {
        const store = new SqliteWorkspaceSlotStore(owner, new TestSqlite());

        expect(() => store.contribute(entry("workspace:none", 1, { title: "None" }))).toThrow(
            expect.objectContaining({
                code: "facet.inactive",
                message: "Slot dashboard.card is not installed"
            })
        );
        expect(store.revision().value).toBe(0);
    });

    test("rejects declaration projection drift during startup validation", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceSlotStore(owner, database);
        store.install(slot());
        database.run("UPDATE facet_slots SET name = 'forged-slot'", []);

        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot declaration projection does not match codec bytes"
            })
        );
    });

    test("rejects every forged entry projection column with the exact error", { tags: "p1" }, () => {
        const forgeries: readonly (readonly [string, SqliteValue, string])[] = [
            ["id", "forged-id", "dashboard.card"],
            ["slot", "forged-slot", "forged-slot"],
            ["ordinal", 99, "dashboard.card"]
        ];

        for (const [column, value, queried] of forgeries) {
            const database = new TestSqlite();
            const store = new SqliteWorkspaceSlotStore(owner, database);
            store.install(slot());
            store.contribute(entry("workspace:forge", 1, { title: "Forged" }));
            database.run(`UPDATE facet_slot_entries SET ${column} = ?`, [value]);
            expect(() => store.entries(new SlotName(queried)), column).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "SQLite Slot entry projection does not match codec bytes"
                })
            );
        }
    });

    test("reports tampered revision values with the exact column error", { tags: "p2" }, () => {
        const database = new RevisionTamperSqlite();
        const store = new SqliteWorkspaceSlotStore(owner, database);

        for (const forged of [-1, 1.5]) {
            database.revision = forged;
            expect(() => store.revision(), String(forged)).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "SQLite Slot column revision must be a non-negative integer"
                })
            );
        }

        database.revision = "missing";
        expect(() => new SqliteWorkspaceSlotStore(owner, database)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "SQLite Slot revision does not match its records"
            })
        );
    });
});

class MarkerTamperSqlite extends TestSqlite {
    public marker: SqliteRow | "missing" | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (
            this.marker === undefined ||
            !statement.includes("SELECT version, workspace FROM facet_slot_schema")
        ) {
            return rows;
        }
        if (this.marker === "missing") return [];
        const patch = this.marker;
        return rows.map((row) => ({ ...row, ...patch }));
    }
}

class RevisionTamperSqlite extends TestSqlite {
    public revision: number | "missing" | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (
            this.revision === undefined ||
            !statement.includes("SELECT revision FROM facet_slot_revision")
        ) {
            return rows;
        }
        if (this.revision === "missing") return [];
        const forged = this.revision;
        return rows.map((row) => ({ ...row, revision: forged }));
    }
}
