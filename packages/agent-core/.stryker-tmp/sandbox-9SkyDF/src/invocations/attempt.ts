// @ts-nocheck
import { Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core";
import {
    requireDate,
    requireExactObject,
    requireNonnegativeInteger,
    requireString,
    validDate,
    immutableReference,
    type StructuralCodec
} from "./codec";
import { EffectAttemptId, ItemClaimId } from "./id";
import { AuditRecordId, InvocationId } from "../interaction-references";
import { AuthorityAdmissionReference } from "./ports";

export class EffectAttempt<Lease, Admission> {
    readonly #startedAt: number;
    public readonly token: Lease | undefined;

    public static encode<Lease, Admission>(
        record: EffectAttempt<Lease, Admission>,
        lease: StructuralCodec<Lease>,
        admission: StructuralCodec<Admission>
    ): Uint8Array {
        return new EffectAttemptCodec(lease, admission).encode(record);
    }

    public static decode<Lease, Admission>(
        bytes: Uint8Array,
        lease: StructuralCodec<Lease>,
        admission: StructuralCodec<Admission>
    ): EffectAttempt<Lease, Admission> {
        return new EffectAttemptCodec(lease, admission).decode(bytes);
    }

    public constructor(
        public readonly id: EffectAttemptId,
        public readonly invocation: InvocationId,
        public readonly itemIndex: number,
        public readonly ordinal: number,
        public readonly claim: ItemClaimId,
        token: Lease | undefined,
        public readonly admission: AuthorityAdmissionReference<Admission>,
        startedAt: Date,
        public readonly idempotencyKey: string,
        public readonly auditCause: AuditRecordId
    ) {
        if (
            id.constructor !== EffectAttemptId ||
            invocation.constructor !== InvocationId ||
            claim.constructor !== ItemClaimId ||
            auditCause.constructor !== AuditRecordId
        ) {
            throw new TypeError("EffectAttempt identifiers must use exact context classes");
        }
        if (
            !Number.isSafeInteger(itemIndex) ||
            itemIndex < 0 ||
            !Number.isSafeInteger(ordinal) ||
            ordinal < 0
        ) {
            throw new TypeError(
                "Effect attempt item and ordinal must be non-negative safe integers"
            );
        }
        this.#startedAt = validDate(startedAt, "Effect attempt start time");
        this.token = token === undefined ? undefined : immutableReference(token);
        if (idempotencyKey.length === 0)
            throw new TypeError("Effect attempt idempotency key is required");
        Object.freeze(this);
    }

    public get startedAt(): Date {
        return new Date(this.#startedAt);
    }
}

export class EffectAttemptCodec<Lease, Admission> extends RecordCodec<
    EffectAttempt<Lease, Admission>
> {
    public constructor(
        private readonly lease: StructuralCodec<Lease>,
        private readonly admission: StructuralCodec<Admission>
    ) {
        super("invocation.effect-attempt", { major: 1, minor: 0 });
    }

    protected encodePayload(record: EffectAttempt<Lease, Admission>): JsonValue {
        return {
            admission: {
                digest: record.admission.digest.value,
                reference: this.admission.encode(record.admission.reference)
            },
            auditCause: record.auditCause.value,
            claim: record.claim.value,
            id: record.id.value,
            idempotencyKey: record.idempotencyKey,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.ordinal,
            startedAt: record.startedAt.toISOString(),
            token: record.token === undefined ? null : this.lease.encode(record.token)
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): EffectAttempt<Lease, Admission> {
        const object = requireExactObject(
            payload,
            [
                "admission",
                "auditCause",
                "claim",
                "id",
                "idempotencyKey",
                "invocation",
                "itemIndex",
                "ordinal",
                "startedAt",
                "token"
            ],
            "Effect attempt"
        );
        const token = object["token"];
        return new EffectAttempt(
            new EffectAttemptId(requireString(object, "id")),
            new InvocationId(requireString(object, "invocation")),
            requireNonnegativeInteger(object, "itemIndex"),
            requireNonnegativeInteger(object, "ordinal"),
            new ItemClaimId(requireString(object, "claim")),
            token === null ? undefined : this.lease.decode(token!),
            decodeAdmission(object["admission"]!, this.admission),
            requireDate(object, "startedAt"),
            requireString(object, "idempotencyKey"),
            new AuditRecordId(requireString(object, "auditCause"))
        );
    }
}

function decodeAdmission<Admission>(
    value: JsonValue,
    codec: StructuralCodec<Admission>
): AuthorityAdmissionReference<Admission> {
    const object = requireExactObject(
        value,
        ["digest", "reference"],
        "Authority admission reference"
    );
    return new AuthorityAdmissionReference(
        codec.decode(object["reference"]!),
        new Digest(requireString(object, "digest"))
    );
}
