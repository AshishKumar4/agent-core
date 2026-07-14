import {
    ActorId,
    ActorRef,
    requireSynchronousResult,
    type SynchronousResultGuard
} from "../actors";
import { ContentRef, Digest } from "../core";
import { AgentCoreError } from "../errors";
import { TenantId } from "../identity";
import { MediaHint } from "./media";
import { ByteRange } from "./range";
import {
    ContentOwnerEdge,
    ContentRetention,
    requireCollectionTime,
    requireOperationTime,
    type TenantContentPolicyReader
} from "./retention";
import { ContentStat } from "./stat";
import { ContentStore, type ContentPutResult } from "./store";
import {
    TransientContentAccess,
    TransientContentLease,
    TransientContentLeaseState,
    type TransientContentBinding
} from "./transient";

interface MemoryContent {
    readonly bytes: Uint8Array;
    readonly digest: Digest;
    readonly hint: MediaHint | undefined;
}

interface MemoryBackend {
    readonly content: Map<string, MemoryContent>;
    readonly edges: Map<string, Uint8Array>;
    readonly relations: Map<string, number | null>;
    readonly leases: Map<string, Uint8Array>;
    binding: { readonly tenant: TenantId; readonly actor: ActorRef } | undefined;
}

interface MemoryTransactionState {
    readonly backend: MemoryBackend;
    readonly owner: MemoryContentStore | undefined;
    active: boolean;
}

export interface MemoryContentSnapshot {
    readonly version: 1;
    readonly binding: {
        readonly tenant: string;
        readonly actor: { readonly kind: ActorRef["kind"]; readonly id: string };
    } | null;
    readonly content: readonly {
        readonly ref: string;
        readonly digest: string;
        readonly bytes: Uint8Array;
        readonly mediaType: string | null;
    }[];
    readonly edges: readonly Uint8Array[];
    readonly relations: readonly {
        readonly ref: string;
        readonly unownedSince: number | null;
    }[];
    readonly leases: readonly Uint8Array[];
}

export type MemoryContentRetentionSnapshot = MemoryContentSnapshot;

const backends = new WeakMap<MemoryContentStore, MemoryBackend>();
const transactionStates = new WeakMap<MemoryContentRetentionState, MemoryTransactionState>();
const activeTransactions = new WeakSet<MemoryContentStore>();

export class MemoryContentRetentionState {
    public constructor(tenant: TenantId, actor: ActorRef) {
        transactionStates.set(this, {
            backend: emptyBackend({ tenant, actor }),
            owner: undefined,
            active: true
        });
        Object.freeze(this);
    }

    public static restore(
        tenant: TenantId,
        actor: ActorRef,
        snapshot: MemoryContentSnapshot
    ): MemoryContentRetentionState {
        const backend = restoreBackend(snapshot);
        if (
            backend.binding === undefined ||
            !backend.binding.tenant.equals(tenant) ||
            !backend.binding.actor.equals(actor)
        ) {
            throw corruptContent("Memory content snapshot belongs to a different Actor or Tenant");
        }
        const state = new MemoryContentRetentionState(tenant, actor);
        transactionStates.set(state, { backend, owner: undefined, active: true });
        return state;
    }

    public snapshot(): MemoryContentSnapshot {
        return snapshotBackend(requireTransactionState(this));
    }

    public clone(): MemoryContentRetentionState {
        const backend = requireTransactionState(this);
        const binding = requireBinding(backend);
        return MemoryContentRetentionState.restore(
            binding.tenant,
            binding.actor,
            snapshotBackend(backend)
        );
    }
}

export class MemoryContentStore extends ContentStore {
    public constructor(snapshot?: MemoryContentSnapshot) {
        super();
        backends.set(this, snapshot === undefined ? emptyBackend() : restoreBackend(snapshot));
    }

    public static restore(snapshot: MemoryContentSnapshot): MemoryContentStore {
        return new MemoryContentStore(snapshot);
    }

    public retention(tenant: TenantId, actor: ActorRef): MemoryContentRetention {
        bindBackend(backendFor(this), tenant, actor);
        return new MemoryContentRetention(this, tenant, actor);
    }

    public transient(
        tenant: TenantId,
        actor: ActorRef,
        now?: () => Date
    ): MemoryTransientContentAccess {
        bindBackend(backendFor(this), tenant, actor);
        return new MemoryTransientContentAccess(this, tenant, actor, now);
    }

    public transaction<Result>(
        operation: (transaction: MemoryContentRetentionState) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (activeTransactions.has(this)) {
            throw invalidContentState("Nested Memory content transactions are not supported");
        }
        activeTransactions.add(this);
        let transaction: MemoryContentRetentionState | undefined;
        try {
            const backend = backendFor(this);
            const binding = requireBinding(backend);
            transaction = MemoryContentRetentionState.restore(
                binding.tenant,
                binding.actor,
                snapshotBackend(backend)
            );
            const restored = transactionStates.get(transaction);
            if (restored === undefined) {
                throw corruptContent("Memory content transaction is unavailable");
            }
            transactionStates.set(transaction, {
                backend: restored.backend,
                owner: this,
                active: true
            });
            const result = requireSynchronousResult(operation(transaction));
            const committed = restoreBackend(transaction.snapshot());
            requireSameBinding(committed, binding.tenant, binding.actor);
            backends.set(this, committed);
            return result;
        } finally {
            if (transaction !== undefined) {
                const completed = transactionStates.get(transaction);
                if (completed !== undefined) completed.active = false;
            }
            activeTransactions.delete(this);
        }
    }

    public snapshot(): MemoryContentSnapshot {
        return snapshotBackend(backendFor(this));
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        return insertMemoryContent(backendFor(this), bytes, hint);
    }

    public async get(ref: ContentRef, range: ByteRange = ByteRange.all()): Promise<Uint8Array> {
        const content = backendFor(this).content.get(ref.value);
        if (content === undefined) throw contentNotFound(ref);
        validateContent(content, ref);
        return range.read(content.bytes.slice()).slice();
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        const content = backendFor(this).content.get(ref.value);
        if (content === undefined) return undefined;
        validateContent(content, ref);
        return contentStat(ref, content);
    }
}

export class MemoryContentRetention extends ContentRetention<MemoryContentRetentionState> {
    public constructor(
        private readonly store: MemoryContentStore,
        tenant: TenantId,
        actor: ActorRef
    ) {
        super(tenant, actor);
        requireSameBinding(backendFor(store), tenant, actor);
    }

    public retain(
        transaction: MemoryContentRetentionState,
        edge: ContentOwnerEdge,
        operationAtValue: Date
    ): void {
        this.requireOwner(edge);
        requireOperationTime(operationAtValue);
        const state = this.requireState(transaction);
        const existingBytes = state.edges.get(edge.ownerKey);
        if (existingBytes !== undefined) {
            const existing = decodeStoredEdge(existingBytes, edge.ownerKey, state);
            if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
            return;
        }
        const content = state.content.get(edge.ref.value);
        if (content === undefined) throw contentNotFound(edge.ref);
        validateContent(content, edge.ref);
        state.edges.set(edge.ownerKey, ContentOwnerEdge.encode(edge));
        state.relations.set(edge.ref.value, null);
    }

    public release(
        transaction: MemoryContentRetentionState,
        edge: ContentOwnerEdge,
        operationAtValue: Date
    ): void {
        this.requireOwner(edge);
        const operationAt = requireOperationTime(operationAtValue);
        const state = this.requireState(transaction);
        const existingBytes = state.edges.get(edge.ownerKey);
        if (existingBytes === undefined) return;
        const existing = decodeStoredEdge(existingBytes, edge.ownerKey, state);
        if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
        state.edges.delete(edge.ownerKey);
        if (!hasOwner(state, edge.ref.value)) {
            requireRelation(state, edge.ref);
            state.relations.set(edge.ref.value, operationAt.getTime());
        }
    }

    public collect(
        transaction: MemoryContentRetentionState,
        policy: TenantContentPolicyReader<MemoryContentRetentionState>,
        observedAtValue: Date
    ): readonly ContentRef[] {
        const state = this.requireState(transaction);
        const observedAt = requireCollectionTime(observedAtValue);
        validateBackend(state);
        const activeLeaseRefs = normalizeMemoryLeases(state, observedAt);
        const approved: { readonly ref: ContentRef; readonly unownedSince: number }[] = [];
        for (const [value, unownedSince] of [...state.relations].sort(([left], [right]) =>
            left.localeCompare(right)
        )) {
            if (unownedSince === null || hasOwner(state, value) || activeLeaseRefs.has(value))
                continue;
            const ref = new ContentRef(value);
            const content = state.content.get(value);
            if (content === undefined) throw corruptContent("Related content is missing");
            const allowed = policy.allowsCollection(transaction, {
                tenant: this.tenant,
                actor: this.actor,
                stat: contentStat(ref, content),
                unownedSince: new Date(unownedSince),
                observedAt: new Date(observedAt.getTime())
            });
            if (allowed === true) approved.push({ ref, unownedSince });
        }
        const collected: ContentRef[] = [];
        for (const candidate of approved) {
            validateBackend(state);
            const active = normalizeMemoryLeases(state, observedAt);
            if (
                state.relations.get(candidate.ref.value) !== candidate.unownedSince ||
                hasOwner(state, candidate.ref.value) ||
                active.has(candidate.ref.value)
            )
                continue;
            deleteMemoryContent(state, candidate.ref);
            collected.push(candidate.ref);
        }
        return Object.freeze(collected);
    }

    private requireState(transaction: MemoryContentRetentionState): MemoryBackend {
        const state = requireTransactionState(transaction, this.store);
        requireSameBinding(state, this.tenant, this.actor);
        return state;
    }
}

export class MemoryTransientContentAccess extends TransientContentAccess {
    public constructor(
        private readonly store: MemoryContentStore,
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        private readonly now: () => Date = () => new Date()
    ) {
        super();
        requireSameBinding(backendFor(store), tenant, actor);
    }

    public async acquire(
        binding: TransientContentBinding,
        bytes?: Uint8Array,
        hint?: MediaHint
    ): Promise<TransientContentLease | undefined> {
        this.requireLeaseBinding(binding);
        return this.store.transaction((transaction) => ({
            lease: this.acquireInTransaction(transaction, binding, this.now(), bytes, hint)
        })).lease;
    }

    public acquireInTransaction(
        transaction: MemoryContentRetentionState,
        binding: TransientContentBinding,
        operationAtValue: Date,
        bytes?: Uint8Array,
        hint?: MediaHint
    ): TransientContentLease | undefined {
        this.requireLeaseBinding(binding);
        const state = this.requireState(transaction);
        const operationAt = requireOperationTime(operationAtValue, "Lease acquisition time");
        const existingBytes = state.leases.get(binding.envelopeDigest.value);
        let replaced: TransientContentLeaseState | undefined;
        if (existingBytes !== undefined) {
            const existing = decodeMemoryLease(existingBytes, binding.envelopeDigest.value, state);
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
        const content = state.content.get(binding.ref.value);
        if (bytes === undefined) {
            if (content === undefined) return undefined;
            validateContent(content, binding.ref);
        } else {
            validateBindingBytes(binding, bytes);
            insertMemoryContent(state, bytes, hint);
        }
        const stored = state.content.get(binding.ref.value);
        if (stored === undefined) throw corruptContent("Leased content was not stored");
        validateContent(stored, binding.ref);
        if (replaced !== undefined && !hasOwner(state, replaced.ref.value)) {
            advanceUnownedSince(state, replaced.ref, inactiveBoundary(replaced, operationAt));
        }
        const relation = state.relations.get(binding.ref.value);
        state.relations.set(
            binding.ref.value,
            hasOwner(state, binding.ref.value)
                ? null
                : relation === undefined
                  ? operationAt.getTime()
                  : Math.max(requireTimestamp(relation), operationAt.getTime())
        );
        state.leases.set(
            binding.envelopeDigest.value,
            TransientContentLeaseState.encode(candidate)
        );
        return this.lease(candidate);
    }

    public readInTransaction(
        transaction: MemoryContentRetentionState,
        expected: TransientContentLeaseState
    ): Uint8Array {
        const state = this.requireState(transaction);
        const lease = this.requireGeneration(state, expected);
        const content = state.content.get(lease.ref.value);
        if (content === undefined) throw corruptContent("Leased content is missing");
        validateContent(content, lease.ref);
        return content.bytes.slice();
    }

    public matchesInTransaction(
        transaction: MemoryContentRetentionState,
        expected: TransientContentLeaseState,
        binding: TransientContentBinding,
        now: Date
    ): boolean {
        this.requireLeaseBinding(binding);
        const lease = this.requireGeneration(this.requireState(transaction), expected);
        return lease.matches(binding) && lease.isActive(now);
    }

    public closeInTransaction(
        transaction: MemoryContentRetentionState,
        expected: TransientContentLeaseState,
        operationAt: Date
    ): void {
        const state = this.requireState(transaction);
        const lease = this.requireGeneration(state, expected);
        const closed = lease.close(operationAt);
        if (closed === lease) return;
        state.leases.set(lease.envelopeDigest.value, TransientContentLeaseState.encode(closed));
        if (!hasOwner(state, lease.ref.value)) {
            advanceUnownedSince(state, lease.ref, inactiveBoundary(closed, closed.closedAt!));
        }
    }

    private loadLease(state: MemoryBackend, key: Digest): TransientContentLeaseState {
        const bytes = state.leases.get(key.value);
        if (bytes === undefined) throw corruptContent("Transient content lease is missing");
        return decodeMemoryLease(bytes, key.value, state);
    }

    private requireGeneration(
        state: MemoryBackend,
        expected: TransientContentLeaseState
    ): TransientContentLeaseState {
        const lease = this.loadLease(state, expected.envelopeDigest);
        if (!sameLeaseGeneration(lease, expected)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );
        }
        return lease;
    }

    private lease(state: TransientContentLeaseState): MemoryTransientContentLease {
        return new MemoryTransientContentLease(this, this.store, state, this.now);
    }

    private requireState(transaction: MemoryContentRetentionState): MemoryBackend {
        const state = requireTransactionState(transaction, this.store);
        requireSameBinding(state, this.tenant, this.actor);
        return state;
    }

    private requireLeaseBinding(binding: TransientContentBinding): void {
        if (!binding.tenant.equals(this.tenant)) {
            throw invalidContentState("Transient content binding belongs to a different Tenant");
        }
        if (!binding.actor.equals(this.actor)) {
            throw invalidContentState("Transient content binding belongs to a different Actor");
        }
    }
}

class MemoryTransientContentLease extends TransientContentLease {
    public constructor(
        private readonly access: MemoryTransientContentAccess,
        private readonly store: MemoryContentStore,
        private readonly state: TransientContentLeaseState,
        private readonly now: () => Date
    ) {
        super();
    }

    public read(): Uint8Array {
        return this.store.transaction((transaction) =>
            this.access.readInTransaction(transaction, this.state)
        );
    }

    public matches(binding: TransientContentBinding, now: Date): boolean {
        return this.store.transaction((transaction) =>
            this.access.matchesInTransaction(transaction, this.state, binding, now)
        );
    }

    public async close(): Promise<void> {
        this.store.transaction((transaction) =>
            this.access.closeInTransaction(transaction, this.state, this.now())
        );
    }
}

function emptyBackend(binding?: {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
}): MemoryBackend {
    return {
        content: new Map(),
        edges: new Map(),
        relations: new Map(),
        leases: new Map(),
        binding
    };
}

function backendFor(store: MemoryContentStore): MemoryBackend {
    const backend = backends.get(store);
    if (backend === undefined) throw corruptContent("Memory content backend is unavailable");
    return backend;
}

function requireTransactionState(
    state: MemoryContentRetentionState,
    owner?: MemoryContentStore
): MemoryBackend {
    const transaction = transactionStates.get(state);
    if (transaction === undefined || !transaction.active) {
        throw new AgentCoreError("actor.closed", "Memory content transaction is no longer active");
    }
    if (owner !== undefined && transaction.owner !== owner) {
        throw invalidContentState("Memory content transaction belongs to a different store");
    }
    return transaction.backend;
}

function bindBackend(backend: MemoryBackend, tenant: TenantId, actor: ActorRef): void {
    if (backend.binding !== undefined) {
        requireSameBinding(backend, tenant, actor);
        return;
    }
    backend.binding = { tenant, actor };
}

function requireBinding(backend: MemoryBackend): {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
} {
    if (backend.binding === undefined) {
        throw invalidContentState("Memory content storage is not bound to an Actor and Tenant");
    }
    return backend.binding;
}

function requireSameBinding(backend: MemoryBackend, tenant: TenantId, actor: ActorRef): void {
    const binding = requireBinding(backend);
    if (!binding.tenant.equals(tenant) || !binding.actor.equals(actor)) {
        throw invalidContentState("Memory content storage is bound to a different Actor or Tenant");
    }
}

function insertMemoryContent(
    backend: MemoryBackend,
    bytes: Uint8Array,
    hint?: MediaHint
): ContentPutResult {
    const detached = bytes.slice();
    const digest = Digest.sha256(detached);
    const ref = ContentRef.fromDigest(digest);
    const existing = backend.content.get(ref.value);
    if (existing === undefined) {
        backend.content.set(ref.value, {
            bytes: detached,
            digest,
            hint: hint === undefined ? undefined : new MediaHint(hint.mediaType)
        });
    } else {
        validateContent(existing, ref, detached);
    }
    return { ref, digest };
}

function snapshotBackend(backend: MemoryBackend): MemoryContentSnapshot {
    validateBackend(backend);
    return Object.freeze({
        version: 1,
        binding:
            backend.binding === undefined
                ? null
                : Object.freeze({
                      tenant: backend.binding.tenant.value,
                      actor: Object.freeze({
                          kind: backend.binding.actor.kind,
                          id: backend.binding.actor.id.value
                      })
                  }),
        content: Object.freeze(
            [...backend.content.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([ref, content]) =>
                    Object.freeze({
                        ref,
                        digest: content.digest.value,
                        bytes: content.bytes.slice(),
                        mediaType: content.hint?.mediaType ?? null
                    })
                )
        ),
        edges: Object.freeze(
            [...backend.edges.values()].sort(compareBytes).map((value) => value.slice())
        ),
        relations: Object.freeze(
            [...backend.relations.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([ref, unownedSince]) => Object.freeze({ ref, unownedSince }))
        ),
        leases: Object.freeze(
            [...backend.leases.values()].sort(compareBytes).map((value) => value.slice())
        )
    });
}

function restoreBackend(snapshot: MemoryContentSnapshot): MemoryBackend {
    try {
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            snapshot.version !== 1 ||
            !Array.isArray(snapshot.content) ||
            !Array.isArray(snapshot.edges) ||
            !Array.isArray(snapshot.relations) ||
            !Array.isArray(snapshot.leases)
        ) {
            throw corruptContent("Memory content snapshot is malformed");
        }
        const binding =
            snapshot.binding === null
                ? undefined
                : {
                      tenant: new TenantId(snapshot.binding.tenant),
                      actor: new ActorRef(
                          snapshot.binding.actor.kind,
                          new ActorId(snapshot.binding.actor.id)
                      )
                  };
        const backend = emptyBackend(binding);
        for (const stored of snapshot.content) {
            const ref = new ContentRef(stored.ref);
            const content: MemoryContent = {
                bytes: stored.bytes.slice(),
                digest: new Digest(stored.digest),
                hint: stored.mediaType === null ? undefined : new MediaHint(stored.mediaType)
            };
            if (backend.content.has(ref.value))
                throw corruptContent("Duplicate content snapshot row");
            validateContent(content, ref);
            backend.content.set(ref.value, content);
        }
        for (const bytes of snapshot.edges) {
            if (!(bytes instanceof Uint8Array))
                throw corruptContent("Malformed owner edge snapshot");
            const edge = ContentOwnerEdge.decode(bytes.slice());
            requireSnapshotBinding(backend, edge.tenant, edge.actor);
            if (backend.edges.has(edge.ownerKey))
                throw corruptContent("Duplicate owner edge snapshot");
            backend.edges.set(edge.ownerKey, ContentOwnerEdge.encode(edge));
        }
        for (const relation of snapshot.relations) {
            const ref = new ContentRef(relation.ref);
            if (
                backend.relations.has(ref.value) ||
                (relation.unownedSince !== null && !validTimestamp(relation.unownedSince))
            ) {
                throw corruptContent("Malformed content relation snapshot");
            }
            backend.relations.set(ref.value, relation.unownedSince);
        }
        for (const bytes of snapshot.leases) {
            if (!(bytes instanceof Uint8Array)) throw corruptContent("Malformed lease snapshot");
            const lease = TransientContentLeaseState.decode(bytes.slice());
            requireSnapshotBinding(backend, lease.tenant, lease.actor);
            if (backend.leases.has(lease.envelopeDigest.value)) {
                throw corruptContent("Duplicate lease snapshot");
            }
            backend.leases.set(
                lease.envelopeDigest.value,
                TransientContentLeaseState.encode(lease)
            );
        }
        validateBackend(backend);
        return backend;
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw corruptContent("Memory content snapshot is malformed");
    }
}

function validateBackend(backend: MemoryBackend): void {
    if (backend.edges.size > 0 || backend.relations.size > 0 || backend.leases.size > 0) {
        requireBinding(backend);
    }
    for (const [value, content] of backend.content) validateContent(content, new ContentRef(value));
    for (const [ownerKey, bytes] of backend.edges) {
        const edge = decodeStoredEdge(bytes, ownerKey, backend);
        if (
            !backend.content.has(edge.ref.value) ||
            backend.relations.get(edge.ref.value) !== null
        ) {
            throw corruptContent("Owned content relation is malformed");
        }
    }
    for (const [value, unownedSince] of backend.relations) {
        new ContentRef(value);
        const owned = hasOwner(backend, value);
        if (
            !backend.content.has(value) ||
            (unownedSince !== null && !validTimestamp(unownedSince)) ||
            owned !== (unownedSince === null)
        ) {
            throw corruptContent("Content relation is malformed");
        }
    }
    for (const [key, bytes] of backend.leases) decodeMemoryLease(bytes, key, backend);
}

function decodeStoredEdge(
    bytes: Uint8Array,
    ownerKey: string,
    backend: MemoryBackend
): ContentOwnerEdge {
    const edge = ContentOwnerEdge.decode(bytes.slice());
    requireSnapshotBinding(backend, edge.tenant, edge.actor);
    if (edge.ownerKey !== ownerKey) throw corruptContent("Owner edge does not match its key");
    return edge;
}

function decodeMemoryLease(
    bytes: Uint8Array,
    key: string,
    backend: MemoryBackend
): TransientContentLeaseState {
    const lease = TransientContentLeaseState.decode(bytes.slice());
    requireSnapshotBinding(backend, lease.tenant, lease.actor);
    if (
        lease.envelopeDigest.value !== key ||
        !backend.content.has(lease.ref.value) ||
        !backend.relations.has(lease.ref.value)
    ) {
        throw corruptContent("Transient content lease storage is malformed");
    }
    return lease;
}

function normalizeMemoryLeases(backend: MemoryBackend, observedAt: Date): ReadonlySet<string> {
    const active = new Set<string>();
    for (const [key, bytes] of backend.leases) {
        const lease = decodeMemoryLease(bytes, key, backend);
        if (lease.isActive(observedAt)) {
            active.add(lease.ref.value);
        } else if (!hasOwner(backend, lease.ref.value)) {
            advanceUnownedSince(backend, lease.ref, inactiveBoundary(lease, observedAt));
        }
    }
    return active;
}

function inactiveBoundary(lease: TransientContentLeaseState, observedAt: Date): Date {
    const closedAt = lease.closedAt;
    if (closedAt !== undefined) {
        return new Date(Math.min(closedAt.getTime(), lease.expiresAt.getTime()));
    }
    if (lease.isActive(observedAt)) throw corruptContent("Active lease has no inactive boundary");
    return lease.expiresAt;
}

function advanceUnownedSince(backend: MemoryBackend, ref: ContentRef, boundary: Date): void {
    const current = requireRelation(backend, ref);
    if (current === null) {
        if (hasOwner(backend, ref.value)) return;
        throw corruptContent("Unowned content has an owned relation");
    }
    backend.relations.set(ref.value, Math.max(current, boundary.getTime()));
}

function requireRelation(backend: MemoryBackend, ref: ContentRef): number | null {
    const relation = backend.relations.get(ref.value);
    if (relation === undefined) throw corruptContent("Authenticated content relation is missing");
    return relation;
}

function hasOwner(backend: MemoryBackend, ref: string): boolean {
    for (const [ownerKey, bytes] of backend.edges) {
        if (decodeStoredEdge(bytes, ownerKey, backend).ref.value === ref) return true;
    }
    return false;
}

function deleteMemoryContent(backend: MemoryBackend, ref: ContentRef): void {
    const leaseKeys: string[] = [];
    for (const [key, bytes] of backend.leases) {
        if (decodeMemoryLease(bytes, key, backend).ref.equals(ref)) leaseKeys.push(key);
    }
    for (const key of leaseKeys) backend.leases.delete(key);
    backend.relations.delete(ref.value);
    backend.content.delete(ref.value);
}

function validateBindingBytes(binding: TransientContentBinding, bytes: Uint8Array): void {
    const digest = Digest.sha256(bytes);
    if (!binding.ref.digest.equals(binding.digest) || !binding.digest.equals(digest)) {
        throw new AgentCoreError("codec.invalid", "Transient content binding does not match bytes");
    }
}

function requireSnapshotBinding(backend: MemoryBackend, tenant: TenantId, actor: ActorRef): void {
    try {
        requireSameBinding(backend, tenant, actor);
    } catch {
        throw corruptContent("Stored content state has foreign Actor or Tenant ownership");
    }
}

function contentStat(ref: ContentRef, content: MemoryContent): ContentStat {
    return new ContentStat(ref, content.digest, content.bytes.byteLength, content.hint);
}

function validateContent(
    content: MemoryContent,
    expectedRef: ContentRef,
    expectedBytes?: Uint8Array
): void {
    const recomputed = Digest.sha256(content.bytes);
    if (
        !expectedRef.digest.equals(content.digest) ||
        !content.digest.equals(recomputed) ||
        (expectedBytes !== undefined && !equalBytes(content.bytes, expectedBytes))
    ) {
        throw corruptContent();
    }
}

function requireTimestamp(value: number | null): number {
    if (value === null || !validTimestamp(value))
        throw corruptContent("Unowned timestamp is malformed");
    return value;
}

function validTimestamp(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
    return Buffer.compare(left, right);
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

function corruptContent(
    message = "Stored content or retention state is malformed"
): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
