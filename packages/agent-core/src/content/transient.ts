import { ActorId, ActorRef } from "../actors";
import {
    ContentRef,
    Digest,
    RecordCodec,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AgentCoreError } from "../errors";
import { TenantId } from "../identity";
import type { MediaHint } from "./media";
import { requireOperationTime } from "./retention";

export interface TransientContentBinding {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly ref: ContentRef;
    readonly digest: Digest;
    readonly expiresAt: Date;
}

class TransientContentLeaseStateCodec extends RecordCodec<TransientContentLeaseState> {
    public constructor() {
        super("content.transient-lease", { major: 1, minor: 0 });
    }

    protected encodePayload(lease: TransientContentLeaseState): JsonValue {
        return {
            acquiredAt: lease.acquiredAt.getTime(),
            actor: { id: lease.actor.id.value, kind: lease.actor.kind },
            closedAt: lease.closedAt?.getTime() ?? null,
            digest: lease.digest.value,
            envelopeDigest: lease.envelopeDigest.value,
            expiresAt: lease.expiresAt.getTime(),
            ref: lease.ref.value,
            tenant: lease.tenant.value
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): TransientContentLeaseState {
        const actor = isObject(payload) ? payload["actor"] : undefined;
        if (
            !isObject(payload) ||
            !hasExactJsonKeys(payload, [
                "acquiredAt",
                "actor",
                "closedAt",
                "digest",
                "envelopeDigest",
                "expiresAt",
                "ref",
                "tenant"
            ]) ||
            !isObject(actor) ||
            !hasExactJsonKeys(actor, ["id", "kind"]) ||
            typeof actor["id"] !== "string" ||
            !isActorKind(actor["kind"]) ||
            typeof payload["acquiredAt"] !== "number" ||
            (payload["closedAt"] !== null && typeof payload["closedAt"] !== "number") ||
            typeof payload["digest"] !== "string" ||
            typeof payload["envelopeDigest"] !== "string" ||
            typeof payload["expiresAt"] !== "number" ||
            typeof payload["ref"] !== "string" ||
            typeof payload["tenant"] !== "string"
        ) {
            throw corruptLease("Transient content lease payload is malformed");
        }
        try {
            return new TransientContentLeaseState(
                new TenantId(payload["tenant"]),
                new ActorRef(actor["kind"], new ActorId(actor["id"])),
                new Digest(payload["envelopeDigest"]),
                new ContentRef(payload["ref"]),
                new Digest(payload["digest"]),
                new Date(payload["acquiredAt"]),
                new Date(payload["expiresAt"]),
                payload["closedAt"] === null ? undefined : new Date(payload["closedAt"])
            );
        } catch (error) {
            throw corruptLease(
                `Transient content lease payload is invalid: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

export class TransientContentLeaseState {
    public static readonly codec: RecordCodec<TransientContentLeaseState> =
        new TransientContentLeaseStateCodec();
    readonly #acquiredAt: number;
    readonly #expiresAt: number;
    readonly #closedAt: number | undefined;

    public constructor(
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        public readonly envelopeDigest: Digest,
        public readonly ref: ContentRef,
        public readonly digest: Digest,
        acquiredAt: Date,
        expiresAt: Date,
        closedAt?: Date
    ) {
        this.#acquiredAt = requireOperationTime(acquiredAt, "Lease acquisition time").getTime();
        this.#expiresAt = requireOperationTime(expiresAt, "Lease expiration time").getTime();
        this.#closedAt =
            closedAt === undefined
                ? undefined
                : requireOperationTime(closedAt, "Lease close time").getTime();
        if (this.#expiresAt <= this.#acquiredAt) {
            throw new TypeError("Transient content lease expiration must follow acquisition");
        }
        if (this.#closedAt !== undefined && this.#closedAt < this.#acquiredAt) {
            throw new TypeError("Transient content lease cannot close before acquisition");
        }
        if (!ref.digest.equals(digest)) {
            throw new TypeError("Transient content lease reference and digest must match");
        }
        Object.freeze(this);
    }

    public static encode(lease: TransientContentLeaseState): Uint8Array {
        return TransientContentLeaseState.codec.encode(lease);
    }

    public static decode(bytes: Uint8Array): TransientContentLeaseState {
        return TransientContentLeaseState.codec.decode(bytes);
    }

    public get acquiredAt(): Date {
        return new Date(this.#acquiredAt);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public get closedAt(): Date | undefined {
        return this.#closedAt === undefined ? undefined : new Date(this.#closedAt);
    }

    public get inactiveAt(): Date | undefined {
        if (this.#closedAt === undefined) return undefined;
        return new Date(Math.min(this.#closedAt, this.#expiresAt));
    }

    public isActive(now: Date): boolean {
        const time = requireOperationTime(now, "Lease observation time").getTime();
        return this.#closedAt === undefined && time < this.#expiresAt;
    }

    public matches(binding: TransientContentBinding): boolean {
        return (
            this.tenant.equals(binding.tenant) &&
            this.actor.equals(binding.actor) &&
            this.envelopeDigest.equals(binding.envelopeDigest) &&
            this.ref.equals(binding.ref) &&
            this.digest.equals(binding.digest) &&
            this.#expiresAt ===
                requireOperationTime(binding.expiresAt, "Lease binding expiration").getTime()
        );
    }

    public close(operationAt: Date): TransientContentLeaseState {
        if (this.#closedAt !== undefined) return this;
        return new TransientContentLeaseState(
            this.tenant,
            this.actor,
            this.envelopeDigest,
            this.ref,
            this.digest,
            this.acquiredAt,
            this.expiresAt,
            operationAt
        );
    }
}

export abstract class TransientContentLease {
    public abstract read(): Uint8Array;

    public abstract matches(binding: TransientContentBinding, now: Date): boolean;

    public abstract close(): Promise<void>;
}

export abstract class TransientContentAccess {
    public abstract acquire(
        binding: TransientContentBinding,
        bytes?: Uint8Array,
        hint?: MediaHint
    ): Promise<TransientContentLease | undefined>;
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
    return (
        value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    );
}

function isActorKind(value: JsonValue | undefined): value is ActorRef["kind"] {
    return (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    );
}

function corruptLease(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
