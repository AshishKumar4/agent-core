import { type TransactionOperation, type SynchronousResultGuard } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import type { SettingsLayerId } from "./id";
import {
    cloneRecordMap,
    insertImmutable,
    orderedRecords,
    requireSynchronousRecordResult,
    sameRecordMaps,
    type RecordMap
} from "./record-map";
import { SettingsLayer, SettingsLayerOrigin } from "./settings";
import { WorkspaceSettingsStore } from "./settings-store";

interface MemorySettingsState {
    revision: number;
    layers: RecordMap;
}

export class MemoryWorkspaceSettingsStore extends WorkspaceSettingsStore<MemorySettingsState> {
    #state: MemorySettingsState;
    #active: MemorySettingsState | undefined;

    public constructor(owner: WorkspaceId) {
        super(owner);
        this.#state = { revision: 0, layers: new Map() };
    }

    public transaction<Result>(
        operation: TransactionOperation<MemorySettingsState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw invalidState("Nested Settings transactions are not supported");
        }
        const draft = cloneState(this.#state);
        this.#active = draft;
        try {
            const result = requireSynchronousRecordResult(operation(draft), "Settings");
            validateState(draft);
            validateCommit(this.#state, draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public loadRevision(transaction: MemorySettingsState): Revision {
        this.requireActive(transaction);
        return new Revision(transaction.revision);
    }

    public saveRevision(transaction: MemorySettingsState, revision: Revision): void {
        this.requireActive(transaction);
        if (revision.value !== transaction.revision + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Settings revision must advance exactly once"
            );
        }
        transaction.revision = revision.value;
    }

    public loadLayer(
        transaction: MemorySettingsState,
        id: SettingsLayerId
    ): SettingsLayer | undefined {
        this.requireActive(transaction);
        const bytes = transaction.layers.get(id.value);
        return bytes === undefined ? undefined : decodeLayer(bytes, id.value);
    }

    public loadLayerAt(
        transaction: MemorySettingsState,
        origin: SettingsLayerOrigin
    ): SettingsLayer | undefined {
        this.requireActive(transaction);
        for (const [key, bytes] of transaction.layers) {
            const layer = decodeLayer(bytes, key);
            if (layer.origin.equals(origin)) return layer;
        }
        return undefined;
    }

    public insertLayer(transaction: MemorySettingsState, layer: SettingsLayer): void {
        this.requireActive(transaction);
        this.requireFreeOrigin(transaction, layer);
        insertImmutable(transaction.layers, layer.id.value, SettingsLayer.encode(layer), "Settings layer");
    }

    public retireLayer(transaction: MemorySettingsState, id: SettingsLayerId): void {
        this.requireActive(transaction);
        if (!transaction.layers.delete(id.value)) {
            throw invalidState(`Settings layer ${id.value} is not stored`);
        }
    }

    public listLayers(transaction: MemorySettingsState): readonly SettingsLayer[] {
        this.requireActive(transaction);
        return Object.freeze(
            orderedRecords(transaction.layers).map(([key, bytes]) => decodeLayer(bytes, key))
        );
    }

    private requireActive(transaction: MemorySettingsState): void {
        if (transaction !== this.#active) {
            throw invalidState("Workspace Settings access requires its active transaction");
        }
    }
}

function cloneState(state: MemorySettingsState): MemorySettingsState {
    return { revision: state.revision, layers: cloneRecordMap(state.layers) };
}

function decodeLayer(bytes: Uint8Array, key: string): SettingsLayer {
    const value = SettingsLayer.decode(bytes);
    if (value.id.value !== key) {
        throw corrupt("Stored Settings layer key does not match codec bytes");
    }
    return value;
}

function validateState(state: MemorySettingsState): void {
    for (const [key, bytes] of state.layers) decodeLayer(bytes, key);
}

/**
 * The revision counts committed write transactions exactly: a transaction that changed the
 * record set advances it once, and one that changed nothing leaves it alone. Comparing the
 * draft against the state it forked from catches a fabricated layer, a fabricated
 * retirement, and a revision bump over an unchanged store.
 */
function validateCommit(before: MemorySettingsState, after: MemorySettingsState): void {
    const changed = !sameRecordMaps(before.layers, after.layers);
    if (after.revision - before.revision !== (changed ? 1 : 0)) {
        throw corrupt("Memory Workspace Settings revision does not match its records");
    }
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
