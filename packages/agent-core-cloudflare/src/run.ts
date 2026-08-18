import { ActorId, ActorRef } from "@agent-core/core/actors";
import { RunId } from "@agent-core/core/agents/runs";
import type { TenantId } from "@agent-core/core/identity";
import {
    SqliteRunStorage,
    TransactionalSqlite,
    ownSqliteMutations
} from "@agent-core/core/substrates/sqlite";
import { actorObjectName } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteApplicationMigration, SynchronousSqlitePort } from "./migration.js";
import type { CloudflareSqlite, SqliteValue } from "./sqlite.js";
import { requireStorableBlob, storedRowReader } from "./sqlite.js";

const HOSTING_TABLE = "agent_core_run_hosting";
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
    readonly #database: SynchronousSqlitePort;
    private readonly rows = storedRowReader((column) =>
        operationalFailure(this.errors, "codec.invalid", `Stored Run hosting ${column} is corrupt`)
    );

    public constructor(
        database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {
        this.#database =
            database instanceof TransactionalSqlite ? ownSqliteMutations(database) : database;
    }

    public start(hosting: CloudflareRunHosting): CloudflareRunHosting {
        return this.#database.transaction(() => {
            const existing = this.get(hosting.run);
            if (existing === undefined) {
                this.#database.run(INSERT_HOSTING, [
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
        const row = this.#database.all(READ_HOSTING, [run.value])[0];
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
export class DurableObjectRunStorage extends SqliteRunStorage {
    public constructor(
        database: CloudflareSqlite,
        tenant: TenantId,
        public readonly hosting: CloudflareRunHosting,
        errors: CloudflareErrorPort,
        clock?: () => Date
    ) {
        super(database, tenant, hosting.owner, clock, (record) =>
            requireStorableBlob(`Run ${record.kind} record`, record.bytes, errors)
        );
        Object.freeze(this);
    }
}
Object.freeze(DurableObjectRunStorage.prototype);
Object.freeze(DurableObjectRunStorage);

function requireHostingMode(value: SqliteValue | undefined): RunHostingMode {
    if (value !== "workspace" && value !== "dedicated") {
        throw new TypeError("Stored Run hosting mode is invalid");
    }
    return value;
}
