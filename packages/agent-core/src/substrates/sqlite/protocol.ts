import { AgentCoreError } from "../../errors";
import { AuditRecordId, WriteRecordId, type AuditKind } from "../../invocations";
import {
    ProtocolPersistenceAdapter,
    ProtocolRecordStorage,
    type CommandOutcome,
    type ProtocolIdentityProjection,
    type ProtocolWriteIdentityProjection,
    type StoredProtocolAudit,
    type StoredProtocolWrite
} from "../../protocol";
import { TransactionalSqlite, type SqliteRow } from "./sqlite";

const PROTOCOL_SCHEMA_VERSION = 4;
const SCHEMA_OBJECTS = [
    "protocol_schema",
    "protocol_audit_records",
    "protocol_write_records",
    "protocol_principal_identity",
    "protocol_actor_identity",
    "protocol_command_identities"
] as const;

const CREATE_SCHEMA = `CREATE TABLE protocol_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version > 0)
) STRICT`;

const CREATE_AUDITS = `CREATE TABLE protocol_audit_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    evidence_identity TEXT NOT NULL UNIQUE,
    evidence_kind TEXT NOT NULL,
    write_id TEXT,
    write_outcome TEXT,
    record BLOB NOT NULL,
    CHECK (
        (evidence_kind = 'write' AND write_id IS NOT NULL AND write_outcome IS NOT NULL)
        OR (evidence_kind <> 'write' AND write_id IS NULL AND write_outcome IS NULL)
    )
) STRICT`;

const CREATE_WRITES = `CREATE TABLE protocol_write_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    audit_id TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL,
    caller_kind TEXT,
    principal_tenant_id TEXT,
    principal_id TEXT,
    actor_kind TEXT,
    actor_id TEXT,
    idempotency_key TEXT,
    record BLOB NOT NULL,
    CHECK (
        (caller_kind IS NULL AND principal_tenant_id IS NULL AND principal_id IS NULL
            AND actor_kind IS NULL
            AND actor_id IS NULL AND idempotency_key IS NULL)
        OR (caller_kind = 'principal' AND principal_tenant_id IS NOT NULL
            AND principal_id IS NOT NULL
            AND actor_kind IS NULL AND actor_id IS NULL AND idempotency_key IS NOT NULL)
        OR (caller_kind = 'actor' AND principal_tenant_id IS NULL AND principal_id IS NULL
            AND actor_kind IS NOT NULL AND actor_id IS NOT NULL AND idempotency_key IS NOT NULL)
    )
) STRICT`;

const CREATE_PRINCIPAL_IDENTITY_INDEX = `CREATE UNIQUE INDEX protocol_principal_identity
    ON protocol_write_records (principal_tenant_id, principal_id, idempotency_key)
    WHERE caller_kind = 'principal'`;

const CREATE_ACTOR_IDENTITY_INDEX = `CREATE UNIQUE INDEX protocol_actor_identity
    ON protocol_write_records (actor_kind, actor_id, idempotency_key)
    WHERE caller_kind = 'actor'`;

const CREATE_IDENTITY_VIEW = `CREATE VIEW protocol_command_identities AS
    SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
           idempotency_key, id AS write_id
    FROM protocol_write_records
    WHERE caller_kind IS NOT NULL`;

export class SqliteProtocolPersistence extends ProtocolPersistenceAdapter<TransactionalSqlite> {
    public constructor(database: TransactionalSqlite) {
        super();
        database.transaction(() => {
            initializeSchema(database);
            rebuildIdentityView(database);
            validateSchema(database);
            this.repair(database);
        });
    }

    protected storage(transaction: TransactionalSqlite): ProtocolRecordStorage {
        return new SqliteProtocolRecords(transaction);
    }
}

class SqliteProtocolRecords extends ProtocolRecordStorage {
    public constructor(private readonly database: TransactionalSqlite) {
        super();
    }

    public findAudit(id: string): StoredProtocolAudit | undefined {
        const row = this.database.all(
            `SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             WHERE id = ?`,
            [id]
        )[0];
        if (row === undefined) return undefined;
        return storedAudit(row);
    }

    public findAuditByEvidence(identity: string): StoredProtocolAudit | undefined {
        const row = this.database.all(
            `SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             WHERE evidence_identity = ?`,
            [identity]
        )[0];
        return row === undefined ? undefined : storedAudit(row);
    }

    public findWrite(id: string): StoredProtocolWrite | undefined {
        const row = this.database.all(
            `SELECT id, audit_id, outcome, record
             FROM protocol_write_records
             WHERE id = ?`,
            [id]
        )[0];
        return row === undefined ? undefined : storedWrite(row);
    }

    public scanAudits(): readonly StoredProtocolAudit[] {
        return this.database
            .all(
                `SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             ORDER BY sequence`,
                []
            )
            .map(storedAudit);
    }

    public scanWrites(): readonly StoredProtocolWrite[] {
        return this.database
            .all(
                `SELECT id, audit_id, outcome, record
             FROM protocol_write_records
             ORDER BY sequence`,
                []
            )
            .map(storedWrite);
    }

    public insertAudit(record: StoredProtocolAudit): void {
        this.database.run(
            `INSERT INTO protocol_audit_records (
                id, evidence_identity, evidence_kind, write_id, write_outcome, record
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                record.id,
                record.evidenceIdentity,
                record.evidenceKind,
                record.writeId?.value ?? null,
                record.writeOutcome ?? null,
                record.bytes
            ]
        );
    }

    public insertWrite(
        record: StoredProtocolWrite,
        identity: ProtocolIdentityProjection | undefined
    ): void {
        const projection = identityBindings(identity);
        this.database.run(
            `INSERT INTO protocol_write_records (
                id, audit_id, outcome, caller_kind, principal_tenant_id, principal_id,
                actor_kind, actor_id, idempotency_key, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [record.id, record.auditId.value, record.outcome, ...projection, record.bytes]
        );
    }

    public synchronizeIdentityProjection(
        entries: readonly ProtocolWriteIdentityProjection[]
    ): void {
        dropIdentityIndexes(this.database);
        this.database.run(
            `UPDATE protocol_write_records SET
                caller_kind = NULL, principal_tenant_id = NULL, principal_id = NULL,
                actor_kind = NULL,
                actor_id = NULL, idempotency_key = NULL`,
            []
        );
        for (const entry of entries) {
            this.database.run(
                `UPDATE protocol_write_records SET
                    caller_kind = ?, principal_tenant_id = ?, principal_id = ?,
                    actor_kind = ?, actor_id = ?, idempotency_key = ?
                 WHERE id = ?`,
                [...identityBindings(entry.identity), entry.writeId.value]
            );
        }
        rebuildIdentityIndexes(this.database);
    }
}

function initializeSchema(database: TransactionalSqlite): void {
    const existing = database.all(
        `SELECT name, type FROM sqlite_schema
         WHERE name IN (${SCHEMA_OBJECTS.map(() => "?").join(", ")})`,
        [...SCHEMA_OBJECTS]
    );
    if (existing.length === 0) {
        database.run(CREATE_SCHEMA, []);
        database.run("INSERT INTO protocol_schema (singleton, version) VALUES (1, ?)", [
            PROTOCOL_SCHEMA_VERSION
        ]);
        database.run(CREATE_AUDITS, []);
        database.run(CREATE_WRITES, []);
        database.run(CREATE_PRINCIPAL_IDENTITY_INDEX, []);
        database.run(CREATE_ACTOR_IDENTITY_INDEX, []);
        return;
    }
    if (!existing.some((row) => row["name"] === "protocol_schema" && row["type"] === "table")) {
        throw corruptProtocolRow("Legacy protocol persistence schema is not accepted");
    }
}

function validateSchema(database: TransactionalSqlite): void {
    const required = new Map<string, string>([
        ["protocol_schema", "table"],
        ["protocol_audit_records", "table"],
        ["protocol_write_records", "table"],
        ["protocol_command_identities", "view"]
    ]);
    const rows = database.all(
        `SELECT name, type FROM sqlite_schema
         WHERE name IN (${SCHEMA_OBJECTS.map(() => "?").join(", ")})`,
        [...SCHEMA_OBJECTS]
    );
    for (const row of rows) {
        const name = text(row, "name");
        if (!required.has(name)) continue;
        if (required.get(name) !== text(row, "type")) {
            throw corruptProtocolRow(`SQLite protocol schema object is invalid: ${name}`);
        }
        required.delete(name);
    }
    if (required.size !== 0) {
        throw corruptProtocolRow("SQLite protocol schema is incomplete");
    }
    for (const table of ["protocol_schema", "protocol_audit_records", "protocol_write_records"]) {
        const strict = database.all("PRAGMA table_list", []).find((row) => row["name"] === table)?.[
            "strict"
        ];
        if (strict !== 1) {
            throw corruptProtocolRow(`SQLite protocol table is not STRICT: ${table}`);
        }
    }
    requireColumns(database, "protocol_schema", ["singleton", "version"]);
    requireColumns(database, "protocol_audit_records", [
        "sequence",
        "id",
        "evidence_identity",
        "evidence_kind",
        "write_id",
        "write_outcome",
        "record"
    ]);
    requireColumns(database, "protocol_write_records", [
        "sequence",
        "id",
        "audit_id",
        "outcome",
        "caller_kind",
        "principal_tenant_id",
        "principal_id",
        "actor_kind",
        "actor_id",
        "idempotency_key",
        "record"
    ]);
    requireColumns(database, "protocol_command_identities", [
        "sequence",
        "caller_kind",
        "principal_tenant_id",
        "principal_id",
        "actor_kind",
        "actor_id",
        "idempotency_key",
        "write_id"
    ]);
    requireIdentityViewProjection(database);
    const versionRows = database.all("SELECT singleton, version FROM protocol_schema", []);
    if (
        versionRows.length !== 1 ||
        versionRows[0]?.["singleton"] !== 1 ||
        versionRows[0]?.["version"] !== PROTOCOL_SCHEMA_VERSION
    ) {
        throw corruptProtocolRow("SQLite protocol schema version is unsupported");
    }
}

function rebuildIdentityView(database: TransactionalSqlite): void {
    const row = database.all("SELECT name, type FROM sqlite_schema WHERE name = ?", [
        "protocol_command_identities"
    ])[0];
    if (row !== undefined) {
        if (text(row, "type") !== "view") {
            throw corruptProtocolRow(
                "SQLite protocol schema object is invalid: protocol_command_identities"
            );
        }
        database.run("DROP VIEW protocol_command_identities", []);
    }
    database.run(CREATE_IDENTITY_VIEW, []);
}

function requireIdentityViewProjection(database: TransactionalSqlite): void {
    const row = database.all(
        `SELECT
            EXISTS (
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, id AS write_id
                FROM protocol_write_records
                WHERE caller_kind IS NOT NULL
                EXCEPT
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, write_id
                FROM protocol_command_identities
            ) OR EXISTS (
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, write_id
                FROM protocol_command_identities
                EXCEPT
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, id AS write_id
                FROM protocol_write_records
                WHERE caller_kind IS NOT NULL
            ) AS mismatched`,
        []
    )[0];
    if (row?.["mismatched"] !== 0) {
        throw corruptProtocolRow("SQLite protocol identity view projection is invalid");
    }
}

function requireColumns(
    database: TransactionalSqlite,
    table: string,
    expected: readonly string[]
): void {
    const columns = database.all(`PRAGMA table_info(${table})`, []).map((row) => text(row, "name"));
    if (
        columns.length !== expected.length ||
        columns.some((column, index) => column !== expected[index])
    ) {
        throw corruptProtocolRow(`SQLite protocol table columns are invalid: ${table}`);
    }
}

function rebuildIdentityIndexes(database: TransactionalSqlite): void {
    try {
        database.run(CREATE_PRINCIPAL_IDENTITY_INDEX, []);
        database.run(CREATE_ACTOR_IDENTITY_INDEX, []);
    } catch (error) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            `Cannot rebuild protocol identity projection: ${errorMessage(error)}`
        );
    }
}

function dropIdentityIndexes(database: TransactionalSqlite): void {
    database.run("DROP INDEX IF EXISTS protocol_principal_identity", []);
    database.run("DROP INDEX IF EXISTS protocol_actor_identity", []);
}

function identityBindings(
    identity: ProtocolIdentityProjection | undefined
): [string | null, string | null, string | null, string | null, string | null, string | null] {
    if (identity === undefined) return [null, null, null, null, null, null];
    return identity.caller.kind === "principal"
        ? [
              identity.caller.kind,
              identity.caller.tenantId.value,
              identity.caller.id,
              null,
              null,
              identity.idempotencyKey
          ]
        : [
              identity.caller.kind,
              null,
              null,
              identity.caller.actorKind,
              identity.caller.id,
              identity.idempotencyKey
          ];
}

function storedWrite(row: SqliteRow): StoredProtocolWrite {
    return {
        id: text(row, "id"),
        auditId: new AuditRecordId(text(row, "audit_id")),
        outcome: commandOutcome(text(row, "outcome")),
        bytes: bytes(row, "record")
    };
}

function storedAudit(row: SqliteRow): StoredProtocolAudit {
    const writeId = nullableText(row, "write_id");
    const writeOutcome = nullableText(row, "write_outcome");
    return {
        id: text(row, "id"),
        evidenceIdentity: text(row, "evidence_identity"),
        evidenceKind: auditKind(text(row, "evidence_kind")),
        ...(writeId === undefined ? {} : { writeId: new WriteRecordId(writeId) }),
        ...(writeOutcome === undefined ? {} : { writeOutcome: commandOutcome(writeOutcome) }),
        bytes: bytes(row, "record")
    };
}

function auditKind(value: string): AuditKind["kind"] {
    if (
        value === "invocation" ||
        value === "approval" ||
        value === "attempt" ||
        value === "receipt" ||
        value === "receiptSuperseded" ||
        value === "write" ||
        value === "event" ||
        value === "routeReserved" ||
        value === "routeProjected" ||
        value === "delivery" ||
        value === "commit"
    ) {
        return value;
    }
    throw corruptProtocolRow("Stored protocol audit kind is invalid");
}

function commandOutcome(value: string): CommandOutcome {
    if (
        value === "committed" ||
        value === "rejectedMalformed" ||
        value === "rejectedAuthentication" ||
        value === "rejectedAuthority" ||
        value === "rejectedLifecycle" ||
        value === "rejectedRevision" ||
        value === "rejectedLease" ||
        value === "duplicate"
    ) {
        return value;
    }
    throw corruptProtocolRow("Stored protocol write outcome is invalid");
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) {
        throw corruptProtocolRow(`Expected byte column: ${column}`);
    }
    return value.slice();
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") {
        throw corruptProtocolRow(`Expected text column: ${column}`);
    }
    return value;
}

function nullableText(row: SqliteRow, column: string): string | undefined {
    const value = row[column];
    if (value === null) return undefined;
    if (typeof value !== "string") {
        throw corruptProtocolRow(`Expected nullable text column: ${column}`);
    }
    return value;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function corruptProtocolRow(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
