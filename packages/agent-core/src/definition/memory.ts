import {
    ActorId,
    requireSynchronousResult,
    type ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../actors";
import { Digest, Revision, SemVer } from "../core";
import { MaterializationGenerationId, PackageId, type DeploymentId } from "./id";
import {
    DeploymentRecord,
    MaterializationControlStore,
    MaterializationOutboxEntry,
    MaterializationRollout,
    isLegalDeploymentTransition,
    isLegalOutboxTransition,
    requirePlanAttestation,
    requireExactOutboxClosure
} from "./rollout";
import { compareText } from "./order";
import type { MaterializationPlan } from "./plan";
import { ValidationAttestation } from "./attestation";
import { corruptDefinition, definitionRevisionConflict, invalidDefinitionState } from "./error";
import { requireMaterializationKind } from "./materialization-kind";
import {
    MaterializationStore,
    type StoredBlueprint,
    type StoredManagedStateRecord,
    type StoredMaterializationGeneration,
    type StoredMaterializationGenerationPointer,
    type StoredMaterializationPlan
} from "./materialization-store";
import {
    ProjectedPackageStore,
    type StoredMetadataSnapshot,
    type StoredPackageLock,
    type StoredPackageRelease
} from "./package-store";

export interface MemoryPackageSnapshot {
    readonly releases: readonly StoredPackageRelease[];
    readonly snapshots: readonly StoredMetadataSnapshot[];
    readonly locks: readonly StoredPackageLock[];
}

export class MemoryPackageStore extends ProjectedPackageStore {
    readonly #releases = new Map<string, StoredPackageRelease>();
    readonly #snapshots = new Map<string, StoredMetadataSnapshot>();
    readonly #locks = new Map<string, StoredPackageLock>();

    public constructor(
        snapshot: MemoryPackageSnapshot = { releases: [], snapshots: [], locks: [] }
    ) {
        super();
        for (const release of snapshot.releases) {
            const copied = copyRelease(release);
            const key = releaseKey(copied.packageId, copied.version);
            if (this.#releases.has(key)) {
                throw corruptDefinition("Memory package snapshot contains duplicate releases");
            }
            this.#releases.set(key, copied);
        }
        for (const metadata of snapshot.snapshots) {
            const copied = copySnapshot(metadata);
            if (this.#snapshots.has(copied.digest)) {
                throw corruptDefinition(
                    "Memory package snapshot contains duplicate metadata snapshots"
                );
            }
            this.#snapshots.set(copied.digest, copied);
        }
        for (const lock of snapshot.locks) {
            const copied = copyLock(lock);
            if (this.#locks.has(copied.lockDigest)) {
                throw corruptDefinition("Memory package snapshot contains duplicate locks");
            }
            this.#locks.set(copied.lockDigest, copied);
        }
        for (const release of this.#releases.values()) {
            this.get(release.packageId, new SemVer(release.version));
        }
        for (const metadata of this.#snapshots.values()) {
            this.getSnapshot(new Digest(metadata.digest));
        }
        for (const lock of this.#locks.values()) {
            this.getLock(new Digest(lock.lockDigest));
        }
    }

    public clone(): MemoryPackageStore {
        return new MemoryPackageStore(this.snapshot());
    }

    public snapshot(): MemoryPackageSnapshot {
        return Object.freeze({
            releases: Object.freeze(
                [...this.#releases.values()]
                    .sort(compareStoredReleases)
                    .map((release) => Object.freeze(copyRelease(release)))
            ),
            snapshots: Object.freeze(
                [...this.#snapshots.values()]
                    .sort(
                        (left, right) =>
                            left.revision - right.revision || compareText(left.digest, right.digest)
                    )
                    .map((metadata) => Object.freeze(copySnapshot(metadata)))
            ),
            locks: Object.freeze(
                [...this.#locks.values()]
                    .sort((left, right) => compareText(left.lockDigest, right.lockDigest))
                    .map((lock) => Object.freeze(copyLock(lock)))
            )
        });
    }

    protected findRelease(packageId: PackageId, version: string): StoredPackageRelease | undefined {
        const release = this.#releases.get(releaseKey(packageId, version));
        return release === undefined ? undefined : copyRelease(release);
    }

    protected listReleases(packageId?: PackageId): readonly StoredPackageRelease[] {
        return [...this.#releases.values()]
            .filter((release) => packageId === undefined || release.packageId.equals(packageId))
            .map(copyRelease);
    }

    protected insertRelease(release: StoredPackageRelease): StoredPackageRelease {
        const key = releaseKey(release.packageId, release.version);
        const existing = this.#releases.get(key);
        if (existing !== undefined) {
            return copyRelease(existing);
        }
        const copied = copyRelease(release);
        this.#releases.set(key, copied);
        return copyRelease(copied);
    }

    protected findSnapshot(digest: string): StoredMetadataSnapshot | undefined {
        const snapshot = this.#snapshots.get(digest);
        return snapshot === undefined ? undefined : copySnapshot(snapshot);
    }

    protected snapshotRecords(): readonly StoredMetadataSnapshot[] {
        return [...this.#snapshots.values()].map(copySnapshot);
    }

    protected insertSnapshot(snapshot: StoredMetadataSnapshot): StoredMetadataSnapshot {
        const existing = this.#snapshots.get(snapshot.digest);
        if (existing !== undefined) return copySnapshot(existing);
        const copied = copySnapshot(snapshot);
        this.#snapshots.set(copied.digest, copied);
        return copySnapshot(copied);
    }

    protected findLock(lockDigest: string): StoredPackageLock | undefined {
        const lock = this.#locks.get(lockDigest);
        return lock === undefined ? undefined : copyLock(lock);
    }

    protected insertLock(lock: StoredPackageLock): StoredPackageLock {
        const existing = this.#locks.get(lock.lockDigest);
        if (existing !== undefined) {
            return copyLock(existing);
        }
        const copied = copyLock(lock);
        this.#locks.set(copied.lockDigest, copied);
        return copyLock(copied);
    }
}

export interface MemoryMaterializationSnapshot {
    readonly blueprints: readonly StoredBlueprint[];
    readonly plans: readonly StoredMaterializationPlan[];
    readonly generations: readonly StoredMaterializationGeneration[];
    readonly managedState: readonly StoredManagedStateRecord[];
    readonly pointers: readonly StoredMaterializationGenerationPointer[];
}

interface MemoryMaterializationState {
    readonly blueprints: Map<string, StoredBlueprint>;
    readonly plans: Map<string, StoredMaterializationPlan>;
    readonly generations: Map<string, StoredMaterializationGeneration>;
    readonly managedState: Map<string, StoredManagedStateRecord>;
    readonly pointers: Map<string, StoredMaterializationGenerationPointer>;
}

const EMPTY_MATERIALIZATION_SNAPSHOT: MemoryMaterializationSnapshot = {
    blueprints: [],
    plans: [],
    generations: [],
    managedState: [],
    pointers: []
};

export class MemoryMaterializationStore extends MaterializationStore<MemoryMaterializationState> {
    #state: MemoryMaterializationState;

    public constructor(
        owner: ActorRef,
        snapshot: MemoryMaterializationSnapshot = EMPTY_MATERIALIZATION_SNAPSHOT
    ) {
        super(owner);
        this.#state = emptyMaterializationState();
        installSnapshotRows(
            this.#state.blueprints,
            snapshot.blueprints,
            (row) => blueprintStoreKey(row.name, row.version),
            copyBlueprint,
            "Blueprints"
        );
        installSnapshotRows(
            this.#state.plans,
            snapshot.plans,
            (row) => row.id,
            copyPlan,
            "materialization plans"
        );
        installSnapshotRows(
            this.#state.generations,
            snapshot.generations,
            (row) => row.id.value,
            copyGeneration,
            "materialization generations"
        );
        installSnapshotRows(
            this.#state.managedState,
            snapshot.managedState,
            (row) => row.id,
            copyManagedState,
            "managed-state records"
        );
        installSnapshotRows(
            this.#state.pointers,
            snapshot.pointers,
            (row) => pointerStoreKey(row.actorKind, row.actorId, row.deploymentId),
            copyPointer,
            "generation pointers"
        );

        if (owner.kind === "tenant") {
            this.listBlueprints();
            this.listPlans();
        } else if (snapshot.blueprints.length > 0 || snapshot.plans.length > 0) {
            throw corruptDefinition(
                "Actor-local materialization snapshots cannot contain Tenant control records"
            );
        }
        this.listManagedState();
        this.listGenerations();
        this.listGenerationPointers();
        this.requireCompleteMaterializationClosure();
    }

    public transaction<TResult>(
        operation: TransactionOperation<MemoryMaterializationState, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const draft = cloneMaterializationState(this.#state);
        const result = requireSynchronousResult(operation(draft));
        this.#state = draft;
        return result;
    }

    public clone(): MemoryMaterializationStore {
        return new MemoryMaterializationStore(this.owner, this.snapshot());
    }

    public snapshot(): MemoryMaterializationSnapshot {
        return Object.freeze({
            blueprints: frozenRows(
                this.#state.blueprints.values(),
                copyBlueprint,
                (left, right) =>
                    compareText(left.name, right.name) || compareText(left.version, right.version)
            ),
            plans: frozenRows(this.#state.plans.values(), copyPlan, (left, right) =>
                compareText(left.id, right.id)
            ),
            generations: frozenRows(
                this.#state.generations.values(),
                copyGeneration,
                compareStoredGenerations
            ),
            managedState: frozenRows(
                this.#state.managedState.values(),
                copyManagedState,
                compareStoredManagedState
            ),
            pointers: frozenRows(
                this.#state.pointers.values(),
                copyPointer,
                (left, right) =>
                    compareText(left.actorKind, right.actorKind) ||
                    compareText(left.actorId.value, right.actorId.value) ||
                    compareText(left.deploymentId, right.deploymentId)
            )
        });
    }

    protected findBlueprint(
        transaction: MemoryMaterializationState,
        name: string,
        version: string
    ): StoredBlueprint | undefined {
        return copyOptional(
            transaction.blueprints.get(blueprintStoreKey(name, version)),
            copyBlueprint
        );
    }

    protected blueprintRecords(
        transaction: MemoryMaterializationState,
        name?: string
    ): readonly StoredBlueprint[] {
        return [...transaction.blueprints.values()]
            .filter((blueprint) => name === undefined || blueprint.name === name)
            .map(copyBlueprint);
    }

    protected writeBlueprint(
        transaction: MemoryMaterializationState,
        blueprint: StoredBlueprint
    ): StoredBlueprint {
        return insertImmutable(
            transaction.blueprints,
            blueprintStoreKey(blueprint.name, blueprint.version),
            blueprint,
            copyBlueprint
        );
    }

    protected findPlan(
        transaction: MemoryMaterializationState,
        id: string
    ): StoredMaterializationPlan | undefined {
        return copyOptional(transaction.plans.get(id), copyPlan);
    }

    protected planRecords(
        transaction: MemoryMaterializationState
    ): readonly StoredMaterializationPlan[] {
        return [...transaction.plans.values()].map(copyPlan);
    }

    protected writePlan(
        transaction: MemoryMaterializationState,
        plan: StoredMaterializationPlan
    ): StoredMaterializationPlan {
        return insertImmutable(transaction.plans, plan.id, plan, copyPlan);
    }

    protected findGeneration(
        transaction: MemoryMaterializationState,
        id: MaterializationGenerationId
    ): StoredMaterializationGeneration | undefined {
        return copyOptional(transaction.generations.get(id.value), copyGeneration);
    }

    protected generationRecords(
        transaction: MemoryMaterializationState,
        actor?: ActorRef
    ): readonly StoredMaterializationGeneration[] {
        return [...transaction.generations.values()]
            .filter(
                (generation) =>
                    actor === undefined ||
                    (generation.actorKind === actor.kind && generation.actorId.equals(actor.id))
            )
            .map(copyGeneration);
    }

    protected writeGeneration(
        transaction: MemoryMaterializationState,
        generation: StoredMaterializationGeneration
    ): StoredMaterializationGeneration {
        return insertImmutable(
            transaction.generations,
            generation.id.value,
            generation,
            copyGeneration
        );
    }

    protected findManagedState(
        transaction: MemoryMaterializationState,
        id: string
    ): StoredManagedStateRecord | undefined {
        return copyOptional(transaction.managedState.get(id), copyManagedState);
    }

    protected managedStateRecords(
        transaction: MemoryMaterializationState,
        generationId?: MaterializationGenerationId
    ): readonly StoredManagedStateRecord[] {
        return [...transaction.managedState.values()]
            .filter(
                (record) => generationId === undefined || record.generationId.equals(generationId)
            )
            .map(copyManagedState);
    }

    protected writeManagedState(
        transaction: MemoryMaterializationState,
        record: StoredManagedStateRecord
    ): StoredManagedStateRecord {
        requireMaterializationKind(record.recordKind);
        return insertImmutable(transaction.managedState, record.id, record, copyManagedState);
    }

    protected findGenerationPointer(
        transaction: MemoryMaterializationState,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): StoredMaterializationGenerationPointer | undefined {
        return copyOptional(
            transaction.pointers.get(pointerStoreKey(actor.kind, actor.id, deploymentId.value)),
            copyPointer
        );
    }

    protected generationPointerRecords(
        transaction: MemoryMaterializationState
    ): readonly StoredMaterializationGenerationPointer[] {
        return [...transaction.pointers.values()].map(copyPointer);
    }

    protected writeGenerationPointer(
        transaction: MemoryMaterializationState,
        expectedRevision: Revision | undefined,
        pointer: StoredMaterializationGenerationPointer
    ): boolean {
        const key = pointerStoreKey(pointer.actorKind, pointer.actorId, pointer.deploymentId);
        const current = transaction.pointers.get(key);
        const matches =
            expectedRevision === undefined
                ? current === undefined
                : current?.revision === expectedRevision.value;
        if (!matches) return false;
        transaction.pointers.set(key, copyPointer(pointer));
        return true;
    }
}

export interface MemoryMaterializationControlSnapshot {
    readonly attestations: readonly Uint8Array[];
    readonly deployments: readonly Uint8Array[];
    readonly rollouts: readonly Uint8Array[];
    readonly outbox: readonly Uint8Array[];
}

interface MemoryMaterializationControlState {
    readonly attestations: Map<string, Uint8Array>;
    readonly deployments: Map<string, Uint8Array>;
    readonly rollouts: Map<string, Uint8Array>;
    readonly outbox: Map<string, Uint8Array>;
}

export class MemoryMaterializationControlStore extends MaterializationControlStore<MemoryMaterializationControlState> {
    #state: MemoryMaterializationControlState;

    public constructor(snapshot?: MemoryMaterializationControlSnapshot) {
        super();
        this.#state = {
            attestations: installControlRows(
                snapshot?.attestations ?? [],
                ValidationAttestation.decode
            ),
            deployments: installControlRows(snapshot?.deployments ?? [], DeploymentRecord.decode),
            rollouts: installControlRows(snapshot?.rollouts ?? [], MaterializationRollout.decode),
            outbox: installControlRows(snapshot?.outbox ?? [], MaterializationOutboxEntry.decode)
        };
        this.validateClosure();
    }

    public transaction<Result>(
        operation: TransactionOperation<MemoryMaterializationControlState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        const draft = cloneControlState(this.#state);
        const result = requireSynchronousResult(operation(draft));
        this.#state = draft;
        return result;
    }

    public snapshot(): MemoryMaterializationControlSnapshot {
        return Object.freeze({
            attestations: frozenControlRows(this.#state.attestations),
            deployments: frozenControlRows(this.#state.deployments),
            rollouts: frozenControlRows(this.#state.rollouts),
            outbox: frozenControlRows(this.#state.outbox)
        });
    }

    public insertAttestation(
        transaction: MemoryMaterializationControlState,
        attestation: ValidationAttestation
    ): void {
        insertControlImmutable(
            transaction.attestations,
            attestation.id.value,
            ValidationAttestation.encode(attestation),
            "Validation attestation"
        );
    }

    public loadAttestation(
        transaction: MemoryMaterializationControlState,
        id: Digest
    ): ValidationAttestation | undefined {
        const bytes = transaction.attestations.get(id.value);
        if (bytes === undefined) return undefined;
        return ValidationAttestation.decode(bytes.slice());
    }

    public loadDeployment(
        transaction: MemoryMaterializationControlState,
        id: DeploymentId
    ): DeploymentRecord | undefined {
        const bytes = transaction.deployments.get(id.value);
        if (bytes === undefined) return undefined;
        return DeploymentRecord.decode(bytes.slice());
    }

    public compareAndSetDeployment(
        transaction: MemoryMaterializationControlState,
        expected: Revision | undefined,
        deployment: DeploymentRecord
    ): boolean {
        const current = this.loadDeployment(transaction, deployment.id);
        if (!revisionMatches(current?.revision, expected)) return false;
        if (
            !isLegalDeploymentTransition(current, deployment) ||
            !this.isDeploymentLineageValid(transaction, current, deployment)
        ) {
            throw definitionRevisionConflict("Deployment transition is invalid");
        }
        transaction.deployments.set(deployment.id.value, DeploymentRecord.encode(deployment));
        return true;
    }

    public insertRollout(
        transaction: MemoryMaterializationControlState,
        rollout: MaterializationRollout
    ): void {
        if (this.loadDeployment(transaction, rollout.plan.origin.deploymentId) === undefined) {
            throw invalidDefinitionState("Materialization rollout requires its stored deployment");
        }
        const attestation = this.loadAttestation(
            transaction,
            rollout.plan.origin.attestationDigest
        );
        if (attestation === undefined) {
            throw invalidDefinitionState(
                "Materialization rollout requires its stored validation attestation"
            );
        }
        requirePlanAttestation(rollout.plan, attestation);
        insertControlImmutable(
            transaction.rollouts,
            rollout.id.value,
            MaterializationRollout.encode(rollout),
            "Materialization rollout"
        );
    }

    public loadRollout(
        transaction: MemoryMaterializationControlState,
        id: Digest
    ): MaterializationRollout | undefined {
        const bytes = transaction.rollouts.get(id.value);
        if (bytes === undefined) return undefined;
        return MaterializationRollout.decode(bytes.slice());
    }

    public loadPlan(
        transaction: MemoryMaterializationControlState,
        id: Digest
    ): MaterializationPlan | undefined {
        for (const bytes of transaction.rollouts.values()) {
            const plan = MaterializationRollout.decode(bytes.slice()).plan;
            if (plan.id.equals(id)) return plan;
        }
        return undefined;
    }

    public insertOutbox(
        transaction: MemoryMaterializationControlState,
        entry: MaterializationOutboxEntry
    ): void {
        if (this.loadRollout(transaction, entry.rolloutId) === undefined) {
            throw invalidDefinitionState(
                "Materialization outbox entry requires its stored rollout"
            );
        }
        insertControlImmutable(
            transaction.outbox,
            entry.id.value,
            MaterializationOutboxEntry.encode(entry),
            "Materialization outbox entry"
        );
    }

    public loadOutbox(
        transaction: MemoryMaterializationControlState,
        id: Digest
    ): MaterializationOutboxEntry | undefined {
        const bytes = transaction.outbox.get(id.value);
        if (bytes === undefined) return undefined;
        return MaterializationOutboxEntry.decode(bytes.slice());
    }

    public listOutbox(
        transaction: MemoryMaterializationControlState,
        rolloutId: Digest
    ): readonly MaterializationOutboxEntry[] {
        return Object.freeze(
            [...transaction.outbox.values()]
                .map((bytes) => MaterializationOutboxEntry.decode(bytes.slice()))
                .filter((entry) => entry.rolloutId.equals(rolloutId))
                .sort((left, right) => compareText(left.id.value, right.id.value))
        );
    }

    public compareAndSetOutbox(
        transaction: MemoryMaterializationControlState,
        expected: Revision,
        entry: MaterializationOutboxEntry
    ): boolean {
        const current = this.loadOutbox(transaction, entry.id);
        if (current?.revision.equals(expected) !== true) return false;
        if (!isLegalOutboxTransition(current, entry)) {
            throw definitionRevisionConflict("Materialization outbox transition is invalid");
        }
        transaction.outbox.set(entry.id.value, MaterializationOutboxEntry.encode(entry));
        return true;
    }

    private validateClosure(): void {
        this.transaction((transaction) => {
            for (const bytes of transaction.rollouts.values()) {
                const rollout = MaterializationRollout.decode(bytes.slice());
                const deployment = this.loadDeployment(
                    transaction,
                    rollout.plan.origin.deploymentId
                );
                if (deployment === undefined)
                    throw corruptDefinition("Stored rollout has no deployment");
                const attestation = this.loadAttestation(
                    transaction,
                    rollout.plan.origin.attestationDigest
                );
                if (attestation === undefined) {
                    throw corruptDefinition("Stored rollout has no validation attestation");
                }
                try {
                    requirePlanAttestation(rollout.plan, attestation);
                    requireExactOutboxClosure(rollout, this.listOutbox(transaction, rollout.id));
                } catch (error) {
                    throw corruptDefinition(
                        error instanceof Error ? error.message : "Stored rollout closure is corrupt"
                    );
                }
            }
            for (const bytes of transaction.outbox.values()) {
                const entry = MaterializationOutboxEntry.decode(bytes.slice());
                if (this.loadRollout(transaction, entry.rolloutId) === undefined) {
                    throw corruptDefinition("Stored outbox entry has no rollout");
                }
            }
        });
    }

    private isDeploymentLineageValid(
        transaction: MemoryMaterializationControlState,
        current: DeploymentRecord | undefined,
        next: DeploymentRecord
    ): boolean {
        if (current === undefined) return true;
        if (current.pendingRolloutId === undefined) {
            const rollout =
                next.pendingRolloutId === undefined
                    ? undefined
                    : this.loadRollout(transaction, next.pendingRolloutId);
            return (
                rollout !== undefined &&
                rollout.plan.origin.deploymentId.equals(current.id) &&
                rollout.plan.generation === current.nextGeneration
            );
        }
        if (next.pendingRolloutId === undefined) {
            return (
                this.loadRollout(transaction, current.pendingRolloutId)?.plan.id.equals(
                    next.activePlanId!
                ) === true
            );
        }
        const compensation = this.loadRollout(transaction, next.pendingRolloutId);
        return (
            compensation?.compensates?.equals(current.pendingRolloutId) === true &&
            compensation.plan.origin.deploymentId.equals(current.id) &&
            compensation.plan.generation === current.nextGeneration
        );
    }
}

function installControlRows<Value extends { readonly id: { readonly value: string } }>(
    rows: readonly Uint8Array[],
    decode: (bytes: Uint8Array) => Value
): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    for (const bytes of rows) {
        const copied = bytes.slice();
        const value = decode(copied);
        if (result.has(value.id.value))
            throw corruptDefinition("Control snapshot contains duplicate IDs");
        result.set(value.id.value, copied);
    }
    return result;
}

function cloneControlState(
    state: MemoryMaterializationControlState
): MemoryMaterializationControlState {
    return {
        attestations: copyByteMap(state.attestations),
        deployments: copyByteMap(state.deployments),
        rollouts: copyByteMap(state.rollouts),
        outbox: copyByteMap(state.outbox)
    };
}

function copyByteMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...source].map(([key, value]) => [key, value.slice()]));
}

function frozenControlRows(source: ReadonlyMap<string, Uint8Array>): readonly Uint8Array[] {
    return Object.freeze(
        [...source.entries()]
            .sort(([left], [right]) => compareText(left, right))
            .map(([, value]) => value.slice())
    );
}

function insertControlImmutable(
    target: Map<string, Uint8Array>,
    id: string,
    bytes: Uint8Array,
    subject: string
): void {
    const existing = target.get(id);
    if (existing !== undefined && !bytesEqual(existing, bytes)) {
        throw invalidDefinitionState(`${subject} ${id} is immutable`);
    }
    target.set(id, bytes.slice());
}

function revisionMatches(current: Revision | undefined, expected: Revision | undefined): boolean {
    return expected === undefined ? current === undefined : current?.equals(expected) === true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function copyRelease(release: StoredPackageRelease): StoredPackageRelease {
    if (!(release.packageId instanceof PackageId)) {
        throw corruptDefinition("Memory package snapshot package ID is malformed");
    }
    requireText(release.version, "package version");
    requireText(release.manifestDigest, "manifest digest");
    requireText(release.codeDigest, "code digest");
    requireBytes(release.bytes, "package release");
    return {
        ...release,
        packageId: new PackageId(release.packageId.value),
        bytes: release.bytes.slice()
    };
}

function copyLock(lock: StoredPackageLock): StoredPackageLock {
    requireText(lock.lockDigest, "lock digest");
    requireText(lock.snapshotDigest, "snapshot digest");
    if (!Number.isSafeInteger(lock.snapshotRevision) || lock.snapshotRevision < 0) {
        throw corruptDefinition("Memory package snapshot lock revision is malformed");
    }
    requireBytes(lock.bytes, "package lock");
    return { ...lock, bytes: lock.bytes.slice() };
}

function copySnapshot(snapshot: StoredMetadataSnapshot): StoredMetadataSnapshot {
    requireText(snapshot.digest, "metadata snapshot digest");
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
        throw corruptDefinition("Memory package snapshot metadata revision is malformed");
    }
    requireBytes(snapshot.bytes, "metadata snapshot");
    return { ...snapshot, bytes: snapshot.bytes.slice() };
}

function requireText(value: string, subject: string): void {
    if (typeof value !== "string" || value.length === 0) {
        throw corruptDefinition(`Memory package snapshot ${subject} is malformed`);
    }
}

function requireBytes(value: Uint8Array, subject: string): void {
    if (!(value instanceof Uint8Array)) {
        throw corruptDefinition(`Memory package snapshot ${subject} bytes are malformed`);
    }
}

function releaseKey(packageId: PackageId, version: string): string {
    return `${packageId.value}\0${version}`;
}

function compareStoredReleases(left: StoredPackageRelease, right: StoredPackageRelease): number {
    return (
        compareText(left.packageId.value, right.packageId.value) ||
        compareText(left.version, right.version)
    );
}

function emptyMaterializationState(): MemoryMaterializationState {
    return {
        blueprints: new Map(),
        plans: new Map(),
        generations: new Map(),
        managedState: new Map(),
        pointers: new Map()
    };
}

function cloneMaterializationState(state: MemoryMaterializationState): MemoryMaterializationState {
    return {
        blueprints: copyMap(state.blueprints, copyBlueprint),
        plans: copyMap(state.plans, copyPlan),
        generations: copyMap(state.generations, copyGeneration),
        managedState: copyMap(state.managedState, copyManagedState),
        pointers: copyMap(state.pointers, copyPointer)
    };
}

function installSnapshotRows<Row>(
    target: Map<string, Row>,
    rows: readonly Row[],
    key: (row: Row) => string,
    copy: (row: Row) => Row,
    subject: string
): void {
    for (const row of rows) {
        const detached = copy(row);
        const rowKey = key(detached);
        if (target.has(rowKey)) {
            throw corruptDefinition(
                `Memory materialization snapshot contains duplicate ${subject}`
            );
        }
        target.set(rowKey, detached);
    }
}

function insertImmutable<Row>(
    target: Map<string, Row>,
    key: string,
    row: Row,
    copy: (row: Row) => Row
): Row {
    const existing = target.get(key);
    if (existing !== undefined) return copy(existing);
    const detached = copy(row);
    target.set(key, detached);
    return copy(detached);
}

function copyOptional<Row>(row: Row | undefined, copy: (row: Row) => Row): Row | undefined {
    return row === undefined ? undefined : copy(row);
}

function copyMap<Row>(source: Map<string, Row>, copy: (row: Row) => Row): Map<string, Row> {
    return new Map([...source].map(([key, row]) => [key, copy(row)]));
}

function frozenRows<Row extends object>(
    rows: Iterable<Row>,
    copy: (row: Row) => Row,
    compare: (left: Row, right: Row) => number
): readonly Row[] {
    return Object.freeze(
        [...rows]
            .map(copy)
            .sort(compare)
            .map((row) => Object.freeze(row) as Row)
    );
}

function copyBlueprint(row: StoredBlueprint): StoredBlueprint {
    requireStoredText(row.name, "Blueprint name");
    requireStoredText(row.version, "Blueprint version");
    requireStoredText(row.digest, "Blueprint digest");
    return { ...row, bytes: copyStoredBytes(row.bytes, "Blueprint") };
}

function copyPlan(row: StoredMaterializationPlan): StoredMaterializationPlan {
    requireStoredText(row.id, "materialization plan ID");
    requireStoredText(row.blueprintDigest, "materialization plan Blueprint digest");
    requireStoredText(row.packageLockDigest, "materialization plan package-lock digest");
    requireStoredText(row.configDigest, "materialization plan config digest");
    requireStoredInteger(row.generation, "materialization plan generation");
    return { ...row, bytes: copyStoredBytes(row.bytes, "materialization plan") };
}

function copyGeneration(row: StoredMaterializationGeneration): StoredMaterializationGeneration {
    if (!(row.id instanceof MaterializationGenerationId)) {
        throw corruptDefinition("Memory materialization snapshot generation ID is malformed");
    }
    requireStoredText(row.actorKind, "generation Actor kind");
    if (!(row.actorId instanceof ActorId)) {
        throw corruptDefinition("Memory materialization snapshot generation Actor ID is malformed");
    }
    requireStoredText(row.blueprintDigest, "generation Blueprint digest");
    requireStoredText(row.packageLockDigest, "generation package-lock digest");
    requireStoredText(row.configDigest, "generation config digest");
    requireStoredInteger(row.generation, "generation number");
    return {
        ...row,
        id: new MaterializationGenerationId(row.id.value),
        actorId: new ActorId(row.actorId.value),
        bytes: copyStoredBytes(row.bytes, "generation")
    };
}

function copyManagedState(row: StoredManagedStateRecord): StoredManagedStateRecord {
    requireStoredText(row.id, "managed-state ID");
    if (!(row.generationId instanceof MaterializationGenerationId)) {
        throw corruptDefinition(
            "Memory materialization snapshot managed-state generation ID is malformed"
        );
    }
    requireStoredText(row.actorKind, "managed-state Actor kind");
    if (!(row.actorId instanceof ActorId)) {
        throw corruptDefinition(
            "Memory materialization snapshot managed-state Actor ID is malformed"
        );
    }
    requireStoredText(row.logicalKey, "managed-state logical key");
    requireStoredText(row.recordKind, "managed-state record kind");
    requireMaterializationKind(row.recordKind);
    requireStoredText(row.desiredDigest, "managed-state desired digest");
    return {
        ...row,
        generationId: new MaterializationGenerationId(row.generationId.value),
        actorId: new ActorId(row.actorId.value),
        bytes: copyStoredBytes(row.bytes, "managed state")
    };
}

function copyPointer(
    row: StoredMaterializationGenerationPointer
): StoredMaterializationGenerationPointer {
    requireStoredText(row.actorKind, "generation-pointer Actor kind");
    if (!(row.actorId instanceof ActorId)) {
        throw corruptDefinition(
            "Memory materialization snapshot generation-pointer Actor ID is malformed"
        );
    }
    requireStoredText(row.deploymentId, "generation-pointer deployment ID");
    if (!(row.generationId instanceof MaterializationGenerationId)) {
        throw corruptDefinition(
            "Memory materialization snapshot generation-pointer generation ID is malformed"
        );
    }
    requireStoredInteger(row.revision, "generation-pointer revision");
    return {
        ...row,
        actorId: new ActorId(row.actorId.value),
        generationId: new MaterializationGenerationId(row.generationId.value),
        bytes: copyStoredBytes(row.bytes, "generation pointer")
    };
}

function requireStoredText(value: string, subject: string): void {
    if (typeof value !== "string" || value.length === 0) {
        throw corruptDefinition(`Memory materialization snapshot ${subject} is malformed`);
    }
}

function requireStoredInteger(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw corruptDefinition(`Memory materialization snapshot ${subject} is malformed`);
    }
}

function copyStoredBytes(bytes: Uint8Array, subject: string): Uint8Array {
    if (!(bytes instanceof Uint8Array)) {
        throw corruptDefinition(`Memory materialization snapshot ${subject} bytes are malformed`);
    }
    return bytes.slice();
}

function blueprintStoreKey(name: string, version: string): string {
    return `${name}\0${version}`;
}

function pointerStoreKey(kind: string, id: ActorId, deploymentId: DeploymentId["value"]): string {
    return `${kind}\0${id.value}\0${deploymentId}`;
}

function compareStoredGenerations(
    left: StoredMaterializationGeneration,
    right: StoredMaterializationGeneration
): number {
    return (
        compareText(left.actorKind, right.actorKind) ||
        compareText(left.actorId.value, right.actorId.value) ||
        compareText(left.id.value, right.id.value)
    );
}

function compareStoredManagedState(
    left: StoredManagedStateRecord,
    right: StoredManagedStateRecord
): number {
    return (
        compareText(left.generationId.value, right.generationId.value) ||
        compareText(left.logicalKey, right.logicalKey) ||
        compareText(left.id, right.id)
    );
}
