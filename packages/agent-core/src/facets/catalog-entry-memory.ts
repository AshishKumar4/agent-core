import { type TransactionOperation, type SynchronousResultGuard } from "../actors";
import { Revision, hasExactKeys } from "../core";
import { isString } from "./data";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { CatalogEntry } from "./catalog-entry";
import { WorkspaceCatalogStore } from "./catalog-entry-store";
import type { CatalogEntryId } from "./id";
import {
    cloneRecordMap,
    insertImmutable,
    orderedRecords,
    requireSynchronousRecordResult,
    sameRecordMaps,
    type RecordMap
} from "./record-map";

interface MemoryCatalogState {
    revision: number;
    entries: RecordMap;
}

export interface MemoryWorkspaceCatalogSnapshot {
    readonly version: 1;
    readonly owner: string;
    readonly revision: number;
    readonly entries: readonly Uint8Array[];
}

export class MemoryWorkspaceCatalogStore extends WorkspaceCatalogStore<MemoryCatalogState> {
    #state: MemoryCatalogState;
    #active: MemoryCatalogState | undefined;

    public constructor(owner: WorkspaceId) {
        super(owner);
        this.#state = emptyState();
    }

    /** Rebuilds a store from a snapshot of codec bytes, refusing a malformed one. */
    public static restore(
        owner: WorkspaceId,
        snapshot: MemoryWorkspaceCatalogSnapshot
    ): MemoryWorkspaceCatalogStore {
        requireSnapshot(snapshot);
        if (snapshot.owner !== owner.value) {
            throw corrupt("Memory Workspace Catalog snapshot belongs to another Workspace");
        }
        const store = new MemoryWorkspaceCatalogStore(owner);
        const state = emptyState();
        state.revision = snapshot.revision;
        for (const bytes of snapshot.entries) {
            const entry = CatalogEntry.decode(bytes);
            if (state.entries.has(entry.id.value)) {
                throw corrupt("Memory Workspace Catalog snapshot contains duplicate entries");
            }
            insertImmutable(state.entries, entry.id.value, bytes, "Catalog entry");
        }
        validateState(state);
        store.#state = cloneState(state);
        return store;
    }

    public transaction<Result>(
        operation: TransactionOperation<MemoryCatalogState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined)
            throw invalidState("Nested Catalog transactions are not supported");
        const draft = cloneState(this.#state);
        this.#active = draft;
        try {
            const result = requireSynchronousRecordResult(operation(draft), "Catalog");
            validateState(draft);
            validateCommit(this.#state, draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public loadRevision(transaction: MemoryCatalogState): Revision {
        this.requireActive(transaction);
        return new Revision(transaction.revision);
    }

    public saveRevision(transaction: MemoryCatalogState, revision: Revision): void {
        this.requireActive(transaction);
        if (revision.value !== transaction.revision + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Catalog revision must advance exactly once"
            );
        }
        transaction.revision = revision.value;
    }

    public loadEntry(transaction: MemoryCatalogState, id: CatalogEntryId): CatalogEntry | undefined {
        this.requireActive(transaction);
        const bytes = transaction.entries.get(id.value);
        return bytes === undefined ? undefined : decodeEntry(bytes, id.value);
    }

    /**
     * A position lookup, not an assertion about the store's key discipline: `validateState`
     * owns that at every commit, so decoding here does not restate it.
     */
    public loadEntryAt(
        transaction: MemoryCatalogState,
        origin: CatalogEntry["origin"]
    ): CatalogEntry | undefined {
        this.requireActive(transaction);
        return [...transaction.entries.values()]
            .map((bytes) => CatalogEntry.decode(bytes))
            .find((entry) => entry.origin.equals(origin));
    }

    public listEntries(transaction: MemoryCatalogState): readonly CatalogEntry[] {
        this.requireActive(transaction);
        return Object.freeze(
            orderedRecords(transaction.entries).map(([key, bytes]) => decodeEntry(bytes, key))
        );
    }

    public insertEntry(transaction: MemoryCatalogState, entry: CatalogEntry): void {
        this.requireActive(transaction);
        this.requireUnclaimedOrigin(transaction, entry);
        insertImmutable(transaction.entries, entry.id.value, CatalogEntry.encode(entry), "Catalog entry");
    }

    public retireEntry(transaction: MemoryCatalogState, id: CatalogEntryId): void {
        this.requireActive(transaction);
        if (!transaction.entries.delete(id.value)) {
            throw invalidState(`Catalog entry ${id.value} is not contributed`);
        }
    }

    public snapshot(): MemoryWorkspaceCatalogSnapshot {
        return Object.freeze({
            version: 1,
            owner: this.owner.value,
            revision: this.#state.revision,
            entries: Object.freeze(
                orderedRecords(this.#state.entries).map(([, bytes]) => bytes.slice())
            )
        });
    }

    private requireActive(transaction: MemoryCatalogState): void {
        if (transaction !== this.#active)
            throw invalidState("Workspace Catalog access requires its active transaction");
    }
}

function emptyState(): MemoryCatalogState {
    return { revision: 0, entries: new Map() };
}

function cloneState(state: MemoryCatalogState): MemoryCatalogState {
    return { revision: state.revision, entries: cloneRecordMap(state.entries) };
}

function decodeEntry(bytes: Uint8Array, key: string): CatalogEntry {
    const value = CatalogEntry.decode(bytes);
    if (value.id.value !== key) {
        throw corrupt("Stored Catalog entry key does not match codec bytes");
    }
    return value;
}

function requireSnapshot(snapshot: MemoryWorkspaceCatalogSnapshot): void {
    if (
        !hasExactKeys(snapshot, ["entries", "owner", "revision", "version"]) ||
        snapshot.version !== 1 ||
        !isString(snapshot.owner) ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 0 ||
        !Array.isArray(snapshot.entries) ||
        snapshot.entries.some((bytes) => !(bytes instanceof Uint8Array))
    ) {
        throw corrupt("Memory Workspace Catalog snapshot is malformed");
    }
}

function validateState(state: MemoryCatalogState): void {
    const origins = new Set<string>();
    for (const [key, bytes] of state.entries) {
        const entry = decodeEntry(bytes, key);
        if (origins.has(entry.origin.key))
            throw corrupt("Memory Workspace Catalog state contains duplicate origins");
        origins.add(entry.origin.key);
    }
    // Retirement (§4.1 withdrawal) removes records while advancing the revision, so a
    // restored snapshot can only be bounded from below. The exact relation is checked per
    // transaction by validateCommit, where the previous record set is still available.
    if (state.revision < state.entries.size) {
        throw corrupt("Memory Workspace Catalog revision does not match its records");
    }
}

/**
 * The revision counts committed write transactions exactly: a transaction that changed the
 * record set advances it once, and one that changed nothing leaves it alone. Comparing the
 * draft against the state it forked from catches a fabricated insertion, a fabricated
 * retirement, and a revision bump over an unchanged store.
 */
function validateCommit(before: MemoryCatalogState, after: MemoryCatalogState): void {
    const changed = !sameRecordMaps(before.entries, after.entries);
    if (after.revision - before.revision !== (changed ? 1 : 0)) {
        throw corrupt("Memory Workspace Catalog revision does not match its records");
    }
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
