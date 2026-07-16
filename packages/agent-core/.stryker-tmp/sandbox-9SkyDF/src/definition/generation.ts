// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    Digest,
    RecordCodec,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import {
    canonicalMaterializationDesired,
    supportedMaterializationKinds
} from "./materialization-kind";
import { ManagedOrigin } from "./origin";
import type { ActorPlan, DesiredProjection } from "./plan";
import { DeploymentId, MaterializationGenerationId } from "./id";
import { compareText } from "./order";

export interface ManagedStateRecordInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly generationId: MaterializationGenerationId;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest?: Digest;
    readonly resourceId?: Digest;
    readonly id?: Digest;
}

class ManagedStateRecordCodec extends RecordCodec<ManagedStateRecord> {
    public constructor() {
        super("definition.managed-state", { major: 2, minor: 0 });
    }

    protected encodePayload(record: ManagedStateRecord): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): ManagedStateRecord {
        return ManagedStateRecord.fromData(payload);
    }
}

export class ManagedStateRecord {
    public static readonly codec: RecordCodec<ManagedStateRecord> = new ManagedStateRecordCodec();

    public static supportedRecordKinds(): readonly string[] {
        return supportedMaterializationKinds();
    }

    public readonly id: Digest;
    public readonly resourceId: Digest;
    public readonly actor: ActorRef;
    public readonly origin: ManagedOrigin;
    public readonly generationId: MaterializationGenerationId;
    public readonly logicalKey: string;
    public readonly recordKind: string;
    public readonly desired: JsonValue;
    public readonly desiredDigest: Digest;

    public constructor(init: ManagedStateRecordInit) {
        const logicalKey = init.logicalKey;
        const recordKind = init.recordKind;
        const generationId = init.generationId;
        const expectedDigest = init.desiredDigest;
        const expectedId = init.id;
        requireCanonicalName(logicalKey, "Managed state logical key");
        requireCanonicalName(recordKind, "Managed state record kind");
        const actor = copyActorRef(init.actor);
        const desired = canonicalData(
            canonicalMaterializationDesired(recordKind, canonicalData(init.desired))
        );
        const desiredDigest = digestData({ desired, recordKind });
        if (expectedDigest !== undefined && !expectedDigest.equals(desiredDigest)) {
            throw new TypeError("Managed state digest does not match its canonical contents");
        }
        const resourceId = managedResourceId(actor, init.origin, logicalKey, recordKind);
        if (init.resourceId !== undefined && !init.resourceId.equals(resourceId)) {
            throw new TypeError("Managed resource ID does not match its stable identity");
        }
        const id = managedStateRecordId(actor, generationId, resourceId, desiredDigest);
        if (expectedId !== undefined && !expectedId.equals(id)) {
            throw new TypeError("Managed state ID does not match its canonical contents");
        }
        this.id = id;
        this.resourceId = resourceId;
        this.actor = actor;
        this.origin = init.origin;
        this.generationId = generationId;
        this.logicalKey = logicalKey;
        this.recordKind = recordKind;
        this.desired = desired;
        this.desiredDigest = desiredDigest;
        Object.freeze(this);
    }

    public static fromProjection(
        actor: ActorRef,
        origin: ManagedOrigin,
        generationId: MaterializationGenerationId,
        projection: DesiredProjection
    ): ManagedStateRecord {
        return new ManagedStateRecord({
            actor,
            origin,
            generationId,
            logicalKey: projection.logicalKey,
            recordKind: projection.recordKind,
            desired: projection.desired,
            desiredDigest: projection.desiredDigest
        });
    }

    public static encode(record: ManagedStateRecord): Uint8Array {
        return ManagedStateRecord.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): ManagedStateRecord {
        return ManagedStateRecord.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): ManagedStateRecord {
        const object = requireObject(payload, "Managed state");
        requireFields(
            object,
            [
                "actor",
                "desired",
                "desiredDigest",
                "generationId",
                "id",
                "logicalKey",
                "origin",
                "recordKind",
                "resourceId"
            ],
            "Managed state"
        );
        return new ManagedStateRecord({
            actor: actorRefFromData(requireValue(object["actor"], "Managed state actor")),
            desired: requireValue(object["desired"], "Managed state desired value"),
            desiredDigest: digestFromData(object["desiredDigest"], "Managed state desired digest"),
            generationId: materializationGenerationIdFromData(
                object["generationId"],
                "Managed state generation ID"
            ),
            id: digestFromData(object["id"], "Managed state ID"),
            resourceId: digestFromData(object["resourceId"], "Managed resource ID"),
            logicalKey: requireString(object["logicalKey"], "Managed state logical key"),
            origin: ManagedOrigin.fromData(requireValue(object["origin"], "Managed state origin")),
            recordKind: requireString(object["recordKind"], "Managed state record kind")
        });
    }

    public toData(): JsonValue {
        return {
            actor: actorRefData(this.actor),
            desired: this.desired,
            desiredDigest: this.desiredDigest.value,
            generationId: this.generationId.value,
            id: this.id.value,
            logicalKey: this.logicalKey,
            origin: this.origin.toData(),
            recordKind: this.recordKind,
            resourceId: this.resourceId.value
        };
    }
}

export interface MaterializationGenerationInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly actorPlanId: Digest;
    readonly managedRecordIds: readonly Digest[];
    readonly id?: MaterializationGenerationId;
}

class MaterializationGenerationCodec extends RecordCodec<MaterializationGeneration> {
    public constructor() {
        super("definition.materialization-generation", { major: 2, minor: 0 });
    }

    protected encodePayload(generation: MaterializationGeneration): JsonValue {
        return generation.toData();
    }

    protected decodePayload(payload: JsonValue): MaterializationGeneration {
        return MaterializationGeneration.fromData(payload);
    }
}

export class MaterializationGeneration {
    public static readonly codec: RecordCodec<MaterializationGeneration> =
        new MaterializationGenerationCodec();

    public readonly id: MaterializationGenerationId;
    public readonly actor: ActorRef;
    public readonly origin: ManagedOrigin;
    public readonly actorPlanId: Digest;
    public readonly managedRecordIds: readonly Digest[];

    public constructor(init: MaterializationGenerationInit) {
        const actor = copyActorRef(init.actor);
        const managedRecordIds = canonicalDigests(
            init.managedRecordIds,
            "generation managed state"
        );
        const id = materializationGenerationId(actor, init.origin, init.actorPlanId);
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError(
                "Materialization generation ID does not match its canonical contents"
            );
        }
        this.id = id;
        this.actor = actor;
        this.origin = init.origin;
        this.actorPlanId = init.actorPlanId;
        this.managedRecordIds = Object.freeze(managedRecordIds);
        Object.freeze(this);
    }

    public static fromActorPlan(plan: ActorPlan): MaterializationGeneration {
        const id = materializationGenerationId(plan.actor, plan.origin, plan.id);
        const managedRecordIds = plan.projections.map((projection) =>
            managedStateRecordId(
                plan.actor,
                id,
                managedResourceId(
                    plan.actor,
                    plan.origin,
                    projection.logicalKey,
                    projection.recordKind
                ),
                projection.desiredDigest
            )
        );
        return new MaterializationGeneration({
            actor: plan.actor,
            origin: plan.origin,
            actorPlanId: plan.id,
            managedRecordIds,
            id
        });
    }

    public static encode(generation: MaterializationGeneration): Uint8Array {
        return MaterializationGeneration.codec.encode(generation);
    }

    public static decode(bytes: Uint8Array): MaterializationGeneration {
        return MaterializationGeneration.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): MaterializationGeneration {
        const object = requireObject(payload, "Materialization generation");
        requireFields(
            object,
            ["actor", "actorPlanId", "id", "managedRecordIds", "origin"],
            "Materialization generation"
        );
        const managedRecordIds = requireArray(
            object["managedRecordIds"],
            "Materialization generation managed state IDs"
        ).map((value, index) =>
            digestFromData(value, `Materialization generation managed state ID ${index}`)
        );
        return new MaterializationGeneration({
            actor: actorRefFromData(
                requireValue(object["actor"], "Materialization generation actor")
            ),
            actorPlanId: digestFromData(
                object["actorPlanId"],
                "Materialization generation Actor plan ID"
            ),
            id: materializationGenerationIdFromData(object["id"], "Materialization generation ID"),
            managedRecordIds,
            origin: ManagedOrigin.fromData(
                requireValue(object["origin"], "Materialization generation origin")
            )
        });
    }

    public toData(): JsonValue {
        return {
            actor: actorRefData(this.actor),
            actorPlanId: this.actorPlanId.value,
            id: this.id.value,
            managedRecordIds: this.managedRecordIds.map((id) => id.value),
            origin: this.origin.toData()
        };
    }
}

export interface MaterializationGenerationPointerInit {
    readonly actor: ActorRef;
    readonly deploymentId: DeploymentId;
    readonly generationId: MaterializationGenerationId;
    readonly revision: Revision;
}

class MaterializationGenerationPointerCodec extends RecordCodec<MaterializationGenerationPointer> {
    public constructor() {
        super("definition.materialization-generation-pointer", { major: 2, minor: 0 });
    }

    protected encodePayload(pointer: MaterializationGenerationPointer): JsonValue {
        return pointer.toData();
    }

    protected decodePayload(payload: JsonValue): MaterializationGenerationPointer {
        return MaterializationGenerationPointer.fromData(payload);
    }
}

export class MaterializationGenerationPointer {
    public static readonly codec: RecordCodec<MaterializationGenerationPointer> =
        new MaterializationGenerationPointerCodec();

    public readonly actor: ActorRef;
    public readonly deploymentId: DeploymentId;
    public readonly generationId: MaterializationGenerationId;
    public readonly revision: Revision;

    public constructor(init: MaterializationGenerationPointerInit) {
        this.actor = copyActorRef(init.actor);
        this.deploymentId = new DeploymentId(init.deploymentId.value);
        this.generationId = init.generationId;
        this.revision = new Revision(init.revision.value);
        Object.freeze(this);
    }

    public static initial(
        actor: ActorRef,
        deploymentId: DeploymentId,
        generationId: MaterializationGenerationId
    ): MaterializationGenerationPointer {
        return new MaterializationGenerationPointer({
            actor,
            deploymentId,
            generationId,
            revision: Revision.initial()
        });
    }

    public activate(generationId: MaterializationGenerationId): MaterializationGenerationPointer {
        return new MaterializationGenerationPointer({
            actor: this.actor,
            deploymentId: this.deploymentId,
            generationId,
            revision: this.revision.next()
        });
    }

    public static encode(pointer: MaterializationGenerationPointer): Uint8Array {
        return MaterializationGenerationPointer.codec.encode(pointer);
    }

    public static decode(bytes: Uint8Array): MaterializationGenerationPointer {
        return MaterializationGenerationPointer.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): MaterializationGenerationPointer {
        const object = requireObject(payload, "Materialization generation pointer");
        requireFields(
            object,
            ["actor", "deploymentId", "generationId", "revision"],
            "Materialization generation pointer"
        );
        return new MaterializationGenerationPointer({
            actor: actorRefFromData(requireValue(object["actor"], "Generation pointer actor")),
            deploymentId: new DeploymentId(
                requireString(object["deploymentId"], "Generation pointer deployment ID")
            ),
            generationId: materializationGenerationIdFromData(
                object["generationId"],
                "Generation pointer generation ID"
            ),
            revision: new Revision(
                requireNonnegativeInteger(object["revision"], "Generation pointer revision")
            )
        });
    }

    public toData(): JsonValue {
        return {
            actor: actorRefData(this.actor),
            deploymentId: this.deploymentId.value,
            generationId: this.generationId.value,
            revision: this.revision.value
        };
    }
}

export function materializationGenerationId(
    actor: ActorRef,
    origin: ManagedOrigin,
    actorPlanId: Digest
): MaterializationGenerationId {
    return new MaterializationGenerationId(
        digestData({
            actor: actorRefData(actor),
            actorPlanId: actorPlanId.value,
            attestationDigest: origin.attestationDigest.value,
            blueprintDigest: origin.blueprintDigest.value,
            configDigest: origin.configDigest.value,
            deploymentId: origin.deploymentId.value,
            generation: origin.generation,
            packageLockDigest: origin.packageLockDigest.value,
            tenantId: origin.tenantId.value
        }).value
    );
}

export function managedResourceId(
    actor: ActorRef,
    origin: ManagedOrigin,
    logicalKey: string,
    recordKind: string
): Digest {
    requireCanonicalName(logicalKey, "Managed resource logical key");
    requireCanonicalName(recordKind, "Managed resource record kind");
    return digestData({
        actor: actorRefData(actor),
        deploymentId: origin.deploymentId.value,
        domain: "agent-core.managed-resource.v1",
        logicalKey,
        recordKind,
        tenantId: origin.tenantId.value
    });
}

export function managedStateRecordId(
    actor: ActorRef,
    generationId: MaterializationGenerationId,
    resourceId: Digest,
    desiredDigest: Digest
): Digest {
    return digestData({
        actor: actorRefData(actor),
        desiredDigest: desiredDigest.value,
        generationId: generationId.value,
        resourceId: resourceId.value
    });
}

function canonicalDigests(input: readonly Digest[], subject: string): Digest[] {
    const digests = [...input].sort((left, right) => compareText(left.value, right.value));
    if (new Set(digests.map((digest) => digest.value)).size !== digests.length) {
        throw new TypeError(`Materialization ${subject} IDs must be unique`);
    }
    return digests;
}

function actorRefData(actor: ActorRef): JsonValue {
    return { id: actor.id.value, kind: actor.kind };
}

function actorRefFromData(payload: JsonValue): ActorRef {
    const object = requireObject(payload, "Actor reference");
    requireFields(object, ["id", "kind"], "Actor reference");
    return new ActorRef(
        requireActorKind(object["kind"]),
        new ActorId(requireString(object["id"], "Actor ID"))
    );
}

function copyActorRef(actor: ActorRef): ActorRef {
    return Object.freeze(new ActorRef(actor.kind, new ActorId(actor.id.value)));
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new TypeError("Actor kind is invalid");
}

function canonicalData(value: JsonValue): JsonValue {
    return freezeData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function freezeData(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) freezeData(entry);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) freezeData(entry);
        return Object.freeze(value);
    }
    return value;
}

function digestData(value: JsonValue): Digest {
    return Digest.sha256(encodeCanonicalJson(value));
}

function digestFromData(value: JsonValue | undefined, subject: string): Digest {
    return new Digest(requireString(value, subject));
}

function materializationGenerationIdFromData(
    value: JsonValue | undefined,
    subject: string
): MaterializationGenerationId {
    return new MaterializationGenerationId(requireString(value, subject));
}

function requireCanonicalName(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireFields(
    value: { readonly [key: string]: JsonValue },
    fields: readonly string[],
    subject: string
): void {
    if (!hasExactJsonKeys(value, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

function requireValue(value: JsonValue | undefined, subject: string): JsonValue {
    if (value === undefined) {
        throw new TypeError(`${subject} is required`);
    }
    return value;
}
