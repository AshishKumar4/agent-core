import { ActorId, ActorRef, type ActorKind } from "../actors";
import { RunId, TurnId, type LeaseToken } from "../agents";
import { Digest, RecordCodec, Revision, TextId, type JsonValue } from "../core";
import { ProtectionDomain } from "../facets";
import {
    PrincipalId,
    PrincipalRef,
    ProjectId,
    ScopeRef,
    TenantId,
    WorkspaceId
} from "../identity";
import { requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { InvalidationWatermark, ScopeEpoch } from "./epoch";

export interface TargetLeaseEvidenceTarget {
    readonly actor: ActorRef;
    readonly fence: number;
    readonly domain: ProtectionDomain;
}

/** The stable source-delivery identity for one immutable lease attestation. */
export class TargetLeaseEvidenceKey {
    public readonly source: ActorRef;
    public readonly idempotencyKey: string;

    public constructor(source: ActorRef, idempotencyKey: string) {
        if (idempotencyKey.length === 0 || idempotencyKey !== idempotencyKey.trim()) {
            throw new TypeError("Target lease evidence idempotency key must be canonical and nonblank");
        }
        this.source = new ActorRef(source.kind, new ActorId(source.id.value));
        this.idempotencyKey = idempotencyKey;
        Object.freeze(this);
    }

    public equals(other: TargetLeaseEvidenceKey): boolean {
        return (
            this.source.equals(other.source) && this.idempotencyKey === other.idempotencyKey
        );
    }

    public toData(): JsonObject {
        return {
            idempotencyKey: this.idempotencyKey,
            source: { id: this.source.id.value, kind: this.source.kind }
        };
    }

    public static fromData(value: JsonValue | undefined): TargetLeaseEvidenceKey {
        const object = requireObject(value, "Target lease evidence key");
        requireExact(object, ["idempotencyKey", "source"], "Target lease evidence key");
        const source = requireObject(object["source"], "Target lease evidence source");
        requireExact(source, ["id", "kind"], "Target lease evidence source");
        return new TargetLeaseEvidenceKey(
            new ActorRef(
                requireActorKind(source["kind"]),
                new ActorId(requireString(source, "id", "Target lease evidence source ID"))
            ),
            requireString(object, "idempotencyKey", "Target lease evidence idempotency key")
        );
    }
}

/** The exact immutable source evidence a target request names. */
export class TargetLeaseEvidenceReference {
    public readonly key: TargetLeaseEvidenceKey;
    public readonly digest: Digest;

    public constructor(key: TargetLeaseEvidenceKey, digest: Digest) {
        this.key = TargetLeaseEvidenceKey.fromData(key.toData());
        this.digest = new Digest(digest.value);
        Object.freeze(this);
    }

    public equals(other: TargetLeaseEvidenceReference): boolean {
        return this.key.equals(other.key) && this.digest.equals(other.digest);
    }

    public toData(): JsonObject {
        return { ...this.key.toData(), digest: this.digest.value };
    }

    public static fromData(value: JsonValue | undefined): TargetLeaseEvidenceReference {
        const object = requireObject(value, "Target lease evidence reference");
        requireExact(
            object,
            ["digest", "idempotencyKey", "source"],
            "Target lease evidence reference"
        );
        return new TargetLeaseEvidenceReference(
            TargetLeaseEvidenceKey.fromData({
                idempotencyKey: object["idempotencyKey"],
                source: object["source"]
            }),
            new Digest(requireString(object, "digest", "Target lease evidence digest"))
        );
    }
}


export interface TargetLeaseEvidenceBinding {
    readonly key: TargetLeaseEvidenceKey;
    readonly tenant: TenantId;
    readonly run: RunId;
    readonly lease: LeaseToken;
    readonly target: TargetLeaseEvidenceTarget;
    readonly requestIdentity: Digest;
}

export interface TargetLeaseEvidenceInit extends TargetLeaseEvidenceBinding {
    readonly deadline: Date;
    readonly watermark: InvalidationWatermark;
}

class TargetLeaseEvidenceCodec extends RecordCodec<TargetLeaseEvidence> {
    public constructor() {
        super(
            [
                TargetLeaseEvidence,
                TargetLeaseEvidenceReference,
                TargetLeaseEvidenceKey,
                ActorRef,
                ActorId,
                Digest,
                InvalidationWatermark,
                Revision,
                ScopeEpoch,
                ScopeRef,
                ProtectionDomain,
                RunId,
                TenantId,
                WorkspaceId,
                ProjectId,
                TextId,
                TurnId,
                PrincipalId,
                PrincipalRef
            ],
            "authority.target-lease-evidence",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(record: TargetLeaseEvidence): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): TargetLeaseEvidence {
        return TargetLeaseEvidence.fromData(payload);
    }
}

/**
 * A source-Actor's immutable attestation that one exact Turn lease authorizes one target
 * permit-request identity. It snapshots evidence and never represents current lease state.
 */
export class TargetLeaseEvidence {
    public static get codec(): RecordCodec<TargetLeaseEvidence> {
        return targetLeaseEvidenceCodecInstance;
    }

    readonly #deadline: number;
    public readonly key: TargetLeaseEvidenceKey;
    public readonly tenant: TenantId;
    public readonly run: RunId;
    public readonly lease: LeaseToken;
    public readonly target: TargetLeaseEvidenceTarget;
    public readonly requestIdentity: Digest;
    public readonly watermark: InvalidationWatermark;

    public constructor(init: TargetLeaseEvidenceInit) {
        if (!init.lease.holder.tenantId.equals(init.tenant)) {
            throw new TypeError("Target lease evidence lease holder must belong to its Tenant");
        }
        if (
            !init.watermark.ownerTenant.equals(init.tenant) ||
            !init.watermark.owner.equals(init.key.source) ||
            !init.watermark.holder.equals(init.lease.holder)
        ) {
            throw new TypeError("Target lease evidence watermark has the wrong source identity");
        }
        if (!Number.isSafeInteger(init.target.fence) || init.target.fence < 0) {
            throw new TypeError("Target lease evidence target fence is invalid");
        }
        this.#deadline = validTime(init.deadline, "Target lease evidence deadline");
        this.key = TargetLeaseEvidenceKey.fromData(init.key.toData());
        this.tenant = new TenantId(init.tenant.value);
        this.run = new RunId(init.run.value);
        this.lease = Object.freeze({
            turn: new TurnId(init.lease.turn.value),
            holder: new PrincipalRef(init.lease.holder.tenantId, init.lease.holder.principalId),
            epoch: requireEpoch(init.lease.epoch)
        });
        this.target = Object.freeze({
            actor: new ActorRef(init.target.actor.kind, new ActorId(init.target.actor.id.value)),
            fence: init.target.fence,
            domain: new ProtectionDomain(
                init.target.domain.kind,
                init.target.domain.label,
                init.target.domain.secretPolicy
            )
        });
        this.requestIdentity = new Digest(init.requestIdentity.value);
        this.watermark = InvalidationWatermark.fromData(init.watermark.toData());
        Object.freeze(this);
    }


    public reference(): TargetLeaseEvidenceReference {
        return new TargetLeaseEvidenceReference(this.key, this.digest());
    }
    public get deadline(): Date {
        return new Date(this.#deadline);
    }

    public digest(): Digest {
        return Digest.sha256(TargetLeaseEvidence.encode(this));
    }

    public isCurrentAt(now: Date): boolean {
        return validTime(now, "Target lease evidence observation time") < this.#deadline;
    }

    public matches(binding: TargetLeaseEvidenceBinding): boolean {
        return (
            this.key.equals(binding.key) &&
            this.tenant.equals(binding.tenant) &&
            this.run.equals(binding.run) &&
            this.lease.turn.equals(binding.lease.turn) &&
            this.lease.holder.equals(binding.lease.holder) &&
            this.lease.epoch === binding.lease.epoch &&
            this.target.actor.equals(binding.target.actor) &&
            this.target.fence === binding.target.fence &&
            this.target.domain.equals(binding.target.domain) &&
            this.requestIdentity.equals(binding.requestIdentity)
        );
    }

    public toData(): JsonObject {
        return {
            deadline: this.#deadline,
            key: this.key.toData(),
            lease: {
                epoch: this.lease.epoch,
                holder: {
                    principal: this.lease.holder.principalId.value,
                    tenant: this.lease.holder.tenantId.value
                },
                turn: this.lease.turn.value
            },
            requestIdentity: this.requestIdentity.value,
            run: this.run.value,
            target: {
                actor: { id: this.target.actor.id.value, kind: this.target.actor.kind },
                domain: {
                    kind: this.target.domain.kind,
                    label: this.target.domain.label,
                    secretPolicy: this.target.domain.secretPolicy
                },
                fence: this.target.fence
            },
            tenant: this.tenant.value,
            watermark: this.watermark.toData()
        };
    }

    public static encode(record: TargetLeaseEvidence): Uint8Array {
        return TargetLeaseEvidence.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): TargetLeaseEvidence {
        return TargetLeaseEvidence.codec.decode(bytes);
    }

    public static fromData(value: JsonValue | undefined): TargetLeaseEvidence {
        const object = requireObject(value, "Target lease evidence");
        requireExact(
            object,
            ["deadline", "key", "lease", "requestIdentity", "run", "target", "tenant", "watermark"],
            "Target lease evidence"
        );
        const lease = requireObject(object["lease"], "Target lease evidence lease");
        const holder = requireObject(lease["holder"], "Target lease evidence holder");
        const target = requireObject(object["target"], "Target lease evidence target");
        const targetActor = requireObject(target["actor"], "Target lease evidence target Actor");
        const domain = requireObject(target["domain"], "Target lease evidence target domain");
        requireExact(lease, ["epoch", "holder", "turn"], "Target lease evidence lease");
        requireExact(holder, ["principal", "tenant"], "Target lease evidence holder");
        requireExact(target, ["actor", "domain", "fence"], "Target lease evidence target");
        requireExact(targetActor, ["id", "kind"], "Target lease evidence target Actor");
        requireExact(domain, ["kind", "label", "secretPolicy"], "Target lease evidence target domain");
        return new TargetLeaseEvidence({
            key: TargetLeaseEvidenceKey.fromData(object["key"]),
            tenant: new TenantId(requireString(object, "tenant", "Target lease evidence Tenant")),
            run: new RunId(requireString(object, "run", "Target lease evidence Run")),
            lease: Object.freeze({
                turn: new TurnId(requireString(lease, "turn", "Target lease evidence Turn")),
                holder: new PrincipalRef(
                    new TenantId(requireString(holder, "tenant", "Target lease evidence holder Tenant")),
                    new PrincipalId(
                        requireString(holder, "principal", "Target lease evidence holder Principal")
                    )
                ),
                epoch: requireSafeInteger(lease, "epoch", "Target lease evidence lease epoch")
            }),
            target: {
                actor: new ActorRef(
                    requireActorKind(targetActor["kind"]),
                    new ActorId(
                        requireString(targetActor, "id", "Target lease evidence target Actor ID")
                    )
                ),
                fence: requireSafeInteger(target, "fence", "Target lease evidence target fence"),
                domain: new ProtectionDomain(
                    requireDomainKind(domain["kind"]),
                    requireString(domain, "label", "Target lease evidence target domain label"),
                    requireSecretPolicy(domain["secretPolicy"])
                )
            },
            requestIdentity: new Digest(
                requireString(object, "requestIdentity", "Target lease evidence request identity")
            ),
            deadline: new Date(
                requireSafeInteger(object, "deadline", "Target lease evidence deadline")
            ),
            watermark: InvalidationWatermark.fromData(object["watermark"])
        });
    }
}

const targetLeaseEvidenceCodecInstance = new TargetLeaseEvidenceCodec();

function requireEpoch(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Target lease evidence lease epoch is invalid");
    }
    return value;
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
    throw new TypeError("Target lease evidence Actor kind is invalid");
}

function requireDomainKind(value: JsonValue | undefined): "frontend" | "backend" {
    if (value === "frontend" || value === "backend") return value;
    throw new TypeError("Target lease evidence target domain kind is invalid");
}

function requireSecretPolicy(value: JsonValue | undefined): "no-secrets" | "may-hold-secrets" {
    if (value === "no-secrets" || value === "may-hold-secrets") return value;
    throw new TypeError("Target lease evidence target domain secret policy is invalid");
}

function validTime(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
        throw new TypeError(`${subject} must be a valid non-negative Date`);
    }
    return time;
}
