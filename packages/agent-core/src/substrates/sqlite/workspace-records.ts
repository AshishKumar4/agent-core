import { isMember } from "../../core";
import { TransactionalSqlite, isSqliteText, type SqliteRow, type SqliteValue } from "./sqlite";
import {
    DELETABLE_WORKSPACE_RECORD_KINDS,
    WORKSPACE_RECORD_KINDS,
    validateWorkspacePointerAdvance,
    validateStoredWorkspaceRecord,
    validateWorkspaceUnique,
    type DeletableWorkspaceRecordKind,
    type WorkspaceRecordKind
} from "../../workspaces";
import { AgentCoreError } from "../../errors";

interface StoredWorkspaceRecord {
    readonly kind: WorkspaceRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}

interface StoredWorkspaceUnique {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}

interface StoredWorkspacePointer {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}

const SQL_RECORD_KINDS = WORKSPACE_RECORD_KINDS.map((kind) => `'${kind}'`).join(", ");
const CREATE_RECORDS = `CREATE TABLE IF NOT EXISTS workspace_records (
    kind TEXT NOT NULL CHECK (kind IN (${SQL_RECORD_KINDS})),
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 2048),
    bytes BLOB NOT NULL,
    PRIMARY KEY (kind, id)
) STRICT`;

const CREATE_UNIQUES = `CREATE TABLE IF NOT EXISTS workspace_uniques (
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 512),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 2048),
    record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 2048),
    PRIMARY KEY (namespace, key)
) STRICT`;

const CREATE_POINTERS = `CREATE TABLE IF NOT EXISTS workspace_pointers (
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 512),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 2048),
    record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 2048),
    PRIMARY KEY (namespace, key)
) STRICT`;

export class SqliteWorkspaceRecords {
    public constructor(private readonly database: TransactionalSqlite) {
        this.database.transaction(() => {
            this.database.run(CREATE_RECORDS, []);
            this.database.run(CREATE_UNIQUES, []);
            this.database.run(CREATE_POINTERS, []);
            this.requireSchema("workspace_records", CREATE_RECORDS);
            this.requireSchema("workspace_uniques", CREATE_UNIQUES);
            this.requireSchema("workspace_pointers", CREATE_POINTERS);
        });
    }

    public findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined {
        const row = this.database.all(
            `SELECT kind, id, bytes FROM workspace_records
             WHERE kind = ? AND id = ?`,
            [kind, id]
        )[0];
        return row === undefined ? undefined : decodeRecord(row);
    }

    public listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[] {
        return this.database
            .all(
                `SELECT kind, id, bytes FROM workspace_records
             WHERE kind = ? ORDER BY id`,
                [kind]
            )
            .map(decodeRecord);
    }

    public insertRecord(record: StoredWorkspaceRecord): void {
        validateStoredWorkspaceRecord(record);
        if (this.findRecord(record.kind, record.id) !== undefined) {
            throw new AgentCoreError("protocol.duplicate", "Workspace records are append-only");
        }
        try {
            this.database.run(`INSERT INTO workspace_records (kind, id, bytes) VALUES (?, ?, ?)`, [
                record.kind,
                record.id,
                record.bytes.slice()
            ]);
        } catch {
            throw new AgentCoreError("protocol.duplicate", "Workspace records are append-only");
        }
    }

    public deleteRecords(kind: DeletableWorkspaceRecordKind, ids: readonly string[]): void {
        if (!isDeletableRecordKind(kind)) {
            throw new AgentCoreError("protocol.invalid-state", "Record kind is not deletable");
        }
        for (const id of ids) {
            this.database.run(`DELETE FROM workspace_records WHERE kind = ? AND id = ?`, [
                kind,
                id
            ]);
        }
    }

    public findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined {
        const row = this.database.all(
            `SELECT namespace, key, record_id FROM workspace_uniques
             WHERE namespace = ? AND key = ?`,
            [namespace, key]
        )[0];
        return row === undefined ? undefined : decodeUnique(row);
    }

    public insertUnique(unique: StoredWorkspaceUnique): void {
        validateWorkspaceUnique(unique);
        if (this.findUnique(unique.namespace, unique.key) !== undefined) {
            throw new AgentCoreError(
                "protocol.duplicate",
                "Workspace unique key is already reserved"
            );
        }
        try {
            this.database.run(
                `INSERT INTO workspace_uniques (namespace, key, record_id)
                 VALUES (?, ?, ?)`,
                [unique.namespace, unique.key, unique.recordKey]
            );
        } catch {
            throw new AgentCoreError(
                "protocol.duplicate",
                "Workspace unique key is already reserved"
            );
        }
    }

    public findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined {
        const row = this.database.all(
            `SELECT namespace, key, record_id FROM workspace_pointers
             WHERE namespace = ? AND key = ?`,
            [namespace, key]
        )[0];
        return row === undefined ? undefined : decodePointer(row);
    }

    public compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void {
        validateWorkspacePointerAdvance(pointer, expectedRecordKey);
        const current = this.findPointer(pointer.namespace, pointer.key);
        if (
            current?.recordKey !== expectedRecordKey ||
            (current === undefined && expectedRecordKey !== undefined)
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace pointer compare-and-set failed"
            );
        }
        if (current === undefined) {
            this.database.run(
                `INSERT INTO workspace_pointers (namespace, key, record_id)
                 VALUES (?, ?, ?)`,
                [pointer.namespace, pointer.key, pointer.recordKey]
            );
        } else {
            this.database.run(
                `UPDATE workspace_pointers SET record_id = ?
                 WHERE namespace = ? AND key = ? AND record_id = ?`,
                [pointer.recordKey, pointer.namespace, pointer.key, current.recordKey]
            );
        }
        const updated = this.findPointer(pointer.namespace, pointer.key);
        if (updated?.recordKey !== pointer.recordKey) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace pointer compare-and-set lost a concurrent race"
            );
        }
    }

    public deletePointer(namespace: string, key: string, expectedRecordKey: string): void {
        const current = this.findPointer(namespace, key);
        if (current?.recordKey !== expectedRecordKey) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace pointer compare-and-delete failed"
            );
        }
        this.database.run(
            `DELETE FROM workspace_pointers
             WHERE namespace = ? AND key = ? AND record_id = ?`,
            [namespace, key, expectedRecordKey]
        );
        if (this.findPointer(namespace, key) !== undefined) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace pointer compare-and-delete lost a concurrent race"
            );
        }
    }

    private requireSchema(table: string, expectedSql: string): void {
        const row = this.database.all(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            [table]
        )[0];
        const sql = row?.["sql"];
        if (!isSqliteText(sql)) throw new TypeError(`Missing SQLite schema: ${table}`);
        if (normalizeSql(sql) !== normalizeSql(expectedSql)) {
            throw new TypeError(`SQLite schema is incompatible: ${table}`);
        }
    }
}

function isDeletableRecordKind(kind: string): kind is DeletableWorkspaceRecordKind {
    return isMember(DELETABLE_WORKSPACE_RECORD_KINDS, kind);
}

function normalizeSql(value: string): string {
    return value
        .replace(/CREATE TABLE IF NOT EXISTS/iu, "CREATE TABLE")
        .replaceAll(/\s+/gu, " ")
        .trim();
}

function decodeRecord(row: SqliteRow): StoredWorkspaceRecord {
    return {
        kind: decodeRecordKind(row["kind"]),
        id: readText(row, "id"),
        bytes: readBytes(row, "bytes")
    };
}

function decodeUnique(row: SqliteRow): StoredWorkspaceUnique {
    return {
        namespace: readText(row, "namespace"),
        key: readText(row, "key"),
        recordKey: readText(row, "record_id")
    };
}

function decodePointer(row: SqliteRow): StoredWorkspacePointer {
    return {
        namespace: readText(row, "namespace"),
        key: readText(row, "key"),
        recordKey: readText(row, "record_id")
    };
}

function decodeRecordKind(value: SqliteValue | undefined): WorkspaceRecordKind {
    if (isMember(WORKSPACE_RECORD_KINDS, value)) return value;
    throw new TypeError("Stored workspace record kind is invalid");
}

function readText(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isSqliteText(value)) throw new TypeError(`Expected text column: ${column}`);
    return value;
}

function readBytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw new TypeError(`Expected byte column: ${column}`);
    return value.slice();
}
