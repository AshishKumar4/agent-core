import type { SynchronousResultGuard, TransactionOperation } from "../../actors";
import { Revision } from "../../core";
import { AgentCoreError } from "../../errors";
import type { WorkspaceId } from "../../identity";
import { CatalogEntry } from "../../facets/catalog-entry";
import { WorkspaceCatalogStore } from "../../facets/catalog-entry-store";
import type { CatalogEntryId } from "../../facets/id";
import { TransactionalSqlite, isSqliteNumber, isSqliteText, type SqliteRow } from "./sqlite";

const SCHEMA_VERSION = 1;
const CREATE_MARKER = `CREATE TABLE IF NOT EXISTS facet_catalog_schema (
    singleton INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    workspace TEXT NOT NULL
) STRICT`;
const CREATE_REVISION = `CREATE TABLE IF NOT EXISTS facet_catalog_revision (
    singleton INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
) STRICT`;
const CREATE_ENTRIES = `CREATE TABLE IF NOT EXISTS facet_catalog_entries (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    record BLOB NOT NULL
) STRICT`;
// §4.2's origin — one owner per kind per name — is this lookup's UNIQUE index.
const CREATE_ORIGIN_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS facet_catalog_entries_origin
    ON facet_catalog_entries (owner, kind, name)`;
// §4.1's withdrawal set is a query by contributing Facet, so attribution is the index
// the retirement path reads rather than a scan over every entry.
const CREATE_ATTRIBUTION_INDEX = `CREATE INDEX IF NOT EXISTS facet_catalog_entries_attribution
    ON facet_catalog_entries (owner, id)`;

export class SqliteWorkspaceCatalogStore extends WorkspaceCatalogStore<TransactionalSqlite> {
    #active = false;

    public constructor(
        owner: WorkspaceId,
        private readonly database: TransactionalSqlite
    ) {
        super(owner);
        this.database.transaction(() => {
            if (hasCatalogSchema(this.database)) {
                requireExactSchema(this.database);
            } else {
                createSchema(this.database, owner);
            }
            const markers = this.database.all(
                "SELECT version, workspace FROM facet_catalog_schema WHERE singleton = 1",
                []
            );
            if (
                markers.length !== 1 ||
                number(markers[0]!, "version") !== SCHEMA_VERSION ||
                text(markers[0]!, "workspace") !== owner.value
            ) {
                throw corrupt("SQLite Catalog schema belongs to a different Workspace or version");
            }
            requireExactSchema(this.database);
            validateStoredState(this.database);
        });
    }

    public transaction<Result>(
        operation: TransactionOperation<TransactionalSqlite, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active) throw invalidState("Nested SQLite Catalog transactions are not supported");
        return this.database.transaction(
            () => {
                this.#active = true;
                try {
                    return operation(this.database);
                } finally {
                    this.#active = false;
                }
            },
            ..._guard
        );
    }

    public loadRevision(transaction: TransactionalSqlite): Revision {
        this.requireDatabase(transaction);
        const row = transaction.all(
            "SELECT revision FROM facet_catalog_revision WHERE singleton = 1",
            []
        )[0];
        if (row === undefined) throw corrupt("SQLite Catalog revision is missing");
        return new Revision(number(row, "revision"));
    }

    public saveRevision(transaction: TransactionalSqlite, revision: Revision): void {
        this.requireDatabase(transaction);
        const current = this.loadRevision(transaction);
        if (revision.value !== current.value + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Catalog revision must advance exactly once"
            );
        }
        transaction.run(
            `UPDATE facet_catalog_revision SET revision = ?
             WHERE singleton = 1 AND revision = ?`,
            [revision.value, current.value]
        );
        if (!this.loadRevision(transaction).equals(revision)) {
            throw corrupt("SQLite Catalog revision update did not persist");
        }
    }

    public loadEntry(transaction: TransactionalSqlite, id: CatalogEntryId): CatalogEntry | undefined {
        this.requireDatabase(transaction);
        const row = transaction.all(
            "SELECT id, owner, kind, name, record FROM facet_catalog_entries WHERE id = ?",
            [id.value]
        )[0];
        return row === undefined ? undefined : decodeEntry(row, id.value);
    }

    public loadEntryAt(
        transaction: TransactionalSqlite,
        origin: CatalogEntry["origin"]
    ): CatalogEntry | undefined {
        this.requireDatabase(transaction);
        // The UNIQUE (owner, kind, name) constraint is this lookup's index; a direct
        // declaration spends an empty owner segment.
        const row = transaction.all(
            `SELECT id, owner, kind, name, record
             FROM facet_catalog_entries WHERE owner = ? AND kind = ? AND name = ?`,
            [origin.owner?.value ?? "", origin.kind, origin.name]
        )[0];
        return row === undefined ? undefined : decodeEntry(row);
    }

    public listEntries(transaction: TransactionalSqlite): readonly CatalogEntry[] {
        this.requireDatabase(transaction);
        return Object.freeze(
            transaction
                .all(
                    "SELECT id, owner, kind, name, record FROM facet_catalog_entries ORDER BY id",
                    []
                )
                .map((row) => decodeEntry(row))
        );
    }

    public insertEntry(transaction: TransactionalSqlite, entry: CatalogEntry): void {
        this.requireDatabase(transaction);
        this.requireUnclaimedOrigin(transaction, entry);
        const bytes = CatalogEntry.encode(entry);
        transaction.run(
            `INSERT OR IGNORE INTO facet_catalog_entries (id, owner, kind, name, record)
             VALUES (?, ?, ?, ?, ?)`,
            [
                entry.id.value,
                entry.attribution?.contributor.value ?? "",
                entry.kind,
                entry.name,
                bytes
            ]
        );
        const stored = this.loadEntry(transaction, entry.id);
        if (stored === undefined || !equalBytes(CatalogEntry.encode(stored), bytes)) {
            throw invalidState(`Catalog entry ${entry.id.value} is immutable`);
        }
    }

    public retireEntry(transaction: TransactionalSqlite, id: CatalogEntryId): void {
        this.requireDatabase(transaction);
        if (this.loadEntry(transaction, id) === undefined) {
            throw invalidState(`Catalog entry ${id.value} is not contributed`);
        }
        transaction.run("DELETE FROM facet_catalog_entries WHERE id = ?", [id.value]);
        if (this.loadEntry(transaction, id) !== undefined) {
            throw invalidState(`Catalog entry ${id.value} was not retired`);
        }
    }

    private requireDatabase(transaction: TransactionalSqlite): void {
        if (transaction !== this.database || !this.#active) {
            throw invalidState("SQLite Catalog access requires its owning transaction");
        }
    }
}

const EXPECTED_TABLES = new Map<string, string>([
    ["facet_catalog_schema", CREATE_MARKER],
    ["facet_catalog_revision", CREATE_REVISION],
    ["facet_catalog_entries", CREATE_ENTRIES]
]);
const EXPECTED_INDEXES = new Map<string, string>([
    ["facet_catalog_entries_origin", CREATE_ORIGIN_INDEX],
    ["facet_catalog_entries_attribution", CREATE_ATTRIBUTION_INDEX]
]);

function hasCatalogSchema(database: TransactionalSqlite): boolean {
    return (
        database.all(
            `SELECT name FROM sqlite_master
         WHERE name LIKE 'facet_catalog%' AND type IN ('table', 'index', 'trigger')`,
            []
        ).length > 0
    );
}

function createSchema(database: TransactionalSqlite, owner: WorkspaceId): void {
    database.run(CREATE_MARKER, []);
    database.run(CREATE_REVISION, []);
    database.run(CREATE_ENTRIES, []);
    database.run(CREATE_ORIGIN_INDEX, []);
    database.run(CREATE_ATTRIBUTION_INDEX, []);
    database.run(
        `INSERT INTO facet_catalog_schema (singleton, version, workspace)
         VALUES (1, ?, ?)`,
        [SCHEMA_VERSION, owner.value]
    );
    database.run(
        `INSERT INTO facet_catalog_revision (singleton, revision)
         VALUES (1, 0)`,
        []
    );
}

function requireExactSchema(database: TransactionalSqlite): void {
    const rows = database.all(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger')`,
        []
    );
    const objects = new Map(rows.map((row) => [text(row, "name").toLowerCase(), row]));
    for (const [name, sql] of [...EXPECTED_TABLES, ...EXPECTED_INDEXES]) {
        const row = objects.get(name);
        const actual = row?.["sql"];
        if (!isSqliteText(actual) || normalizeSql(actual) !== normalizeSql(sql)) {
            throw corrupt(`SQLite Catalog schema object ${name} is malformed`);
        }
    }
    const protectedTables = new Set(EXPECTED_TABLES.keys());
    for (const row of rows) {
        const type = text(row, "type");
        const table = text(row, "tbl_name").toLowerCase();
        const name = text(row, "name").toLowerCase();
        const sql = row["sql"];
        if (
            protectedTables.has(table) &&
            (type === "trigger" ||
                (type === "index" && sql !== null && !EXPECTED_INDEXES.has(name)))
        ) {
            throw corrupt(`Unexpected SQLite ${type} ${name} targets Catalog state`);
        }
    }
    if (
        database.all("SELECT singleton FROM facet_catalog_schema", []).length !== 1 ||
        database.all("SELECT singleton FROM facet_catalog_revision", []).length !== 1
    ) {
        throw corrupt("SQLite Catalog singleton state is malformed");
    }
}

function validateStoredState(database: TransactionalSqlite): void {
    let entryCount = 0;
    for (const row of database.all(
        "SELECT id, owner, kind, name, record FROM facet_catalog_entries ORDER BY id",
        []
    )) {
        decodeEntry(row);
        entryCount += 1;
    }
    const revisionRows = database.all(
        "SELECT revision FROM facet_catalog_revision WHERE singleton = 1",
        []
    );
    // Retirement (§4.1 withdrawal) advances the revision while removing records, so the
    // revision bounds the record count from above rather than equalling it.
    if (
        revisionRows.length !== 1 ||
        number(revisionRows[0]!, "revision") < entryCount
    ) {
        throw corrupt("SQLite Catalog revision does not match its records");
    }
}

function normalizeSql(value: string): string {
    return value
        .replace(/\s+/gu, " ")
        .replace(/\s*([(),])\s*/gu, "$1")
        .trim()
        .toLowerCase()
        .replace("create table if not exists", "create table")
        .replace("create unique index if not exists", "create unique index")
        .replace("create index if not exists", "create index");
}

function decodeEntry(row: SqliteRow, expectedId?: string): CatalogEntry {
    const record = CatalogEntry.decode(bytes(row, "record"));
    if (
        text(row, "id") !== record.id.value ||
        text(row, "owner") !== (record.attribution?.contributor.value ?? "") ||
        text(row, "kind") !== record.kind ||
        text(row, "name") !== record.name ||
        (expectedId !== undefined && record.id.value !== expectedId)
    ) {
        throw corrupt("SQLite Catalog entry projection does not match codec bytes");
    }
    return record;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isSqliteText(value)) throw corrupt(`SQLite Catalog column ${column} must be text`);
    return value;
}

function number(row: SqliteRow, column: string): number {
    const value = row[column];
    if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) {
        throw corrupt(`SQLite Catalog column ${column} must be a non-negative integer`);
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corrupt(`SQLite Catalog column ${column} must be bytes`);
    return value.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
