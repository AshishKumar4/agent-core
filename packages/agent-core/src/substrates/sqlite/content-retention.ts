import type { ActorRef } from "../../actors";
import {
    ContentOwnerEdge,
    ContentRetention,
    TransientContentAccess,
    TransientContentLease,
    TransientContentLeaseState,
    requireCollectionTime,
    requireOperationTime,
    type MediaHint,
    type TenantContentPolicyReader,
    type TransientContentBinding
} from "../../content";
import { ContentRef, Digest } from "../../core";
import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import {
    deleteSqliteContent,
    initializeSqliteContent,
    insertSqliteContent,
    listSqliteContent,
    loadSqliteContent,
    sqliteBytes,
    sqliteContentStat,
    sqliteInteger,
    sqliteText
} from "./content";
import { hasSameSqliteProvenance, type SqliteRow, TransactionalSqlite } from "./sqlite";

const CREATE_BINDING = `CREATE TABLE IF NOT EXISTS content_retention_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant TEXT NOT NULL CHECK (length(tenant) > 0),
    actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')
    ),
    actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
    UNIQUE (tenant, actor_kind, actor_id)
) STRICT`;

const CREATE_EDGES = `CREATE TABLE IF NOT EXISTS content_owner_edges (
    owner_key TEXT PRIMARY KEY CHECK (length(owner_key) BETWEEN 1 AND 512),
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    record BLOB NOT NULL
) STRICT`;

const CREATE_RELATIONS = `CREATE TABLE IF NOT EXISTS content_relations (
    ref TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    unowned_since INTEGER CHECK (unowned_since IS NULL OR unowned_since >= 0)
) STRICT`;

const CREATE_LEASES = `CREATE TABLE IF NOT EXISTS content_transient_leases (
    lease_key TEXT PRIMARY KEY CHECK (
        length(lease_key) = 64
        AND lease_key NOT GLOB '*[^0-9a-f]*'
    ),
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    digest TEXT NOT NULL,
    acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
    closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= acquired_at),
    record BLOB NOT NULL
) STRICT`;

const CREATE_EDGE_REF_INDEX = `CREATE INDEX IF NOT EXISTS content_owner_edges_ref
    ON content_owner_edges (ref)`;
const CREATE_LEASE_REF_INDEX = `CREATE INDEX IF NOT EXISTS content_transient_leases_ref
    ON content_transient_leases (ref)`;

interface SqliteRelation {
    readonly ref: ContentRef;
    readonly unownedSince: number | null;
}

export class SqliteContentRetention extends ContentRetention<TransactionalSqlite> {
    public constructor(
        private readonly database: TransactionalSqlite,
        tenant: TenantId,
        actor: ActorRef
    ) {
        super(tenant, actor);
        database.transaction(() => initializeRetention(database, tenant, actor));
    }

    public retain(
        transaction: TransactionalSqlite,
        edge: ContentOwnerEdge,
        operationAtValue: Date
    ): void {
        this.requireTransaction(transaction);
        this.requireOwner(edge);
        requireOperationTime(operationAtValue);
        validateSqliteState(transaction, this.tenant, this.actor);
        const existing = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
        if (existing !== undefined) {
            if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
            return;
        }
        if (loadSqliteContent(transaction, edge.ref) === undefined) throw contentNotFound(edge.ref);
        transaction.run(
            `INSERT INTO content_owner_edges
                (owner_key, tenant, actor_kind, actor_id, ref, record)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                edge.ownerKey,
                edge.tenant.value,
                edge.actor.kind,
                edge.actor.id.value,
                edge.ref.value,
                ContentOwnerEdge.encode(edge)
            ]
        );
        const relation = loadRelation(transaction, this.tenant, this.actor, edge.ref);
        if (relation === undefined) {
            insertRelation(transaction, this.tenant, this.actor, edge.ref, null);
        } else {
            transaction.run("UPDATE content_relations SET unowned_since = NULL WHERE ref = ?", [
                edge.ref.value
            ]);
        }
        const stored = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
        if (stored === undefined || !stored.equals(edge)) throw corruptRetention();
    }

    public release(
        transaction: TransactionalSqlite,
        edge: ContentOwnerEdge,
        operationAtValue: Date
    ): void {
        this.requireTransaction(transaction);
        this.requireOwner(edge);
        const operationAt = requireOperationTime(operationAtValue);
        validateSqliteState(transaction, this.tenant, this.actor);
        const existing = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
        if (existing === undefined) return;
        if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
        transaction.run("DELETE FROM content_owner_edges WHERE owner_key = ?", [edge.ownerKey]);
        if (!hasSqliteOwner(transaction, this.tenant, this.actor, edge.ref)) {
            requireRelation(transaction, this.tenant, this.actor, edge.ref);
            transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [
                operationAt.getTime(),
                edge.ref.value
            ]);
        }
    }

    public collect(
        transaction: TransactionalSqlite,
        policy: TenantContentPolicyReader<TransactionalSqlite>,
        observedAtValue: Date
    ): readonly ContentRef[] {
        this.requireTransaction(transaction);
        const observedAt = requireCollectionTime(observedAtValue);
        validateSqliteState(transaction, this.tenant, this.actor);
        const activeLeaseRefs = normalizeSqliteLeases(
            transaction,
            this.tenant,
            this.actor,
            observedAt
        );
        const approved: SqliteRelation[] = [];
        for (const relation of listRelations(transaction, this.tenant, this.actor)) {
            if (
                relation.unownedSince === null ||
                hasSqliteOwner(transaction, this.tenant, this.actor, relation.ref) ||
                activeLeaseRefs.has(relation.ref.value)
            )
                continue;
            const content = loadSqliteContent(transaction, relation.ref);
            if (content === undefined) throw corruptRetention("Related content is missing");
            const allowed = policy.allowsCollection(transaction, {
                tenant: this.tenant,
                actor: this.actor,
                stat: sqliteContentStat(content),
                unownedSince: new Date(relation.unownedSince),
                observedAt: new Date(observedAt.getTime())
            });
            if (allowed === true) approved.push(relation);
        }
        const collected: ContentRef[] = [];
        for (const candidate of approved) {
            validateSqliteState(transaction, this.tenant, this.actor);
            const active = normalizeSqliteLeases(transaction, this.tenant, this.actor, observedAt);
            const relation = loadRelation(transaction, this.tenant, this.actor, candidate.ref);
            if (
                relation?.unownedSince !== candidate.unownedSince ||
                hasSqliteOwner(transaction, this.tenant, this.actor, candidate.ref) ||
                active.has(candidate.ref.value)
            )
                continue;
            deleteRelatedContent(transaction, candidate.ref);
            collected.push(candidate.ref);
        }
        return Object.freeze(collected);
    }

    private requireTransaction(transaction: TransactionalSqlite): void {
        requireExactDatabase(transaction, this.database, this.tenant, this.actor);
    }
}

export class SqliteTransientContentAccess extends TransientContentAccess {
    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        private readonly now: () => Date = () => new Date()
    ) {
        super();
        database.transaction(() => initializeRetention(database, tenant, actor));
    }

    public async acquire(
        binding: TransientContentBinding,
        bytes?: Uint8Array,
        hint?: MediaHint
    ): Promise<TransientContentLease | undefined> {
        requireLeaseBinding(binding, this.tenant, this.actor);
        return this.database.transaction(() =>
            this.acquireInTransaction(this.database, binding, this.now(), bytes, hint)
        );
    }

    public acquireInTransaction(
        transaction: TransactionalSqlite,
        binding: TransientContentBinding,
        operationAtValue: Date,
        bytes?: Uint8Array,
        hint?: MediaHint
    ): TransientContentLease | undefined {
        requireExactDatabase(transaction, this.database, this.tenant, this.actor);
        requireLeaseBinding(binding, this.tenant, this.actor);
        const operationAt = requireOperationTime(operationAtValue, "Lease acquisition time");
        validateSqliteState(transaction, this.tenant, this.actor);
        const existing = loadLease(transaction, this.tenant, this.actor, binding.envelopeDigest);
        let replaced: TransientContentLeaseState | undefined;
        if (existing !== undefined) {
            if (existing.isActive(operationAt)) {
                if (!existing.matches(binding)) throw leaseCollision();
                if (bytes !== undefined) validateBindingBytes(binding, bytes);
                return this.lease(existing);
            }
            replaced = existing;
        }
        const candidate = new TransientContentLeaseState(
            this.tenant,
            this.actor,
            binding.envelopeDigest,
            binding.ref,
            binding.digest,
            operationAt,
            binding.expiresAt
        );
        const stored = loadSqliteContent(transaction, binding.ref);
        if (bytes === undefined) {
            if (stored === undefined) return undefined;
        } else {
            validateBindingBytes(binding, bytes);
            insertSqliteContent(transaction, binding.ref, binding.digest, bytes.slice(), hint);
        }
        const persisted = loadSqliteContent(transaction, binding.ref);
        if (
            persisted === undefined ||
            (bytes !== undefined && !equalBytes(persisted.bytes, bytes))
        ) {
            throw corruptRetention("Leased content was not stored");
        }
        if (
            replaced !== undefined &&
            !hasSqliteOwner(transaction, this.tenant, this.actor, replaced.ref)
        ) {
            advanceSqliteUnownedSince(
                transaction,
                this.tenant,
                this.actor,
                replaced.ref,
                inactiveBoundary(replaced, operationAt)
            );
        }
        const relation = loadRelation(transaction, this.tenant, this.actor, binding.ref);
        const unownedSince = hasSqliteOwner(transaction, this.tenant, this.actor, binding.ref)
            ? null
            : relation === undefined
              ? operationAt.getTime()
              : Math.max(requireUnownedTimestamp(relation), operationAt.getTime());
        if (relation === undefined) {
            insertRelation(transaction, this.tenant, this.actor, binding.ref, unownedSince);
        } else {
            transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [
                unownedSince,
                binding.ref.value
            ]);
        }
        if (replaced === undefined) insertLease(transaction, candidate);
        else updateLease(transaction, candidate);
        return this.lease(candidate);
    }

    public readInTransaction(
        transaction: TransactionalSqlite,
        expected: TransientContentLeaseState
    ): Uint8Array {
        const lease = this.requireGeneration(transaction, expected);
        const content = loadSqliteContent(transaction, lease.ref);
        if (content === undefined) throw corruptRetention("Leased content is missing");
        return content.bytes.slice();
    }

    public matchesInTransaction(
        transaction: TransactionalSqlite,
        expected: TransientContentLeaseState,
        binding: TransientContentBinding,
        now: Date
    ): boolean {
        requireLeaseBinding(binding, this.tenant, this.actor);
        const lease = this.requireGeneration(transaction, expected);
        return lease.matches(binding) && lease.isActive(now);
    }

    public closeInTransaction(
        transaction: TransactionalSqlite,
        expected: TransientContentLeaseState,
        operationAt: Date
    ): void {
        const lease = this.requireGeneration(transaction, expected);
        const closed = lease.close(operationAt);
        if (closed === lease) return;
        updateLease(transaction, closed);
        if (!hasSqliteOwner(transaction, this.tenant, this.actor, lease.ref)) {
            advanceSqliteUnownedSince(
                transaction,
                this.tenant,
                this.actor,
                lease.ref,
                inactiveBoundary(closed, closed.closedAt!)
            );
        }
    }

    private requireLease(
        transaction: TransactionalSqlite,
        key: Digest
    ): TransientContentLeaseState {
        requireExactDatabase(transaction, this.database, this.tenant, this.actor);
        validateSqliteState(transaction, this.tenant, this.actor);
        const lease = loadLease(transaction, this.tenant, this.actor, key);
        if (lease === undefined) throw corruptRetention("Transient content lease is missing");
        return lease;
    }

    private requireGeneration(
        transaction: TransactionalSqlite,
        expected: TransientContentLeaseState
    ): TransientContentLeaseState {
        const lease = this.requireLease(transaction, expected.envelopeDigest);
        if (!sameLeaseGeneration(lease, expected)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );
        }
        return lease;
    }

    private lease(state: TransientContentLeaseState): SqliteTransientContentLease {
        return new SqliteTransientContentLease(this, this.database, state, this.now);
    }
}

class SqliteTransientContentLease extends TransientContentLease {
    public constructor(
        private readonly access: SqliteTransientContentAccess,
        private readonly database: TransactionalSqlite,
        private readonly state: TransientContentLeaseState,
        private readonly now: () => Date
    ) {
        super();
    }

    public read(): Uint8Array {
        return this.database.transaction(() =>
            this.access.readInTransaction(this.database, this.state)
        );
    }

    public matches(binding: TransientContentBinding, now: Date): boolean {
        return this.database.transaction(() =>
            this.access.matchesInTransaction(this.database, this.state, binding, now)
        );
    }

    public async close(): Promise<void> {
        this.database.transaction(() =>
            this.access.closeInTransaction(this.database, this.state, this.now())
        );
    }
}

function initializeRetention(
    database: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef
): void {
    initializeSqliteContent(database);
    database.run(CREATE_BINDING, []);
    database.run(CREATE_EDGES, []);
    database.run(CREATE_RELATIONS, []);
    database.run(CREATE_LEASES, []);
    database.run(CREATE_EDGE_REF_INDEX, []);
    database.run(CREATE_LEASE_REF_INDEX, []);
    database.run(
        `INSERT OR IGNORE INTO content_retention_binding
            (singleton, tenant, actor_kind, actor_id)
         VALUES (1, ?, ?, ?)`,
        [tenant.value, actor.kind, actor.id.value]
    );
    requireBoundDatabase(database, tenant, actor);
    validateSqliteState(database, tenant, actor);
}

function requireBoundDatabase(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef
): void {
    const row = transaction.all(
        `SELECT tenant, actor_kind, actor_id
         FROM content_retention_binding WHERE singleton = 1`,
        []
    )[0];
    if (
        row === undefined ||
        sqliteText(row, "tenant") !== tenant.value ||
        sqliteText(row, "actor_kind") !== actor.kind ||
        sqliteText(row, "actor_id") !== actor.id.value
    ) {
        throw invalidContentState("SQLite content storage is bound to a different Actor or Tenant");
    }
}

function requireExactDatabase(
    transaction: TransactionalSqlite,
    database: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef
): void {
    if (!hasSameSqliteProvenance(transaction, database)) {
        throw invalidContentState(
            "SQLite content transaction belongs to a different database capability"
        );
    }
    requireBoundDatabase(transaction, tenant, actor);
}

function validateSqliteState(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef
): void {
    for (const row of transaction.all(
        `SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges ORDER BY owner_key`,
        []
    )) {
        const edge = decodeEdge(row, tenant, actor);
        const relation = loadRelation(transaction, tenant, actor, edge.ref);
        if (
            loadSqliteContent(transaction, edge.ref) === undefined ||
            relation?.unownedSince !== null
        ) {
            throw corruptRetention("Owned content relation is malformed");
        }
    }
    for (const relation of listRelations(transaction, tenant, actor)) {
        const owned = hasSqliteOwner(transaction, tenant, actor, relation.ref);
        if (
            loadSqliteContent(transaction, relation.ref) === undefined ||
            owned !== (relation.unownedSince === null)
        ) {
            throw corruptRetention("Content relation is malformed");
        }
    }
    for (const row of leaseRows(transaction)) decodeLease(row, tenant, actor, transaction);
    for (const content of listSqliteContent(transaction)) void content;
}

function loadEdge(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ownerKey: string
): ContentOwnerEdge | undefined {
    const row = transaction.all(
        `SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges WHERE owner_key = ?`,
        [ownerKey]
    )[0];
    return row === undefined ? undefined : decodeEdge(row, tenant, actor);
}

function decodeEdge(row: SqliteRow, tenant: TenantId, actor: ActorRef): ContentOwnerEdge {
    try {
        const edge = ContentOwnerEdge.decode(sqliteBytes(row, "record").slice());
        if (
            !edge.tenant.equals(tenant) ||
            !edge.actor.equals(actor) ||
            edge.ownerKey !== sqliteText(row, "owner_key") ||
            edge.tenant.value !== sqliteText(row, "tenant") ||
            edge.actor.kind !== sqliteText(row, "actor_kind") ||
            edge.actor.id.value !== sqliteText(row, "actor_id") ||
            edge.ref.value !== sqliteText(row, "ref")
        )
            throw corruptRetention();
        return edge;
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw corruptRetention();
    }
}

function insertRelation(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ref: ContentRef,
    unownedSince: number | null
): void {
    transaction.run(
        `INSERT INTO content_relations
            (ref, tenant, actor_kind, actor_id, unowned_since)
         VALUES (?, ?, ?, ?, ?)`,
        [ref.value, tenant.value, actor.kind, actor.id.value, unownedSince]
    );
}

function loadRelation(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ref: ContentRef
): SqliteRelation | undefined {
    const row = transaction.all(
        `SELECT ref, tenant, actor_kind, actor_id, unowned_since
         FROM content_relations WHERE ref = ?`,
        [ref.value]
    )[0];
    return row === undefined ? undefined : decodeRelation(row, tenant, actor);
}

function requireRelation(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ref: ContentRef
): SqliteRelation {
    const relation = loadRelation(transaction, tenant, actor, ref);
    if (relation === undefined) throw corruptRetention("Authenticated content relation is missing");
    return relation;
}

function listRelations(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef
): readonly SqliteRelation[] {
    return transaction
        .all(
            `SELECT ref, tenant, actor_kind, actor_id, unowned_since
         FROM content_relations ORDER BY ref`,
            []
        )
        .map((row) => decodeRelation(row, tenant, actor));
}

function decodeRelation(row: SqliteRow, tenant: TenantId, actor: ActorRef): SqliteRelation {
    try {
        const ref = new ContentRef(sqliteText(row, "ref"));
        const unownedSince = nullableInteger(row, "unowned_since");
        if (
            sqliteText(row, "tenant") !== tenant.value ||
            sqliteText(row, "actor_kind") !== actor.kind ||
            sqliteText(row, "actor_id") !== actor.id.value
        )
            throw corruptRetention();
        return { ref, unownedSince };
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw corruptRetention("Stored content relation is malformed");
    }
}

function hasSqliteOwner(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ref: ContentRef
): boolean {
    const rows = transaction.all(
        `SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges WHERE ref = ?`,
        [ref.value]
    );
    for (const row of rows) decodeEdge(row, tenant, actor);
    return rows.length > 0;
}

function leaseRows(transaction: TransactionalSqlite, key?: Digest): readonly SqliteRow[] {
    return key === undefined
        ? transaction.all(
              `SELECT lease_key, tenant, actor_kind, actor_id, ref, digest,
                    acquired_at, expires_at, closed_at, record
             FROM content_transient_leases ORDER BY lease_key`,
              []
          )
        : transaction.all(
              `SELECT lease_key, tenant, actor_kind, actor_id, ref, digest,
                    acquired_at, expires_at, closed_at, record
             FROM content_transient_leases WHERE lease_key = ?`,
              [key.value]
          );
}

function loadLease(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    key: Digest
): TransientContentLeaseState | undefined {
    const row = leaseRows(transaction, key)[0];
    return row === undefined ? undefined : decodeLease(row, tenant, actor, transaction);
}

function decodeLease(
    row: SqliteRow,
    tenant: TenantId,
    actor: ActorRef,
    transaction: TransactionalSqlite
): TransientContentLeaseState {
    try {
        const lease = TransientContentLeaseState.decode(sqliteBytes(row, "record").slice());
        const closedAt = nullableInteger(row, "closed_at");
        if (
            !lease.tenant.equals(tenant) ||
            !lease.actor.equals(actor) ||
            lease.envelopeDigest.value !== sqliteText(row, "lease_key") ||
            lease.tenant.value !== sqliteText(row, "tenant") ||
            lease.actor.kind !== sqliteText(row, "actor_kind") ||
            lease.actor.id.value !== sqliteText(row, "actor_id") ||
            lease.ref.value !== sqliteText(row, "ref") ||
            lease.digest.value !== sqliteText(row, "digest") ||
            lease.acquiredAt.getTime() !== sqliteInteger(row, "acquired_at") ||
            lease.expiresAt.getTime() !== sqliteInteger(row, "expires_at") ||
            (lease.closedAt?.getTime() ?? null) !== closedAt ||
            loadSqliteContent(transaction, lease.ref) === undefined ||
            loadRelation(transaction, tenant, actor, lease.ref) === undefined
        ) {
            throw corruptRetention();
        }
        return lease;
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw corruptRetention("Stored transient content lease is malformed");
    }
}

function insertLease(transaction: TransactionalSqlite, lease: TransientContentLeaseState): void {
    transaction.run(
        `INSERT INTO content_transient_leases
            (lease_key, tenant, actor_kind, actor_id, ref, digest,
             acquired_at, expires_at, closed_at, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        leaseBindings(lease)
    );
}

function updateLease(transaction: TransactionalSqlite, lease: TransientContentLeaseState): void {
    transaction.run(
        `UPDATE content_transient_leases SET
            tenant = ?, actor_kind = ?, actor_id = ?, ref = ?, digest = ?,
            acquired_at = ?, expires_at = ?, closed_at = ?, record = ?
         WHERE lease_key = ?`,
        [
            lease.tenant.value,
            lease.actor.kind,
            lease.actor.id.value,
            lease.ref.value,
            lease.digest.value,
            lease.acquiredAt.getTime(),
            lease.expiresAt.getTime(),
            lease.closedAt?.getTime() ?? null,
            TransientContentLeaseState.encode(lease),
            lease.envelopeDigest.value
        ]
    );
}

function leaseBindings(
    lease: TransientContentLeaseState
): readonly import("./sqlite").SqliteValue[] {
    return [
        lease.envelopeDigest.value,
        lease.tenant.value,
        lease.actor.kind,
        lease.actor.id.value,
        lease.ref.value,
        lease.digest.value,
        lease.acquiredAt.getTime(),
        lease.expiresAt.getTime(),
        lease.closedAt?.getTime() ?? null,
        TransientContentLeaseState.encode(lease)
    ];
}

function normalizeSqliteLeases(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    observedAt: Date
): ReadonlySet<string> {
    const active = new Set<string>();
    for (const row of leaseRows(transaction)) {
        const lease = decodeLease(row, tenant, actor, transaction);
        if (lease.isActive(observedAt)) {
            active.add(lease.ref.value);
        } else if (!hasSqliteOwner(transaction, tenant, actor, lease.ref)) {
            advanceSqliteUnownedSince(
                transaction,
                tenant,
                actor,
                lease.ref,
                inactiveBoundary(lease, observedAt)
            );
        }
    }
    return active;
}

function advanceSqliteUnownedSince(
    transaction: TransactionalSqlite,
    tenant: TenantId,
    actor: ActorRef,
    ref: ContentRef,
    boundary: Date
): void {
    const relation = requireRelation(transaction, tenant, actor, ref);
    const current = requireUnownedTimestamp(relation);
    transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [
        Math.max(current, boundary.getTime()),
        ref.value
    ]);
}

function inactiveBoundary(lease: TransientContentLeaseState, observedAt: Date): Date {
    const closedAt = lease.closedAt;
    if (closedAt !== undefined) {
        return new Date(Math.min(closedAt.getTime(), lease.expiresAt.getTime()));
    }
    if (lease.isActive(observedAt)) throw corruptRetention("Active lease has no inactive boundary");
    return lease.expiresAt;
}

function requireUnownedTimestamp(relation: SqliteRelation): number {
    if (relation.unownedSince === null) {
        throw corruptRetention("Unowned content has an owned relation");
    }
    return relation.unownedSince;
}

function deleteRelatedContent(transaction: TransactionalSqlite, ref: ContentRef): void {
    transaction.run("DELETE FROM content_transient_leases WHERE ref = ?", [ref.value]);
    transaction.run("DELETE FROM content_relations WHERE ref = ?", [ref.value]);
    deleteSqliteContent(transaction, ref);
}

function requireLeaseBinding(
    binding: TransientContentBinding,
    tenant: TenantId,
    actor: ActorRef
): void {
    if (!binding.tenant.equals(tenant)) {
        throw invalidContentState("Transient content binding belongs to a different Tenant");
    }
    if (!binding.actor.equals(actor)) {
        throw invalidContentState("Transient content binding belongs to a different Actor");
    }
}

function validateBindingBytes(binding: TransientContentBinding, bytes: Uint8Array): void {
    const digest = Digest.sha256(bytes);
    if (!binding.ref.digest.equals(binding.digest) || !binding.digest.equals(digest)) {
        throw new AgentCoreError("codec.invalid", "Transient content binding does not match bytes");
    }
}

function nullableInteger(row: SqliteRow, column: string): number | null {
    const value = row[column];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new AgentCoreError(
            "codec.invalid",
            `Expected nullable non-negative integer column: ${column}`
        );
    }
    return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function ownerCollision(ownerKey: string): AgentCoreError {
    return contentCollision(`Content owner key is already retained: ${ownerKey}`);
}

function leaseCollision(): AgentCoreError {
    return contentCollision("Active transient lease key is bound to different content");
}

function sameLeaseGeneration(
    left: TransientContentLeaseState,
    right: TransientContentLeaseState
): boolean {
    return (
        left.tenant.equals(right.tenant) &&
        left.actor.equals(right.actor) &&
        left.envelopeDigest.equals(right.envelopeDigest) &&
        left.ref.equals(right.ref) &&
        left.digest.equals(right.digest) &&
        left.acquiredAt.getTime() === right.acquiredAt.getTime() &&
        left.expiresAt.getTime() === right.expiresAt.getTime()
    );
}

function contentCollision(message: string): AgentCoreError {
    return invalidContentState(message);
}

function invalidContentState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function contentNotFound(ref: ContentRef): AgentCoreError {
    return new AgentCoreError("content.not-found", `Content not found: ${ref.value}`);
}

function corruptRetention(message = "Stored content retention state is malformed"): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
