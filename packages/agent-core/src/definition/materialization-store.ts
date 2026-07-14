import { ActorId, type ActorRef } from "../actors";
import { Digest, Revision, SemVer } from "../core";
import { AgentCoreError } from "../errors";
import { Blueprint } from "./blueprint";
import {
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer
} from "./generation";
import { LocalMaterializationStore } from "./materializer";
import { MaterializationPlan } from "./plan";
import { DeploymentId, MaterializationGenerationId } from "./id";
import { compareText } from "./order";
import { definitionRevisionConflict, invalidDefinitionState } from "./error";

export interface StoredBlueprint {
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly bytes: Uint8Array;
}

export interface StoredMaterializationPlan {
    readonly id: string;
    readonly blueprintDigest: string;
    readonly packageLockDigest: string;
    readonly configDigest: string;
    readonly generation: number;
    readonly bytes: Uint8Array;
}

export interface StoredMaterializationGeneration {
    readonly id: MaterializationGenerationId;
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly blueprintDigest: string;
    readonly packageLockDigest: string;
    readonly configDigest: string;
    readonly generation: number;
    readonly bytes: Uint8Array;
}

export interface StoredManagedStateRecord {
    readonly id: string;
    readonly generationId: MaterializationGenerationId;
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desiredDigest: string;
    readonly bytes: Uint8Array;
}

export interface StoredMaterializationGenerationPointer {
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly deploymentId: DeploymentId["value"];
    readonly generationId: MaterializationGenerationId;
    readonly revision: number;
    readonly bytes: Uint8Array;
}

export abstract class MaterializationStore<
    TTransaction
> extends LocalMaterializationStore<TTransaction> {
    public constructor(owner: ActorRef) {
        super(owner);
    }

    public addBlueprint(blueprint: Blueprint): void {
        requireTenantControl(this.owner, "Blueprint");
        this.transaction((transaction) => {
            const bytes = Blueprint.encode(blueprint);
            const canonical = Blueprint.decode(bytes);
            const candidate = projectBlueprint(canonical, bytes);
            const stored = this.writeBlueprint(transaction, candidate);
            this.decodeBlueprint(stored, canonical.meta.name, canonical.meta.version);
            requireEqualImmutable(stored.bytes, bytes, `Blueprint ${blueprintKey(candidate)}`);
        });
    }

    public getBlueprint(name: string, version: SemVer): Blueprint | undefined {
        requireTenantControl(this.owner, "Blueprint");
        return this.transaction((transaction) => {
            const stored = this.findBlueprint(transaction, name, version.toString());
            return stored === undefined ? undefined : this.decodeBlueprint(stored, name, version);
        });
    }

    public listBlueprints(name?: string): readonly Blueprint[] {
        requireTenantControl(this.owner, "Blueprint");
        return this.transaction((transaction) => {
            const blueprints = this.blueprintRecords(transaction, name)
                .map((stored) => this.decodeBlueprint(stored, name))
                .sort(compareBlueprints);
            requireUnique(
                blueprints.map((blueprint) =>
                    blueprintKey(projectBlueprint(blueprint, Blueprint.encode(blueprint)))
                ),
                "Stored Blueprints contain a duplicate immutable key"
            );
            return Object.freeze(blueprints);
        });
    }

    public addPlan(plan: MaterializationPlan): void {
        requireTenantControl(this.owner, "Materialization plan");
        this.transaction((transaction) => this.insertPlan(transaction, plan));
    }

    public getPlan(id: Digest): MaterializationPlan | undefined {
        requireTenantControl(this.owner, "Materialization plan");
        return this.transaction((transaction) => {
            const plan = this.loadPlan(transaction, id);
            if (plan !== undefined) requireOwnedPlan(plan, this.owner);
            return plan;
        });
    }

    public listPlans(): readonly MaterializationPlan[] {
        requireTenantControl(this.owner, "Materialization plan");
        return this.transaction((transaction) => {
            const plans = this.planRecords(transaction)
                .map((stored) => this.decodePlan(stored))
                .sort((left, right) => compareText(left.id.value, right.id.value));
            requireUnique(
                plans.map((plan) => plan.id.value),
                "Stored materialization plans contain a duplicate immutable key"
            );
            for (const plan of plans) requireOwnedPlan(plan, this.owner);
            return Object.freeze(plans);
        });
    }

    public addGeneration(generation: MaterializationGeneration): void {
        this.transaction((transaction) => this.insertGeneration(transaction, generation));
    }

    public getGeneration(id: MaterializationGenerationId): MaterializationGeneration | undefined {
        return this.transaction((transaction) => this.loadGeneration(transaction, id));
    }

    public listGenerations(actor?: ActorRef): readonly MaterializationGeneration[] {
        if (actor !== undefined) requireOwnedActor(actor, this.owner, "Generation query");
        return this.transaction((transaction) => {
            const generations = this.generationRecords(transaction)
                .map((stored) => this.decodeGeneration(transaction, stored))
                .sort(compareGenerations);
            requireUnique(
                generations.map((generation) => generation.id.value),
                "Stored materialization generations contain a duplicate immutable key"
            );
            for (const generation of generations) {
                requireOwnedActor(
                    generation.actor,
                    this.owner,
                    "Stored materialization generation"
                );
            }
            return Object.freeze(generations);
        });
    }

    public addManagedState(record: ManagedStateRecord): void {
        const canonical = ManagedStateRecord.decode(ManagedStateRecord.encode(record));
        this.transaction((transaction) => {
            this.insertManagedState(transaction, canonical);
            const generation = this.loadGeneration(transaction, canonical.generationId);
            if (
                generation === undefined ||
                !generation.managedRecordIds.some((id) => id.equals(canonical.id))
            ) {
                throw invalidDefinitionState(
                    "Standalone managed state must belong to a stored generation"
                );
            }
        });
    }

    public getManagedState(id: Digest): ManagedStateRecord | undefined {
        return this.transaction((transaction) => this.loadManagedState(transaction, id));
    }

    public listManagedState(
        generationId?: MaterializationGenerationId
    ): readonly ManagedStateRecord[] {
        return this.transaction((transaction) => {
            const records = this.managedStateRecords(transaction, generationId)
                .map((stored) => this.decodeManagedState(stored))
                .sort(compareManagedState);
            requireUnique(
                records.map((record) => record.id.value),
                "Stored managed state contains a duplicate immutable key"
            );
            for (const record of records) {
                requireOwnedActor(record.actor, this.owner, "Stored managed state");
            }
            return Object.freeze(records);
        });
    }

    public getGenerationPointer(
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        requireOwnedActor(actor, this.owner, "Generation pointer query");
        return this.transaction((transaction) =>
            this.loadGenerationPointer(transaction, actor, deploymentId)
        );
    }

    public listGenerationPointers(): readonly MaterializationGenerationPointer[] {
        return this.transaction((transaction) => {
            const pointers = this.generationPointerRecords(transaction)
                .map((stored) => this.decodeGenerationPointer(transaction, stored))
                .sort((left, right) => compareActors(left.actor, right.actor));
            requireUnique(
                pointers.map((pointer) => pointerKey(pointer.actor, pointer.deploymentId)),
                "Stored materialization generation pointers contain a duplicate Actor key"
            );
            for (const pointer of pointers) {
                requireOwnedActor(pointer.actor, this.owner, "Stored generation pointer");
            }
            return Object.freeze(pointers);
        });
    }

    public loadGeneration(
        transaction: TTransaction,
        id: MaterializationGenerationId
    ): MaterializationGeneration | undefined {
        const stored = this.findGeneration(transaction, id);
        if (stored === undefined) return undefined;
        const generation = this.decodeGeneration(transaction, stored);
        if (!generation.id.equals(id)) {
            throw corruptMaterialization("Stored generation key does not match its codec bytes");
        }
        requireOwnedActor(generation.actor, this.owner, "Stored materialization generation");
        return generation;
    }

    public insertGeneration(
        transaction: TTransaction,
        generation: MaterializationGeneration
    ): void {
        const bytes = MaterializationGeneration.encode(generation);
        const canonical = MaterializationGeneration.decode(bytes);
        requireOwnedActor(canonical.actor, this.owner, "Materialization generation");
        const existing = this.findGeneration(transaction, canonical.id);
        if (existing !== undefined && !equalBytes(existing.bytes, bytes)) {
            throw invalidDefinitionState(
                `Materialization generation ${canonical.id.value} is immutable`
            );
        }
        const ordinalConflict = this.generationRecords(transaction, canonical.actor)
            .map((stored) => this.decodeGeneration(transaction, stored))
            .find(
                (generation) =>
                    generation.origin.deploymentId.equals(canonical.origin.deploymentId) &&
                    generation.origin.generation === canonical.origin.generation &&
                    !generation.id.equals(canonical.id)
            );
        if (ordinalConflict !== undefined) {
            throw invalidDefinitionState(
                `Materialization generation ${canonical.origin.generation} is immutable per deployment`
            );
        }
        this.requireGenerationRecords(transaction, canonical);
        const stored = this.writeGeneration(transaction, projectGeneration(canonical, bytes));
        this.decodeGeneration(transaction, stored);
        requireEqualImmutable(
            stored.bytes,
            bytes,
            `Materialization generation ${canonical.id.value}`
        );
    }

    public loadManagedState(transaction: TTransaction, id: Digest): ManagedStateRecord | undefined {
        const stored = this.findManagedState(transaction, id.value);
        if (stored === undefined) return undefined;
        const record = this.decodeManagedState(stored);
        if (!record.id.equals(id)) {
            throw corruptMaterialization("Stored managed-state key does not match its codec bytes");
        }
        requireOwnedActor(record.actor, this.owner, "Stored managed state");
        return record;
    }

    public insertManagedState(transaction: TTransaction, record: ManagedStateRecord): void {
        const bytes = ManagedStateRecord.encode(record);
        const canonical = ManagedStateRecord.decode(bytes);
        requireOwnedActor(canonical.actor, this.owner, "Managed state");
        const generation = this.findGeneration(transaction, canonical.generationId);
        if (generation !== undefined) {
            const decoded = this.decodeGeneration(transaction, generation);
            if (!decoded.managedRecordIds.some((id) => id.equals(canonical.id))) {
                throw invalidDefinitionState(
                    `Materialization generation ${canonical.generationId.value} is immutable`
                );
            }
        }
        const conflict = this.managedStateRecords(transaction, canonical.generationId).find(
            (stored) =>
                stored.logicalKey === canonical.logicalKey && stored.id !== canonical.id.value
        );
        if (conflict !== undefined) {
            throw invalidDefinitionState(
                `Managed state logical key ${canonical.logicalKey} is immutable per generation`
            );
        }
        const stored = this.writeManagedState(transaction, projectManagedState(canonical, bytes));
        this.decodeManagedState(stored);
        requireEqualImmutable(stored.bytes, bytes, `Managed state ${canonical.id.value}`);
    }

    public loadGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        requireOwnedActor(actor, this.owner, "Generation pointer query");
        const stored = this.findGenerationPointer(transaction, actor, deploymentId);
        if (stored === undefined) return undefined;
        const pointer = this.decodeGenerationPointer(transaction, stored);
        if (!pointer.actor.equals(actor) || !pointer.deploymentId.equals(deploymentId)) {
            throw corruptMaterialization(
                "Stored generation pointer key does not match its codec bytes"
            );
        }
        requireOwnedActor(pointer.actor, this.owner, "Stored generation pointer");
        return pointer;
    }

    public compareAndSetGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        requireOwnedActor(actor, this.owner, "Generation pointer");
        const bytes = MaterializationGenerationPointer.encode(next);
        const canonical = MaterializationGenerationPointer.decode(bytes);
        if (!canonical.actor.equals(actor) || !canonical.deploymentId.equals(deploymentId)) {
            throw invalidDefinitionState(
                "Materialization generation pointer belongs to a different Actor"
            );
        }
        const current = this.loadGenerationPointer(transaction, actor, deploymentId);
        const matches =
            expectedRevision === undefined
                ? current === undefined
                : current?.revision.equals(expectedRevision) === true;
        if (!matches) return false;

        const requiredRevision =
            expectedRevision === undefined ? Revision.initial() : expectedRevision.next();
        if (!canonical.revision.equals(requiredRevision)) {
            throw definitionRevisionConflict(
                "Materialization generation pointer must advance exactly one revision"
            );
        }
        const generation = this.loadGeneration(transaction, canonical.generationId);
        if (
            generation === undefined ||
            !generation.actor.equals(actor) ||
            !generation.origin.deploymentId.equals(deploymentId)
        ) {
            throw invalidDefinitionState(
                "Materialization generation pointer must target a stored generation"
            );
        }
        if (current !== undefined) {
            const currentGeneration = this.loadGeneration(transaction, current.generationId);
            if (
                currentGeneration === undefined ||
                generation.origin.generation <= currentGeneration.origin.generation
            ) {
                throw definitionRevisionConflict(
                    "Materialization generation pointer must strictly increase generation"
                );
            }
        }
        const stored = projectGenerationPointer(canonical, bytes);
        if (!this.writeGenerationPointer(transaction, expectedRevision, stored)) return false;
        const persisted = this.loadGenerationPointer(transaction, actor, deploymentId);
        if (
            persisted === undefined ||
            !equalBytes(MaterializationGenerationPointer.encode(persisted), bytes)
        ) {
            throw corruptMaterialization("Generation pointer CAS did not persist its codec bytes");
        }
        return true;
    }

    protected abstract findBlueprint(
        transaction: TTransaction,
        name: string,
        version: string
    ): StoredBlueprint | undefined;

    protected abstract blueprintRecords(
        transaction: TTransaction,
        name?: string
    ): readonly StoredBlueprint[];

    protected abstract writeBlueprint(
        transaction: TTransaction,
        blueprint: StoredBlueprint
    ): StoredBlueprint;

    protected abstract findPlan(
        transaction: TTransaction,
        id: string
    ): StoredMaterializationPlan | undefined;

    protected abstract planRecords(transaction: TTransaction): readonly StoredMaterializationPlan[];

    protected abstract writePlan(
        transaction: TTransaction,
        plan: StoredMaterializationPlan
    ): StoredMaterializationPlan;

    protected abstract findGeneration(
        transaction: TTransaction,
        id: MaterializationGenerationId
    ): StoredMaterializationGeneration | undefined;

    protected abstract generationRecords(
        transaction: TTransaction,
        actor?: ActorRef
    ): readonly StoredMaterializationGeneration[];

    protected abstract writeGeneration(
        transaction: TTransaction,
        generation: StoredMaterializationGeneration
    ): StoredMaterializationGeneration;

    protected abstract findManagedState(
        transaction: TTransaction,
        id: string
    ): StoredManagedStateRecord | undefined;

    protected abstract managedStateRecords(
        transaction: TTransaction,
        generationId?: MaterializationGenerationId
    ): readonly StoredManagedStateRecord[];

    protected abstract writeManagedState(
        transaction: TTransaction,
        record: StoredManagedStateRecord
    ): StoredManagedStateRecord;

    protected abstract findGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): StoredMaterializationGenerationPointer | undefined;

    protected abstract generationPointerRecords(
        transaction: TTransaction
    ): readonly StoredMaterializationGenerationPointer[];

    protected abstract writeGenerationPointer(
        transaction: TTransaction,
        expectedRevision: Revision | undefined,
        pointer: StoredMaterializationGenerationPointer
    ): boolean;

    private insertPlan(transaction: TTransaction, plan: MaterializationPlan): void {
        const bytes = MaterializationPlan.encode(plan);
        const canonical = MaterializationPlan.decode(bytes);
        requireOwnedPlan(canonical, this.owner);
        const stored = this.writePlan(transaction, projectPlan(canonical, bytes));
        this.decodePlan(stored);
        requireEqualImmutable(stored.bytes, bytes, `Materialization plan ${canonical.id.value}`);
    }

    private loadPlan(transaction: TTransaction, id: Digest): MaterializationPlan | undefined {
        const stored = this.findPlan(transaction, id.value);
        if (stored === undefined) return undefined;
        const plan = this.decodePlan(stored);
        if (!plan.id.equals(id)) {
            throw corruptMaterialization(
                "Stored materialization-plan key does not match codec bytes"
            );
        }
        return plan;
    }

    private decodeBlueprint(
        stored: StoredBlueprint,
        expectedName?: string,
        expectedVersion?: SemVer
    ): Blueprint {
        const bytes = copyBytes(stored.bytes, "Blueprint");
        const blueprint = Blueprint.decode(bytes);
        const projection = projectBlueprint(blueprint, bytes);
        if (
            stored.name !== projection.name ||
            stored.version !== projection.version ||
            stored.digest !== projection.digest ||
            (expectedName !== undefined && blueprint.meta.name !== expectedName) ||
            (expectedVersion !== undefined &&
                blueprint.meta.version.toString() !== expectedVersion.toString())
        ) {
            throw corruptMaterialization(
                "Stored Blueprint key or projection does not match codec bytes"
            );
        }
        return blueprint;
    }

    private decodePlan(stored: StoredMaterializationPlan): MaterializationPlan {
        const bytes = copyBytes(stored.bytes, "materialization plan");
        const plan = MaterializationPlan.decode(bytes);
        const projection = projectPlan(plan, bytes);
        if (!equalPlanProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored materialization-plan key or projection does not match codec bytes"
            );
        }
        return plan;
    }

    private decodeGeneration(
        transaction: TTransaction,
        stored: StoredMaterializationGeneration
    ): MaterializationGeneration {
        const bytes = copyBytes(stored.bytes, "materialization generation");
        const generation = MaterializationGeneration.decode(bytes);
        const projection = projectGeneration(generation, bytes);
        if (!equalGenerationProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored generation key or projection does not match codec bytes"
            );
        }
        this.requireGenerationRecords(transaction, generation);
        return generation;
    }

    private decodeManagedState(stored: StoredManagedStateRecord): ManagedStateRecord {
        const bytes = copyBytes(stored.bytes, "managed state");
        const record = ManagedStateRecord.decode(bytes);
        const projection = projectManagedState(record, bytes);
        if (!equalManagedStateProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored managed-state key or projection does not match codec bytes"
            );
        }
        return record;
    }

    private decodeGenerationPointer(
        transaction: TTransaction,
        stored: StoredMaterializationGenerationPointer
    ): MaterializationGenerationPointer {
        const bytes = copyBytes(stored.bytes, "generation pointer");
        const pointer = MaterializationGenerationPointer.decode(bytes);
        const projection = projectGenerationPointer(pointer, bytes);
        if (!equalGenerationPointerProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored generation-pointer projection does not match codec bytes"
            );
        }
        const generation = this.loadGeneration(transaction, pointer.generationId);
        if (
            generation === undefined ||
            !generation.actor.equals(pointer.actor) ||
            !generation.origin.deploymentId.equals(pointer.deploymentId)
        ) {
            throw corruptMaterialization(
                "Stored generation pointer targets missing or foreign state"
            );
        }
        return pointer;
    }

    private requireGenerationRecords(
        transaction: TTransaction,
        generation: MaterializationGeneration
    ): void {
        const records = this.managedStateRecords(transaction, generation.id).map((stored) =>
            this.decodeManagedState(stored)
        );
        const expectedIds = new Set(generation.managedRecordIds.map((id) => id.value));
        if (
            records.length !== expectedIds.size ||
            records.some((record) => !expectedIds.has(record.id.value))
        ) {
            throw corruptMaterialization(
                "Materialization generation closure does not match managed state"
            );
        }
        const logicalKeys = new Set<string>();
        for (const record of records) {
            if (
                !record.generationId.equals(generation.id) ||
                !record.actor.equals(generation.actor)
            ) {
                throw corruptMaterialization(
                    "Managed state does not belong to its materialization generation"
                );
            }
            if (logicalKeys.has(record.logicalKey)) {
                throw corruptMaterialization(
                    "Materialization generation contains conflicting logical keys"
                );
            }
            logicalKeys.add(record.logicalKey);
        }
    }

    protected requireCompleteMaterializationClosure(): void {
        this.transaction((transaction) => {
            for (const stored of this.managedStateRecords(transaction)) {
                const record = this.decodeManagedState(stored);
                const generation = this.loadGeneration(transaction, record.generationId);
                if (
                    generation === undefined ||
                    !generation.managedRecordIds.some((id) => id.equals(record.id))
                ) {
                    throw corruptMaterialization(
                        "Managed state is not referenced by its generation"
                    );
                }
            }
        });
    }
}

function projectBlueprint(blueprint: Blueprint, bytes: Uint8Array): StoredBlueprint {
    return {
        name: blueprint.meta.name,
        version: blueprint.meta.version.toString(),
        digest: Digest.sha256(bytes).value,
        bytes: bytes.slice()
    };
}

function projectPlan(plan: MaterializationPlan, bytes: Uint8Array): StoredMaterializationPlan {
    return {
        id: plan.id.value,
        blueprintDigest: plan.blueprintDigest.value,
        packageLockDigest: plan.packageLockDigest.value,
        configDigest: plan.configDigest.value,
        generation: plan.generation,
        bytes: bytes.slice()
    };
}

function projectGeneration(
    generation: MaterializationGeneration,
    bytes: Uint8Array
): StoredMaterializationGeneration {
    return {
        id: generation.id,
        actorKind: generation.actor.kind,
        actorId: new ActorId(generation.actor.id.value),
        blueprintDigest: generation.origin.blueprintDigest.value,
        packageLockDigest: generation.origin.packageLockDigest.value,
        configDigest: generation.origin.configDigest.value,
        generation: generation.origin.generation,
        bytes: bytes.slice()
    };
}

function projectManagedState(
    record: ManagedStateRecord,
    bytes: Uint8Array
): StoredManagedStateRecord {
    return {
        id: record.id.value,
        generationId: record.generationId,
        actorKind: record.actor.kind,
        actorId: new ActorId(record.actor.id.value),
        logicalKey: record.logicalKey,
        recordKind: record.recordKind,
        desiredDigest: record.desiredDigest.value,
        bytes: bytes.slice()
    };
}

function projectGenerationPointer(
    pointer: MaterializationGenerationPointer,
    bytes: Uint8Array
): StoredMaterializationGenerationPointer {
    return {
        actorKind: pointer.actor.kind,
        actorId: new ActorId(pointer.actor.id.value),
        deploymentId: pointer.deploymentId.value,
        generationId: pointer.generationId,
        revision: pointer.revision.value,
        bytes: bytes.slice()
    };
}

function equalPlanProjection(
    left: StoredMaterializationPlan,
    right: StoredMaterializationPlan
): boolean {
    return (
        left.id === right.id &&
        left.blueprintDigest === right.blueprintDigest &&
        left.packageLockDigest === right.packageLockDigest &&
        left.configDigest === right.configDigest &&
        left.generation === right.generation
    );
}

function equalGenerationProjection(
    left: StoredMaterializationGeneration,
    right: StoredMaterializationGeneration
): boolean {
    return (
        left.id.equals(right.id) &&
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.blueprintDigest === right.blueprintDigest &&
        left.packageLockDigest === right.packageLockDigest &&
        left.configDigest === right.configDigest &&
        left.generation === right.generation
    );
}

function equalManagedStateProjection(
    left: StoredManagedStateRecord,
    right: StoredManagedStateRecord
): boolean {
    return (
        left.id === right.id &&
        left.generationId.equals(right.generationId) &&
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.logicalKey === right.logicalKey &&
        left.recordKind === right.recordKind &&
        left.desiredDigest === right.desiredDigest
    );
}

function equalGenerationPointerProjection(
    left: StoredMaterializationGenerationPointer,
    right: StoredMaterializationGenerationPointer
): boolean {
    return (
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.deploymentId === right.deploymentId &&
        left.generationId.equals(right.generationId) &&
        left.revision === right.revision
    );
}

function compareBlueprints(left: Blueprint, right: Blueprint): number {
    return (
        compareText(left.meta.name, right.meta.name) ||
        compareText(left.meta.version.toString(), right.meta.version.toString())
    );
}

function compareGenerations(
    left: MaterializationGeneration,
    right: MaterializationGeneration
): number {
    return compareActors(left.actor, right.actor) || compareText(left.id.value, right.id.value);
}

function compareManagedState(left: ManagedStateRecord, right: ManagedStateRecord): number {
    return (
        compareText(left.generationId.value, right.generationId.value) ||
        compareText(left.logicalKey, right.logicalKey) ||
        compareText(left.id.value, right.id.value)
    );
}

function compareActors(left: ActorRef, right: ActorRef): number {
    return compareText(left.kind, right.kind) || compareText(left.id.value, right.id.value);
}

function pointerKey(actor: ActorRef, deploymentId: DeploymentId): string {
    return `${actor.kind}\0${actor.id.value}\0${deploymentId.value}`;
}

function requireOwnedPlan(plan: MaterializationPlan, owner: ActorRef): void {
    if (plan.actors.length !== 1 || !plan.actors[0]!.actor.equals(owner)) {
        throw invalidDefinitionState("Materialization plan must target exactly the store owner");
    }
}

function requireOwnedActor(actor: ActorRef, owner: ActorRef, subject: string): void {
    if (!actor.equals(owner))
        throw invalidDefinitionState(`${subject} belongs to a different Actor`);
}

function requireTenantControl(owner: ActorRef, subject: string): void {
    if (owner.kind !== "tenant") {
        throw invalidDefinitionState(`${subject} is stored only by its Tenant control Actor`);
    }
}

function blueprintKey(blueprint: Pick<StoredBlueprint, "name" | "version">): string {
    return `${blueprint.name}\0${blueprint.version}`;
}

function requireUnique(keys: readonly string[], message: string): void {
    if (new Set(keys).size !== keys.length) throw corruptMaterialization(message);
}

function requireEqualImmutable(actual: Uint8Array, expected: Uint8Array, subject: string): void {
    if (!equalBytes(actual, expected)) throw invalidDefinitionState(`${subject} is immutable`);
}

function copyBytes(bytes: Uint8Array, subject: string): Uint8Array {
    if (!(bytes instanceof Uint8Array)) {
        throw corruptMaterialization(`Stored ${subject} codec bytes are malformed`);
    }
    return bytes.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corruptMaterialization(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
