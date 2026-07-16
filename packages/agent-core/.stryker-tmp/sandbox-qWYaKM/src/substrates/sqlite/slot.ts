// @ts-nocheck
import type { SynchronousResultGuard, TransactionOperation } from "../../actors";
import { Revision } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    SlotDeclaration,
    SlotEntry,
    SlotName,
    WorkspaceSlotStore,
    type SlotEntryId
} from "../../facets";
import { WorkspaceId } from "../../identity";
import { TransactionalSqlite, type SqliteRow } from "./sqlite";

const CREATE_MARKER = `CREATE TABLE IF NOT EXISTS facet_slot_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 1),
    workspace TEXT NOT NULL CHECK (length(workspace) > 0)
) STRICT`;
const CREATE_REVISION = `CREATE TABLE IF NOT EXISTS facet_slot_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT`;
const CREATE_SLOTS = `CREATE TABLE IF NOT EXISTS facet_slots (
    name TEXT PRIMARY KEY CHECK (length(name) > 0),
    record BLOB NOT NULL
) STRICT`;
const CREATE_ENTRIES = `CREATE TABLE IF NOT EXISTS facet_slot_entries (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    slot TEXT NOT NULL CHECK (length(slot) > 0),
    contributor TEXT NOT NULL CHECK (length(contributor) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    record BLOB NOT NULL,
    UNIQUE (slot, contributor, ordinal)
) STRICT`;
const CREATE_ENTRY_INDEX = `CREATE INDEX IF NOT EXISTS facet_slot_entries_query
    ON facet_slot_entries (slot, ordinal, contributor, id)`;

export class SqliteWorkspaceSlotStore extends WorkspaceSlotStore<TransactionalSqlite> {
    #active = false;

    public constructor(
        owner: WorkspaceId,
        private readonly database: TransactionalSqlite
    ) {
        super(owner);
        this.database.transaction(() => {
            if (hasSlotSchema(this.database)) {
                requireExactSchema(this.database);
            } else {
                createSchema(this.database, owner);
            }
            const markers = this.database.all(
                "SELECT version, workspace FROM facet_slot_schema WHERE singleton = 1",
                []
            );
            if (
                markers.length !== 1 ||
                number(markers[0]!, "version") !== 1 ||
                text(markers[0]!, "workspace") !== owner.value
            ) {
                throw corrupt("SQLite Slot schema belongs to a different Workspace or version");
            }
            requireExactSchema(this.database);
            validateStoredState(this.database);
        });
    }

    public transaction<Result>(
        operation: TransactionOperation<TransactionalSqlite, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active) throw invalidState("Nested SQLite Slot transactions are not supported");
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
            "SELECT revision FROM facet_slot_revision WHERE singleton = 1",
            []
        )[0];
        if (row === undefined) throw corrupt("SQLite Slot revision is missing");
        return new Revision(number(row, "revision"));
    }

    public saveRevision(transaction: TransactionalSqlite, revision: Revision): void {
        this.requireDatabase(transaction);
        const current = this.loadRevision(transaction);
        if (revision.value !== current.value + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Slot revision must advance exactly once"
            );
        }
        transaction.run(
            `UPDATE facet_slot_revision SET revision = ?
             WHERE singleton = 1 AND revision = ?`,
            [revision.value, current.value]
        );
        if (!this.loadRevision(transaction).equals(revision)) {
            throw corrupt("SQLite Slot revision update did not persist");
        }
    }

    public loadSlot(transaction: TransactionalSqlite, name: SlotName): SlotDeclaration | undefined {
        this.requireDatabase(transaction);
        const row = transaction.all("SELECT name, record FROM facet_slots WHERE name = ?", [
            name.value
        ])[0];
        return row === undefined ? undefined : decodeSlot(row, name.value);
    }

    public insertSlot(transaction: TransactionalSqlite, declaration: SlotDeclaration): void {
        this.requireDatabase(transaction);
        const bytes = SlotDeclaration.encode(declaration);
        transaction.run("INSERT OR IGNORE INTO facet_slots (name, record) VALUES (?, ?)", [
            declaration.name.value,
            bytes
        ]);
        const stored = this.loadSlot(transaction, declaration.name);
        if (stored === undefined || !equalBytes(SlotDeclaration.encode(stored), bytes)) {
            throw invalidState(`Slot declaration ${declaration.name.value} is immutable`);
        }
    }

    public loadEntry(transaction: TransactionalSqlite, id: SlotEntry["id"]): SlotEntry | undefined {
        this.requireDatabase(transaction);
        const row = transaction.all(
            `SELECT id, slot, contributor, ordinal, record
             FROM facet_slot_entries WHERE id = ?`,
            [id.value]
        )[0];
        if (row === undefined) return undefined;
        const entry = decodeEntry(row, id);
        this.requireEntryClosure(transaction, entry);
        return entry;
    }

    public listEntries(transaction: TransactionalSqlite, slot: SlotName): readonly SlotEntry[] {
        this.requireDatabase(transaction);
        const entries = transaction
            .all(
                `SELECT id, slot, contributor, ordinal, record
             FROM facet_slot_entries WHERE slot = ?
             ORDER BY ordinal, contributor, id`,
                [slot.value]
            )
            .map((row) => decodeEntry(row));
        for (const entry of entries) this.requireEntryClosure(transaction, entry);
        return Object.freeze(entries);
    }

    public insertEntry(transaction: TransactionalSqlite, entry: SlotEntry): void {
        this.requireDatabase(transaction);
        const declaration = this.loadSlot(transaction, entry.slot);
        if (declaration === undefined) {
            throw new AgentCoreError("facet.inactive", `Slot ${entry.slot.value} is not installed`);
        }
        if (!declaration.entrySchema.accepts(entry.value)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slot entry ${entry.id.value} does not match the entry schema`
            );
        }
        const bytes = SlotEntry.encode(entry);
        transaction.run(
            `INSERT OR IGNORE INTO facet_slot_entries
                (id, slot, contributor, ordinal, record)
             VALUES (?, ?, ?, ?, ?)`,
            [entry.id.value, entry.slot.value, entry.contributor.value, entry.ordinal, bytes]
        );
        const stored = this.loadEntry(transaction, entry.id);
        if (stored === undefined || !equalBytes(SlotEntry.encode(stored), bytes)) {
            throw invalidState(`Slot entry ${entry.id.value} is immutable`);
        }
    }

    private requireDatabase(transaction: TransactionalSqlite): void {
        if (transaction !== this.database || !this.#active) {
            throw invalidState("SQLite Slot access requires its owning transaction");
        }
    }

    private requireEntryClosure(transaction: TransactionalSqlite, entry: SlotEntry): void {
        const declaration = this.loadSlot(transaction, entry.slot);
        if (declaration === undefined || !declaration.entrySchema.accepts(entry.value)) {
            throw corrupt(`SQLite Slot entry ${entry.id.value} violates its Slot declaration`);
        }
    }

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    public slot(name: SlotName): SlotDeclaration | undefined {
        return this.transaction((transaction) => this.loadSlot(transaction, name));
    }

    public entries(name: SlotName): readonly SlotEntry[] {
        return this.transaction((transaction) => this.listEntries(transaction, name));
    }

    public install(declaration: SlotDeclaration): Revision {
        return this.transaction((transaction) => {
            const existing = this.loadSlot(transaction, declaration.name);
            if (
                existing !== undefined &&
                equalBytes(SlotDeclaration.encode(existing), SlotDeclaration.encode(declaration))
            )
                return this.loadRevision(transaction);
            this.insertSlot(transaction, declaration);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    public contribute(entry: SlotEntry): Revision {
        return this.transaction((transaction) => {
            const existing = this.loadEntry(transaction, entry.id);
            if (
                existing !== undefined &&
                equalBytes(SlotEntry.encode(existing), SlotEntry.encode(entry))
            )
                return this.loadRevision(transaction);
            this.insertEntry(transaction, entry);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }
}

const EXPECTED_TABLES = new Map<string, string>([
    ["facet_slot_schema", CREATE_MARKER],
    ["facet_slot_revision", CREATE_REVISION],
    ["facet_slots", CREATE_SLOTS],
    ["facet_slot_entries", CREATE_ENTRIES]
]);
const EXPECTED_INDEXES = new Map<string, string>([
    ["facet_slot_entries_query", CREATE_ENTRY_INDEX]
]);

function hasSlotSchema(database: TransactionalSqlite): boolean {
    return (
        database.all(
            `SELECT name FROM sqlite_master
         WHERE name LIKE 'facet_slot%' AND type IN ('table', 'index', 'trigger')`,
            []
        ).length > 0
    );
}

function createSchema(database: TransactionalSqlite, owner: WorkspaceId): void {
    database.run(CREATE_MARKER, []);
    database.run(CREATE_REVISION, []);
    database.run(CREATE_SLOTS, []);
    database.run(CREATE_ENTRIES, []);
    database.run(CREATE_ENTRY_INDEX, []);
    database.run(
        `INSERT INTO facet_slot_schema (singleton, version, workspace)
         VALUES (1, 1, ?)`,
        [owner.value]
    );
    database.run(
        `INSERT INTO facet_slot_revision (singleton, revision)
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
        if (typeof actual !== "string" || normalizeSql(actual) !== normalizeSql(sql)) {
            throw corrupt(`SQLite Slot schema object ${name} is malformed`);
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
            throw corrupt(`Unexpected SQLite ${type} ${name} targets Slot state`);
        }
    }
    if (
        database.all("SELECT singleton FROM facet_slot_schema", []).length !== 1 ||
        database.all("SELECT singleton FROM facet_slot_revision", []).length !== 1
    ) {
        throw corrupt("SQLite Slot singleton state is malformed");
    }
}

function validateStoredState(database: TransactionalSqlite): void {
    const declarations = new Map<string, SlotDeclaration>();
    for (const row of database.all("SELECT name, record FROM facet_slots ORDER BY name", [])) {
        const declaration = decodeSlot(row);
        declarations.set(declaration.name.value, declaration);
    }
    let entryCount = 0;
    for (const row of database.all(
        `SELECT id, slot, contributor, ordinal, record
         FROM facet_slot_entries ORDER BY slot, ordinal, contributor, id`,
        []
    )) {
        const entry = decodeEntry(row);
        const declaration = declarations.get(entry.slot.value);
        if (declaration === undefined || !declaration.entrySchema.accepts(entry.value)) {
            throw corrupt(`SQLite Slot entry ${entry.id.value} violates its Slot declaration`);
        }
        entryCount += 1;
    }
    const revisionRows = database.all(
        "SELECT revision FROM facet_slot_revision WHERE singleton = 1",
        []
    );
    if (
        revisionRows.length !== 1 ||
        number(revisionRows[0]!, "revision") !== declarations.size + entryCount
    ) {
        throw corrupt("SQLite Slot revision does not match its records");
    }
}

function normalizeSql(value: string): string {
    return value
        .replace(/\s+/gu, " ")
        .replace(/\s*([(),])\s*/gu, "$1")
        .trim()
        .toLowerCase()
        .replace("create table if not exists", "create table")
        .replace("create index if not exists", "create index");
}

function decodeSlot(row: SqliteRow, expectedName?: string): SlotDeclaration {
    const record = SlotDeclaration.decode(bytes(row, "record"));
    if (
        text(row, "name") !== record.name.value ||
        (expectedName !== undefined && record.name.value !== expectedName)
    ) {
        throw corrupt("SQLite Slot declaration projection does not match codec bytes");
    }
    return record;
}

function decodeEntry(row: SqliteRow, expectedId?: SlotEntryId): SlotEntry {
    const record = SlotEntry.decode(bytes(row, "record"));
    if (
        text(row, "id") !== record.id.value ||
        text(row, "slot") !== record.slot.value ||
        text(row, "contributor") !== record.contributor.value ||
        number(row, "ordinal") !== record.ordinal ||
        (expectedId !== undefined && !record.id.equals(expectedId))
    ) {
        throw corrupt("SQLite Slot entry projection does not match codec bytes");
    }
    return record;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") throw corrupt(`SQLite Slot column ${column} must be text`);
    return value;
}

function number(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corrupt(`SQLite Slot column ${column} must be a non-negative integer`);
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corrupt(`SQLite Slot column ${column} must be bytes`);
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
