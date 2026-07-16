// @ts-nocheck
import type { ActorRef, SynchronousResultGuard } from "../../actors";
import type { RunStoragePort } from "../../agents";
import { AgentCoreError } from "../../errors";
import { TransactionalSqlite, type SqliteRow } from "./sqlite";

const SCHEMA_VERSION = 1;
const SCHEMA_TABLE = "agent_run_storage_schema";
const RECORD_TABLE = "agent_run_records";
const PARENT_TABLE = "agent_run_commit_parents";
const RECORD_KINDS = [
    "configuration",
    "run",
    "branch",
    "commit",
    "turn",
    "placement",
    "checkpoint",
    "inbox",
    "spawn",
    "admission",
    "forcedCancellation"
] as const;

export type SqliteRunRecordKind = (typeof RECORD_KINDS)[number];

export interface SqliteStoredRunRecord {
    readonly kind: SqliteRunRecordKind;
    readonly key: string;
    readonly revision: number | null;
    readonly bytes: Uint8Array;
}

export interface SqliteStoredRunParent {
    readonly commit: string;
    readonly ordinal: number;
    readonly parent: string;
}

const KIND_CHECK = RECORD_KINDS.map((kind) => `'${kind}'`).join(", ");
const CREATE_SCHEMA = `CREATE TABLE ${SCHEMA_TABLE} (
    version INTEGER PRIMARY KEY CHECK (version = ${SCHEMA_VERSION}),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('workspace', 'run')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0)
) STRICT`;
const CREATE_RECORDS = `CREATE TABLE ${RECORD_TABLE} (
    kind TEXT NOT NULL CHECK (kind IN (${KIND_CHECK})),
    record_key TEXT NOT NULL CHECK (length(record_key) > 0),
    revision INTEGER CHECK (revision IS NULL OR revision >= 0),
    record BLOB NOT NULL,
    PRIMARY KEY (kind, record_key)
) STRICT`;
const CREATE_PARENTS = `CREATE TABLE ${PARENT_TABLE} (
    commit_id TEXT NOT NULL CHECK (length(commit_id) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
    parent_id TEXT NOT NULL CHECK (length(parent_id) > 0),
    PRIMARY KEY (commit_id, ordinal)
) STRICT`;
const CREATE_PARENT_INDEX = `CREATE INDEX agent_run_commit_parent_reverse
    ON ${PARENT_TABLE} (parent_id, commit_id)`;
const EXPECTED_SCHEMA = new Map<string, { readonly type: "table" | "index"; readonly sql: string }>(
    [
        [SCHEMA_TABLE, { type: "table", sql: CREATE_SCHEMA }],
        [RECORD_TABLE, { type: "table", sql: CREATE_RECORDS }],
        [PARENT_TABLE, { type: "table", sql: CREATE_PARENTS }],
        ["agent_run_commit_parent_reverse", { type: "index", sql: CREATE_PARENT_INDEX }]
    ]
);

export class SqliteRunStorage implements RunStoragePort<TransactionalSqlite> {
    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        if (owner.kind !== "workspace" && owner.kind !== "run") {
            throw new TypeError("Run storage must belong to a Workspace or dedicated Run Actor");
        }
        database.transaction(() => this.initialize(database));
    }

    public transaction<Result>(
        operation: (transaction: TransactionalSqlite) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.database.transaction(() => operation(this.database), ...guard);
    }

    public get(
        transaction: TransactionalSqlite,
        kind: SqliteRunRecordKind,
        key: string
    ): SqliteStoredRunRecord | undefined {
        validateKind(kind);
        const rows = transaction.all(
            `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? AND record_key = ?`,
            [kind, key]
        );
        if (rows.length > 1) throw corrupt("Run record primary key returned multiple rows");
        return rows[0] === undefined ? undefined : decodeRecord(rows[0], kind, key);
    }

    public list(
        transaction: TransactionalSqlite,
        kind: SqliteRunRecordKind
    ): readonly SqliteStoredRunRecord[] {
        validateKind(kind);
        return transaction
            .all(
                `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? ORDER BY record_key`,
                [kind]
            )
            .map((row) => decodeRecord(row, kind));
    }

    public insert(transaction: TransactionalSqlite, record: SqliteStoredRunRecord): void {
        validateRecord(record);
        const existing = this.get(transaction, record.kind, record.key);
        if (existing !== undefined) {
            if (recordsEqual(existing, record)) return;
            throw invalidStorage("Run records are immutable unless replaced by revision CAS");
        }
        transaction.run(
            `INSERT INTO ${RECORD_TABLE} (kind, record_key, revision, record)
             VALUES (?, ?, ?, ?)`,
            [record.kind, record.key, record.revision, record.bytes.slice()]
        );
    }

    public replace(
        transaction: TransactionalSqlite,
        record: SqliteStoredRunRecord,
        expectedRevision: number
    ): void {
        validateRecord(record);
        const existing = this.get(transaction, record.kind, record.key);
        if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
            throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
        }
        transaction.run(
            `UPDATE ${RECORD_TABLE} SET revision = ?, record = ?
             WHERE kind = ? AND record_key = ? AND revision = ?`,
            [record.revision, record.bytes.slice(), record.kind, record.key, expectedRevision]
        );
    }

    public insertParent(transaction: TransactionalSqlite, edge: SqliteStoredRunParent): void {
        validateParent(edge);
        const rows = transaction.all(
            `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? AND ordinal = ?`,
            [edge.commit, edge.ordinal]
        );
        if (rows[0] !== undefined) {
            const existing = decodeParent(rows[0]);
            if (existing.parent === edge.parent) return;
            throw invalidStorage("Run commit parent edges are immutable");
        }
        transaction.run(
            `INSERT INTO ${PARENT_TABLE} (commit_id, ordinal, parent_id) VALUES (?, ?, ?)`,
            [edge.commit, edge.ordinal, edge.parent]
        );
    }

    public parents(
        transaction: TransactionalSqlite,
        commit: string
    ): readonly SqliteStoredRunParent[] {
        return transaction
            .all(
                `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? ORDER BY ordinal`,
                [commit]
            )
            .map(decodeParent);
    }

    private initialize(database: TransactionalSqlite): void {
        const objects = new Map(
            database
                .all(
                    "SELECT name, type, sql FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name",
                    []
                )
                .map((row) => [requiredText(row, "name"), row])
        );
        if (!objects.has(SCHEMA_TABLE)) {
            if (objects.size !== 0) {
                throw corrupt("Unmarked Run storage objects require explicit replacement");
            }
            database.run(CREATE_SCHEMA, []);
            database.run(CREATE_RECORDS, []);
            database.run(CREATE_PARENTS, []);
            database.run(CREATE_PARENT_INDEX, []);
            database.run(
                `INSERT INTO ${SCHEMA_TABLE} (version, owner_kind, owner_id) VALUES (?, ?, ?)`,
                [SCHEMA_VERSION, this.owner.kind, this.owner.id.value]
            );
        }
        this.validateSchema(database);
    }

    private validateSchema(database: TransactionalSqlite): void {
        const required = new Set([
            SCHEMA_TABLE,
            RECORD_TABLE,
            PARENT_TABLE,
            "agent_run_commit_parent_reverse"
        ]);
        const rows = database.all(
            "SELECT name, type, sql FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name",
            []
        );
        const names = new Set(rows.map((row) => requiredText(row, "name")));
        if (names.size !== required.size || [...required].some((name) => !names.has(name))) {
            throw corrupt("Run storage schema is incomplete or contains unexpected objects");
        }
        for (const row of rows) {
            const name = requiredText(row, "name");
            const expected = EXPECTED_SCHEMA.get(name);
            const type = requiredText(row, "type");
            const sql = requiredText(row, "sql");
            if (
                expected === undefined ||
                type !== expected.type ||
                normalizeSql(sql) !== normalizeSql(expected.sql)
            ) {
                throw corrupt(`Run storage object ${name} does not match its exact schema`);
            }
        }
        const marker = database.all(
            `SELECT version, owner_kind, owner_id FROM ${SCHEMA_TABLE}`,
            []
        );
        if (
            marker.length !== 1 ||
            requiredInteger(marker[0]!, "version") !== SCHEMA_VERSION ||
            requiredText(marker[0]!, "owner_kind") !== this.owner.kind ||
            requiredText(marker[0]!, "owner_id") !== this.owner.id.value
        ) {
            throw corrupt("Run storage schema version or owner does not match");
        }
        for (const kind of RECORD_KINDS) this.list(database, kind);
        database
            .all(
                `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE} ORDER BY commit_id, ordinal`,
                []
            )
            .forEach((row) => validateParent(decodeParent(row)));
    }
}

function decodeRecord(
    row: SqliteRow,
    expectedKind: SqliteRunRecordKind,
    expectedKey?: string
): SqliteStoredRunRecord {
    const kind = requiredText(row, "kind");
    const key = requiredText(row, "record_key");
    const revision = row["revision"];
    const bytes = row["record"];
    if (
        kind !== expectedKind ||
        (expectedKey !== undefined && key !== expectedKey) ||
        (revision !== null &&
            (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) ||
        !(bytes instanceof Uint8Array)
    ) {
        throw corrupt("Stored Run record projection is malformed");
    }
    return Object.freeze({ kind: expectedKind, key, revision, bytes: bytes.slice() });
}

function decodeParent(row: SqliteRow): SqliteStoredRunParent {
    const edge = Object.freeze({
        commit: requiredText(row, "commit_id"),
        ordinal: requiredInteger(row, "ordinal"),
        parent: requiredText(row, "parent_id")
    });
    validateParent(edge);
    return edge;
}

function validateRecord(record: SqliteStoredRunRecord): void {
    validateKind(record.kind);
    if (
        record.key.length === 0 ||
        !(record.bytes instanceof Uint8Array) ||
        (record.revision !== null &&
            (!Number.isSafeInteger(record.revision) || record.revision < 0))
    ) {
        throw corrupt("Stored Run record is malformed");
    }
}

function validateKind(kind: string): asserts kind is SqliteRunRecordKind {
    if (!RECORD_KINDS.includes(kind as SqliteRunRecordKind)) {
        throw corrupt("Stored Run record kind is invalid");
    }
}

function validateParent(edge: SqliteStoredRunParent): void {
    if (
        edge.commit.length === 0 ||
        edge.parent.length === 0 ||
        !Number.isSafeInteger(edge.ordinal) ||
        edge.ordinal < 0 ||
        edge.ordinal > 1
    ) {
        throw corrupt("Stored Run parent edge is malformed");
    }
}

function recordsEqual(left: SqliteStoredRunRecord, right: SqliteStoredRunRecord): boolean {
    return (
        left.revision === right.revision &&
        left.bytes.byteLength === right.bytes.byteLength &&
        left.bytes.every((value, index) => value === right.bytes[index])
    );
}

function requiredText(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0)
        throw corrupt(`SQLite ${column} is invalid`);
    return value;
}

function requiredInteger(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw corrupt(`SQLite ${column} is invalid`);
    return value;
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidStorage(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function normalizeSql(value: string): string {
    return value.trim().replaceAll(/\s+/g, " ");
}
