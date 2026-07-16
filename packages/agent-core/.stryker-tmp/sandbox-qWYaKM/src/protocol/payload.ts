// @ts-nocheck
import type { ActorRef } from "../actors";
import type {
    TransientContentAccess,
    TransientContentBinding,
    TransientContentLease
} from "../content";
import type { ContentRef, Digest } from "../core";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";

export type PayloadMalformedReason =
    "absent" | "missing" | "referenceMismatch" | "submittedMismatch" | "tooLarge";

// Removed once W2/W4 consume TransientContentAccess in their owned compositions.
export type HeldContentStore = TransientContentAccess;
export type HeldContentVerifier = TransientContentAccess;

export interface CommandPayloadCodec<Payload = unknown> {
    decode(bytes: Uint8Array): Payload;
}

export class CommandPayloadMalformedError extends AgentCoreError {
    public constructor(message = "Command payload is malformed") {
        super("protocol.invalid-envelope", message);
        this.name = "CommandPayloadMalformedError";
    }
}

export class PayloadLeaseBinding implements TransientContentBinding {
    readonly #expiresAt: number;

    public constructor(
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        public readonly envelopeDigest: Digest,
        public readonly ref: ContentRef,
        public readonly digest: Digest,
        expiresAt: Date
    ) {
        const expiresAtTime = expiresAt.getTime();
        if (!Number.isFinite(expiresAtTime)) {
            throw new TypeError("Payload lease expiry must be valid");
        }
        this.#expiresAt = expiresAtTime;
        Object.freeze(this);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public matches(
        tenant: TenantId,
        actor: ActorRef,
        envelopeDigest: Digest,
        ref: ContentRef,
        digest: Digest
    ): boolean {
        return (
            this.tenant.equals(tenant) &&
            this.actor.equals(actor) &&
            this.envelopeDigest.equals(envelopeDigest) &&
            this.ref.equals(ref) &&
            this.digest.equals(digest)
        );
    }
}

interface PreparedPayloadState {
    readonly lease?: TransientContentLease;
    readonly binding?: PayloadLeaseBinding;
    readonly malformedReason?: PayloadMalformedReason;
}

const preparedPayloadIssuer = Symbol("prepared-command-payload-issuer");
const preparedPayloadStates = new WeakMap<PreparedCommandPayload, PreparedPayloadState>();

export class PreparedCommandPayload {
    public constructor(issuer: symbol, state: PreparedPayloadState) {
        if (issuer !== preparedPayloadIssuer) {
            throw invalidPreparedPayloadIssuer();
        }
        preparedPayloadStates.set(this, Object.freeze({ ...state }));
        Object.freeze(this);
    }

    public get lease(): TransientContentLease | undefined {
        return requirePreparedState(this).lease;
    }

    public get binding(): PayloadLeaseBinding | undefined {
        return requirePreparedState(this).binding;
    }

    public get malformedReason(): PayloadMalformedReason | undefined {
        return requirePreparedState(this).malformedReason;
    }
}

export function issueLeasedCommandPayload(
    lease: TransientContentLease,
    binding: PayloadLeaseBinding
): PreparedCommandPayload {
    return new PreparedCommandPayload(preparedPayloadIssuer, { lease, binding });
}

export function issueMalformedCommandPayload(
    malformedReason: PayloadMalformedReason
): PreparedCommandPayload {
    return new PreparedCommandPayload(preparedPayloadIssuer, { malformedReason });
}

export function inspectPreparedCommandPayload(
    value: unknown
): Readonly<PreparedPayloadState> | undefined {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return undefined;
    }
    return preparedPayloadStates.get(value as PreparedCommandPayload);
}

function requirePreparedState(value: PreparedCommandPayload): PreparedPayloadState {
    const state = preparedPayloadStates.get(value);
    if (state === undefined) {
        throw invalidPreparedPayloadIssuer();
    }
    return state;
}

function invalidPreparedPayloadIssuer(): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        "Prepared command payload has an invalid issuer"
    );
}
