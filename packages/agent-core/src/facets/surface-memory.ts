import { type TransactionOperation, type SynchronousResultGuard } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import type { SurfaceId } from "./id";
import {
    cloneRecordMap,
    insertImmutable,
    orderedRecords,
    requireSynchronousRecordResult,
    sameRecordMaps,
    type RecordMap
} from "./record-map";
import { SurfaceRegistration } from "./surface";
import { WorkspaceSurfaceStore } from "./surface-store";

interface MemorySurfaceState {
    revision: number;
    registrations: RecordMap;
}

export class MemoryWorkspaceSurfaceStore extends WorkspaceSurfaceStore<MemorySurfaceState> {
    #state: MemorySurfaceState;
    #active: MemorySurfaceState | undefined;

    public constructor(owner: WorkspaceId) {
        super(owner);
        this.#state = { revision: 0, registrations: new Map() };
    }

    public transaction<Result>(
        operation: TransactionOperation<MemorySurfaceState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw invalidState("Nested Surface transactions are not supported");
        }
        const draft = cloneState(this.#state);
        this.#active = draft;
        try {
            const result = requireSynchronousRecordResult(operation(draft), "Surface");
            validateState(draft);
            validateCommit(this.#state, draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public loadRevision(transaction: MemorySurfaceState): Revision {
        this.requireActive(transaction);
        return new Revision(transaction.revision);
    }

    public saveRevision(transaction: MemorySurfaceState, revision: Revision): void {
        this.requireActive(transaction);
        if (revision.value !== transaction.revision + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace Surface revision must advance exactly once"
            );
        }
        transaction.revision = revision.value;
    }

    public loadRegistration(
        transaction: MemorySurfaceState,
        surface: SurfaceId
    ): SurfaceRegistration | undefined {
        this.requireActive(transaction);
        const bytes = transaction.registrations.get(surface.value);
        return bytes === undefined ? undefined : decodeRegistration(bytes, surface.value);
    }

    public insertRegistration(
        transaction: MemorySurfaceState,
        registration: SurfaceRegistration
    ): void {
        this.requireActive(transaction);
        this.requireUnclaimedSurface(transaction, registration);
        insertImmutable(
            transaction.registrations,
            registration.descriptor.id.value,
            SurfaceRegistration.encode(registration),
            "Surface registration"
        );
    }

    public retireRegistration(transaction: MemorySurfaceState, surface: SurfaceId): void {
        this.requireActive(transaction);
        if (!transaction.registrations.delete(surface.value)) {
            throw invalidState(`Surface ${surface.value} is not registered`);
        }
    }

    public listRegistrations(transaction: MemorySurfaceState): readonly SurfaceRegistration[] {
        this.requireActive(transaction);
        return Object.freeze(
            orderedRecords(transaction.registrations).map(([key, bytes]) =>
                decodeRegistration(bytes, key)
            )
        );
    }

    private requireActive(transaction: MemorySurfaceState): void {
        if (transaction !== this.#active) {
            throw invalidState("Workspace Surface access requires its active transaction");
        }
    }
}

function cloneState(state: MemorySurfaceState): MemorySurfaceState {
    return { revision: state.revision, registrations: cloneRecordMap(state.registrations) };
}

function decodeRegistration(bytes: Uint8Array, key: string): SurfaceRegistration {
    const value = SurfaceRegistration.decode(bytes);
    if (value.descriptor.id.value !== key) {
        throw corrupt("Stored Surface registration key does not match codec bytes");
    }
    return value;
}

function validateState(state: MemorySurfaceState): void {
    for (const [key, bytes] of state.registrations) decodeRegistration(bytes, key);
}

/**
 * The revision counts committed write transactions exactly: a transaction that changed the
 * record set advances it once, and one that changed nothing leaves it alone. Comparing the
 * draft against the state it forked from catches a fabricated registration, a fabricated
 * retirement, and a revision bump over an unchanged store.
 */
function validateCommit(before: MemorySurfaceState, after: MemorySurfaceState): void {
    const changed = !sameRecordMaps(before.registrations, after.registrations);
    if (after.revision - before.revision !== (changed ? 1 : 0)) {
        throw corrupt("Memory Workspace Surface revision does not match its records");
    }
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
