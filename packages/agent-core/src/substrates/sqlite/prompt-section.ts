import type { SynchronousResultGuard, TransactionOperation } from "../../actors";
import { Revision } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    PromptSection,
    WorkspacePromptSectionStore,
    type PromptSectionContributionOrigin,
    type PromptSectionId
} from "../../facets";
import { WorkspaceId } from "../../identity";
import { TransactionalSqlite, isSqliteNumber, isSqliteText, type SqliteRow } from "./sqlite";

const SCHEMA_VERSION = 1;
const CREATE_MARKER = `CREATE TABLE IF NOT EXISTS facet_prompt_section_schema (
    singleton INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    workspace TEXT NOT NULL
) STRICT`;
const CREATE_REVISION = `CREATE TABLE IF NOT EXISTS facet_prompt_section_revision (
    singleton INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
) STRICT`;
const CREATE_SECTIONS = `CREATE TABLE IF NOT EXISTS facet_prompt_sections (
    id TEXT PRIMARY KEY,
    contributor TEXT NOT NULL,
    position INTEGER NOT NULL,
    record BLOB NOT NULL
) STRICT`;
// The UNIQUE constraint is the §4.2 origin lookup: at most one section per contributor per
// declared position, so a changed contribution's supersession is observable in storage.
const CREATE_ORIGIN_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS facet_prompt_sections_origin
    ON facet_prompt_sections (contributor, position)`;
// §4.1's withdrawal set is a query by contributing Facet, so attribution is the index
// the retirement path reads rather than a scan over every section.
const CREATE_ATTRIBUTION_INDEX = `CREATE INDEX IF NOT EXISTS facet_prompt_sections_attribution
    ON facet_prompt_sections (contributor, id)`;

export class SqliteWorkspacePromptSectionStore extends WorkspacePromptSectionStore<TransactionalSqlite> {
    #active = false;

    public constructor(
        owner: WorkspaceId,
        private readonly database: TransactionalSqlite
    ) {
        super(owner);
        this.database.transaction(() => {
            if (hasPromptSchema(this.database)) {
                requireExactSchema(this.database);
            } else {
                createSchema(this.database, owner);
            }
            const markers = this.database.all(
                "SELECT version, workspace FROM facet_prompt_section_schema WHERE singleton = 1",
                []
            );
            if (
                markers.length !== 1 ||
                number(markers[0]!, "version") !== SCHEMA_VERSION ||
                text(markers[0]!, "workspace") !== owner.value
            ) {
                throw corrupt(
                    "SQLite prompt section schema belongs to a different Workspace or version"
                );
            }
            requireExactSchema(this.database);
            validateStoredState(this.database);
        });
    }

    public transaction<Result>(
        operation: TransactionOperation<TransactionalSqlite, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active)
            throw invalidState("Nested SQLite prompt section transactions are not supported");
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
            "SELECT revision FROM facet_prompt_section_revision WHERE singleton = 1",
            []
        )[0];
        if (row === undefined) throw corrupt("SQLite prompt section revision is missing");
        return new Revision(number(row, "revision"));
    }

    public saveRevision(transaction: TransactionalSqlite, revision: Revision): void {
        this.requireDatabase(transaction);
        const current = this.loadRevision(transaction);
        if (revision.value !== current.value + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace prompt section revision must advance exactly once"
            );
        }
        transaction.run(
            `UPDATE facet_prompt_section_revision SET revision = ?
             WHERE singleton = 1 AND revision = ?`,
            [revision.value, current.value]
        );
        if (!this.loadRevision(transaction).equals(revision)) {
            throw corrupt("SQLite prompt section revision update did not persist");
        }
    }

    public loadSection(transaction: TransactionalSqlite, id: PromptSectionId): PromptSection | undefined {
        this.requireDatabase(transaction);
        const row = transaction.all(
            "SELECT id, contributor, position, record FROM facet_prompt_sections WHERE id = ?",
            [id.value]
        )[0];
        return row === undefined ? undefined : decodeSection(row, id);
    }

    public loadSectionAt(
        transaction: TransactionalSqlite,
        origin: PromptSectionContributionOrigin
    ): PromptSection | undefined {
        this.requireDatabase(transaction);
        // The UNIQUE (contributor, position) constraint is this lookup's index.
        const row = transaction.all(
            `SELECT id, contributor, position, record
             FROM facet_prompt_sections WHERE contributor = ? AND position = ?`,
            [origin.contributor.value, origin.position]
        )[0];
        return row === undefined ? undefined : decodeSection(row);
    }

    public listSections(transaction: TransactionalSqlite): readonly PromptSection[] {
        this.requireDatabase(transaction);
        return Object.freeze(
            transaction
                .all(
                    `SELECT id, contributor, position, record
                     FROM facet_prompt_sections ORDER BY contributor, position`,
                    []
                )
                .map((row) => decodeSection(row))
        );
    }

    public insertSection(transaction: TransactionalSqlite, section: PromptSection): void {
        this.requireDatabase(transaction);
        this.requireFreeOrigin(transaction, section);
        const bytes = PromptSection.encode(section);
        transaction.run(
            `INSERT OR IGNORE INTO facet_prompt_sections
                (id, contributor, position, record)
             VALUES (?, ?, ?, ?)`,
            [section.id.value, section.attribution.contributor.value, section.position, bytes]
        );
        const stored = this.loadSection(transaction, section.id);
        if (stored === undefined || !equalBytes(PromptSection.encode(stored), bytes)) {
            throw invalidState(`Prompt section ${section.id.value} is immutable`);
        }
    }

    public retireSection(transaction: TransactionalSqlite, id: PromptSectionId): void {
        this.requireDatabase(transaction);
        const held = transaction.all("SELECT id FROM facet_prompt_sections WHERE id = ?", [
            id.value
        ])[0];
        if (held === undefined) {
            throw invalidState(`Prompt section ${id.value} is not contributed`);
        }
        transaction.run("DELETE FROM facet_prompt_sections WHERE id = ?", [id.value]);
        if (
            transaction.all("SELECT id FROM facet_prompt_sections WHERE id = ?", [id.value])
                .length > 0
        ) {
            throw invalidState(`Prompt section ${id.value} was not retired`);
        }
    }

    private requireDatabase(transaction: TransactionalSqlite): void {
        if (transaction !== this.database || !this.#active) {
            throw invalidState("SQLite prompt section access requires its owning transaction");
        }
    }
}

const EXPECTED_TABLES = new Map<string, string>([
    ["facet_prompt_section_schema", CREATE_MARKER],
    ["facet_prompt_section_revision", CREATE_REVISION],
    ["facet_prompt_sections", CREATE_SECTIONS]
]);
const EXPECTED_INDEXES = new Map<string, string>([
    ["facet_prompt_sections_origin", CREATE_ORIGIN_INDEX],
    ["facet_prompt_sections_attribution", CREATE_ATTRIBUTION_INDEX]
]);

function hasPromptSchema(database: TransactionalSqlite): boolean {
    return (
        database.all(
            `SELECT name FROM sqlite_master
         WHERE name LIKE 'facet_prompt%' AND type IN ('table', 'index', 'trigger')`,
            []
        ).length > 0
    );
}

function createSchema(database: TransactionalSqlite, owner: WorkspaceId): void {
    database.run(CREATE_MARKER, []);
    database.run(CREATE_REVISION, []);
    database.run(CREATE_SECTIONS, []);
    database.run(CREATE_ORIGIN_INDEX, []);
    database.run(CREATE_ATTRIBUTION_INDEX, []);
    database.run(
        `INSERT INTO facet_prompt_section_schema (singleton, version, workspace)
         VALUES (1, ?, ?)`,
        [SCHEMA_VERSION, owner.value]
    );
    database.run(
        `INSERT INTO facet_prompt_section_revision (singleton, revision)
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
            throw corrupt(`SQLite prompt section schema object ${name} is malformed`);
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
            throw corrupt(`Unexpected SQLite ${type} ${name} targets prompt section state`);
        }
    }
    if (
        database.all("SELECT singleton FROM facet_prompt_section_schema", []).length !== 1 ||
        database.all("SELECT singleton FROM facet_prompt_section_revision", []).length !== 1
    ) {
        throw corrupt("SQLite prompt section singleton state is malformed");
    }
}

function validateStoredState(database: TransactionalSqlite): void {
    let count = 0;
    for (const row of database.all(
        `SELECT id, contributor, position, record
         FROM facet_prompt_sections ORDER BY contributor, position`,
        []
    )) {
        decodeSection(row);
        count += 1;
    }
    const revisionRows = database.all(
        "SELECT revision FROM facet_prompt_section_revision WHERE singleton = 1",
        []
    );
    // Retirement (§4.1 withdrawal) advances the revision while removing records, so the
    // revision bounds the record count from above rather than equalling it.
    if (revisionRows.length !== 1 || number(revisionRows[0]!, "revision") < count) {
        throw corrupt("SQLite prompt section revision does not match its records");
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

function decodeSection(row: SqliteRow, expectedId?: PromptSectionId): PromptSection {
    const record = PromptSection.decode(bytes(row, "record"));
    if (
        text(row, "id") !== record.id.value ||
        text(row, "contributor") !== record.attribution.contributor.value ||
        number(row, "position") !== record.origin.position ||
        (expectedId !== undefined && !record.id.equals(expectedId))
    ) {
        throw corrupt("SQLite prompt section projection does not match codec bytes");
    }
    return record;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isSqliteText(value)) throw corrupt(`SQLite prompt section column ${column} must be text`);
    return value;
}

function number(row: SqliteRow, column: string): number {
    const value = row[column];
    if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) {
        throw corrupt(`SQLite prompt section column ${column} must be a non-negative integer`);
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array))
        throw corrupt(`SQLite prompt section column ${column} must be bytes`);
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
