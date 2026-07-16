// @ts-nocheck
import { Revision } from "../core";
import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { SlotName, type SlotEntryId } from "./id";
import { SlotDeclaration } from "./slot";
import { SlotEntry } from "./slot-entry";
import { WorkspaceSlotStore } from "./slot-store";

interface MemorySlotState {
    revision: number;
    slots: Map<string, Uint8Array>;
    entries: Map<string, Uint8Array>;
}

export interface MemoryWorkspaceSlotSnapshot {
    readonly version: 1;
    readonly owner: string;
    readonly revision: number;
    readonly slots: readonly Uint8Array[];
    readonly entries: readonly Uint8Array[];
}

export class MemoryWorkspaceSlotStore extends WorkspaceSlotStore<MemorySlotState> {
    #state: MemorySlotState;
    #active: MemorySlotState | undefined;

    public constructor(owner: WorkspaceId) {
        super(owner);
        this.#state = emptyState();
    }

    public static restore(
        owner: WorkspaceId,
        snapshot: MemoryWorkspaceSlotSnapshot
    ): MemoryWorkspaceSlotStore {
        requireSnapshot(snapshot);
        if (snapshot.owner !== owner.value) {
            throw corrupt("Memory Workspace Slot snapshot belongs to another Workspace");
        }
        const store = new MemoryWorkspaceSlotStore(owner);
        const state = emptyState();
        state.revision = snapshot.revision;
        for (const bytes of snapshot.slots) {
            const declaration = SlotDeclaration.decode(bytes.slice());
            if (state.slots.has(declaration.name.value)) {
                throw corrupt(
                    "Memory Workspace Slot snapshot contains duplicate Slot declarations"
                );
            }
            insertImmutable(state.slots, declaration.name.value, bytes, "Slot declaration");
        }
        for (const bytes of snapshot.entries) {
            const entry = SlotEntry.decode(bytes.slice());
            requireEntryClosure(state, entry);
            if (state.entries.has(entry.id.value)) {
                throw corrupt("Memory Workspace Slot snapshot contains duplicate Slot entries");
            }
            insertImmutable(state.entries, entry.id.value, bytes, "Slot entry");
            requireUniqueOrigin(state, entry);
        }
        if (state.revision !== state.slots.size + state.entries.size) {
            throw corrupt("Memory Workspace Slot snapshot revision does not match its records");
        }
        validateState(state);
        store.#state = cloneState(state);
        return store;
    }

    public transaction<Result>(
        operation: TransactionOperation<MemorySlotState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined)
            throw invalidState("Nested Slot transactions are not supported");
        const draft = cloneState(this.#state);
        this.#active = draft;
        try {
            const result = operation(draft);
            if (isThenable(result)) {
                if (result instanceof Promise) void result.catch(noop);
                throw invalidState("Slot transactions must be synchronous");
            }
            validateState(draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public loadRevision(transaction: MemorySlotState): Revision {
        this.requireActive(transaction);
        return new Revision(transaction.revision);
    }

    public saveRevision(transaction: MemorySlotState, revision: Revision): void {
        this.requireActive(transaction);
        if (revision.value !== transaction.revision + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Slot revision must advance exactly once"
            );
        }
        transaction.revision = revision.value;
    }

    public loadSlot(transaction: MemorySlotState, name: SlotName): SlotDeclaration | undefined {
        this.requireActive(transaction);
        const bytes = transaction.slots.get(name.value);
        return bytes === undefined ? undefined : decodeSlot(bytes, name.value);
    }

    public insertSlot(transaction: MemorySlotState, declaration: SlotDeclaration): void {
        this.requireActive(transaction);
        const bytes = SlotDeclaration.encode(declaration);
        insertImmutable(transaction.slots, declaration.name.value, bytes, "Slot declaration");
    }

    public loadEntry(transaction: MemorySlotState, id: SlotEntryId): SlotEntry | undefined {
        this.requireActive(transaction);
        const bytes = transaction.entries.get(id.value);
        return bytes === undefined ? undefined : decodeEntry(bytes, id.value);
    }

    public listEntries(transaction: MemorySlotState, slot: SlotName): readonly SlotEntry[] {
        this.requireActive(transaction);
        return Object.freeze(
            [...transaction.entries.values()]
                .map((bytes) => SlotEntry.decode(bytes.slice()))
                .filter((entry) => entry.slot.equals(slot))
                .sort(compareEntries)
        );
    }

    public insertEntry(transaction: MemorySlotState, entry: SlotEntry): void {
        this.requireActive(transaction);
        requireEntryClosure(transaction, entry);
        requireUniqueOrigin(transaction, entry);
        insertImmutable(transaction.entries, entry.id.value, SlotEntry.encode(entry), "Slot entry");
    }

    public snapshot(): MemoryWorkspaceSlotSnapshot {
        return Object.freeze({
            version: 1,
            owner: this.owner.value,
            revision: this.#state.revision,
            slots: Object.freeze(
                [...this.#state.slots].sort(compareRecordKeys).map(([, bytes]) => bytes.slice())
            ),
            entries: Object.freeze(
                [...this.#state.entries].sort(compareRecordKeys).map(([, bytes]) => bytes.slice())
            )
        });
    }

    private requireActive(transaction: MemorySlotState): void {
        if (transaction !== this.#active)
            throw invalidState("Workspace Slot access requires its active transaction");
    }
}

function emptyState(): MemorySlotState {
    return { revision: 0, slots: new Map(), entries: new Map() };
}

function cloneState(state: MemorySlotState): MemorySlotState {
    return {
        revision: state.revision,
        slots: new Map([...state.slots].map(([key, bytes]) => [key, bytes.slice()])),
        entries: new Map([...state.entries].map(([key, bytes]) => [key, bytes.slice()]))
    };
}

function decodeSlot(bytes: Uint8Array, key: string): SlotDeclaration {
    const value = SlotDeclaration.decode(bytes.slice());
    if (value.name.value !== key)
        throw corrupt("Stored Slot declaration key does not match codec bytes");
    return value;
}

function decodeEntry(bytes: Uint8Array, key: string): SlotEntry {
    const value = SlotEntry.decode(bytes.slice());
    if (value.id.value !== key) throw corrupt("Stored Slot entry key does not match codec bytes");
    return value;
}

function requireEntryClosure(state: MemorySlotState, entry: SlotEntry): void {
    const bytes = state.slots.get(entry.slot.value);
    if (bytes === undefined) {
        throw new AgentCoreError("facet.inactive", `Slot ${entry.slot.value} is not installed`);
    }
    const declaration = decodeSlot(bytes, entry.slot.value);
    if (!declaration.entrySchema.accepts(entry.value)) {
        throw new AgentCoreError(
            "operation.invalid-input",
            `Slot entry ${entry.id.value} does not match the entry schema`
        );
    }
}

function requireUniqueOrigin(state: MemorySlotState, entry: SlotEntry): void {
    const conflict = [...state.entries.values()]
        .map((bytes) => SlotEntry.decode(bytes.slice()))
        .find(
            (candidate) =>
                candidate.slot.equals(entry.slot) &&
                candidate.contributor.equals(entry.contributor) &&
                candidate.ordinal === entry.ordinal &&
                !candidate.id.equals(entry.id)
        );
    if (conflict !== undefined) throw invalidState("Slot contribution origin is immutable");
}

function insertImmutable(
    records: Map<string, Uint8Array>,
    key: string,
    bytes: Uint8Array,
    subject: string
): void {
    const previous = records.get(key);
    if (previous !== undefined && !equalBytes(previous, bytes)) {
        throw invalidState(`${subject} ${key} is immutable`);
    }
    records.set(key, bytes.slice());
}

function compareEntries(left: SlotEntry, right: SlotEntry): number {
    return (
        left.ordinal - right.ordinal || compareText(left.contributor.value, right.contributor.value)
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : 1;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof (value as { readonly then?: unknown }).then === "function"
        : false;
}

function requireSnapshot(snapshot: MemoryWorkspaceSlotSnapshot): void {
    if (
        JSON.stringify(Object.keys(snapshot).sort()) !==
            JSON.stringify(["entries", "owner", "revision", "slots", "version"]) ||
        snapshot.version !== 1 ||
        typeof snapshot.owner !== "string" ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 0 ||
        !Array.isArray(snapshot.slots) ||
        !Array.isArray(snapshot.entries) ||
        [...snapshot.slots, ...snapshot.entries].some((bytes) => !(bytes instanceof Uint8Array))
    ) {
        throw corrupt("Memory Workspace Slot snapshot is malformed");
    }
}

function validateState(state: MemorySlotState): void {
    for (const [key, bytes] of state.slots) decodeSlot(bytes, key);
    const origins = new Set<string>();
    for (const [key, bytes] of state.entries) {
        const entry = decodeEntry(bytes, key);
        requireEntryClosure(state, entry);
        const origin = `${entry.slot.value}\0${entry.contributor.value}\0${entry.ordinal}`;
        if (origins.has(origin))
            throw corrupt("Memory Workspace Slot state contains duplicate origins");
        origins.add(origin);
    }
    if (state.revision !== state.slots.size + state.entries.size) {
        throw corrupt("Memory Workspace Slot revision does not match its records");
    }
}

function compareRecordKeys(
    left: readonly [string, Uint8Array],
    right: readonly [string, Uint8Array]
): number {
    return compareText(left[0], right[0]);
}

function noop(): void {}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
