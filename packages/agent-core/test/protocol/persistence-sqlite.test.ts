import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import { TenantId } from "../../src/identity";
import { AuditRecord, AuditRecordCodec, AuditRecordId, CorrelationId } from "../../src/invocations";
import { SqliteProtocolPersistence, TransactionalSqlite } from "../../src/substrates";
import { WriteRecordCodec } from "../../src/protocol";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import {
    appendProtocolTestRecords,
    protocolPersistenceContract,
    protocolTestRecords,
    protocolUnsupportedAuditRecords,
    type ProtocolPersistenceHarness
} from "./persistence-contract";
import { expectAgentCoreError } from "./error-assertion";

protocolPersistenceContract("SQLite", createSqliteHarness);

test("SQLite protocol persistence survives a file-backed database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-protocol-"));
    const path = join(directory, "protocol.sqlite");
    const expected = protocolTestRecords("sqlite-file-restart");
    let firstDatabase: FileSqlite | undefined;
    let restartedDatabase: FileSqlite | undefined;
    try {
        firstDatabase = new FileSqlite(path);
        const first = new SqliteProtocolPersistence(firstDatabase);
        firstDatabase.transaction(() => {
            appendProtocolTestRecords(first, firstDatabase, expected);
        });
        firstDatabase.close();
        firstDatabase = undefined;

        restartedDatabase = new FileSqlite(path);
        const activeRestarted = restartedDatabase;
        const restarted = new SqliteProtocolPersistence(activeRestarted);
        activeRestarted.transaction(() => {
            expect(restarted.findWrite(activeRestarted, expected.identity)?.id.value).toBe(
                expected.write.id.value
            );
            expect(restarted.findAudit(activeRestarted, expected.audit.id)?.kind).toMatchObject({
                kind: "write",
                id: expected.write.id
            });
        });
        restartedDatabase.close();
        restartedDatabase = undefined;
    } finally {
        firstDatabase?.close();
        restartedDatabase?.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("SQLite reads every hand-seeded codec-representable non-write audit projection", () => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const audits = protocolUnsupportedAuditRecords("sqlite-unsupported");
    for (const audit of audits) {
        database.run(
            `INSERT INTO protocol_audit_records (
                id, evidence_kind, write_id, write_outcome, record
             ) VALUES (?, ?, ?, ?, ?)`,
            [audit.id.value, audit.kind.kind, null, null, AuditRecordCodec.encode(audit)]
        );
    }

    for (const expected of audits) {
        const actual = persistence.findAudit(database, expected.id);
        expect(actual).toBeDefined();
        if (actual === undefined) throw new TypeError("Expected stored audit record");
        expect(AuditRecordCodec.encode(actual)).toEqual(AuditRecordCodec.encode(expected));
    }
});

test.each(["audit", "write"] as const)("SQLite reads reject corrupt %s codec bytes", (record) => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const expected = protocolTestRecords(`sqlite-codec-${record}`);
    database.transaction(() => {
        appendProtocolTestRecords(persistence, database, expected);
    });
    database.run(`UPDATE protocol_${record}_records SET record = ?`, [new Uint8Array([0])]);

    expectAgentCoreError(
        () =>
            record === "audit"
                ? persistence.findAudit(database, expected.audit.id)
                : persistence.findWriteById(database, expected.write.id),
        "codec.invalid"
    );
});

test.each(["evidenceKind", "writeId", "writeOutcome"] as const)(
    "SQLite reads reject a corrupt write-audit %s projection",
    (projection) => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const expected = protocolTestRecords(`sqlite-write-audit-${projection}`);
        database.transaction(() => {
            appendProtocolTestRecords(persistence, database, expected);
        });
        if (projection === "evidenceKind") {
            database.run(
                `UPDATE protocol_audit_records
                 SET evidence_kind = ?, write_id = NULL, write_outcome = NULL
                 WHERE id = ?`,
                ["commit", expected.audit.id.value]
            );
        } else {
            database.run(
                `UPDATE protocol_audit_records SET ${
                    projection === "writeId" ? "write_id" : "write_outcome"
                } = ? WHERE id = ?`,
                [
                    projection === "writeId" ? "other-write" : "rejectedAuthority",
                    expected.audit.id.value
                ]
            );
        }

        expectAgentCoreError(
            () => persistence.findAudit(database, expected.audit.id),
            "codec.invalid"
        );
    }
);

test.each(["missing", "actor", "tenant", "correlation"] as const)(
    "SQLite write reads reject a %s Invocation cause",
    (corruption) => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const expected = protocolTestRecords(`sqlite-cause-${corruption}`);
        database.transaction(() => {
            appendProtocolTestRecords(persistence, database, expected);
        });
        if (corruption === "missing") {
            database.run("DELETE FROM protocol_audit_records WHERE id = ?", [
                expected.root.id.value
            ]);
        } else {
            database.run("UPDATE protocol_audit_records SET record = ? WHERE id = ?", [
                AuditRecordCodec.encode(
                    new AuditRecord({
                        id: expected.root.id,
                        actor:
                            corruption === "actor"
                                ? new ActorRef("run", new ActorId("other-sqlite-actor"))
                                : expected.root.actor,
                        tenant:
                            corruption === "tenant"
                                ? new TenantId("other-sqlite-tenant")
                                : expected.root.tenant,
                        correlation:
                            corruption === "correlation"
                                ? new CorrelationId("other-sqlite-correlation")
                                : expected.root.correlation,
                        kind: expected.root.kind
                    })
                ),
                expected.root.id.value
            ]);
        }

        expectAgentCoreError(
            () => persistence.findWriteById(database, expected.write.id),
            "protocol.invalid-state"
        );
    }
);

test.each(["audit", "write"] as const)(
    "SQLite reads reject a corrupt %s projection",
    (projection) => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const expected = protocolTestRecords(`sqlite-corrupt-${projection}`);
        database.transaction(() => {
            appendProtocolTestRecords(persistence, database, expected);
        });

        if (projection === "audit") {
            database.run("UPDATE protocol_audit_records SET id = ? WHERE id = ?", [
                "sqlite-corrupt-audit-key",
                expected.root.id.value
            ]);
            expectAgentCoreError(() => new SqliteProtocolPersistence(database), "codec.invalid");
            expectAgentCoreError(
                () =>
                    persistence.findAudit(database, new AuditRecordId("sqlite-corrupt-audit-key")),
                "codec.invalid"
            );
            return;
        }
        if (projection === "write") {
            database.run("UPDATE protocol_write_records SET outcome = ? WHERE id = ?", [
                "rejectedAuthority",
                expected.write.id.value
            ]);
            expectAgentCoreError(() => new SqliteProtocolPersistence(database), "codec.invalid");
            expectAgentCoreError(
                () => persistence.findWriteById(database, expected.write.id),
                "codec.invalid"
            );
            return;
        }
    }
);

test("SQLite repairs corrupt identity projections from canonical write bytes", () => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const expected = protocolTestRecords("sqlite-repair-identity");
    database.transaction(() => appendProtocolTestRecords(persistence, database, expected));
    database.run(
        `UPDATE protocol_write_records SET principal_id = ?, idempotency_key = ?
         WHERE id = ?`,
        ["corrupt-principal", "corrupt-key", expected.write.id.value]
    );

    expect(persistence.findWrite(database, expected.identity)?.id.value).toBe(
        expected.write.id.value
    );
    expect(
        database.all(
            `SELECT principal_id, idempotency_key FROM protocol_write_records WHERE id = ?`,
            [expected.write.id.value]
        )[0]
    ).toMatchObject({
        principal_id: "persistence-principal",
        idempotency_key: expected.identity.idempotencyKey
    });
});

test("SQLite repairs deleted identity projections and lost or corrupt indexes", () => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const expected = protocolTestRecords("sqlite-rebuild-projection");
    database.transaction(() => appendProtocolTestRecords(persistence, database, expected));
    database.run(
        `UPDATE protocol_write_records SET caller_kind = NULL, principal_tenant_id = NULL,
            principal_id = NULL,
            actor_kind = NULL, actor_id = NULL, idempotency_key = NULL`,
        []
    );
    database.run("DROP INDEX protocol_principal_identity", []);
    database.run("DROP INDEX protocol_actor_identity", []);
    database.run("CREATE INDEX protocol_principal_identity ON protocol_write_records (id)", []);

    expect(persistence.findWrite(database, expected.identity)?.id.value).toBe(
        expected.write.id.value
    );
    const indexes = database.all(
        `SELECT name, sql FROM sqlite_schema
         WHERE name IN ('protocol_principal_identity', 'protocol_actor_identity')`,
        []
    );
    expect(indexes).toHaveLength(2);
    expect(
        indexes.every(
            (row) => typeof row["sql"] === "string" && row["sql"].startsWith("CREATE UNIQUE INDEX")
        )
    ).toBe(true);
});

test("SQLite rebuilds missing and counterfeit command identity views canonically", () => {
    const counterfeitViews: readonly (string | undefined)[] = [
        undefined,
        `CREATE VIEW protocol_command_identities AS
            SELECT sequence, caller_kind, principal_id, actor_kind, actor_id,
                   idempotency_key, id AS write_id
            FROM protocol_write_records`,
        `CREATE VIEW protocol_command_identities AS
            SELECT sequence, caller_kind, principal_id, actor_kind, actor_id,
                   idempotency_key, audit_id AS write_id
            FROM protocol_write_records
            WHERE caller_kind IS NOT NULL`
    ];
    for (const counterfeit of counterfeitViews) {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const indexed = protocolTestRecords("sqlite-view-indexed");
        const unindexed = protocolTestRecords("sqlite-view-unindexed", undefined, {
            outcome: "rejectedAuthentication"
        });
        database.transaction(() => {
            appendProtocolTestRecords(persistence, database, indexed);
            appendProtocolTestRecords(persistence, database, unindexed, null);
        });
        database.run("DROP VIEW protocol_command_identities", []);
        if (counterfeit !== undefined) database.run(counterfeit, []);

        new SqliteProtocolPersistence(database);

        expect(
            database
                .all("PRAGMA table_info(protocol_command_identities)", [])
                .map((row) => row["name"])
        ).toEqual([
            "sequence",
            "caller_kind",
            "principal_tenant_id",
            "principal_id",
            "actor_kind",
            "actor_id",
            "idempotency_key",
            "write_id"
        ]);
        expect(
            database.all(
                `SELECT caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                    idempotency_key, write_id
             FROM protocol_command_identities ORDER BY sequence`,
                []
            )
        ).toEqual([
            {
                caller_kind: "principal",
                principal_tenant_id: "persistence-tenant",
                principal_id: "persistence-principal",
                actor_kind: null,
                actor_id: null,
                idempotency_key: indexed.identity.idempotencyKey,
                write_id: indexed.write.id.value
            }
        ]);
        expect(
            database.all(
                "SELECT sql FROM sqlite_schema WHERE name = 'protocol_command_identities'",
                []
            )[0]?.["sql"]
        ).toContain("WHERE caller_kind IS NOT NULL");
    }
});

test("SQLite clears swapped identity projections before rebuilding unique indexes", () => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const first = protocolTestRecords("sqlite-swap-first");
    const second = protocolTestRecords("sqlite-swap-second", undefined, { key: "second-key" });
    database.transaction(() => {
        appendProtocolTestRecords(persistence, database, first);
        appendProtocolTestRecords(persistence, database, second);
    });
    database.run("DROP INDEX protocol_principal_identity", []);
    database.run("DROP INDEX protocol_actor_identity", []);
    database.run(
        `UPDATE protocol_write_records SET
            idempotency_key = CASE id WHEN ? THEN ? WHEN ? THEN ? END
         WHERE id IN (?, ?)`,
        [
            first.write.id.value,
            second.identity.idempotencyKey,
            second.write.id.value,
            first.identity.idempotencyKey,
            first.write.id.value,
            second.write.id.value
        ]
    );
    database.run(
        `CREATE UNIQUE INDEX protocol_principal_identity
         ON protocol_write_records (principal_tenant_id, principal_id, idempotency_key)
         WHERE caller_kind = 'principal'`,
        []
    );
    database.run(
        `CREATE UNIQUE INDEX protocol_actor_identity
         ON protocol_write_records (actor_kind, actor_id, idempotency_key)
         WHERE caller_kind = 'actor'`,
        []
    );

    expect(persistence.findWrite(database, first.identity)?.id.value).toBe(first.write.id.value);
    expect(
        database.all("SELECT idempotency_key FROM protocol_write_records WHERE id = ?", [
            first.write.id.value
        ])[0]?.["idempotency_key"]
    ).toBe(first.identity.idempotencyKey);
});

test.each(["missing-audit", "orphan-write-audit", "missing-cause", "duplicate-lineage"] as const)(
    "SQLite startup repair rejects %s corruption",
    (corruption) => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const original = protocolTestRecords(`sqlite-startup-${corruption}`);
        database.transaction(() => appendProtocolTestRecords(persistence, database, original));
        if (corruption === "missing-audit") {
            database.run("DELETE FROM protocol_audit_records WHERE id = ?", [
                original.audit.id.value
            ]);
        } else if (corruption === "orphan-write-audit") {
            database.run("DELETE FROM protocol_write_records WHERE id = ?", [
                original.write.id.value
            ]);
        } else if (corruption === "missing-cause") {
            database.run("DELETE FROM protocol_audit_records WHERE id = ?", [
                original.root.id.value
            ]);
        } else {
            const duplicate = protocolTestRecords("sqlite-startup-duplicate", undefined, {
                outcome: "duplicate",
                duplicateOf: original.write.id,
                key: original.identity.idempotencyKey,
                reply: original.write.reply
            });
            database.transaction(() => appendProtocolTestRecords(persistence, database, duplicate));
            const encoded = new TextDecoder().decode(WriteRecordCodec.encode(duplicate.write));
            database.run("UPDATE protocol_write_records SET record = ? WHERE id = ?", [
                new TextEncoder().encode(
                    encoded.replace(original.write.id.value, "missing-startup-original")
                ),
                duplicate.write.id.value
            ]);
        }

        expectAgentCoreError(
            () => new SqliteProtocolPersistence(database),
            "protocol.invalid-state"
        );
    }
);

test("SQLite fails closed when canonical writes conflict after index loss", () => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const original = protocolTestRecords("sqlite-conflict-original");
    const conflict = protocolTestRecords("sqlite-conflict-second", undefined, {
        key: original.identity.idempotencyKey
    });
    database.transaction(() => appendProtocolTestRecords(persistence, database, original));
    database.run("DROP INDEX protocol_principal_identity", []);
    database.transaction(() => {
        persistence.appendAudit(database, conflict.root);
        persistence.appendAudit(database, conflict.audit);
        database.run(
            `INSERT INTO protocol_write_records (
                id, audit_id, outcome, caller_kind, principal_tenant_id, principal_id,
                actor_kind, actor_id, idempotency_key, record
             ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
            [
                conflict.write.id.value,
                conflict.write.audit.value,
                conflict.write.outcome,
                WriteRecordCodec.encode(conflict.write)
            ]
        );
    });

    expectAgentCoreError(
        () => persistence.findWrite(database, original.identity),
        "protocol.invalid-state"
    );
});

test("SQLite validates STRICT protocol schema version without accepting legacy tables", () => {
    const database = new TestSqlite();
    new SqliteProtocolPersistence(database);
    const strict = new Map(
        database.all("PRAGMA table_list", []).map((row) => [row["name"], row["strict"]])
    );
    expect(strict.get("protocol_schema")).toBe(1);
    expect(strict.get("protocol_audit_records")).toBe(1);
    expect(strict.get("protocol_write_records")).toBe(1);
    database.run("UPDATE protocol_schema SET version = 4", []);
    expectAgentCoreError(() => new SqliteProtocolPersistence(database), "codec.invalid");

    const legacy = new TestSqlite();
    legacy.run("CREATE TABLE protocol_write_records (id TEXT)", []);
    expectAgentCoreError(() => new SqliteProtocolPersistence(legacy), "codec.invalid");
});

test.each(["wrong-type", "non-strict", "columns"] as const)(
    "SQLite rejects %s protocol schema corruption",
    (corruption) => {
        const database = new TestSqlite();
        new SqliteProtocolPersistence(database);
        if (corruption === "wrong-type") {
            database.run("DROP VIEW protocol_command_identities", []);
            database.run("CREATE TABLE protocol_command_identities (id TEXT) STRICT", []);
        } else if (corruption === "non-strict") {
            database.run("DROP TABLE protocol_schema", []);
            database.run(
                `CREATE TABLE protocol_schema (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                version INTEGER NOT NULL CHECK (version > 0)
            )`,
                []
            );
            database.run("INSERT INTO protocol_schema VALUES (1, 2)", []);
        } else {
            database.run("DROP TABLE protocol_audit_records", []);
            database.run(
                `CREATE TABLE protocol_audit_records (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE
            ) STRICT`,
                []
            );
        }

        expectAgentCoreError(() => new SqliteProtocolPersistence(database), "codec.invalid");
    }
);

test("SQLite schema validation propagates an unexpected driver TypeError", () => {
    const database = new TestSqlite();
    new SqliteProtocolPersistence(database);
    const all = database.all.bind(database);
    const fault = new TypeError("injected schema driver fault");
    Object.defineProperty(database, "all", {
        value(statement: string, bindings: Parameters<TestSqlite["all"]>[1]) {
            if (statement === "PRAGMA table_list") throw fault;
            return all(statement, bindings);
        }
    });

    let failure: unknown;
    try {
        new SqliteProtocolPersistence(database);
    } catch (error) {
        failure = error;
    }
    expect(failure).toBe(fault);
    expect(failure).toBeInstanceOf(TypeError);
});

test.each([
    ["audit kind", "audit", "evidence_kind", "invalid-kind"],
    ["write outcome", "write", "outcome", "invalid-outcome"]
] as const)("SQLite rejects an invalid stored %s", (_case, record, column, value) => {
    const database = new TestSqlite();
    const persistence = new SqliteProtocolPersistence(database);
    const expected = protocolTestRecords(`sqlite-invalid-${record}`);
    database.transaction(() => appendProtocolTestRecords(persistence, database, expected));
    const id = record === "audit" ? expected.root.id : expected.write.id;
    database.run(`UPDATE protocol_${record}_records SET ${column} = ? WHERE id = ?`, [
        value,
        id.value
    ]);

    expectAgentCoreError(
        () =>
            record === "audit"
                ? persistence.findAudit(database, expected.root.id)
                : persistence.findWriteById(database, expected.write.id),
        "codec.invalid"
    );
});

test.each([
    ["byte", "record", "not-bytes"],
    ["text", "id", 7],
    ["nullable text", "write_id", 7]
] as const)(
    "SQLite rejects a projected %s column with the wrong runtime type",
    (_case, column, corruptValue) => {
        const database = new TestSqlite();
        const persistence = new SqliteProtocolPersistence(database);
        const expected = protocolTestRecords(`sqlite-runtime-type-${column}`);
        database.transaction(() => appendProtocolTestRecords(persistence, database, expected));
        const all = database.all.bind(database);
        Object.defineProperty(database, "all", {
            value(statement: string, bindings: Parameters<TestSqlite["all"]>[1]) {
                const rows = all(statement, bindings);
                if (
                    !statement.includes("FROM protocol_audit_records") ||
                    bindings[0] !== expected.audit.id.value
                )
                    return rows;
                return rows.map((row) => ({ ...row, [column]: corruptValue }));
            }
        });

        expectAgentCoreError(
            () => persistence.findAudit(database, expected.audit.id),
            "codec.invalid"
        );
    }
);

test.each([
    ["Error", new Error("index rebuild fault")],
    ["non-Error", "index rebuild fault"]
] as const)("SQLite rolls back an %s identity-index rebuild fault", (_case, fault) => {
    const database = new TestSqlite();
    new SqliteProtocolPersistence(database);
    const run = database.run.bind(database);
    Object.defineProperty(database, "run", {
        value(statement: string, bindings: Parameters<TestSqlite["run"]>[1]) {
            if (statement.startsWith("CREATE UNIQUE INDEX protocol_principal_identity")) {
                throw fault;
            }
            run(statement, bindings);
        }
    });

    expectAgentCoreError(() => new SqliteProtocolPersistence(database), "protocol.invalid-state");
    expect(
        database.all(
            `SELECT name FROM sqlite_schema
         WHERE name IN ('protocol_principal_identity', 'protocol_actor_identity')`,
            []
        )
    ).toHaveLength(2);
});

function createSqliteHarness(): ProtocolPersistenceHarness<TransactionalSqlite> {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-protocol-contract-"));
    const path = join(directory, "protocol.sqlite");
    let database = new FileSqlite(path);
    let persistence = new SqliteProtocolPersistence(database);
    let disposed = false;
    return {
        get persistence(): SqliteProtocolPersistence {
            return persistence;
        },
        transaction<Result>(
            operation: (transaction: TransactionalSqlite) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return database.transaction(() => operation(database), ...guard);
        },
        restart(): void {
            database.close();
            database = new FileSqlite(path);
            persistence = new SqliteProtocolPersistence(database);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            database.close();
            rmSync(directory, { recursive: true, force: true });
        }
    };
}
