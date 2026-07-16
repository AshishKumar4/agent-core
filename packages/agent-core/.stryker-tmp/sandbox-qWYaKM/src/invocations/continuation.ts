// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import { Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core";
import {
    requireDate,
    requireDigest,
    requireExactObject,
    requireNonnegativeInteger,
    requireObject,
    requireString,
    immutableReference,
    validDate,
    type StructuralCodec
} from "./codec";
import type { ItemClaimOwner } from "./claim";
import { ApprovalId, ClaimWorkerId, EffectAttemptId, ItemClaimId } from "./id";
import { InvocationId } from "../interaction-references";

export class InvocationContinuation<Lease> {
    readonly #admittedAt: number;
    public readonly firstClaimOwner: ItemClaimOwner<Lease>;

    public constructor(
        public readonly invocation: InvocationId,
        public readonly intentDigest: Digest,
        public readonly approval: ApprovalId,
        public readonly firstAttempt: EffectAttemptId,
        public readonly firstItemIndex: number,
        public readonly firstOrdinal: number,
        public readonly firstClaim: ItemClaimId,
        firstClaimOwner: ItemClaimOwner<Lease>,
        public readonly firstItemKey: string,
        admittedAt: Date
    ) {
        if (
            invocation.constructor !== InvocationId ||
            approval.constructor !== ApprovalId ||
            firstAttempt.constructor !== EffectAttemptId ||
            firstClaim.constructor !== ItemClaimId
        ) {
            throw new TypeError(
                "InvocationContinuation identifiers must use exact context classes"
            );
        }
        requireIndex(firstItemIndex, "Continuation first item index");
        requireIndex(firstOrdinal, "Continuation first ordinal");
        if (firstItemKey.trim().length === 0 || firstItemKey !== firstItemKey.trim()) {
            throw new TypeError("Continuation first item key must be canonical");
        }
        this.firstClaimOwner = copyOwner(firstClaimOwner);
        this.#admittedAt = validDate(admittedAt, "Continuation admission time");
        Object.freeze(intentDigest);
        Object.freeze(this);
    }

    public static encode<Lease>(
        record: InvocationContinuation<Lease>,
        lease: StructuralCodec<Lease>
    ): Uint8Array {
        return new InvocationContinuationCodec(lease).encode(record);
    }

    public static decode<Lease>(
        bytes: Uint8Array,
        lease: StructuralCodec<Lease>
    ): InvocationContinuation<Lease> {
        return new InvocationContinuationCodec(lease).decode(bytes);
    }

    public get admittedAt(): Date {
        return new Date(this.#admittedAt);
    }
}

export class InvocationContinuationCodec<Lease> extends RecordCodec<InvocationContinuation<Lease>> {
    public constructor(private readonly lease: StructuralCodec<Lease>) {
        super("invocation.continuation", { major: 1, minor: 0 });
    }

    protected encodePayload(record: InvocationContinuation<Lease>): JsonValue {
        return {
            admittedAt: record.admittedAt.toISOString(),
            approval: record.approval.value,
            firstAttempt: record.firstAttempt.value,
            firstClaim: record.firstClaim.value,
            firstClaimOwner: encodeOwner(record.firstClaimOwner, this.lease),
            firstItemIndex: record.firstItemIndex,
            firstItemKey: record.firstItemKey,
            firstOrdinal: record.firstOrdinal,
            intentDigest: record.intentDigest.value,
            invocation: record.invocation.value
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): InvocationContinuation<Lease> {
        const object = requireExactObject(
            payload,
            [
                "admittedAt",
                "approval",
                "firstAttempt",
                "firstClaim",
                "firstClaimOwner",
                "firstItemIndex",
                "firstItemKey",
                "firstOrdinal",
                "intentDigest",
                "invocation"
            ],
            "Invocation continuation"
        );
        return new InvocationContinuation(
            new InvocationId(requireString(object, "invocation")),
            requireDigest(object, "intentDigest"),
            new ApprovalId(requireString(object, "approval")),
            new EffectAttemptId(requireString(object, "firstAttempt")),
            requireNonnegativeInteger(object, "firstItemIndex"),
            requireNonnegativeInteger(object, "firstOrdinal"),
            new ItemClaimId(requireString(object, "firstClaim")),
            decodeOwner(object["firstClaimOwner"]!, this.lease),
            requireString(object, "firstItemKey"),
            requireDate(object, "admittedAt")
        );
    }
}

function encodeOwner<Lease>(
    owner: ItemClaimOwner<Lease>,
    lease: StructuralCodec<Lease>
): JsonValue {
    return owner.kind === "executor"
        ? { kind: owner.kind, token: lease.encode(owner.token), worker: owner.worker.value }
        : {
              actor: { id: owner.actor.id.value, kind: owner.actor.kind },
              kind: owner.kind,
              worker: owner.worker.value
          };
}

function decodeOwner<Lease>(
    value: JsonValue,
    lease: StructuralCodec<Lease>
): ItemClaimOwner<Lease> {
    const candidate = requireObject(value, "Continuation claim owner");
    const object = requireExactObject(
        value,
        candidate["kind"] === "executor"
            ? ["kind", "token", "worker"]
            : ["actor", "kind", "worker"],
        "Continuation claim owner"
    );
    const kind = requireString(object, "kind");
    if (kind === "executor") {
        return Object.freeze({
            kind,
            token: lease.decode(object["token"]!),
            worker: new ClaimWorkerId(requireString(object, "worker"))
        });
    }
    if (kind !== "system") throw new TypeError("Continuation claim owner kind is invalid");
    const actor = requireExactObject(object["actor"]!, ["id", "kind"], "Continuation Actor");
    return Object.freeze({
        kind,
        actor: new ActorRef(
            requireActorKind(requireString(actor, "kind")),
            new ActorId(requireString(actor, "id"))
        ),
        worker: new ClaimWorkerId(requireString(object, "worker"))
    });
}

function copyOwner<Lease>(owner: ItemClaimOwner<Lease>): ItemClaimOwner<Lease> {
    return owner.kind === "executor"
        ? Object.freeze({
              kind: owner.kind,
              token: immutableReference(owner.token),
              worker: owner.worker
          })
        : Object.freeze({ kind: owner.kind, actor: owner.actor, worker: owner.worker });
}

function requireActorKind(value: string): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    )
        return value;
    throw new TypeError("Continuation Actor kind is invalid");
}

function requireIndex(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
}
