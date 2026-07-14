import {
    InvalidationWatermark,
    watermarkKey,
    type InvalidationWatermarkStore,
    type ScopeEpoch
} from "../../authority";
import { AgentCoreError } from "../../errors";
import type { ActorRef } from "../../actors";
import type { TenantId } from "../../identity";
import type { SqliteRow, SqliteValue } from "./sqlite";
import { TransactionalSqlite } from "./sqlite";

const CREATE_WATERMARKS = `CREATE TABLE IF NOT EXISTS actor_invalidation_watermarks (
    watermark_key TEXT PRIMARY KEY CHECK (length(watermark_key) > 0),
    owner_tenant_id TEXT NOT NULL CHECK (length(owner_tenant_id) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    holder_tenant_id TEXT NOT NULL CHECK (length(holder_tenant_id) > 0),
    holder_principal_id TEXT NOT NULL CHECK (length(holder_principal_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

export class SqliteInvalidationWatermarkStore implements InvalidationWatermarkStore {
    public constructor(
        private readonly database: TransactionalSqlite,
        private readonly ownerTenant: TenantId,
        private readonly owner: ActorRef
    ) {
        try {
            database.transaction(() => database.run(CREATE_WATERMARKS, []));
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Watermark schema initialization failed"
            );
        }
        for (const row of readWatermarks(
            database,
            "SELECT * FROM actor_invalidation_watermarks ORDER BY watermark_key",
            []
        )) {
            const watermark = decodeWatermark(row, text(row, "watermark_key"));
            if (!watermark.ownerTenant.equals(ownerTenant) || !watermark.owner.equals(owner)) {
                throw corruptWatermark();
            }
        }
    }

    public load(key: string): InvalidationWatermark | undefined {
        const row = readWatermarks(
            this.database,
            "SELECT * FROM actor_invalidation_watermarks WHERE watermark_key = ?",
            [key]
        )[0];
        if (row === undefined) return undefined;
        const watermark = decodeWatermark(row, key);
        if (
            !watermark.ownerTenant.equals(this.ownerTenant) ||
            !watermark.owner.equals(this.owner)
        ) {
            throw corruptWatermark();
        }
        return watermark;
    }

    public save(watermark: InvalidationWatermark): void {
        try {
            this.database.transaction(() => this.saveInTransaction(watermark));
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError("protocol.revision-conflict", "Watermark write failed");
        }
    }

    private saveInTransaction(watermark: InvalidationWatermark): void {
        if (
            !watermark.ownerTenant.equals(this.ownerTenant) ||
            !watermark.owner.equals(this.owner)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Watermark belongs to another Actor store"
            );
        }
        const key = watermarkKey(watermark);
        const previous = this.load(key);
        if (previous === undefined) {
            if (watermark.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "New watermarks require revision zero"
                );
            }
            this.database.run(
                `INSERT INTO actor_invalidation_watermarks (
                    watermark_key, owner_tenant_id, owner_kind, owner_id,
                    holder_tenant_id, holder_principal_id, revision, record
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                projections(watermark)
            );
        } else {
            const previousBytes = InvalidationWatermark.encode(previous);
            const nextBytes = InvalidationWatermark.encode(watermark);
            if (bytesEqual(previousBytes, nextBytes)) return;
            if (
                watermark.revision.value !== previous.revision.value + 1 ||
                !watermark.dominates(previous)
            ) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "Watermark updates require monotonic entries and the next revision"
                );
            }
            this.database.run(
                `UPDATE actor_invalidation_watermarks SET revision = ?, record = ?
                 WHERE watermark_key = ? AND revision = ?`,
                [watermark.revision.value, nextBytes, key, previous.revision.value]
            );
        }
        const stored = this.load(key);
        if (
            stored === undefined ||
            !bytesEqual(
                InvalidationWatermark.encode(stored),
                InvalidationWatermark.encode(watermark)
            )
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Watermark changed concurrently"
            );
        }
    }

    public join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark {
        try {
            return this.database.transaction(() => {
                const current = this.load(key);
                if (current === undefined) {
                    throw new AgentCoreError(
                        "protocol.invalid-state",
                        "Watermark must be initialized before join"
                    );
                }
                const joined = current.join(entries);
                this.saveInTransaction(joined);
                return joined;
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError("protocol.revision-conflict", "Watermark join failed");
        }
    }
}

function projections(watermark: InvalidationWatermark): readonly (string | number | Uint8Array)[] {
    return [
        watermarkKey(watermark),
        watermark.ownerTenant.value,
        watermark.owner.kind,
        watermark.owner.id.value,
        watermark.holder.tenantId.value,
        watermark.holder.principalId.value,
        watermark.revision.value,
        InvalidationWatermark.encode(watermark)
    ];
}

function decodeWatermark(row: SqliteRow, expectedKey: string): InvalidationWatermark {
    const watermark = InvalidationWatermark.decode(bytes(row, "record").slice());
    if (
        watermarkKey(watermark) !== expectedKey ||
        watermarkKey(watermark) !== text(row, "watermark_key") ||
        watermark.ownerTenant.value !== text(row, "owner_tenant_id") ||
        watermark.owner.kind !== text(row, "owner_kind") ||
        watermark.owner.id.value !== text(row, "owner_id") ||
        watermark.holder.tenantId.value !== text(row, "holder_tenant_id") ||
        watermark.holder.principalId.value !== text(row, "holder_principal_id") ||
        watermark.revision.value !== integer(row, "revision")
    ) {
        throw corruptWatermark();
    }
    return watermark;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corruptWatermark();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptWatermark();
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corruptWatermark();
    return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function readWatermarks(
    database: TransactionalSqlite,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    try {
        return database.all(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Watermark read failed");
    }
}

function corruptWatermark(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored invalidation watermark is malformed");
}
