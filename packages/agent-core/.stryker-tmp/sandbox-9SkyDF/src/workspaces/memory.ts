// @ts-nocheck
import { ACTOR_STATE_SNAPSHOT, type ActorCloneOwnedState } from "../actors";
import {
    type StoredWorkspacePointer,
    type StoredWorkspaceRecord,
    type StoredWorkspaceUnique,
    type CompactableWorkspaceRecordKind,
    type WorkspaceRecordKind,
    type WorkspaceRecordStorage,
    validateStoredWorkspaceRecord,
    validateWorkspacePointer,
    validateWorkspaceUnique,
    validateWorkspacePointerAdvance
} from "./persistence";
import { AgentCoreError } from "../errors";

export interface MemoryWorkspaceSnapshot {
    readonly version: 1;
    readonly records: readonly StoredWorkspaceRecord[];
    readonly uniques: readonly StoredWorkspaceUnique[];
    readonly pointers: readonly StoredWorkspacePointer[];
}

export class MemoryWorkspaceRecords implements WorkspaceRecordStorage, ActorCloneOwnedState {
    readonly #records = new Map<WorkspaceRecordKind, Map<string, StoredWorkspaceRecord>>();
    readonly #uniques = new Map<string, Map<string, StoredWorkspaceUnique>>();
    readonly #pointers = new Map<string, Map<string, StoredWorkspacePointer>>();

    public constructor(snapshot?: MemoryWorkspaceSnapshot) {
        if (snapshot !== undefined && snapshot.version !== 1) {
            throw new TypeError("Memory workspace snapshot version is unsupported");
        }
        for (const record of snapshot?.records ?? []) this.insertRecord(record);
        for (const unique of snapshot?.uniques ?? []) this.insertUnique(unique);
        for (const pointer of snapshot?.pointers ?? []) {
            validateWorkspacePointer(pointer);
            const pointers = nested(this.#pointers, pointer.namespace);
            if (pointers.has(pointer.key)) {
                throw new TypeError("Memory workspace snapshot contains duplicate pointers");
            }
            pointers.set(pointer.key, Object.freeze({ ...pointer }));
        }
        Object.freeze(this);
    }

    public findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined {
        const record = this.#records.get(kind)?.get(id);
        return record === undefined ? undefined : copyRecord(record);
    }

    public listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[] {
        return [...(this.#records.get(kind)?.values() ?? [])]
            .map(copyRecord)
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    public insertRecord(record: StoredWorkspaceRecord): void {
        validateStoredWorkspaceRecord(record);
        const records = nested(this.#records, record.kind);
        if (records.has(record.id)) {
            throw new AgentCoreError("protocol.duplicate", "Workspace records are append-only");
        }
        records.set(record.id, copyRecord(record));
    }

    public deleteCompactedRecords(
        kind: CompactableWorkspaceRecordKind,
        ids: readonly string[]
    ): void {
        if (kind !== "view" && kind !== "viewDelta" && kind !== "contentRetention") {
            throw new AgentCoreError("protocol.invalid-state", "Record kind is not compactable");
        }
        const records = this.#records.get(kind);
        if (records === undefined) return;
        for (const id of ids) records.delete(id);
        if (records.size === 0) this.#records.delete(kind);
    }

    public findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined {
        const unique = this.#uniques.get(namespace)?.get(key);
        return unique === undefined ? undefined : { ...unique };
    }

    public insertUnique(unique: StoredWorkspaceUnique): void {
        validateWorkspaceUnique(unique);
        const uniques = nested(this.#uniques, unique.namespace);
        if (uniques.has(unique.key)) {
            throw new AgentCoreError(
                "protocol.duplicate",
                "Workspace unique key is already reserved"
            );
        }
        uniques.set(unique.key, Object.freeze({ ...unique }));
    }

    public findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined {
        const pointer = this.#pointers.get(namespace)?.get(key);
        return pointer === undefined ? undefined : { ...pointer };
    }

    public compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void {
        validateWorkspacePointerAdvance(pointer, expectedRecordKey);
        const pointers = nested(this.#pointers, pointer.namespace);
        const current = pointers.get(pointer.key);
        if (
            current?.recordKey !== expectedRecordKey ||
            (current === undefined && expectedRecordKey !== undefined)
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace pointer compare-and-set failed"
            );
        }
        pointers.set(pointer.key, Object.freeze({ ...pointer }));
    }

    public snapshot(): MemoryWorkspaceSnapshot {
        return Object.freeze({
            version: 1 as const,
            records: Object.freeze(flatten(this.#records).map(copyRecord)),
            uniques: Object.freeze(flatten(this.#uniques).map((value) => ({ ...value }))),
            pointers: Object.freeze(flatten(this.#pointers).map((value) => ({ ...value })))
        });
    }

    public clone(): MemoryWorkspaceRecords {
        return new MemoryWorkspaceRecords(this.snapshot());
    }

    public [ACTOR_STATE_SNAPSHOT](): MemoryWorkspaceSnapshot {
        return this.snapshot();
    }
}

function copyRecord(record: StoredWorkspaceRecord): StoredWorkspaceRecord {
    return { kind: record.kind, id: record.id, bytes: record.bytes.slice() };
}

function nested<Key, Value>(values: Map<Key, Map<string, Value>>, key: Key): Map<string, Value> {
    let entries = values.get(key);
    if (entries === undefined) {
        entries = new Map<string, Value>();
        values.set(key, entries);
    }
    return entries;
}

function flatten<Key, Value>(values: Map<Key, Map<string, Value>>): Value[] {
    return [...values.values()].flatMap((entries) => [...entries.values()]);
}
