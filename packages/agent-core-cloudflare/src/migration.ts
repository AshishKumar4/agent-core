import type { TransactionalSqlite } from "@agent-core/core/substrates/sqlite";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteRow } from "./sqlite.js";
import { storedRowReader } from "./sqlite.js";

const CREATE_MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS agent_core_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
) STRICT`;
const READ_MIGRATIONS = "SELECT version, name FROM agent_core_migrations ORDER BY version";
const INSERT_MIGRATION = "INSERT INTO agent_core_migrations (version, name) VALUES (?, ?)";

/**
 * The refusal an object raises when its storage carries a schema marker this code does
 * not declare. It is permanent for as long as the deployed release stays behind the
 * schema, so the boundary that raises it is the object's operations, never its
 * construction.
 */
export const UNREADABLE_SCHEMA = "schema.unreadable";

export type SynchronousSqlitePort = Pick<TransactionalSqlite, "all" | "run" | "transaction">;

export interface SqliteApplicationMigration {
    readonly version: number;
    readonly name: string;
    readonly statements: readonly string[];
}

export const cloudflareRuntimeMigrations: readonly SqliteApplicationMigration[] = Object.freeze([
    Object.freeze({
        version: 1,
        name: "cloudflare-runtime-views-and-outbox",
        statements: Object.freeze([
            `CREATE TABLE agent_core_view_snapshots (
                channel TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                payload BLOB NOT NULL,
                PRIMARY KEY (channel, revision)
            ) STRICT`,
            `CREATE TABLE agent_core_view_deltas (
                channel TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision > 0),
                payload BLOB NOT NULL,
                PRIMARY KEY (channel, revision)
            ) STRICT`,
            `CREATE TABLE agent_core_reconciliation_outbox (
                id TEXT PRIMARY KEY,
                scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0)
            ) STRICT`,
            `CREATE INDEX agent_core_reconciliation_due
                ON agent_core_reconciliation_outbox (scheduled_at, id)`
        ])
    }),
    Object.freeze({
        version: 2,
        name: "cloudflare-runtime-alarm-claims",
        statements: Object.freeze([
            `CREATE TABLE agent_core_alarm_claims (
                owner TEXT PRIMARY KEY,
                due_at INTEGER NOT NULL CHECK (due_at >= 0)
            ) STRICT`
        ])
    }),
    Object.freeze({
        version: 3,
        name: "cloudflare-runtime-resumable-operations",
        statements: Object.freeze([
            `CREATE TABLE agent_core_resumable_operations (
                id TEXT PRIMARY KEY,
                work TEXT NOT NULL,
                attempts INTEGER NOT NULL CHECK (attempts >= 0),
                claimed INTEGER NOT NULL CHECK (claimed IN (0, 1))
            ) STRICT`,
            `CREATE TABLE agent_core_resumable_steps (
                operation_id TEXT NOT NULL,
                step TEXT NOT NULL,
                PRIMARY KEY (operation_id, step)
            ) STRICT`
        ])
    })
]);

export class SqliteApplicationMigrator {
    readonly #migrations: readonly SqliteApplicationMigration[];

    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort,
        migrations: readonly SqliteApplicationMigration[] = cloudflareRuntimeMigrations
    ) {
        this.#migrations = validateMigrations(migrations);
    }

    public migrate(): readonly number[] {
        this.database.run(CREATE_MIGRATION_TABLE, []);
        const applied = readApplied(this.database.all(READ_MIGRATIONS, []), this.errors);
        const declared = new Map(
            this.#migrations.map((migration) => [migration.version, migration.name])
        );
        for (const [version, name] of applied) {
            if (declared.get(version) !== name) {
                operationalFailure(
                    this.errors,
                    UNREADABLE_SCHEMA,
                    `SQLite migration ${version} marker ${name} is not declared by this runtime`
                );
            }
        }
        for (const migration of this.#migrations) {
            if (applied.has(migration.version)) continue;
            this.database.transaction(() => {
                for (const statement of migration.statements) this.database.run(statement, []);
                this.database.run(INSERT_MIGRATION, [migration.version, migration.name]);
            });
            applied.set(migration.version, migration.name);
        }
        return Object.freeze([...applied.keys()].sort((left, right) => left - right));
    }
}

function validateMigrations(
    migrations: readonly SqliteApplicationMigration[]
): readonly SqliteApplicationMigration[] {
    let previous = 0;
    const copy: SqliteApplicationMigration[] = [];
    for (const migration of migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version !== previous + 1) {
            throw new TypeError(
                "SQLite application migrations must have contiguous positive versions"
            );
        }
        if (migration.name.length === 0 || migration.statements.length === 0) {
            throw new TypeError("SQLite application migrations require a name and statements");
        }
        if (migration.statements.some((statement) => statement.trim().length === 0)) {
            throw new TypeError("SQLite application migration statements must be non-empty");
        }
        copy.push(
            Object.freeze({
                version: migration.version,
                name: migration.name,
                statements: Object.freeze([...migration.statements])
            })
        );
        previous = migration.version;
    }
    return Object.freeze(copy);
}

function readApplied(rows: readonly SqliteRow[], errors: CloudflareErrorPort): Map<number, string> {
    const marker = storedRowReader(() =>
        operationalFailure(errors, UNREADABLE_SCHEMA, "SQLite migration marker is corrupt")
    );
    const applied = new Map<number, string>();
    for (const row of rows) {
        const version = marker.integer(row, "version");
        const name = marker.text(row, "name");
        if (applied.has(version)) {
            operationalFailure(errors, UNREADABLE_SCHEMA, "SQLite migration marker is duplicated");
        }
        applied.set(version, name);
    }
    return applied;
}
