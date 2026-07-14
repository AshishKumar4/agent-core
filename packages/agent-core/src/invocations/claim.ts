import { ActorId, ActorRef, type ActorKind } from "../actors";
import { RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireDate,
    requireExactObject,
    requireNonnegativeInteger,
    requireString,
    validDate,
    immutableReference,
    type StructuralCodec
} from "./codec";
import { ClaimWorkerId, ItemClaimId } from "./id";
import { InvocationId } from "../interaction-references";

export type ItemClaimOwner<Lease> =
    | { readonly kind: "executor"; readonly token: Lease; readonly worker: ClaimWorkerId }
    | { readonly kind: "system"; readonly actor: ActorRef; readonly worker: ClaimWorkerId };

export class ItemClaim<Lease> {
    readonly #expiresAt: number;
    public readonly owner: ItemClaimOwner<Lease>;

    public static encode<Lease>(
        record: ItemClaim<Lease>,
        lease: StructuralCodec<Lease>
    ): Uint8Array {
        return new ItemClaimCodec(lease).encode(record);
    }

    public static decode<Lease>(
        bytes: Uint8Array,
        lease: StructuralCodec<Lease>
    ): ItemClaim<Lease> {
        return new ItemClaimCodec(lease).decode(bytes);
    }

    public constructor(
        public readonly id: ItemClaimId,
        public readonly invocation: InvocationId,
        public readonly itemIndex: number,
        public readonly attemptOrdinal: number,
        owner: ItemClaimOwner<Lease>,
        expiresAt: Date
    ) {
        if (id.constructor !== ItemClaimId || invocation.constructor !== InvocationId) {
            throw new TypeError("ItemClaim identifiers must use exact context classes");
        }
        requireIndex(itemIndex, "Claim item index");
        requireIndex(attemptOrdinal, "Claim attempt ordinal");
        this.#expiresAt = validDate(expiresAt, "Claim expiry");
        this.owner = copyOwner(owner);
        Object.freeze(this);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public requireFuture(now: Date): void {
        if (this.#expiresAt <= validDate(now, "Claim time")) {
            throw new AgentCoreError("invocation.invalid", "Item claim must have a future expiry");
        }
    }

    public recover(
        id: ItemClaimId,
        owner: ItemClaimOwner<Lease>,
        expiresAt: Date,
        now: Date
    ): ItemClaim<Lease> {
        const nowTime = validDate(now, "Claim recovery time");
        if (this.#expiresAt > nowTime) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Only an expired claim may be recovered"
            );
        }
        const replacement = new ItemClaim(
            id,
            this.invocation,
            this.itemIndex,
            this.attemptOrdinal,
            owner,
            expiresAt
        );
        replacement.requireFuture(now);
        if (sameWorker(this.owner, replacement.owner)) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Claim recovery requires a different worker"
            );
        }
        return replacement;
    }
}

export class ItemClaimCodec<Lease> extends RecordCodec<ItemClaim<Lease>> {
    public constructor(private readonly lease: StructuralCodec<Lease>) {
        super("invocation.item-claim", { major: 1, minor: 0 });
    }

    protected encodePayload(record: ItemClaim<Lease>): JsonValue {
        return {
            attemptOrdinal: record.attemptOrdinal,
            expiresAt: record.expiresAt.toISOString(),
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            owner: encodeOwner(record.owner, this.lease)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ItemClaim<Lease> {
        const object = requireExactObject(
            payload,
            ["attemptOrdinal", "expiresAt", "id", "invocation", "itemIndex", "owner"],
            "Item claim"
        );
        return new ItemClaim(
            new ItemClaimId(requireString(object, "id")),
            new InvocationId(requireString(object, "invocation")),
            requireNonnegativeInteger(object, "itemIndex"),
            requireNonnegativeInteger(object, "attemptOrdinal"),
            decodeOwner(object["owner"]!, this.lease),
            requireDate(object, "expiresAt")
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
    const object =
        value === null || Array.isArray(value) || typeof value !== "object" ? undefined : value;
    if (object === undefined) throw new TypeError("Claim owner must be an object");
    const kind = requireString(object as { readonly [key: string]: JsonValue }, "kind");
    if (kind === "executor") {
        const exact = requireExactObject(
            value,
            ["kind", "token", "worker"],
            "Executor claim owner"
        );
        return Object.freeze({
            kind,
            token: lease.decode(exact["token"]!),
            worker: new ClaimWorkerId(requireString(exact, "worker"))
        });
    }
    if (kind === "system") {
        const exact = requireExactObject(value, ["actor", "kind", "worker"], "System claim owner");
        const actor = requireExactObject(exact["actor"], ["id", "kind"], "Claim owner Actor");
        return Object.freeze({
            kind,
            actor: new ActorRef(
                requireActorKind(requireString(actor, "kind")),
                new ActorId(requireString(actor, "id"))
            ),
            worker: new ClaimWorkerId(requireString(exact, "worker"))
        });
    }
    throw new TypeError("Claim owner kind is invalid");
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

function sameWorker<Lease>(left: ItemClaimOwner<Lease>, right: ItemClaimOwner<Lease>): boolean {
    return left.worker.equals(right.worker);
}

function requireIndex(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
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
    throw new TypeError("Claim owner Actor kind is invalid");
}
