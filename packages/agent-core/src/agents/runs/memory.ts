import { compareCanonicalText } from "../../core";
import { AgentCoreError } from "../../errors";
import { type ActorRef, requireSynchronousResult, type SynchronousResultGuard } from "../../actors";
import {
    ContentOwnerEdge,
    MemoryContentStore,
    type MemoryContentRetention,
    MemoryContentRetentionState,
    type MemoryContentSnapshot
} from "../../content";
import type { TenantId } from "../../identity";
import {
    RUN_RECORD_KINDS,
    ownRunStorageBackend,
    RunStoragePort,
    type RunRecordKind,
    type RunTransaction,
    type StoredRunParent,
    type StoredRunRecord
} from "./store";

export interface MemoryRunStorageSnapshot {
    readonly version: 2;
    readonly records: readonly StoredRunRecord[];
    readonly parents: readonly StoredRunParent[];
    readonly content: MemoryContentSnapshot;
}

interface MemoryState {
    readonly records: Map<string, StoredRunRecord>;
    readonly parents: Map<string, StoredRunParent>;
}

interface MemoryRunTransactionState {
    readonly transaction: RunTransaction;
    readonly content: MemoryContentRetentionState;
    readonly runs: MemoryState;
    failure: Error | undefined;
}

export class MemoryRunStorage extends RunStoragePort<RunTransaction> {
    readonly #snapshot: () => MemoryRunStorageSnapshot;

    public constructor(
        tenant: TenantId,
        owner: ActorRef,
        snapshot?: MemoryRunStorageSnapshot,
        now?: () => Date
    ) {
        if (owner.kind !== "workspace" && owner.kind !== "run") {
            throw new TypeError("Run storage must belong to a Workspace or dedicated Run Actor");
        }
        const state = snapshot === undefined ? emptyState() : restoreSnapshot(snapshot);
        const contentStore = new MemoryContentStore(snapshot?.content);
        const retention = contentStore.retention(tenant, owner);
        const backend = new MemoryRunStorageBackend(contentStore, retention, state, () =>
            MemoryRunStorage.createTransaction()
        );
        super(tenant, owner, contentStore, ownRunStorageBackend(backend), now);
        this.#snapshot = () => backend.snapshot();
        if (new.target === MemoryRunStorage) Object.freeze(this);
    }

    public snapshot(): MemoryRunStorageSnapshot {
        return this.#snapshot();
    }
}
Object.freeze(MemoryRunStorage.prototype);
Object.freeze(MemoryRunStorage);

class MemoryRunStorageBackend {
    #active: MemoryRunTransactionState | undefined;
    #state: MemoryState;

    public constructor(
        private readonly contentStore: MemoryContentStore,
        private readonly retention: MemoryContentRetention,
        state: MemoryState,
        private readonly createTransaction: () => RunTransaction
    ) {
        this.#state = state;
    }

    public transaction<Result>(
        operation: (transaction: RunTransaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        const current = this.#active;
        if (current !== undefined) {
            current.failure ??= invalidStorage("Nested Run storage transactions are not supported");
            throw current.failure;
        }
        const draft = cloneState(this.#state);
        const transaction = this.createTransaction();
        const outcome = this.contentStore.transaction((content) => {
            const active: MemoryRunTransactionState = {
                transaction,
                content,
                runs: draft,
                failure: undefined
            };
            this.#active = active;
            try {
                const result = requireSynchronousRunResult(operation(transaction));
                if (active.failure !== undefined) throw active.failure;
                return { result, runs: cloneState(draft) };
            } finally {
                this.#active = undefined;
            }
        });
        this.#state = outcome.runs;
        return outcome.result;
    }

    public get(
        transaction: RunTransaction,
        kind: RunRecordKind,
        key: string
    ): StoredRunRecord | undefined {
        const value = this.require(transaction).runs.records.get(recordKey(kind, key));
        return value === undefined ? undefined : copyRecord(value);
    }

    public list(transaction: RunTransaction, kind: RunRecordKind): readonly StoredRunRecord[] {
        return [...this.require(transaction).runs.records.values()]
            .filter((record) => record.kind === kind)
            .sort((left, right) => compareCanonicalText(left.key, right.key))
            .map(copyRecord);
    }

    public validate(record: StoredRunRecord): void {
        validateRecord(record);
    }

    public poison(transaction: RunTransaction, failure: Error): never {
        const state = this.require(transaction);
        state.failure ??= failure;
        throw state.failure;
    }

    public insert(transaction: RunTransaction, record: StoredRunRecord): void {
        const key = recordKey(record.kind, record.key);
        const records = this.require(transaction).runs.records;
        const existing = records.get(key);
        if (existing !== undefined) {
            if (sameRecord(existing, record)) return;
            throw invalidStorage("Run records are immutable unless replaced by revision CAS");
        }
        records.set(key, copyRecord(record));
    }

    public replace(
        transaction: RunTransaction,
        record: StoredRunRecord,
        expectedRevision: number
    ): void {
        const key = recordKey(record.kind, record.key);
        const records = this.require(transaction).runs.records;
        const existing = records.get(key);
        if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
            throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
        }
        records.set(key, copyRecord(record));
    }

    public insertParent(transaction: RunTransaction, edge: StoredRunParent): void {
        if (!Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || edge.ordinal > 1) {
            throw corruptStorage("Run parent ordinal must be zero or one");
        }
        const key = parentKey(edge.commit, edge.ordinal);
        const parents = this.require(transaction).runs.parents;
        const existing = parents.get(key);
        if (existing !== undefined) {
            if (existing.parent === edge.parent) return;
            throw invalidStorage("Run commit parent edges are immutable");
        }
        parents.set(key, Object.freeze({ ...edge }));
    }

    public parents(transaction: RunTransaction, commit: string): readonly StoredRunParent[] {
        return [...this.require(transaction).runs.parents.values()]
            .filter((edge) => edge.commit === commit)
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((edge) => Object.freeze({ ...edge }));
    }

    public retain(transaction: RunTransaction, edge: ContentOwnerEdge, operationAt: Date): void {
        const active = this.require(transaction);
        this.retention.retain(active.content, edge, operationAt);
    }

    public release(transaction: RunTransaction, edge: ContentOwnerEdge, operationAt: Date): void {
        const active = this.require(transaction);
        this.retention.release(active.content, edge, operationAt);
    }

    public verify(
        transaction: RunTransaction,
        ownerPrefixes: readonly string[],
        expected: readonly ContentOwnerEdge[]
    ): void {
        const active = this.require(transaction);
        this.retention.verifyExactNamespace(active.content, ownerPrefixes, expected);
    }

    public snapshot(): MemoryRunStorageSnapshot {
        return Object.freeze({
            version: 2,
            records: Object.freeze(
                [...this.#state.records.values()]
                    .sort((left, right) =>
                        compareCanonicalText(
                            recordKey(left.kind, left.key),
                            recordKey(right.kind, right.key)
                        )
                    )
                    .map(copyRecord)
            ),
            parents: Object.freeze(
                [...this.#state.parents.values()]
                    .sort((left, right) =>
                        compareCanonicalText(
                            parentKey(left.commit, left.ordinal),
                            parentKey(right.commit, right.ordinal)
                        )
                    )
                    .map((edge) => Object.freeze({ ...edge }))
            ),
            content: this.contentStore.snapshot()
        });
    }

    private require(transaction: RunTransaction): MemoryRunTransactionState {
        const active = this.#active;
        if (active === undefined || active.transaction !== transaction) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Memory Run transaction is inactive or belongs to a different store"
            );
        }
        if (active.failure !== undefined) throw active.failure;
        return active;
    }
}

function emptyState(): MemoryState {
    return { records: new Map(), parents: new Map() };
}

function cloneState(state: MemoryState): MemoryState {
    return {
        records: new Map([...state.records].map(([key, value]) => [key, copyRecord(value)])),
        parents: new Map(
            [...state.parents].map(([key, value]) => [key, Object.freeze({ ...value })])
        )
    };
}

function restoreSnapshot(snapshot: MemoryRunStorageSnapshot): MemoryState {
    if (
        snapshot.version !== 2 ||
        !Array.isArray(snapshot.records) ||
        !Array.isArray(snapshot.parents) ||
        snapshot.content === undefined
    ) {
        throw corruptStorage("Memory Run storage snapshot is malformed");
    }
    const state = emptyState();
    for (const record of snapshot.records) {
        validateRecord(record);
        const key = recordKey(record.kind, record.key);
        if (state.records.has(key))
            throw corruptStorage("Memory Run snapshot contains duplicate records");
        state.records.set(key, copyRecord(record));
    }
    for (const edge of snapshot.parents) {
        if (
            edge.commit.length === 0 ||
            edge.parent.length === 0 ||
            !Number.isSafeInteger(edge.ordinal) ||
            edge.ordinal < 0 ||
            edge.ordinal > 1
        ) {
            throw corruptStorage("Memory Run snapshot contains a malformed parent edge");
        }
        const key = parentKey(edge.commit, edge.ordinal);
        if (state.parents.has(key))
            throw corruptStorage("Memory Run snapshot contains duplicate parents");
        state.parents.set(key, Object.freeze({ ...edge }));
    }
    return state;
}

function validateRecord(record: StoredRunRecord): void {
    if (
        !RUN_RECORD_KINDS.includes(record.kind) ||
        record.key.length === 0 ||
        !(record.bytes instanceof Uint8Array) ||
        (record.revision !== null &&
            (!Number.isSafeInteger(record.revision) || record.revision < 0))
    ) {
        throw corruptStorage("Stored Run record is malformed");
    }
}

function copyRecord(record: StoredRunRecord): StoredRunRecord {
    return Object.freeze({ ...record, bytes: record.bytes.slice() });
}

function sameRecord(left: StoredRunRecord, right: StoredRunRecord): boolean {
    return (
        left.revision === right.revision &&
        left.bytes.byteLength === right.bytes.byteLength &&
        left.bytes.every((value, index) => value === right.bytes[index])
    );
}

function recordKey(kind: RunRecordKind, key: string): string {
    return `${kind}\u0000${key}`;
}
function parentKey(commit: string, ordinal: number): string {
    return `${commit}\u0000${ordinal}`;
}
function requireSynchronousRunResult<Result>(result: Result): Result {
    try {
        return requireSynchronousResult(result);
    } catch (error) {
        if (error instanceof TypeError)
            throw invalidStorage("Run storage transactions must be synchronous");
        throw error;
    }
}

function invalidStorage(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function corruptStorage(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
