import type { ActorRef, SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { Revision, type Digest } from "../../src/core";
import type {
    DefinitionPinSet,
    DeploymentId,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    PackagePin,
    RunPinsReservationPort
} from "../../src/definition";
import { LocalMaterializationStore } from "../../src/definition/materializer";
import {
    DeferredManagedRecord,
    ManagedResourcePort,
    ReconciliationDeferral,
    type ManagedResourceChange,
    type ManagedResourceOwner,
    type ManagedResourceSnapshot
} from "../../src/definition/reconciliation";

export interface MemoryManagedResourceState {
    readonly resources: Map<string, ManagedResourceSnapshot>;
}

export class MemoryManagedResourcePort<
    Transaction extends MemoryManagedResourceState
> extends ManagedResourcePort<Transaction> {
    public deferral: (change: ManagedResourceChange) => ReconciliationDeferral = () =>
        ReconciliationDeferral.clear();
    public failAfterMutation = false;

    public get(transaction: Transaction, resourceId: Digest): ManagedResourceSnapshot | undefined {
        return transaction.resources.get(resourceId.value);
    }

    public list(
        transaction: Transaction,
        owner: ManagedResourceOwner
    ): readonly ManagedResourceSnapshot[] {
        return [...transaction.resources.values()].filter(
            (resource) =>
                resource.actor.equals(owner.actor) &&
                resource.tenantId.equals(owner.tenantId) &&
                resource.deploymentId.equals(owner.deploymentId)
        );
    }

    public deferrals(
        _transaction: Transaction,
        change: ManagedResourceChange
    ): ReconciliationDeferral {
        return this.deferral(change);
    }

    public create(transaction: Transaction, desired: ManagedStateRecord): ManagedResourceSnapshot {
        if (transaction.resources.has(desired.resourceId.value)) {
            throw new TypeError("Managed resource already exists");
        }
        const snapshot = snapshotOf(desired, Revision.initial());
        transaction.resources.set(desired.resourceId.value, snapshot);
        this.maybeFail();
        return snapshot;
    }

    public update(
        transaction: Transaction,
        current: ManagedResourceSnapshot,
        desired: ManagedStateRecord
    ): ManagedResourceSnapshot {
        const snapshot = snapshotOf(desired, current.revision.next());
        transaction.resources.set(desired.resourceId.value, snapshot);
        this.maybeFail();
        return snapshot;
    }

    public remove(transaction: Transaction, current: ManagedResourceSnapshot): void {
        transaction.resources.delete(current.resourceId.value);
        this.maybeFail();
    }

    private maybeFail(): void {
        if (this.failAfterMutation) throw new TypeError("injected managed-resource fault");
    }
}

/**
 * The wiring a host performs between SPEC §5.2 pin holders and §9.3 reconciliation: what a
 * change defers on is exactly what the pin-holding planes answer about the release the
 * managed record carries, mapped into pending obligations by the evidence itself.
 */
export class PinHoldingManagedResourcePort<
    Transaction extends MemoryManagedResourceState
> extends MemoryManagedResourcePort<Transaction> {
    public constructor(
        private readonly reservations: RunPinsReservationPort<Transaction>,
        private readonly pins: DefinitionPinSet,
        private readonly release: PackagePin
    ) {
        super();
    }

    public override deferrals(
        transaction: Transaction,
        change: ManagedResourceChange
    ): ReconciliationDeferral {
        return this.reservations
            .removalEvidence(transaction, this.pins)
            .deferral(new DeferredManagedRecord(change), this.release);
    }
}

export interface LocalRecordStoreState extends MemoryManagedResourceState {
    readonly generations: Map<string, MaterializationGeneration>;
    readonly records: Map<string, ManagedStateRecord>;
    readonly pointers: Map<string, MaterializationGenerationPointer>;
}

/** One Actor's materialization journal in memory, with no fault injection of its own. */
export class LocalRecordStore extends LocalMaterializationStore<LocalRecordStoreState> {
    #state: LocalRecordStoreState = {
        generations: new Map(),
        records: new Map(),
        pointers: new Map(),
        resources: new Map()
    };

    public constructor(
        owner: ActorRef,
        public readonly resourcePort: ManagedResourcePort<LocalRecordStoreState>
    ) {
        super(owner);
    }

    public get resources(): readonly ManagedResourceSnapshot[] {
        return [...this.#state.resources.values()];
    }

    public get managedRecords(): readonly ManagedStateRecord[] {
        return [...this.#state.records.values()];
    }

    /** Writes a resource nobody declared, which is the manual edit §9.3 scopes out. */
    public writeManualEdit(snapshot: ManagedResourceSnapshot): void {
        this.#state.resources.set(snapshot.resourceId.value, snapshot);
    }

    public transaction<TResult>(
        operation: TransactionOperation<LocalRecordStoreState, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const draft: LocalRecordStoreState = {
            generations: new Map(this.#state.generations),
            records: new Map(this.#state.records),
            pointers: new Map(this.#state.pointers),
            resources: cloneManagedResources(this.#state.resources)
        };
        const result = operation(draft);
        this.#state = draft;
        return result;
    }

    public loadGeneration(
        transaction: LocalRecordStoreState,
        id: Digest
    ): MaterializationGeneration | undefined {
        return transaction.generations.get(id.value);
    }

    public insertGeneration(
        transaction: LocalRecordStoreState,
        generation: MaterializationGeneration
    ): void {
        transaction.generations.set(generation.id.value, generation);
    }

    public loadManagedState(
        transaction: LocalRecordStoreState,
        id: Digest
    ): ManagedStateRecord | undefined {
        return transaction.records.get(id.value);
    }

    public insertManagedState(
        transaction: LocalRecordStoreState,
        record: ManagedStateRecord
    ): void {
        transaction.records.set(record.id.value, record);
    }

    public loadGenerationPointer(
        transaction: LocalRecordStoreState,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        return transaction.pointers.get(pointerKey(actor, deploymentId));
    }

    public compareAndSetGenerationPointer(
        transaction: LocalRecordStoreState,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        const key = pointerKey(actor, deploymentId);
        const current = transaction.pointers.get(key);
        if (current?.revision.value !== expectedRevision?.value) return false;
        transaction.pointers.set(key, next);
        return true;
    }
}

function pointerKey(actor: ActorRef, deploymentId: DeploymentId): string {
    return `${actor.kind}:${actor.id.value}:${deploymentId.value}`;
}

export function cloneManagedResources(
    resources: ReadonlyMap<string, ManagedResourceSnapshot>
): Map<string, ManagedResourceSnapshot> {
    return new Map(resources);
}

function snapshotOf(desired: ManagedStateRecord, revision: Revision): ManagedResourceSnapshot {
    return Object.freeze({
        actor: desired.actor,
        tenantId: desired.origin.tenantId,
        deploymentId: desired.origin.deploymentId,
        resourceId: desired.resourceId,
        logicalKey: desired.logicalKey,
        recordKind: desired.recordKind,
        desiredDigest: desired.desiredDigest,
        revision
    });
}
