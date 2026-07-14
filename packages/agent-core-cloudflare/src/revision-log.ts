import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteRow } from "./sqlite.js";
import type { SynchronousSqlitePort } from "./migration.js";

const CURRENT_REVISION = `SELECT MAX(revision) AS revision FROM (
    SELECT revision FROM agent_core_view_snapshots WHERE channel = ?
    UNION ALL
    SELECT revision FROM agent_core_view_deltas WHERE channel = ?
)`;
const INSERT_DELTA =
    "INSERT INTO agent_core_view_deltas (channel, revision, payload) VALUES (?, ?, ?)";
const LATEST_SNAPSHOT = `SELECT revision, payload FROM agent_core_view_snapshots
    WHERE channel = ? AND revision > ? ORDER BY revision DESC LIMIT 1`;
const READ_DELTAS = `SELECT revision, payload FROM agent_core_view_deltas
    WHERE channel = ? AND revision > ? ORDER BY revision`;
const INSERT_SNAPSHOT =
    "INSERT INTO agent_core_view_snapshots (channel, revision, payload) VALUES (?, ?, ?)";
const DELETE_COMPACTED_DELTAS =
    "DELETE FROM agent_core_view_deltas WHERE channel = ? AND revision <= ?";
const DELETE_OLD_SNAPSHOTS =
    "DELETE FROM agent_core_view_snapshots WHERE channel = ? AND revision < ?";

export interface DurableViewEntry {
    readonly revision: number;
    readonly payload: Uint8Array;
}

export interface DurableViewReplay {
    readonly currentRevision: number;
    readonly snapshot: DurableViewEntry | undefined;
    readonly deltas: readonly DurableViewEntry[];
}

export class DurableViewRevisionLog {
    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {}

    public currentRevision(channel: string): number {
        requireChannel(channel, this.errors);
        const rows = this.database.all(CURRENT_REVISION, [channel, channel]);
        if (rows.length !== 1) this.corrupt("SQLite revision query returned an invalid row count");
        const revision = rows[0]?.revision;
        if (revision === null) return 0;
        return readRevision(revision, this.errors, "SQLite current revision is corrupt");
    }

    public append(channel: string, revision: number, payload: Uint8Array): void {
        requireChannel(channel, this.errors);
        requirePositiveRevision(revision, this.errors);
        const detached = requirePayload(payload, this.errors);
        this.database.transaction(() => {
            const expected = this.currentRevision(channel) + 1;
            if (revision !== expected) {
                operationalFailure(
                    this.errors,
                    "protocol.revision-conflict",
                    `View delta revision ${revision} does not follow ${expected - 1}`
                );
            }
            this.database.run(INSERT_DELTA, [channel, revision, detached]);
        });
    }

    public replay(channel: string, ackedRevision: number): DurableViewReplay {
        requireChannel(channel, this.errors);
        requireRevision(ackedRevision, this.errors);
        const currentRevision = this.currentRevision(channel);
        if (ackedRevision > currentRevision) {
            operationalFailure(
                this.errors,
                "protocol.revision-conflict",
                `Acknowledged revision ${ackedRevision} exceeds current revision ${currentRevision}`
            );
        }
        const snapshots = this.database.all(LATEST_SNAPSHOT, [channel, ackedRevision]);
        if (snapshots.length > 1) this.corrupt("SQLite snapshot query returned too many rows");
        const snapshot =
            snapshots[0] === undefined
                ? undefined
                : readEntry(snapshots[0], this.errors, "SQLite view snapshot is corrupt");
        const cursor = snapshot?.revision ?? ackedRevision;
        const deltas = this.database
            .all(READ_DELTAS, [channel, cursor])
            .map((row) => readEntry(row, this.errors, "SQLite view delta is corrupt"));
        let previous = cursor;
        for (const delta of deltas) {
            if (delta.revision !== previous + 1) {
                this.corrupt("SQLite view delta log is not contiguous");
            }
            previous = delta.revision;
        }
        if (previous !== currentRevision) {
            this.corrupt("SQLite view replay does not reach the current revision");
        }
        return Object.freeze({
            currentRevision,
            snapshot,
            deltas: Object.freeze(deltas)
        });
    }

    public compact(channel: string, revision: number, payload: Uint8Array): void {
        requireChannel(channel, this.errors);
        requirePositiveRevision(revision, this.errors);
        const detached = requirePayload(payload, this.errors);
        this.database.transaction(() => {
            const current = this.currentRevision(channel);
            if (revision !== current) {
                operationalFailure(
                    this.errors,
                    "protocol.revision-conflict",
                    `Snapshot revision ${revision} does not equal current revision ${current}`
                );
            }
            this.database.run(INSERT_SNAPSHOT, [channel, revision, detached]);
            this.database.run(DELETE_COMPACTED_DELTAS, [channel, revision]);
            this.database.run(DELETE_OLD_SNAPSHOTS, [channel, revision]);
        });
    }

    private corrupt(message: string): never {
        return operationalFailure(this.errors, "codec.invalid", message);
    }
}

function readEntry(row: SqliteRow, errors: CloudflareErrorPort, message: string): DurableViewEntry {
    const revision = readRevision(row.revision, errors, message);
    if (!(row.payload instanceof Uint8Array)) operationalFailure(errors, "codec.invalid", message);
    return Object.freeze({ revision, payload: row.payload.slice() });
}

function readRevision(
    value: SqliteRow[string] | undefined,
    errors: CloudflareErrorPort,
    message: string
): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        operationalFailure(errors, "codec.invalid", message);
    }
    return value as number;
}

function requireChannel(channel: string, errors: CloudflareErrorPort): void {
    if (channel.length === 0) {
        operationalFailure(errors, "operation.invalid-input", "View channel must be non-empty");
    }
}

function requireRevision(revision: number, errors: CloudflareErrorPort): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "View revision must be a non-negative safe integer"
        );
    }
}

function requirePositiveRevision(revision: number, errors: CloudflareErrorPort): void {
    requireRevision(revision, errors);
    if (revision === 0) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "View delta revision must be positive"
        );
    }
}

function requirePayload(payload: Uint8Array, errors: CloudflareErrorPort): Uint8Array {
    if (payload.byteLength === 0) {
        operationalFailure(errors, "operation.invalid-input", "View payload must be non-empty");
    }
    return payload.slice();
}
