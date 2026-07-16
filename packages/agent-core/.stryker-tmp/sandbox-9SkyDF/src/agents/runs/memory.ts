// @ts-nocheck
import { AgentCoreError } from "../../errors";
import type { SynchronousResultGuard } from "../../actors";
import {
    RUN_RECORD_KINDS,
    type RunRecordKind,
    type RunStoragePort,
    type StoredRunParent,
    type StoredRunRecord
} from "./store";

export interface MemoryRunStorageSnapshot {
    readonly version: 1;
    readonly records: readonly StoredRunRecord[];
    readonly parents: readonly StoredRunParent[];
}

interface MemoryState {
    readonly records: Map<string, StoredRunRecord>;
    readonly parents: Map<string, StoredRunParent>;
}

export class MemoryRunStorage implements RunStoragePort<MemoryState> {
    #state: MemoryState;
    #active = false;

    public constructor(snapshot?: MemoryRunStorageSnapshot) {
        this.#state = snapshot === undefined ? emptyState() : restoreSnapshot(snapshot);
    }

    public transaction<Result>(
        operation: (transaction: MemoryState) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active) throw invalidStorage("Nested Run storage transactions are not supported");
        const draft = cloneState(this.#state);
        this.#active = true;
        try {
            const result = operation(draft);
            if (isThenable(result))
                throw invalidStorage("Run storage transactions must be synchronous");
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = false;
        }
    }

    public get(
        transaction: MemoryState,
        kind: RunRecordKind,
        key: string
    ): StoredRunRecord | undefined {
        const value = transaction.records.get(recordKey(kind, key));
        return value === undefined ? undefined : copyRecord(value);
    }

    public list(transaction: MemoryState, kind: RunRecordKind): readonly StoredRunRecord[] {
        return [...transaction.records.values()]
            .filter((record) => record.kind === kind)
            .sort((left, right) => left.key.localeCompare(right.key))
            .map(copyRecord);
    }

    public insert(transaction: MemoryState, record: StoredRunRecord): void {
        validateRecord(record);
        const key = recordKey(record.kind, record.key);
        const existing = transaction.records.get(key);
        if (existing !== undefined) {
            if (sameRecord(existing, record)) return;
            throw invalidStorage("Run records are immutable unless replaced by revision CAS");
        }
        transaction.records.set(key, copyRecord(record));
    }

    public replace(
        transaction: MemoryState,
        record: StoredRunRecord,
        expectedRevision: number
    ): void {
        validateRecord(record);
        const key = recordKey(record.kind, record.key);
        const existing = transaction.records.get(key);
        if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
            throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
        }
        transaction.records.set(key, copyRecord(record));
    }

    public insertParent(transaction: MemoryState, edge: StoredRunParent): void {
        if (!Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || edge.ordinal > 1) {
            throw corruptStorage("Run parent ordinal must be zero or one");
        }
        const key = parentKey(edge.commit, edge.ordinal);
        const existing = transaction.parents.get(key);
        if (existing !== undefined) {
            if (existing.parent === edge.parent) return;
            throw invalidStorage("Run commit parent edges are immutable");
        }
        transaction.parents.set(key, Object.freeze({ ...edge }));
    }

    public parents(transaction: MemoryState, commit: string): readonly StoredRunParent[] {
        return [...transaction.parents.values()]
            .filter((edge) => edge.commit === commit)
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((edge) => Object.freeze({ ...edge }));
    }

    public snapshot(): MemoryRunStorageSnapshot {
        return Object.freeze({
            version: 1,
            records: Object.freeze(
                [...this.#state.records.values()]
                    .sort((left, right) =>
                        recordKey(left.kind, left.key).localeCompare(
                            recordKey(right.kind, right.key)
                        )
                    )
                    .map(copyRecord)
            ),
            parents: Object.freeze(
                [...this.#state.parents.values()]
                    .sort((left, right) =>
                        parentKey(left.commit, left.ordinal).localeCompare(
                            parentKey(right.commit, right.ordinal)
                        )
                    )
                    .map((edge) => Object.freeze({ ...edge }))
            )
        });
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
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.records) ||
        !Array.isArray(snapshot.parents)
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
function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? "then" in value
        : false;
}

function invalidStorage(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function corruptStorage(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
