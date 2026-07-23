import { describe, expect, test } from "vitest";
import { SqliteProtocolPersistence, type SqliteRow, type SqliteValue } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import {
    appendProtocolTestRecords,
    protocolTestRecords,
    type ProtocolTestRecords
} from "../../protocol/persistence-contract";

class RowTamperSqlite extends TestSqlite {
    public tamper: ((statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[]) | undefined;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        return this.tamper === undefined ? rows : this.tamper(statement, rows);
    }
}

class ViewRebuildLossSqlite extends TestSqlite {
    public suppressRebuild = false;

    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (
            this.suppressRebuild &&
            (statement === "DROP VIEW protocol_command_identities" ||
                statement.startsWith("CREATE VIEW protocol_command_identities"))
        ) {
            return;
        }
        super.run(statement, bindings);
    }
}

class IndexRebuildFaultSqlite extends TestSqlite {
    public failPrincipalIndex = false;

    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (
            this.failPrincipalIndex &&
            statement.startsWith("CREATE UNIQUE INDEX protocol_principal_identity")
        ) {
            throw new Error("index rebuild fault");
        }
        super.run(statement, bindings);
    }
}

function corruptProtocol(message: string) {
    return expect.objectContaining({ code: "codec.invalid", message });
}

function seededPersistence(database: TestSqlite, prefix: string): ProtocolTestRecords {
    const persistence = new SqliteProtocolPersistence(database);
    const records = protocolTestRecords(prefix);
    database.transaction(() => appendProtocolTestRecords(persistence, database, records));
    return records;
}

describe("SQLite protocol persistence exact schema and projection behavior", () => {
    test("rejects a legacy table-only schema with the exact legacy message", { tags: "p1" }, () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE protocol_write_records (id TEXT)", []);

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("Legacy protocol persistence schema is not accepted")
        );
    });

    test("rejects a legacy schema whose protocol_schema is not a table", { tags: "p1" }, () => {
        const database = new TestSqlite();
        database.run("CREATE VIEW protocol_schema AS SELECT 1 AS singleton, 4 AS version", []);

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("Legacy protocol persistence schema is not accepted")
        );
    });

    test("reopens an initialized schema and keeps the exact version singleton", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        new SqliteProtocolPersistence(database);

        expect(database.all("SELECT singleton, version FROM protocol_schema", [])).toEqual([
            { singleton: 1, version: 4 }
        ]);
    });

    test("names a schema object with the wrong type exactly", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        database.run("DROP TABLE protocol_audit_records", []);
        database.run(
            `CREATE VIEW protocol_audit_records AS
             SELECT 1 AS sequence, 'a' AS id, 'b' AS evidence_identity, 'c' AS evidence_kind,
                    NULL AS write_id, NULL AS write_outcome, x'00' AS record`,
            []
        );

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("SQLite protocol schema object is invalid: protocol_audit_records")
        );
    });

    test("reports a missing protocol table as incomplete", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        database.run("DROP TABLE protocol_audit_records", []);

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("SQLite protocol schema is incomplete")
        );
    });

    test("names a non-STRICT protocol table exactly", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        database.run("DROP TABLE protocol_schema", []);
        database.run(
            `CREATE TABLE protocol_schema (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                version INTEGER NOT NULL CHECK (version > 0)
            )`,
            []
        );
        database.run("INSERT INTO protocol_schema (singleton, version) VALUES (1, 4)", []);

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("SQLite protocol table is not STRICT: protocol_schema")
        );
    });

    test("enforces exactly one singleton schema version row", { tags: "p0" }, () => {
        const unsupported = corruptProtocol("SQLite protocol schema version is unsupported");

        const empty = new TestSqlite();
        new SqliteProtocolPersistence(empty);
        empty.run("DELETE FROM protocol_schema", []);
        expect(() => new SqliteProtocolPersistence(empty)).toThrow(unsupported);

        const extra = new TestSqlite();
        new SqliteProtocolPersistence(extra);
        extra.run("PRAGMA ignore_check_constraints = ON", []);
        extra.run("INSERT INTO protocol_schema (singleton, version) VALUES (2, 4)", []);
        expect(() => new SqliteProtocolPersistence(extra)).toThrow(unsupported);

        const forged = new TestSqlite();
        new SqliteProtocolPersistence(forged);
        forged.run("PRAGMA ignore_check_constraints = ON", []);
        forged.run("UPDATE protocol_schema SET singleton = 2", []);
        expect(() => new SqliteProtocolPersistence(forged)).toThrow(unsupported);
    });

    test("rejects a counterfeit identity view projection when its rebuild is lost", { tags: "p0" }, () => {
        const database = new ViewRebuildLossSqlite();
        seededPersistence(database, "sqlite-view-tamper");
        database.run("DROP VIEW protocol_command_identities", []);
        database.run(
            `CREATE VIEW protocol_command_identities AS
             SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                    idempotency_key, audit_id AS write_id
             FROM protocol_write_records
             WHERE caller_kind IS NOT NULL`,
            []
        );
        database.suppressRebuild = true;

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("SQLite protocol identity view projection is invalid")
        );
    });

    test("names a protocol table with reordered columns exactly", { tags: "p1" }, () => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        database.run("DROP TABLE protocol_audit_records", []);
        database.run(
            `CREATE TABLE protocol_audit_records (
                id TEXT NOT NULL UNIQUE,
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                evidence_identity TEXT NOT NULL UNIQUE,
                evidence_kind TEXT NOT NULL,
                write_id TEXT,
                write_outcome TEXT,
                record BLOB NOT NULL
            ) STRICT`,
            []
        );

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            corruptProtocol("SQLite protocol table columns are invalid: protocol_audit_records")
        );
    });

    test("rejects an unknown stored audit kind with its exact message", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const records = protocolTestRecords("sqlite-audit-kind");
        database.transaction(() => appendProtocolTestRecords(persistence, database, records));
        database.run(
            `UPDATE protocol_audit_records
             SET evidence_kind = 'invalid-kind', write_id = NULL, write_outcome = NULL
             WHERE id = ?`,
            [records.root.id.value]
        );

        expect(() => persistence.findAudit(database, records.root.id)).toThrow(
            corruptProtocol("Stored protocol audit kind is invalid")
        );
    });

    test("rejects an unknown stored write outcome with its exact message", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const records = protocolTestRecords("sqlite-write-outcome");
        database.transaction(() => appendProtocolTestRecords(persistence, database, records));
        database.run("UPDATE protocol_write_records SET outcome = 'invalid-outcome' WHERE id = ?", [
            records.write.id.value
        ]);

        expect(() => persistence.findWriteById(database, records.write.id)).toThrow(
            corruptProtocol("Stored protocol write outcome is invalid")
        );
    });

    test("rejects wrong runtime column types with exact column messages", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const records = protocolTestRecords("sqlite-runtime-types");
        database.transaction(() => appendProtocolTestRecords(persistence, database, records));
        const corrupt = (column: string, value: SqliteValue) => {
            database.tamper = (statement, rows) =>
                statement.includes("FROM protocol_audit_records") && statement.includes("WHERE id")
                    ? rows.map((row) => ({ ...row, [column]: value }))
                    : rows;
        };

        corrupt("record", "not-bytes");
        expect(() => persistence.findAudit(database, records.root.id)).toThrow(
            corruptProtocol("Expected byte column: record")
        );
        corrupt("id", 7);
        expect(() => persistence.findAudit(database, records.root.id)).toThrow(
            corruptProtocol("Expected text column: id")
        );
        corrupt("write_id", 7);
        expect(() => persistence.findAudit(database, records.root.id)).toThrow(
            corruptProtocol("Expected nullable text column: write_id")
        );
    });

    test("surfaces the identity-index rebuild fault message verbatim", { tags: "p1" }, () => {
        const database = new IndexRebuildFaultSqlite();
        new SqliteProtocolPersistence(database);
        database.failPrincipalIndex = true;

        expect(() => new SqliteProtocolPersistence(database)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Cannot rebuild protocol identity projection: index rebuild fault"
            })
        );
    });
});
