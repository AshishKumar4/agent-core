import { Revision, compareText, hasExactKeys } from "../core";
import {
    requireSynchronousResult,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../actors";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { isString } from "./data";
import { SlotName, type SlotEntryId } from "./id";
import { InstalledSlot } from "./slot";
import { SlotEntry, type SlotContributionOrigin } from "./slot-entry";
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
            const installed = InstalledSlot.decode(bytes);
            if (state.slots.has(installed.declaration.name.value)) {
                throw corrupt(
                    "Memory Workspace Slot snapshot contains duplicate Slot declarations"
                );
            }
            insertImmutable(
                state.slots,
                installed.declaration.name.value,
                bytes,
                "Slot declaration"
            );
        }
        for (const bytes of snapshot.entries) {
            const entry = SlotEntry.decode(bytes);
            requireEntryClosure(state, entry);
            if (state.entries.has(entry.id.value)) {
                throw corrupt("Memory Workspace Slot snapshot contains duplicate Slot entries");
            }
            insertImmutable(state.entries, entry.id.value, bytes, "Slot entry");
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
            const result = requireSynchronousSlotResult(operation(draft));
            validateState(draft);
            validateCommit(this.#state, draft);
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

    public loadSlot(transaction: MemorySlotState, name: SlotName): InstalledSlot | undefined {
        this.requireActive(transaction);
        const bytes = transaction.slots.get(name.value);
        return bytes === undefined ? undefined : decodeSlot(bytes, name.value);
    }

    public insertSlot(transaction: MemorySlotState, slot: InstalledSlot): void {
        this.requireActive(transaction);
        const bytes = InstalledSlot.encode(slot);
        insertImmutable(transaction.slots, slot.declaration.name.value, bytes, "Slot declaration");
    }

    public retireSlot(transaction: MemorySlotState, name: SlotName): void {
        this.requireActive(transaction);
        if (!transaction.slots.delete(name.value)) {
            throw invalidState(`Slot ${name.value} is not installed`);
        }
    }

    public listSlots(transaction: MemorySlotState): readonly InstalledSlot[] {
        this.requireActive(transaction);
        return Object.freeze(
            [...transaction.slots]
                .sort(compareRecordKeys)
                .map(([key, bytes]) => decodeSlot(bytes, key))
        );
    }

    public loadEntry(transaction: MemorySlotState, id: SlotEntryId): SlotEntry | undefined {
        this.requireActive(transaction);
        const bytes = transaction.entries.get(id.value);
        return bytes === undefined ? undefined : decodeEntry(bytes, id.value);
    }

    /**
     * A position lookup, not an assertion about the store's key discipline: `validateState`
     * owns that at every commit, so decoding here does not restate it.
     */
    public loadEntryAt(
        transaction: MemorySlotState,
        origin: SlotContributionOrigin
    ): SlotEntry | undefined {
        this.requireActive(transaction);
        return [...transaction.entries.values()]
            .map((bytes) => SlotEntry.decode(bytes))
            .find((entry) => entry.origin.equals(origin));
    }

    public listEntries(transaction: MemorySlotState, slot: SlotName): readonly SlotEntry[] {
        this.requireActive(transaction);
        return Object.freeze(
            [...transaction.entries.values()]
                .map((bytes) => SlotEntry.decode(bytes))
                .filter((entry) => entry.slot.equals(slot))
                .sort(compareEntries)
        );
    }

    public listAllEntries(transaction: MemorySlotState): readonly SlotEntry[] {
        this.requireActive(transaction);
        return Object.freeze(
            [...transaction.entries]
                .sort(compareRecordKeys)
                .map(([key, bytes]) => decodeEntry(bytes, key))
        );
    }

    public insertEntry(transaction: MemorySlotState, entry: SlotEntry): void {
        this.requireActive(transaction);
        requireEntryClosure(transaction, entry);
        this.requireFreeOrigin(transaction, entry);
        insertImmutable(transaction.entries, entry.id.value, SlotEntry.encode(entry), "Slot entry");
    }

    public retireEntry(transaction: MemorySlotState, id: SlotEntryId): void {
        this.requireActive(transaction);
        if (!transaction.entries.delete(id.value)) {
            throw invalidState(`Slot entry ${id.value} is not contributed`);
        }
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

function decodeSlot(bytes: Uint8Array, key: string): InstalledSlot {
    const value = InstalledSlot.decode(bytes);
    if (value.declaration.name.value !== key)
        throw corrupt("Stored Slot declaration key does not match codec bytes");
    return value;
}

function decodeEntry(bytes: Uint8Array, key: string): SlotEntry {
    const value = SlotEntry.decode(bytes);
    if (value.id.value !== key) throw corrupt("Stored Slot entry key does not match codec bytes");
    return value;
}

function requireEntryClosure(state: MemorySlotState, entry: SlotEntry): void {
    const bytes = state.slots.get(entry.slot.value);
    if (bytes === undefined) {
        throw new AgentCoreError("facet.inactive", `Slot ${entry.slot.value} is not installed`);
    }
    const installed = decodeSlot(bytes, entry.slot.value);
    if (!installed.declaration.entrySchema.accepts(entry.value)) {
        throw new AgentCoreError(
            "operation.invalid-input",
            `Slot entry ${entry.id.value} does not match the entry schema`
        );
    }
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
        left.ordinal - right.ordinal ||
        compareText(left.attribution.contributor.value, right.attribution.contributor.value)
    );
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function requireSynchronousSlotResult<Result>(result: Result): Result {
    try {
        return requireSynchronousResult(result);
    } catch (error) {
        if (error instanceof TypeError) throw invalidState("Slot transactions must be synchronous");
        throw error;
    }
}

function requireSnapshot(snapshot: MemoryWorkspaceSlotSnapshot): void {
    if (
        !hasExactKeys(snapshot, ["entries", "owner", "revision", "slots", "version"]) ||
        snapshot.version !== 1 ||
        !isString(snapshot.owner) ||
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
        if (origins.has(entry.origin.key))
            throw corrupt("Memory Workspace Slot state contains duplicate origins");
        origins.add(entry.origin.key);
    }
    // Retirement (§4.1 withdrawal) removes records while advancing the revision, so a
    // restored snapshot can only be bounded from below. The exact relation is checked per
    // transaction by validateCommit, where the previous record set is still available.
    if (state.revision < state.slots.size + state.entries.size) {
        throw corrupt("Memory Workspace Slot revision does not match its records");
    }
}

/**
 * The revision counts committed write transactions exactly: a transaction that changed the
 * record set advances it once, and one that changed nothing leaves it alone. Comparing the
 * draft against the state it forked from catches a fabricated insertion, a fabricated
 * retirement, and a revision bump over an unchanged store — which the append-only
 * record-count equality used to catch before retirement existed.
 */
function validateCommit(before: MemorySlotState, after: MemorySlotState): void {
    const changed =
        !sameRecords(before.slots, after.slots) || !sameRecords(before.entries, after.entries);
    if (after.revision - before.revision !== (changed ? 1 : 0)) {
        throw corrupt("Memory Workspace Slot revision does not match its records");
    }
}

function sameRecords(left: Map<string, Uint8Array>, right: Map<string, Uint8Array>): boolean {
    if (left.size !== right.size) return false;
    for (const [key, bytes] of left) {
        const other = right.get(key);
        if (other === undefined || !equalBytes(bytes, other)) return false;
    }
    return true;
}

function compareRecordKeys(
    left: readonly [string, Uint8Array],
    right: readonly [string, Uint8Array]
): number {
    return compareText(left[0], right[0]);
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
