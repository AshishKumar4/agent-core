import type { SynchronousResultGuard, TransactionOperation } from "../../actors";
import { Revision } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    InstalledSlot,
    SlotEntry,
    SlotName,
    WorkspaceSlotStore,
    type SlotContributionOrigin,
    type SlotEntryId
} from "../../facets";
import { WorkspaceId } from "../../identity";
import { TransactionalSqlite, isSqliteNumber, isSqliteText, type SqliteRow } from "./sqlite";

const SCHEMA_VERSION = 2;
const CREATE_MARKER = `CREATE TABLE IF NOT EXISTS facet_slot_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 2),
    workspace TEXT NOT NULL CHECK (length(workspace) > 0)
) STRICT`;
const CREATE_REVISION = `CREATE TABLE IF NOT EXISTS facet_slot_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT`;
const CREATE_SLOTS = `CREATE TABLE IF NOT EXISTS facet_slots (
    name TEXT PRIMARY KEY CHECK (length(name) > 0),
    contributor TEXT NOT NULL CHECK (length(contributor) > 0),
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
// §4.1's withdrawal set is a query by contributing Facet, so attribution is the index
// the retirement path reads rather than a scan over every slot.
const CREATE_ATTRIBUTION_INDEX = `CREATE INDEX IF NOT EXISTS facet_slot_entries_attribution
    ON facet_slot_entries (contributor, id)`;
const CREATE_SLOT_ATTRIBUTION_INDEX = `CREATE INDEX IF NOT EXISTS facet_slots_attribution
    ON facet_slots (contributor, name)`;

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
                number(markers[0]!, "version") !== SCHEMA_VERSION ||
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
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active) {
            throw invalidState("Nested SQLite Slot transactions are not supported");
        }
        return this.database.transaction(
            () => {
                this.#active = true;
                try {
                    return operation(this.database);
                } finally {
                    this.#active = false;
                }
            },
            ...guard
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

    public loadSlot(transaction: TransactionalSqlite, name: SlotName): InstalledSlot | undefined {
        this.requireDatabase(transaction);
        const row = transaction.all(
            "SELECT name, contributor, record FROM facet_slots WHERE name = ?",
            [name.value]
        )[0];
        return row === undefined ? undefined : decodeSlot(row, name.value);
    }

    public insertSlot(transaction: TransactionalSqlite, slot: InstalledSlot): void {
        this.requireDatabase(transaction);
        const bytes = InstalledSlot.encode(slot);
        transaction.run(
            `INSERT OR IGNORE INTO facet_slots (name, contributor, record) VALUES (?, ?, ?)`,
            [slot.declaration.name.value, slot.attribution.contributor.value, bytes]
        );
        const stored = this.loadSlot(transaction, slot.declaration.name);
        if (stored === undefined || !equalBytes(InstalledSlot.encode(stored), bytes)) {
            throw invalidState(`Slot declaration ${slot.declaration.name.value} is immutable`);
        }
    }

    public retireSlot(transaction: TransactionalSqlite, name: SlotName): void {
        this.requireDatabase(transaction);
        transaction.run("DELETE FROM facet_slots WHERE name = ?", [name.value]);
        if (this.loadSlot(transaction, name) !== undefined) {
            throw invalidState(`Slot ${name.value} was not retired`);
        }
    }

    public listSlots(transaction: TransactionalSqlite): readonly InstalledSlot[] {
        this.requireDatabase(transaction);
        return Object.freeze(
            transaction
                .all("SELECT name, contributor, record FROM facet_slots ORDER BY name", [])
                .map((row) => decodeSlot(row))
        );
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

    public loadEntryAt(
        transaction: TransactionalSqlite,
        origin: SlotContributionOrigin
    ): SlotEntry | undefined {
        this.requireDatabase(transaction);
        // The UNIQUE (slot, contributor, ordinal) constraint is this lookup's index.
        const row = transaction.all(
            `SELECT id, slot, contributor, ordinal, record
             FROM facet_slot_entries WHERE slot = ? AND contributor = ? AND ordinal = ?`,
            [origin.slot.value, origin.contributor.value, origin.ordinal]
        )[0];
        if (row === undefined) return undefined;
        const entry = decodeEntry(row);
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

    public listAllEntries(transaction: TransactionalSqlite): readonly SlotEntry[] {
        this.requireDatabase(transaction);
        return Object.freeze(
            transaction
                .all(
                    `SELECT id, slot, contributor, ordinal, record
                     FROM facet_slot_entries ORDER BY contributor, id`,
                    []
                )
                .map((row) => decodeEntry(row))
        );
    }

    public insertEntry(transaction: TransactionalSqlite, entry: SlotEntry): void {
        this.requireDatabase(transaction);
        const installed = this.loadSlot(transaction, entry.slot);
        if (installed === undefined) {
            throw new AgentCoreError("facet.inactive", `Slot ${entry.slot.value} is not installed`);
        }
        if (!installed.declaration.entrySchema.accepts(entry.value)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slot entry ${entry.id.value} does not match the entry schema`
            );
        }
        this.requireFreeOrigin(transaction, entry);
        const bytes = SlotEntry.encode(entry);
        transaction.run(
            `INSERT OR IGNORE INTO facet_slot_entries
                (id, slot, contributor, ordinal, record)
             VALUES (?, ?, ?, ?, ?)`,
            [
                entry.id.value,
                entry.slot.value,
                entry.attribution.contributor.value,
                entry.ordinal,
                bytes
            ]
        );
        const stored = this.loadEntry(transaction, entry.id);
        if (stored === undefined || !equalBytes(SlotEntry.encode(stored), bytes)) {
            throw invalidState(`Slot entry ${entry.id.value} is immutable`);
        }
    }

    public retireEntry(transaction: TransactionalSqlite, id: SlotEntryId): void {
        this.requireDatabase(transaction);
        transaction.run("DELETE FROM facet_slot_entries WHERE id = ?", [id.value]);
        const row = transaction.all("SELECT id FROM facet_slot_entries WHERE id = ?", [
            id.value
        ])[0];
        if (row !== undefined) throw invalidState(`Slot entry ${id.value} was not retired`);
    }

    private requireDatabase(transaction: TransactionalSqlite): void {
        if (transaction !== this.database) {
            throw invalidState("SQLite Slot access requires its owning database");
        }
    }

    private requireEntryClosure(transaction: TransactionalSqlite, entry: SlotEntry): void {
        const installed = this.loadSlot(transaction, entry.slot);
        if (installed === undefined || !installed.declaration.entrySchema.accepts(entry.value)) {
            throw corrupt(`SQLite Slot entry ${entry.id.value} violates its Slot declaration`);
        }
    }
}

const EXPECTED_TABLES = new Map<string, string>([
    ["facet_slot_schema", CREATE_MARKER],
    ["facet_slot_revision", CREATE_REVISION],
    ["facet_slots", CREATE_SLOTS],
    ["facet_slot_entries", CREATE_ENTRIES]
]);
const EXPECTED_INDEXES = new Map<string, string>([
    ["facet_slot_entries_query", CREATE_ENTRY_INDEX],
    ["facet_slot_entries_attribution", CREATE_ATTRIBUTION_INDEX],
    ["facet_slots_attribution", CREATE_SLOT_ATTRIBUTION_INDEX]
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
    database.run(CREATE_ATTRIBUTION_INDEX, []);
    database.run(CREATE_SLOT_ATTRIBUTION_INDEX, []);
    database.run(
        `INSERT INTO facet_slot_schema (singleton, version, workspace)
         VALUES (1, ?, ?)`,
        [SCHEMA_VERSION, owner.value]
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
        if (!isSqliteText(actual) || normalizeSql(actual) !== normalizeSql(sql)) {
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
    const installed = new Map<string, InstalledSlot>();
    for (const row of database.all(
        "SELECT name, contributor, record FROM facet_slots ORDER BY name",
        []
    )) {
        const slot = decodeSlot(row);
        installed.set(slot.declaration.name.value, slot);
    }
    let entryCount = 0;
    for (const row of database.all(
        `SELECT id, slot, contributor, ordinal, record
         FROM facet_slot_entries ORDER BY slot, ordinal, contributor, id`,
        []
    )) {
        const entry = decodeEntry(row);
        const slot = installed.get(entry.slot.value);
        if (slot === undefined || !slot.declaration.entrySchema.accepts(entry.value)) {
            throw corrupt(`SQLite Slot entry ${entry.id.value} violates its Slot declaration`);
        }
        entryCount += 1;
    }
    const revisionRows = database.all(
        "SELECT revision FROM facet_slot_revision WHERE singleton = 1",
        []
    );
    // Retirement (§4.1 withdrawal) advances the revision while removing records, so the
    // revision bounds the record count from above rather than equalling it.
    if (
        revisionRows.length !== 1 ||
        number(revisionRows[0]!, "revision") < installed.size + entryCount
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

function decodeSlot(row: SqliteRow, expectedName?: string): InstalledSlot {
    const record = InstalledSlot.decode(bytes(row, "record"));
    if (
        text(row, "name") !== record.declaration.name.value ||
        text(row, "contributor") !== record.attribution.contributor.value ||
        (expectedName !== undefined && record.declaration.name.value !== expectedName)
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
        text(row, "contributor") !== record.attribution.contributor.value ||
        number(row, "ordinal") !== record.ordinal ||
        (expectedId !== undefined && !record.id.equals(expectedId))
    ) {
        throw corrupt("SQLite Slot entry projection does not match codec bytes");
    }
    return record;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isSqliteText(value)) throw corrupt(`SQLite Slot column ${column} must be text`);
    return value;
}

function number(row: SqliteRow, column: string): number {
    const value = row[column];
    if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) {
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
