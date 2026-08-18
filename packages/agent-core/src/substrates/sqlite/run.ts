import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../../actors";
import {
    ownRunStorageBackend,
    RUN_RECORD_KINDS,
    RunStoragePort,
    type RunRecordKind,
    type RunTransaction,
    type StoredRunParent,
    type StoredRunRecord
} from "../../agents";
import { ContentOwnerEdge } from "../../content";
import { isMember } from "../../core";
import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import { SqliteContentStore } from "./content";
import { SqliteContentRetention } from "./content-retention";
import {
    TransactionalSqlite,
    isSqliteNumber,
    isSqliteText,
    ownSqliteMutations,
    withExclusiveSqliteMutation,
    type SqliteRow
} from "./sqlite";

const SCHEMA_VERSION = 2;
const SCHEMA_TABLE = "agent_run_storage_schema";
const RECORD_TABLE = "agent_run_records";
const PARENT_TABLE = "agent_run_commit_parents";
export type SqliteRunRecordKind = RunRecordKind;
export type SqliteStoredRunRecord = StoredRunRecord;
export type SqliteStoredRunParent = StoredRunParent;

const KIND_CHECK = RUN_RECORD_KINDS.map((kind) => `'${kind}'`).join(", ");
const CREATE_SCHEMA = `CREATE TABLE ${SCHEMA_TABLE} (
    version INTEGER PRIMARY KEY CHECK (version = ${SCHEMA_VERSION}),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
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

export class SqliteRunStorage extends RunStoragePort<RunTransaction> {
    public constructor(
        database: TransactionalSqlite,
        tenant: TenantId,
        owner: ActorRef,
        now?: () => Date,
        recordConstraint?: (record: SqliteStoredRunRecord) => void
    ) {
        if (owner.kind !== "workspace" && owner.kind !== "run") {
            throw new TypeError("Run storage must belong to a Workspace or dedicated Run Actor");
        }
        const ownedDatabase = ownSqliteMutations(database);
        ownedDatabase.transaction(() => {
            initializeRunStorage(ownedDatabase, tenant, owner);
            SqliteContentStore.initializeOwner(ownedDatabase, tenant, owner);
        });
        const contentStore = new SqliteContentStore(ownedDatabase);
        const retention = new SqliteContentRetention(ownedDatabase, tenant, owner);
        super(
            tenant,
            owner,
            contentStore,
            ownRunStorageBackend(
                new SqliteRunStorageBackend(
                    ownedDatabase,
                    retention,
                    () => SqliteRunStorage.createTransaction(),
                    recordConstraint
                )
            ),
            now
        );
        if (new.target === SqliteRunStorage) Object.freeze(this);
    }
}
Object.freeze(SqliteRunStorage.prototype);
Object.freeze(SqliteRunStorage);

class SqliteRunStorageBackend {
    #active:
        | {
              readonly transaction: RunTransaction;
              readonly database: TransactionalSqlite;
              failure: Error | undefined;
          }
        | undefined;

    public constructor(
        private readonly database: TransactionalSqlite,
        private readonly retention: SqliteContentRetention,
        private readonly createTransaction: () => RunTransaction,
        private readonly recordConstraint?: (record: SqliteStoredRunRecord) => void
    ) {}

    public transaction<Result>(
        operation: (transaction: RunTransaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        const current = this.#active;
        if (current !== undefined) {
            current.failure ??= invalidTransaction(
                "Nested Run storage transactions are not supported"
            );
            throw current.failure;
        }
        return withExclusiveSqliteMutation(
            this.database,
            (database) => {
                const transaction = this.createTransaction();
                const active = { transaction, database, failure: undefined };
                this.#active = active;
                try {
                    const result = requireSynchronousResult(operation(transaction));
                    if (active.failure !== undefined) throw active.failure;
                    return result;
                } finally {
                    this.#active = undefined;
                }
            },
            ...guard
        );
    }

    public get(
        transaction: RunTransaction,
        kind: SqliteRunRecordKind,
        key: string
    ): SqliteStoredRunRecord | undefined {
        return readStoredRecord(this.require(transaction), kind, key);
    }

    public list(
        transaction: RunTransaction,
        kind: SqliteRunRecordKind
    ): readonly SqliteStoredRunRecord[] {
        return listStoredRecords(this.require(transaction), kind);
    }

    public validate(record: SqliteStoredRunRecord): void {
        validateRecord(record);
        this.recordConstraint?.(record);
    }

    public poison(transaction: RunTransaction, failure: Error): never {
        this.require(transaction);
        const state = this.#active;
        if (state === undefined) throw invalidTransaction("Run transaction is inactive");
        state.failure ??= failure;
        throw state.failure;
    }

    public insert(transaction: RunTransaction, record: SqliteStoredRunRecord): void {
        const database = this.require(transaction);
        const existing = readStoredRecord(database, record.kind, record.key);
        if (existing !== undefined) {
            if (recordsEqual(existing, record)) return;
            throw invalidStorage("Run records are immutable unless replaced by revision CAS");
        }
        database.run(
            `INSERT INTO ${RECORD_TABLE} (kind, record_key, revision, record)
             VALUES (?, ?, ?, ?)`,
            [record.kind, record.key, record.revision, record.bytes.slice()]
        );
    }

    public replace(
        transaction: RunTransaction,
        record: SqliteStoredRunRecord,
        expectedRevision: number
    ): void {
        const database = this.require(transaction);
        const existing = readStoredRecord(database, record.kind, record.key);
        if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
            throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
        }
        database.run(
            `UPDATE ${RECORD_TABLE} SET revision = ?, record = ?
             WHERE kind = ? AND record_key = ? AND revision = ?`,
            [record.revision, record.bytes.slice(), record.kind, record.key, expectedRevision]
        );
    }

    public insertParent(transaction: RunTransaction, edge: SqliteStoredRunParent): void {
        const database = this.require(transaction);
        validateParent(edge);
        const rows = database.all(
            `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? AND ordinal = ?`,
            [edge.commit, edge.ordinal]
        );
        if (rows[0] !== undefined) {
            const existing = decodeParent(rows[0]);
            if (existing.parent === edge.parent) return;
            throw invalidStorage("Run commit parent edges are immutable");
        }
        database.run(
            `INSERT INTO ${PARENT_TABLE} (commit_id, ordinal, parent_id) VALUES (?, ?, ?)`,
            [edge.commit, edge.ordinal, edge.parent]
        );
    }

    public parents(transaction: RunTransaction, commit: string): readonly SqliteStoredRunParent[] {
        return this.require(transaction)
            .all(
                `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? ORDER BY ordinal`,
                [commit]
            )
            .map(decodeParent);
    }

    public retain(transaction: RunTransaction, edge: ContentOwnerEdge, operationAt: Date): void {
        this.retention.retain(this.require(transaction), edge, operationAt);
    }

    public release(transaction: RunTransaction, edge: ContentOwnerEdge, operationAt: Date): void {
        this.retention.release(this.require(transaction), edge, operationAt);
    }

    public verify(
        transaction: RunTransaction,
        ownerPrefixes: readonly string[],
        expected: readonly ContentOwnerEdge[]
    ): void {
        this.retention.verifyExactNamespace(this.require(transaction), ownerPrefixes, expected);
    }

    private require(transaction: RunTransaction): TransactionalSqlite {
        const active = this.#active;
        if (active === undefined || active.transaction !== transaction) {
            throw invalidTransaction(
                "Run transaction is inactive or belongs to a different database capability"
            );
        }
        if (active.failure !== undefined) throw active.failure;
        return active.database;
    }
}

function initializeRunStorage(
    database: TransactionalSqlite,
    tenant: TenantId,
    owner: ActorRef
): void {
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
            `INSERT INTO ${SCHEMA_TABLE}
                (version, tenant_id, owner_kind, owner_id) VALUES (?, ?, ?, ?)`,
            [SCHEMA_VERSION, tenant.value, owner.kind, owner.id.value]
        );
    }
    validateRunSchema(database, tenant, owner);
}

function validateRunSchema(database: TransactionalSqlite, tenant: TenantId, owner: ActorRef): void {
    const rows = database.all(
        "SELECT name, type, sql FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name",
        []
    );
    const names = new Set(rows.map((row) => requiredText(row, "name")));
    if (
        names.size !== EXPECTED_SCHEMA.size ||
        [...EXPECTED_SCHEMA.keys()].some((name) => !names.has(name))
    ) {
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
    const markerRows = database.all(
        `SELECT version, tenant_id, owner_kind, owner_id FROM ${SCHEMA_TABLE}`,
        []
    );
    const marker = markerRows[0];
    if (
        markerRows.length !== 1 ||
        marker === undefined ||
        requiredInteger(marker, "version") !== SCHEMA_VERSION ||
        requiredText(marker, "tenant_id") !== tenant.value ||
        !matchesOwner(marker, owner)
    ) {
        throw corrupt("Run storage schema version, Tenant, or owner does not match");
    }
    for (const kind of RUN_RECORD_KINDS) listStoredRecords(database, kind);
    database
        .all(
            `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE} ORDER BY commit_id, ordinal`,
            []
        )
        .forEach((row) => validateParent(decodeParent(row)));
}

function readStoredRecord(
    database: TransactionalSqlite,
    kind: SqliteRunRecordKind,
    key: string
): SqliteStoredRunRecord | undefined {
    validateKind(kind);
    const rows = database.all(
        `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
         WHERE kind = ? AND record_key = ?`,
        [kind, key]
    );
    if (rows.length > 1) throw corrupt("Run record primary key returned multiple rows");
    return rows[0] === undefined ? undefined : decodeRecord(rows[0], kind, key);
}

function listStoredRecords(
    database: TransactionalSqlite,
    kind: SqliteRunRecordKind
): readonly SqliteStoredRunRecord[] {
    validateKind(kind);
    return database
        .all(
            `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? ORDER BY record_key`,
            [kind]
        )
        .map((row) => decodeRecord(row, kind));
}

function matchesOwner(row: SqliteRow, owner: ActorRef): boolean {
    return (
        requiredText(row, "owner_kind") === owner.kind &&
        requiredText(row, "owner_id") === owner.id.value
    );
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
            (!isSqliteNumber(revision) || !Number.isSafeInteger(revision) || revision < 0)) ||
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
    if (!isMember(RUN_RECORD_KINDS, kind)) {
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
    if (!isSqliteText(value) || value.length === 0) throw corrupt(`SQLite ${column} is invalid`);
    return value;
}

function requiredInteger(row: SqliteRow, column: string): number {
    const value = row[column];
    if (!isSqliteNumber(value) || !Number.isSafeInteger(value))
        throw corrupt(`SQLite ${column} is invalid`);
    return value;
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidStorage(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function invalidTransaction(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function normalizeSql(value: string): string {
    return value.trim().replaceAll(/\s+/g, " ");
}
