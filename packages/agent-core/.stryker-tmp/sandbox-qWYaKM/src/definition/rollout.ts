// @ts-nocheck
import {
    ActorId,
    ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../actors";
import {
    Digest,
    RecordCodec,
    Revision,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { TenantId } from "../identity";
import { DeploymentId, DeploymentKey } from "./id";
import { ManagedOrigin } from "./origin";
import { ActorPlan, MaterializationPlan } from "./plan";
import { compareText } from "./order";
import type { ValidationAttestation } from "./attestation";
import { definitionRevisionConflict, invalidDefinition, invalidDefinitionState } from "./error";

export interface DeploymentRecordInit {
    readonly id: DeploymentId;
    readonly tenantId: TenantId;
    readonly key: DeploymentKey;
    readonly activePlanId?: Digest;
    readonly pendingRolloutId?: Digest;
    readonly nextGeneration: number;
    readonly revision: Revision;
}

class DeploymentRecordCodec extends RecordCodec<DeploymentRecord> {
    public constructor() {
        super("definition.deployment", { major: 1, minor: 0 });
    }

    protected encodePayload(record: DeploymentRecord): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): DeploymentRecord {
        return DeploymentRecord.fromData(payload);
    }
}

export class DeploymentRecord {
    public static readonly codec: RecordCodec<DeploymentRecord> = new DeploymentRecordCodec();

    public constructor(
        public readonly id: DeploymentId,
        public readonly tenantId: TenantId,
        public readonly key: DeploymentKey,
        public readonly activePlanId: Digest | undefined,
        public readonly pendingRolloutId: Digest | undefined,
        public readonly nextGeneration: number,
        public readonly revision: Revision
    ) {
        if (!id.equals(DeploymentId.derive(tenantId, key))) {
            throw new TypeError("Deployment ID does not match its Tenant-scoped key");
        }
        requireSafeGeneration(nextGeneration, "Deployment next generation");
        Object.freeze(this);
    }

    public static initial(tenantId: TenantId, key: DeploymentKey): DeploymentRecord {
        return new DeploymentRecord(
            DeploymentId.derive(tenantId, key),
            tenantId,
            key,
            undefined,
            undefined,
            1,
            Revision.initial()
        );
    }

    public begin(rolloutId: Digest, generation: number): DeploymentRecord {
        if (this.pendingRolloutId !== undefined) {
            throw invalidDefinitionState(
                "Deployment already has a pending materialization rollout"
            );
        }
        if (generation !== this.nextGeneration) {
            throw definitionRevisionConflict(
                "Materialization rollout generation was not allocated by its deployment"
            );
        }
        return new DeploymentRecord(
            this.id,
            this.tenantId,
            this.key,
            this.activePlanId,
            rolloutId,
            increment(generation, "Deployment generation"),
            this.revision.next()
        );
    }

    public compensate(
        failedRolloutId: Digest,
        compensationRolloutId: Digest,
        generation: number
    ): DeploymentRecord {
        if (this.pendingRolloutId?.equals(failedRolloutId) !== true) {
            throw invalidDefinitionState(
                "Deployment compensation does not match its failed pending rollout"
            );
        }
        if (generation !== this.nextGeneration) {
            throw definitionRevisionConflict(
                "Compensation generation was not allocated by its deployment"
            );
        }
        return new DeploymentRecord(
            this.id,
            this.tenantId,
            this.key,
            this.activePlanId,
            compensationRolloutId,
            increment(generation, "Deployment generation"),
            this.revision.next()
        );
    }

    public complete(rolloutId: Digest, planId: Digest): DeploymentRecord {
        if (this.pendingRolloutId?.equals(rolloutId) !== true) {
            throw invalidDefinitionState(
                "Deployment completion does not match its pending rollout"
            );
        }
        return new DeploymentRecord(
            this.id,
            this.tenantId,
            this.key,
            planId,
            undefined,
            this.nextGeneration,
            this.revision.next()
        );
    }

    public static encode(record: DeploymentRecord): Uint8Array {
        return DeploymentRecord.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): DeploymentRecord {
        return DeploymentRecord.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): DeploymentRecord {
        const object = requireObject(value, "Deployment");
        requireFields(
            object,
            [
                "activePlanId",
                "id",
                "key",
                "nextGeneration",
                "pendingRolloutId",
                "revision",
                "tenantId"
            ],
            "Deployment"
        );
        return new DeploymentRecord(
            new DeploymentId(requireString(object["id"], "Deployment ID")),
            new TenantId(requireString(object["tenantId"], "Deployment Tenant ID")),
            new DeploymentKey(requireString(object["key"], "Deployment key")),
            optionalDigest(object["activePlanId"], "Deployment active plan"),
            optionalDigest(object["pendingRolloutId"], "Deployment pending rollout"),
            requireInteger(object["nextGeneration"], "Deployment next generation"),
            new Revision(requireInteger(object["revision"], "Deployment revision"))
        );
    }

    public toData(): JsonValue {
        return {
            activePlanId: this.activePlanId?.value ?? null,
            id: this.id.value,
            key: this.key.value,
            nextGeneration: this.nextGeneration,
            pendingRolloutId: this.pendingRolloutId?.value ?? null,
            revision: this.revision.value,
            tenantId: this.tenantId.value
        };
    }
}

export interface MaterializationRolloutInit {
    readonly plan: MaterializationPlan;
    readonly previousPlanId?: Digest;
    readonly compensates?: Digest;
    readonly id?: Digest;
}

class MaterializationRolloutCodec extends RecordCodec<MaterializationRollout> {
    public constructor() {
        super("definition.materialization-rollout", { major: 1, minor: 0 });
    }

    protected encodePayload(record: MaterializationRollout): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): MaterializationRollout {
        return MaterializationRollout.fromData(payload);
    }
}

export class MaterializationRollout {
    public static readonly codec: RecordCodec<MaterializationRollout> =
        new MaterializationRolloutCodec();

    public readonly id: Digest;
    public readonly plan: MaterializationPlan;
    public readonly previousPlanId: Digest | undefined;
    public readonly compensates: Digest | undefined;

    public constructor(init: MaterializationRolloutInit) {
        const plan = MaterializationPlan.decode(MaterializationPlan.encode(init.plan));
        const id = Digest.sha256(
            encodeCanonicalJson({
                compensates: init.compensates?.value ?? null,
                domain: "agent-core.materialization-rollout.v1",
                planId: plan.id.value,
                previousPlanId: init.previousPlanId?.value ?? null
            })
        );
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError("Materialization rollout ID does not match its canonical contents");
        }
        this.id = id;
        this.plan = plan;
        this.previousPlanId = init.previousPlanId;
        this.compensates = init.compensates;
        Object.freeze(this);
    }

    public static encode(record: MaterializationRollout): Uint8Array {
        return MaterializationRollout.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): MaterializationRollout {
        return MaterializationRollout.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): MaterializationRollout {
        const object = requireObject(value, "Materialization rollout");
        requireFields(
            object,
            ["compensates", "id", "plan", "previousPlanId"],
            "Materialization rollout"
        );
        const previousPlanId = optionalDigest(object["previousPlanId"], "Previous plan ID");
        const compensates = optionalDigest(object["compensates"], "Compensated rollout ID");
        return new MaterializationRollout({
            id: digestValue(object["id"], "Materialization rollout ID"),
            plan: MaterializationPlan.fromData(object["plan"]!),
            ...(previousPlanId === undefined ? {} : { previousPlanId }),
            ...(compensates === undefined ? {} : { compensates })
        });
    }

    public toData(): JsonValue {
        return {
            compensates: this.compensates?.value ?? null,
            id: this.id.value,
            plan: this.plan.toData(),
            previousPlanId: this.previousPlanId?.value ?? null
        };
    }
}

export type OutboxStatus = "pending" | "acknowledged";

export interface MaterializationApplyReceipt {
    readonly outcome: "applied";
    readonly rolloutId: Digest;
    readonly outboxId: Digest;
    readonly actorPlanId: Digest;
    readonly replyDigest: Digest;
}

class MaterializationOutboxEntryCodec extends RecordCodec<MaterializationOutboxEntry> {
    public constructor() {
        super("definition.materialization-outbox", { major: 1, minor: 0 });
    }

    protected encodePayload(record: MaterializationOutboxEntry): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): MaterializationOutboxEntry {
        return MaterializationOutboxEntry.fromData(payload);
    }
}

export class MaterializationOutboxEntry {
    public static readonly codec: RecordCodec<MaterializationOutboxEntry> =
        new MaterializationOutboxEntryCodec();

    public readonly id: Digest;
    public readonly idempotencyKey: string;

    public constructor(
        public readonly rolloutId: Digest,
        public readonly target: ActorRef,
        public readonly actorPlanId: Digest,
        public readonly status: OutboxStatus,
        public readonly attempts: number,
        public readonly replyDigest: Digest | undefined,
        public readonly revision: Revision,
        id?: Digest
    ) {
        if (!Number.isSafeInteger(attempts) || attempts < 0) {
            throw new TypeError(
                "Materialization outbox attempts must be a non-negative safe integer"
            );
        }
        if ((status === "pending") !== (replyDigest === undefined)) {
            throw new TypeError(
                "Only acknowledged materialization outbox entries carry a reply digest"
            );
        }
        const requiredRevision = status === "pending" ? attempts : attempts + 1;
        if (!Number.isSafeInteger(requiredRevision) || revision.value !== requiredRevision) {
            throw new TypeError(
                "Materialization outbox revision does not match its durable transition history"
            );
        }
        const derived = Digest.sha256(
            encodeCanonicalJson({
                actorPlanId: actorPlanId.value,
                domain: "agent-core.materialization-outbox.v1",
                rolloutId: rolloutId.value,
                target: actorData(target)
            })
        );
        if (id !== undefined && !id.equals(derived)) {
            throw new TypeError("Materialization outbox ID does not match its canonical contents");
        }
        this.id = derived;
        this.idempotencyKey = derived.value;
        Object.freeze(this);
    }

    public static pending(rolloutId: Digest, plan: ActorPlan): MaterializationOutboxEntry {
        return new MaterializationOutboxEntry(
            rolloutId,
            plan.actor,
            plan.id,
            "pending",
            0,
            undefined,
            Revision.initial()
        );
    }

    public attempted(): MaterializationOutboxEntry {
        if (this.status !== "pending") return this;
        return new MaterializationOutboxEntry(
            this.rolloutId,
            this.target,
            this.actorPlanId,
            this.status,
            increment(this.attempts, "Materialization outbox attempts"),
            undefined,
            this.revision.next(),
            this.id
        );
    }

    public acknowledge(replyDigest: Digest): MaterializationOutboxEntry {
        if (this.status === "acknowledged") {
            if (!this.replyDigest!.equals(replyDigest)) {
                throw invalidDefinitionState("Materialization outbox acknowledgement is immutable");
            }
            return this;
        }
        return new MaterializationOutboxEntry(
            this.rolloutId,
            this.target,
            this.actorPlanId,
            "acknowledged",
            this.attempts,
            replyDigest,
            this.revision.next(),
            this.id
        );
    }

    public static encode(record: MaterializationOutboxEntry): Uint8Array {
        return MaterializationOutboxEntry.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): MaterializationOutboxEntry {
        return MaterializationOutboxEntry.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): MaterializationOutboxEntry {
        const object = requireObject(value, "Materialization outbox");
        requireFields(
            object,
            [
                "actorPlanId",
                "attempts",
                "id",
                "replyDigest",
                "revision",
                "rolloutId",
                "status",
                "target"
            ],
            "Materialization outbox"
        );
        const status = requireString(object["status"], "Materialization outbox status");
        if (status !== "pending" && status !== "acknowledged") {
            throw new TypeError("Materialization outbox status is invalid");
        }
        return new MaterializationOutboxEntry(
            digestValue(object["rolloutId"], "Materialization outbox rollout ID"),
            requireActor(object["target"]!),
            digestValue(object["actorPlanId"], "Materialization outbox Actor plan ID"),
            status,
            requireInteger(object["attempts"], "Materialization outbox attempts"),
            optionalDigest(object["replyDigest"], "Materialization outbox reply digest"),
            new Revision(requireInteger(object["revision"], "Materialization outbox revision")),
            digestValue(object["id"], "Materialization outbox ID")
        );
    }

    public toData(): JsonValue {
        return {
            actorPlanId: this.actorPlanId.value,
            attempts: this.attempts,
            id: this.id.value,
            replyDigest: this.replyDigest?.value ?? null,
            revision: this.revision.value,
            rolloutId: this.rolloutId.value,
            status: this.status,
            target: actorData(this.target)
        };
    }
}

export abstract class MaterializationControlStore<Transaction> {
    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    public abstract loadDeployment(
        transaction: Transaction,
        id: DeploymentId
    ): DeploymentRecord | undefined;
    public abstract insertAttestation(
        transaction: Transaction,
        attestation: ValidationAttestation
    ): void;
    public abstract loadAttestation(
        transaction: Transaction,
        id: Digest
    ): ValidationAttestation | undefined;
    public abstract compareAndSetDeployment(
        transaction: Transaction,
        expected: Revision | undefined,
        deployment: DeploymentRecord
    ): boolean;
    public abstract insertRollout(transaction: Transaction, rollout: MaterializationRollout): void;
    public abstract loadRollout(
        transaction: Transaction,
        id: Digest
    ): MaterializationRollout | undefined;
    public abstract loadPlan(transaction: Transaction, id: Digest): MaterializationPlan | undefined;
    public abstract insertOutbox(transaction: Transaction, entry: MaterializationOutboxEntry): void;
    public abstract loadOutbox(
        transaction: Transaction,
        id: Digest
    ): MaterializationOutboxEntry | undefined;
    public abstract listOutbox(
        transaction: Transaction,
        rolloutId: Digest
    ): readonly MaterializationOutboxEntry[];
    public abstract compareAndSetOutbox(
        transaction: Transaction,
        expected: Revision,
        entry: MaterializationOutboxEntry
    ): boolean;
}

export abstract class MaterializationPlanAdmissionPort {
    public abstract permits(plan: MaterializationPlan, attestation: ValidationAttestation): boolean;
}

export class MaterializationRolloutController<Transaction> {
    public constructor(
        private readonly store: MaterializationControlStore<Transaction>,
        private readonly admission: MaterializationPlanAdmissionPort
    ) {}

    public begin(
        plan: MaterializationPlan,
        key: DeploymentKey,
        previous?: MaterializationPlan,
        compensates?: Digest,
        attestation?: ValidationAttestation
    ): MaterializationRollout {
        return this.store.transaction((transaction) => {
            if (attestation !== undefined) {
                requirePlanAttestation(plan, attestation);
                this.store.insertAttestation(transaction, attestation);
            }
            const persistedAttestation = required(
                this.store.loadAttestation(transaction, plan.origin.attestationDigest),
                "validation attestation"
            );
            requirePlanAttestation(plan, persistedAttestation);
            if (!this.admission.permits(plan, persistedAttestation)) {
                throw invalidDefinitionState(
                    "Materialization plan topology is not admitted by its validation authority"
                );
            }
            const existing = this.store.loadDeployment(transaction, plan.origin.deploymentId);
            const deployment = existing ?? DeploymentRecord.initial(plan.origin.tenantId, key);
            if (
                !deployment.id.equals(plan.origin.deploymentId) ||
                !deployment.tenantId.equals(plan.origin.tenantId) ||
                !deployment.key.equals(key)
            ) {
                throw invalidDefinition("Materialization plan targets a different deployment");
            }
            if (
                existing === undefined &&
                !this.store.compareAndSetDeployment(transaction, undefined, deployment)
            ) {
                throw definitionRevisionConflict(
                    "Deployment changed while initializing materialization rollout"
                );
            }
            const active =
                deployment.activePlanId === undefined
                    ? undefined
                    : required(
                          this.store.loadPlan(transaction, deployment.activePlanId),
                          "active plan"
                      );
            if (
                previous !== undefined &&
                (deployment.activePlanId === undefined ||
                    !previous.id.equals(deployment.activePlanId))
            ) {
                throw invalidDefinitionState(
                    "Materialization predecessor does not match the active plan"
                );
            }
            let completePlan = unionTargetPlan(active, plan);
            let rollout = new MaterializationRollout({
                plan: completePlan,
                ...(active === undefined ? {} : { previousPlanId: active.id }),
                ...(compensates === undefined ? {} : { compensates })
            });
            if (deployment.pendingRolloutId !== undefined) {
                const pending = required(
                    this.store.loadRollout(transaction, deployment.pendingRolloutId),
                    "pending rollout"
                );
                if (pending.id.equals(rollout.id)) return pending;
                if (
                    compensates !== undefined &&
                    pending.compensates?.equals(compensates) === true
                ) {
                    const retryPlan = unionTargetPlan(pending.plan, completePlan);
                    const retry = new MaterializationRollout({
                        plan: retryPlan,
                        ...(active === undefined ? {} : { previousPlanId: active.id }),
                        compensates: pending.compensates
                    });
                    if (retry.id.equals(pending.id)) return pending;
                }
                if (compensates?.equals(pending.id) !== true) {
                    throw invalidDefinitionState(
                        "Deployment already has a different pending rollout"
                    );
                }
                completePlan = unionTargetPlan(pending.plan, completePlan);
                rollout = new MaterializationRollout({
                    plan: completePlan,
                    ...(active === undefined ? {} : { previousPlanId: active.id }),
                    compensates: pending.id
                });
            }
            if (
                compensates !== undefined &&
                this.store.loadRollout(transaction, compensates) === undefined
            ) {
                throw invalidDefinitionState("Compensation references an unknown rollout");
            }
            const next =
                compensates === undefined
                    ? deployment.begin(rollout.id, completePlan.generation)
                    : deployment.compensate(compensates, rollout.id, completePlan.generation);
            this.store.insertRollout(transaction, rollout);
            for (const actorPlan of completePlan.actors) {
                this.store.insertOutbox(
                    transaction,
                    MaterializationOutboxEntry.pending(rollout.id, actorPlan)
                );
            }
            if (!this.store.compareAndSetDeployment(transaction, deployment.revision, next)) {
                throw definitionRevisionConflict(
                    "Deployment changed while beginning materialization rollout"
                );
            }
            return rollout;
        });
    }

    public acknowledge(
        entryId: Digest,
        receipt: MaterializationApplyReceipt
    ): MaterializationOutboxEntry {
        return this.store.transaction((transaction) => {
            const entry = required(this.store.loadOutbox(transaction, entryId), "outbox entry");
            if (
                receipt.outcome !== "applied" ||
                !receipt.outboxId.equals(entry.id) ||
                !receipt.rolloutId.equals(entry.rolloutId) ||
                !receipt.actorPlanId.equals(entry.actorPlanId)
            ) {
                throw invalidDefinitionState(
                    "Materialization acknowledgement does not match its target apply receipt"
                );
            }
            const acknowledged = entry.acknowledge(receipt.replyDigest);
            if (acknowledged === entry) return entry;
            if (!this.store.compareAndSetOutbox(transaction, entry.revision, acknowledged)) {
                throw definitionRevisionConflict(
                    "Materialization outbox changed while acknowledging delivery"
                );
            }
            return acknowledged;
        });
    }

    public complete(rolloutId: Digest): DeploymentRecord {
        return this.store.transaction((transaction) => {
            const rollout = required(this.store.loadRollout(transaction, rolloutId), "rollout");
            const entries = this.store.listOutbox(transaction, rolloutId);
            requireExactOutboxClosure(rollout, entries);
            if (entries.some((entry) => entry.status !== "acknowledged")) {
                throw invalidDefinitionState(
                    "Materialization rollout cannot complete with pending targets"
                );
            }
            const deployment = required(
                this.store.loadDeployment(transaction, rollout.plan.origin.deploymentId),
                "deployment"
            );
            if (
                deployment.pendingRolloutId === undefined &&
                deployment.activePlanId?.equals(rollout.plan.id) === true
            ) {
                return deployment;
            }
            const complete = deployment.complete(rolloutId, rollout.plan.id);
            if (!this.store.compareAndSetDeployment(transaction, deployment.revision, complete)) {
                throw definitionRevisionConflict(
                    "Deployment changed while completing materialization rollout"
                );
            }
            return complete;
        });
    }
}

export function requirePlanAttestation(
    plan: MaterializationPlan,
    attestation: ValidationAttestation
): void {
    if (
        !attestation.id.equals(plan.origin.attestationDigest) ||
        !attestation.blueprintDigest.equals(plan.origin.blueprintDigest) ||
        !attestation.packageLockDigest.equals(plan.origin.packageLockDigest)
    ) {
        throw invalidDefinitionState(
            "Materialization plan does not match its persisted validation attestation"
        );
    }
}

export function expectedOutboxEntries(
    rollout: MaterializationRollout
): readonly MaterializationOutboxEntry[] {
    return Object.freeze(
        rollout.plan.actors
            .map((actorPlan) => MaterializationOutboxEntry.pending(rollout.id, actorPlan))
            .sort((left, right) => compareText(left.id.value, right.id.value))
    );
}

export function requireExactOutboxClosure(
    rollout: MaterializationRollout,
    entries: readonly MaterializationOutboxEntry[]
): void {
    const expected = expectedOutboxEntries(rollout);
    const actual = [...entries].sort((left, right) => compareText(left.id.value, right.id.value));
    if (
        expected.length !== actual.length ||
        expected.some((entry, index) => {
            const candidate = actual[index]!;
            return (
                !candidate.id.equals(entry.id) ||
                !candidate.rolloutId.equals(entry.rolloutId) ||
                !candidate.target.equals(entry.target) ||
                !candidate.actorPlanId.equals(entry.actorPlanId)
            );
        })
    ) {
        throw invalidDefinitionState(
            "Materialization rollout outbox does not match its exact target closure"
        );
    }
}

export function isLegalOutboxTransition(
    current: MaterializationOutboxEntry,
    next: MaterializationOutboxEntry
): boolean {
    const attempted = current.attempted();
    if (
        MaterializationOutboxEntry.encode(attempted).every(
            (value, index) => value === MaterializationOutboxEntry.encode(next)[index]
        )
    )
        return true;
    return (
        next.status === "acknowledged" &&
        current.status === "pending" &&
        next.attempts === current.attempts &&
        next.revision.equals(current.revision.next()) &&
        next.id.equals(current.id) &&
        next.rolloutId.equals(current.rolloutId) &&
        next.actorPlanId.equals(current.actorPlanId) &&
        next.target.equals(current.target)
    );
}

export function isLegalDeploymentTransition(
    current: DeploymentRecord | undefined,
    next: DeploymentRecord
): boolean {
    if (current === undefined)
        return (
            next.revision.value === 0 &&
            next.nextGeneration === 1 &&
            next.activePlanId === undefined &&
            next.pendingRolloutId === undefined
        );
    if (
        !next.id.equals(current.id) ||
        !next.tenantId.equals(current.tenantId) ||
        !next.key.equals(current.key) ||
        !next.revision.equals(current.revision.next())
    )
        return false;
    if (current.pendingRolloutId === undefined) {
        return (
            next.pendingRolloutId !== undefined &&
            sameOptionalDigest(next.activePlanId, current.activePlanId) &&
            next.nextGeneration === current.nextGeneration + 1
        );
    }
    const completion =
        next.pendingRolloutId === undefined &&
        next.activePlanId !== undefined &&
        next.nextGeneration === current.nextGeneration;
    const compensation =
        next.pendingRolloutId !== undefined &&
        !next.pendingRolloutId.equals(current.pendingRolloutId) &&
        sameOptionalDigest(next.activePlanId, current.activePlanId) &&
        next.nextGeneration === current.nextGeneration + 1;
    return completion || compensation;
}

function sameOptionalDigest(left: Digest | undefined, right: Digest | undefined): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

export function forwardRollbackPlan(
    active: MaterializationPlan,
    failed: MaterializationPlan,
    origin: ManagedOrigin
): MaterializationPlan {
    if (
        !active.origin.deploymentId.equals(failed.origin.deploymentId) ||
        !active.origin.deploymentId.equals(origin.deploymentId) ||
        !active.origin.tenantId.equals(origin.tenantId) ||
        origin.generation <= failed.generation
    ) {
        throw invalidDefinition("Forward rollback must advance the same Tenant deployment");
    }
    const activeByActor = new Map(active.actors.map((plan) => [actorKey(plan.actor), plan]));
    const actors = canonicalActors([...active.actors, ...failed.actors]).map((actor) => {
        const prior = activeByActor.get(actorKey(actor));
        return new ActorPlan({
            actor,
            origin,
            projections: prior?.projections ?? []
        });
    });
    return new MaterializationPlan({ origin, actors });
}

function unionTargetPlan(
    previous: MaterializationPlan | undefined,
    desired: MaterializationPlan
): MaterializationPlan {
    if (previous === undefined) return desired;
    if (
        !previous.origin.deploymentId.equals(desired.origin.deploymentId) ||
        !previous.origin.tenantId.equals(desired.origin.tenantId)
    ) {
        throw invalidDefinition("Materialization rollout plans belong to different deployments");
    }
    const desiredByActor = new Map(desired.actors.map((plan) => [actorKey(plan.actor), plan]));
    const actors = canonicalActors([...previous.actors, ...desired.actors]).map(
        (actor) =>
            desiredByActor.get(actorKey(actor)) ??
            new ActorPlan({
                actor,
                origin: desired.origin,
                projections: []
            })
    );
    return new MaterializationPlan({ origin: desired.origin, actors });
}

function canonicalActors(plans: readonly ActorPlan[]): readonly ActorRef[] {
    const byKey = new Map(plans.map((plan) => [actorKey(plan.actor), plan.actor]));
    return [...byKey.values()].sort((left, right) => compareText(actorKey(left), actorKey(right)));
}

function actorData(actor: ActorRef): JsonValue {
    return { id: actor.id.value, kind: actor.kind };
}

function requireActor(value: JsonValue): ActorRef {
    const object = requireObject(value, "Materialization target Actor");
    requireFields(object, ["id", "kind"], "Materialization target Actor");
    const kind = requireString(object["kind"], "Materialization target Actor kind");
    if (
        kind !== "tenant" &&
        kind !== "workspace" &&
        kind !== "run" &&
        kind !== "environment" &&
        kind !== "slate"
    ) {
        throw new TypeError("Materialization target Actor kind is invalid");
    }
    const id = requireString(object["id"], "Materialization target Actor ID");
    return new ActorRef(kind, new ActorId(id));
}

function actorKey(actor: ActorRef): string {
    return `${actor.kind}\0${actor.id.value}`;
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireFields(
    object: { readonly [key: string]: JsonValue },
    fields: readonly string[],
    subject: string
): void {
    if (!hasExactJsonKeys(object, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}

function requireInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

function optionalDigest(value: JsonValue | undefined, subject: string): Digest | undefined {
    return value === null ? undefined : digestValue(value, subject);
}

function digestValue(value: JsonValue | undefined, subject: string): Digest {
    return new Digest(requireString(value, subject));
}

function requireSafeGeneration(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${subject} must be a positive safe integer`);
    }
}

function increment(value: number, subject: string): number {
    if (value === Number.MAX_SAFE_INTEGER)
        throw definitionRevisionConflict(`${subject} cannot advance`);
    return value + 1;
}

function required<Value>(value: Value | undefined, subject: string): Value {
    if (value === undefined) throw invalidDefinitionState(`Missing materialization ${subject}`);
    return value;
}
