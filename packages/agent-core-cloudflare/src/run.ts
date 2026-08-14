import { ActorId, ActorRef } from "@agent-core/core/actors";
import type { SynchronousResultGuard } from "@agent-core/core/actors";
import { RunId } from "@agent-core/core/agents/runs";
import type {
    RunRecordKind,
    RunStoragePort,
    StoredRunParent,
    StoredRunRecord
} from "@agent-core/core/agents/runs";
import { actorObjectName } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteApplicationMigration, SynchronousSqlitePort } from "./migration.js";
import type { SqliteRow, SqliteValue, StoredRowReader } from "./sqlite.js";
import { CloudflareSqlite, requireStorableBlob, storedRowReader } from "./sqlite.js";

const SCHEMA_VERSION = 1;
const SCHEMA_TABLE = "agent_run_storage_schema";
const RECORD_TABLE = "agent_run_records";
const PARENT_TABLE = "agent_run_commit_parents";
const PARENT_INDEX = "agent_run_commit_parent_reverse";
const HOSTING_TABLE = "agent_core_run_hosting";

/**
 * The record makes the set exhaustive at compile time: a kind added to the core union
 * without an entry here fails to typecheck rather than failing at an INSERT.
 */
const RECORD_KIND_SET = {
    configuration: true,
    run: true,
    branch: true,
    commit: true,
    turn: true,
    placement: true,
    checkpoint: true,
    inbox: true,
    spawn: true,
    admission: true,
    forcedCancellation: true,
    acceptance: true,
    verdict: true
} satisfies Record<RunRecordKind, true>;

const RECORD_KINDS: readonly RunRecordKind[] = Object.freeze(
    Object.keys(RECORD_KIND_SET).filter(isRecordKind)
);
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
const CREATE_PARENT_INDEX = `CREATE INDEX ${PARENT_INDEX}
    ON ${PARENT_TABLE} (parent_id, commit_id)`;
const EXPECTED_SCHEMA = new Map<string, { readonly type: "table" | "index"; readonly sql: string }>(
    [
        [SCHEMA_TABLE, { type: "table", sql: CREATE_SCHEMA }],
        [RECORD_TABLE, { type: "table", sql: CREATE_RECORDS }],
        [PARENT_TABLE, { type: "table", sql: CREATE_PARENTS }],
        [PARENT_INDEX, { type: "index", sql: CREATE_PARENT_INDEX }]
    ]
);
const READ_SCHEMA_OBJECTS = `SELECT name, type, sql FROM sqlite_schema
    WHERE name LIKE 'agent_run_%' ORDER BY name`;
const READ_HOSTING = `SELECT run_id, mode, workspace_id FROM ${HOSTING_TABLE} WHERE run_id = ?`;
const INSERT_HOSTING = `INSERT INTO ${HOSTING_TABLE} (run_id, mode, workspace_id)
    VALUES (?, ?, ?)`;

export type RunHostingMode = "workspace" | "dedicated";

/**
 * Where one Run's records live. Offering no pin is the Workspace-owned default; the only
 * pin a Run may be given is `dedicated`, which moves ownership to a Run Durable Object of
 * its own. Either way exactly one Actor object owns the Run, so its pins, outcome, commit
 * graph, and derived settlement obligations never straddle a boundary no transaction
 * crosses.
 */
export class CloudflareRunHosting {
    public readonly owner: ActorRef;
    public readonly objectName: string;

    public constructor(
        public readonly run: RunId,
        public readonly workspace: ActorId,
        public readonly mode: RunHostingMode = "workspace"
    ) {
        if (mode !== "workspace" && mode !== "dedicated") {
            throw new TypeError("Run hosting mode must be workspace or dedicated");
        }
        this.owner =
            mode === "workspace"
                ? new ActorRef("workspace", workspace)
                : new ActorRef("run", new ActorId(run.value));
        this.objectName = actorObjectName(this.owner);
        Object.freeze(this);
    }

    public equals(other: CloudflareRunHosting): boolean {
        return (
            this.run.equals(other.run) &&
            this.mode === other.mode &&
            this.workspace.equals(other.workspace)
        );
    }
}

/**
 * Installs the Workspace's Run index. It belongs to the Workspace object rather than the
 * runtime migrations every Actor object applies: a Run object that installed its own index
 * could pin a second hosting for a Run the Workspace already started.
 */
export function runHostingMigration(version: number): SqliteApplicationMigration {
    return Object.freeze({
        version,
        name: "cloudflare-run-hosting",
        statements: Object.freeze([
            `CREATE TABLE ${HOSTING_TABLE} (
                run_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL CHECK (mode IN ('workspace', 'dedicated')),
                workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0)
            ) STRICT`
        ])
    });
}

/**
 * The Workspace's record of where each of its Runs is hosted. `start` is the only writer,
 * because hosting is decided once, at Run start: a repeated start with the same decision
 * is idempotent under at-least-once delivery, and a different decision for a Run that has
 * already started is refused rather than silently moving the Run's owner. Changing a
 * started Run is Run migration (SPEC §5.2), which rewrites pins, not ownership.
 */
export class SqliteRunHostingIndex {
    private readonly rows = storedRowReader((column) =>
        operationalFailure(this.errors, "codec.invalid", `Stored Run hosting ${column} is corrupt`)
    );

    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {}

    public start(hosting: CloudflareRunHosting): CloudflareRunHosting {
        return this.database.transaction(() => {
            const existing = this.get(hosting.run);
            if (existing === undefined) {
                this.database.run(INSERT_HOSTING, [
                    hosting.run.value,
                    hosting.mode,
                    hosting.workspace.value
                ]);
                return hosting;
            }
            if (existing.equals(hosting)) return existing;
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Run ${hosting.run.value} started ${existing.mode}-hosted; a Run may be ` +
                    `pinned ${hosting.mode} only at start`
            );
        });
    }

    public get(run: RunId): CloudflareRunHosting | undefined {
        const row = this.database.all(READ_HOSTING, [run.value])[0];
        if (row === undefined) return undefined;
        // The column reads name the column that is wrong; what is left inside the guard is
        // domain validation, whose TypeErrors carry no code of their own.
        const workspace = this.rows.text(row, "workspace_id");
        try {
            return new CloudflareRunHosting(
                run,
                new ActorId(workspace),
                requireHostingMode(row["mode"])
            );
        } catch (cause) {
            operationalFailure(this.errors, "codec.invalid", "Stored Run hosting is corrupt", {
                value: cause
            });
        }
    }
}

/**
 * The Run record store over a Durable Object's private SQLite, bound to the Actor object
 * its hosting names. The owner marker is part of the schema, so a store opened under a
 * hosting other than the one that created it fails closed instead of serving another
 * owner's Run: the Workspace object cannot read a `dedicated` Run's records, and the Run
 * object cannot read the Workspace's.
 */
export class DurableObjectRunStorage implements RunStoragePort<CloudflareSqlite> {
    public readonly owner: ActorRef;
    private readonly rows: StoredRowReader;

    public constructor(
        private readonly database: CloudflareSqlite,
        public readonly hosting: CloudflareRunHosting,
        private readonly errors: CloudflareErrorPort
    ) {
        this.owner = hosting.owner;
        // Assigned before `initialize`, which reads rows while the constructor still runs.
        this.rows = storedRowReader((column) => this.corrupt(`SQLite ${column} is invalid`));
        database.transaction(() => this.initialize(database));
    }

    public transaction<Result>(
        operation: (transaction: CloudflareSqlite) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.database.transaction(() => operation(this.database), ...guard);
    }

    public get(
        transaction: CloudflareSqlite,
        kind: RunRecordKind,
        key: string
    ): StoredRunRecord | undefined {
        this.requireKind(kind);
        const rows = transaction.all(
            `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? AND record_key = ?`,
            [kind, key]
        );
        if (rows.length > 1) {
            this.corrupt("Run record primary key returned multiple rows");
        }
        const row = rows[0];
        return row === undefined ? undefined : this.decodeRecord(row, kind, key);
    }

    public list(transaction: CloudflareSqlite, kind: RunRecordKind): readonly StoredRunRecord[] {
        this.requireKind(kind);
        return transaction
            .all(
                `SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? ORDER BY record_key`,
                [kind]
            )
            .map((row) => this.decodeRecord(row, kind));
    }

    public insert(transaction: CloudflareSqlite, record: StoredRunRecord): void {
        this.requireRecord(record);
        const existing = this.get(transaction, record.kind, record.key);
        if (existing !== undefined) {
            if (recordsEqual(existing, record)) return;
            operationalFailure(
                this.errors,
                "run.invalid-state",
                "Run records are immutable unless replaced by revision CAS"
            );
        }
        transaction.run(
            `INSERT INTO ${RECORD_TABLE} (kind, record_key, revision, record)
             VALUES (?, ?, ?, ?)`,
            [record.kind, record.key, record.revision, record.bytes]
        );
    }

    public replace(
        transaction: CloudflareSqlite,
        record: StoredRunRecord,
        expectedRevision: number
    ): void {
        this.requireRecord(record);
        const existing = this.get(transaction, record.kind, record.key);
        if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
            operationalFailure(
                this.errors,
                "protocol.revision-conflict",
                "Run record revision changed"
            );
        }
        transaction.run(
            `UPDATE ${RECORD_TABLE} SET revision = ?, record = ?
             WHERE kind = ? AND record_key = ? AND revision = ?`,
            [record.revision, record.bytes, record.kind, record.key, expectedRevision]
        );
    }

    public insertParent(transaction: CloudflareSqlite, edge: StoredRunParent): void {
        this.requireParent(edge);
        const rows = transaction.all(
            `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? AND ordinal = ?`,
            [edge.commit, edge.ordinal]
        );
        const row = rows[0];
        if (row !== undefined) {
            if (this.decodeParent(row).parent === edge.parent) return;
            operationalFailure(
                this.errors,
                "run.invalid-state",
                "Run commit parent edges are immutable"
            );
        }
        transaction.run(
            `INSERT INTO ${PARENT_TABLE} (commit_id, ordinal, parent_id) VALUES (?, ?, ?)`,
            [edge.commit, edge.ordinal, edge.parent]
        );
    }

    public parents(transaction: CloudflareSqlite, commit: string): readonly StoredRunParent[] {
        return transaction
            .all(
                `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? ORDER BY ordinal`,
                [commit]
            )
            .map((row) => this.decodeParent(row));
    }

    private initialize(database: CloudflareSqlite): void {
        const objects = new Set(
            database.all(READ_SCHEMA_OBJECTS, []).map((row) => this.rows.text(row, "name"))
        );
        if (!objects.has(SCHEMA_TABLE)) {
            if (objects.size !== 0) {
                this.corrupt("Unmarked Run storage objects require explicit replacement");
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

    private validateSchema(database: CloudflareSqlite): void {
        const rows = database.all(READ_SCHEMA_OBJECTS, []);
        const names = new Set(rows.map((row) => this.rows.text(row, "name")));
        if (
            names.size !== EXPECTED_SCHEMA.size ||
            [...EXPECTED_SCHEMA.keys()].some((name) => !names.has(name))
        ) {
            this.corrupt("Run storage schema is incomplete or contains unexpected objects");
        }
        for (const row of rows) {
            const name = this.rows.text(row, "name");
            const expected = EXPECTED_SCHEMA.get(name);
            if (
                expected === undefined ||
                this.rows.text(row, "type") !== expected.type ||
                normalizeSql(this.rows.text(row, "sql")) !== normalizeSql(expected.sql)
            ) {
                this.corrupt(`Run storage object ${name} does not match its exact schema`);
            }
        }
        // The marker's schema pins its version and admits at most one row, so only the
        // owner and the marker's presence are still open questions here.
        const marker = database.all(`SELECT owner_kind, owner_id FROM ${SCHEMA_TABLE}`, [])[0];
        if (
            marker === undefined ||
            this.rows.text(marker, "owner_kind") !== this.owner.kind ||
            this.rows.text(marker, "owner_id") !== this.owner.id.value
        ) {
            this.corrupt("Run storage owner does not match");
        }
        for (const kind of RECORD_KINDS) this.list(database, kind);
        for (const row of database.all(
            `SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE} ORDER BY commit_id, ordinal`,
            []
        )) {
            this.decodeParent(row);
        }
    }

    private decodeRecord(
        row: SqliteRow,
        expectedKind: RunRecordKind,
        expectedKey?: string
    ): StoredRunRecord {
        const kind = this.rows.text(row, "kind");
        const key = this.rows.text(row, "record_key");
        const revision = this.rows.nullableInteger(row, "revision");
        const bytes = this.rows.bytes(row, "record");
        if (
            kind !== expectedKind ||
            (expectedKey !== undefined && key !== expectedKey) ||
            (revision !== null && revision < 0)
        ) {
            this.corrupt("Stored Run record projection is malformed");
        }
        return Object.freeze({ kind: expectedKind, key, revision, bytes });
    }

    private decodeParent(row: SqliteRow): StoredRunParent {
        const edge = Object.freeze({
            commit: this.rows.text(row, "commit_id"),
            ordinal: this.rows.integer(row, "ordinal"),
            parent: this.rows.text(row, "parent_id")
        });
        this.requireParent(edge);
        return edge;
    }

    private requireRecord(record: StoredRunRecord): void {
        this.requireKind(record.kind);
        if (
            record.key.length === 0 ||
            !(record.bytes instanceof Uint8Array) ||
            (record.revision !== null &&
                (!Number.isSafeInteger(record.revision) || record.revision < 0))
        ) {
            this.corrupt("Stored Run record is malformed");
        }
        requireStorableBlob(`Run ${record.kind} record`, record.bytes, this.errors);
    }

    private requireKind(kind: string): asserts kind is RunRecordKind {
        if (!isRecordKind(kind)) this.corrupt("Stored Run record kind is invalid");
    }

    private requireParent(edge: StoredRunParent): void {
        if (
            edge.commit.length === 0 ||
            edge.parent.length === 0 ||
            !Number.isSafeInteger(edge.ordinal) ||
            edge.ordinal < 0 ||
            edge.ordinal > 1
        ) {
            this.corrupt("Stored Run parent edge is malformed");
        }
    }

    private corrupt(message: string): never {
        operationalFailure(this.errors, "codec.invalid", message);
    }
}

function requireHostingMode(value: SqliteValue | undefined): RunHostingMode {
    if (value !== "workspace" && value !== "dedicated") {
        throw new TypeError("Stored Run hosting mode is invalid");
    }
    return value;
}

function isRecordKind(value: string): value is RunRecordKind {
    return Object.hasOwn(RECORD_KIND_SET, value);
}

function recordsEqual(left: StoredRunRecord, right: StoredRunRecord): boolean {
    return (
        left.revision === right.revision &&
        left.bytes.byteLength === right.bytes.byteLength &&
        left.bytes.every((value, index) => value === right.bytes[index])
    );
}

function normalizeSql(value: string): string {
    return value.trim().replaceAll(/\s+/g, " ");
}
