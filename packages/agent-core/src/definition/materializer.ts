import type { ActorRef, SynchronousResultGuard, TransactionOperation } from "../actors";
import type { Digest, Revision } from "../core";
import {
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer
} from "./generation";
import { validateMaterializationKind } from "./materialization-kind";
import { requireRecordedCustody } from "./credential-custody";
import { ActorPlan, MaterializationPlan } from "./plan";
import type { DeploymentId, MaterializationGenerationId } from "./id";
import {
    ManagedResourcePort,
    PendingObligationSet,
    applyReconciliation,
    planReconciliation,
    type AdoptedManagedRecord,
    type ReconciliationAction
} from "./reconciliation";
import { corruptDefinition, definitionRevisionConflict, invalidDefinitionState } from "./error";

export interface LocalMaterialization {
    readonly generation: MaterializationGeneration;
    readonly records: readonly ManagedStateRecord[];
}

export abstract class LocalMaterializationStore<TTransaction> {
    public constructor(public readonly owner: ActorRef) {}

    public abstract transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult;

    public abstract loadGeneration(
        transaction: TTransaction,
        id: MaterializationGenerationId
    ): MaterializationGeneration | undefined;

    public abstract insertGeneration(
        transaction: TTransaction,
        generation: MaterializationGeneration
    ): void;

    public abstract loadManagedState(
        transaction: TTransaction,
        id: Digest
    ): ManagedStateRecord | undefined;

    public abstract insertManagedState(transaction: TTransaction, record: ManagedStateRecord): void;

    public abstract loadGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined;

    public abstract compareAndSetGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean;
}

export interface LocalMaterializerInit<TTransaction> {
    readonly actor: ActorRef;
    readonly store: LocalMaterializationStore<TTransaction>;
    readonly resources: ManagedResourcePort<TTransaction>;
}

export interface LocalMaterializationResult {
    readonly generation: MaterializationGeneration;
    readonly pointer: MaterializationGenerationPointer;
    readonly insertedGeneration: boolean;
    readonly insertedRecords: readonly Digest[];
    readonly pointerChanged: boolean;
    readonly semanticNoop: boolean;
    readonly actions: readonly ReconciliationAction["kind"][];
    /**
     * SPEC §9.3: the deferrals this reconciliation opened, each naming its record, reason,
     * and discharging condition. A Scope is converged exactly when this set is empty, so a
     * caller reads `pending.converged` rather than a second answer stated beside it.
     */
    readonly pending: PendingObligationSet;
}

export class LocalMaterializer<TTransaction> {
    readonly #actor: ActorRef;
    readonly #store: LocalMaterializationStore<TTransaction>;
    readonly #resources: ManagedResourcePort<TTransaction>;

    public constructor(init: LocalMaterializerInit<TTransaction>) {
        this.#actor = init.actor;
        this.#store = init.store;
        this.#resources = init.resources;
        if (!init.store.owner.equals(init.actor)) {
            throw new TypeError("Local materialization store belongs to a different Actor");
        }
    }

    public materialize(plan: ActorPlan | MaterializationPlan): LocalMaterialization {
        const canonical =
            plan instanceof MaterializationPlan
                ? MaterializationPlan.decode(MaterializationPlan.encode(plan))
                : ActorPlan.decode(ActorPlan.encode(plan));
        return materializeActorPlan(this.#actor, requireLocalActorPlan(canonical));
    }

    /**
     * SPEC §9.3: `adoptions` are the manual edits an operator explicitly adopts. Adoption
     * is admissible only as a change to the Blueprint, so each one names a record this
     * plan declares; an adoption no declaration covers is rejected rather than marked
     * Blueprint-managed.
     */
    public apply(
        plan: ActorPlan | MaterializationPlan,
        adoptions: readonly AdoptedManagedRecord[] = []
    ): LocalMaterializationResult {
        return this.#store.transaction((transaction) =>
            this.applyInTransaction(transaction, plan, adoptions)
        );
    }

    public applyInTransaction(
        transaction: TTransaction,
        plan: ActorPlan | MaterializationPlan,
        adoptions: readonly AdoptedManagedRecord[] = []
    ): LocalMaterializationResult {
        return this.applyTransaction(transaction, this.materialize(plan), adoptions);
    }

    private applyTransaction(
        transaction: TTransaction,
        desired: LocalMaterialization,
        adoptions: readonly AdoptedManagedRecord[]
    ): LocalMaterializationResult {
        const current = this.#store.loadGenerationPointer(
            transaction,
            this.#actor,
            desired.generation.origin.deploymentId
        );
        if (current !== undefined) requirePointerActor(current, this.#actor);
        const previousGeneration =
            current === undefined
                ? undefined
                : requireStored(
                      this.#store.loadGeneration(transaction, current.generationId),
                      `active materialization generation ${current.generationId.value}`
                  );
        if (previousGeneration !== undefined && !previousGeneration.actor.equals(this.#actor)) {
            throw corruptDefinition(
                "Active materialization generation belongs to a different Actor"
            );
        }
        const previousRecords =
            previousGeneration === undefined
                ? []
                : previousGeneration.managedRecordIds.map((id) =>
                      requireStored(
                          this.#store.loadManagedState(transaction, id),
                          `managed state ${id.value}`
                      )
                  );
        const reconciliation = planReconciliation(
            transaction,
            this.#resources,
            {
                actor: this.#actor,
                tenantId: desired.generation.origin.tenantId,
                deploymentId: desired.generation.origin.deploymentId
            },
            previousRecords,
            desired.records,
            adoptions
        );
        if (!reconciliation.converged) {
            const activePointer = requireStored(
                current,
                "active pointer for blocked reconciliation"
            );
            const activeGeneration = requireStored(
                previousGeneration,
                "active generation for blocked reconciliation"
            );
            return freezeResult({
                generation: activeGeneration,
                pointer: activePointer,
                insertedGeneration: false,
                insertedRecords: [],
                pointerChanged: false,
                semanticNoop: false,
                actions: reconciliation.actions.map((action) => action.kind),
                pending: reconciliation.pending
            });
        }
        const semanticNoop =
            current !== undefined &&
            reconciliation.actions.every((action) => action.kind === "noop") &&
            previousRecords.length === desired.records.length;
        if (semanticNoop && current.generationId.equals(desired.generation.id)) {
            return freezeResult({
                generation: previousGeneration!,
                pointer: current,
                insertedGeneration: false,
                insertedRecords: [],
                pointerChanged: false,
                semanticNoop: true,
                actions: reconciliation.actions.map((action) => action.kind),
                pending: PendingObligationSet.empty
            });
        }
        applyReconciliation(transaction, this.#resources, reconciliation);
        if (
            current?.generationId.equals(desired.generation.id) !== true &&
            previousGeneration !== undefined &&
            desired.generation.origin.generation <= previousGeneration.origin.generation
        ) {
            throw definitionRevisionConflict("Materialization generation must strictly increase");
        }

        const insertedRecords: Digest[] = [];
        for (const record of desired.records) {
            const existing = this.#store.loadManagedState(transaction, record.id);
            if (existing !== undefined) {
                requireEqualRecord(existing, record);
                continue;
            }
            this.#store.insertManagedState(transaction, record);
            requireEqualRecord(
                requireStored(
                    this.#store.loadManagedState(transaction, record.id),
                    `managed state ${record.id.value}`
                ),
                record
            );
            insertedRecords.push(record.id);
        }

        const existingGeneration = this.#store.loadGeneration(transaction, desired.generation.id);
        let insertedGeneration = false;
        if (existingGeneration === undefined) {
            this.#store.insertGeneration(transaction, desired.generation);
            requireEqualGeneration(
                requireStored(
                    this.#store.loadGeneration(transaction, desired.generation.id),
                    `materialization generation ${desired.generation.id.value}`
                ),
                desired.generation
            );
            insertedGeneration = true;
        } else {
            requireEqualGeneration(existingGeneration, desired.generation);
        }

        const pointer =
            current === undefined
                ? MaterializationGenerationPointer.initial(
                      this.#actor,
                      desired.generation.origin.deploymentId,
                      desired.generation.id
                  )
                : current.activate(desired.generation.id);
        if (
            !this.#store.compareAndSetGenerationPointer(
                transaction,
                this.#actor,
                desired.generation.origin.deploymentId,
                current?.revision,
                pointer
            )
        ) {
            throw definitionRevisionConflict(
                "Active materialization generation changed concurrently"
            );
        }
        const storedPointer = requireStored(
            this.#store.loadGenerationPointer(
                transaction,
                this.#actor,
                desired.generation.origin.deploymentId
            ),
            "active materialization generation pointer"
        );
        requireEqualPointer(storedPointer, pointer);
        return freezeResult({
            generation: desired.generation,
            pointer,
            insertedGeneration,
            insertedRecords,
            pointerChanged: true,
            semanticNoop,
            actions: reconciliation.actions.map((action) => action.kind),
            pending: PendingObligationSet.empty
        });
    }
}

export function materializeActorPlan(actor: ActorRef, plan: ActorPlan): LocalMaterialization {
    const canonical = ActorPlan.decode(ActorPlan.encode(plan));
    if (!canonical.actor.equals(actor)) {
        throw invalidDefinitionState("Actor plan target must exactly equal the owning Actor");
    }
    for (const projection of canonical.projections) {
        validateMaterializationKind(projection.recordKind, projection.desired);
    }
    const generation = MaterializationGeneration.fromActorPlan(canonical);
    const records = canonical.projections.map((projection) =>
        ManagedStateRecord.fromProjection(actor, canonical.origin, generation.id, projection)
    );
    // §3.5: whatever records custody checks it, so an Environment declaration that names
    // another Tenant's SecretRef is refused where it is written into managed state.
    for (const record of records) requireRecordedCustody(record);
    return Object.freeze({
        generation,
        records: Object.freeze(records)
    });
}

function requireLocalActorPlan(plan: ActorPlan | MaterializationPlan): ActorPlan {
    if (plan instanceof ActorPlan) return plan;
    if (plan.actors.length !== 1) {
        throw invalidDefinitionState(
            "Local materialization rejects multi-Actor materialization plans"
        );
    }
    return plan.actors[0]!;
}

function requireEqualRecord(actual: ManagedStateRecord, expected: ManagedStateRecord): void {
    if (
        !actual.id.equals(expected.id) ||
        !equalBytes(ManagedStateRecord.encode(actual), ManagedStateRecord.encode(expected))
    ) {
        throw corruptDefinition(`Managed state ${expected.id.value} is immutable`);
    }
}

function requireEqualGeneration(
    actual: MaterializationGeneration,
    expected: MaterializationGeneration
): void {
    if (
        !actual.id.equals(expected.id) ||
        !equalBytes(
            MaterializationGeneration.encode(actual),
            MaterializationGeneration.encode(expected)
        )
    ) {
        throw corruptDefinition(`Materialization generation ${expected.id.value} is immutable`);
    }
}

function requireEqualPointer(
    actual: MaterializationGenerationPointer,
    expected: MaterializationGenerationPointer
): void {
    if (
        !equalBytes(
            MaterializationGenerationPointer.encode(actual),
            MaterializationGenerationPointer.encode(expected)
        )
    ) {
        throw corruptDefinition("Active materialization generation pointer CAS did not persist");
    }
}

function requirePointerActor(pointer: MaterializationGenerationPointer, actor: ActorRef): void {
    if (!pointer.actor.equals(actor)) {
        throw corruptDefinition("Materialization generation pointer belongs to a different Actor");
    }
}

function requireStored<T>(value: T | undefined, subject: string): T {
    if (value === undefined) {
        throw corruptDefinition(`Missing ${subject}`);
    }
    return value;
}

function freezeResult(result: LocalMaterializationResult): LocalMaterializationResult {
    return Object.freeze({
        ...result,
        insertedRecords: Object.freeze([...result.insertedRecords]),
        actions: Object.freeze([...result.actions])
    });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
