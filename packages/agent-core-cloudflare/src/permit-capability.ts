import type { ActorRef } from "@agent-core/core/actors";
import type { TenantId } from "@agent-core/core/identity";
import {
    CommandAuthenticator,
    type CommandCaller,
    type CommandEnvelope
} from "@agent-core/core/protocol";
import { Digest } from "@agent-core/core";
import { operationalFailure, type CloudflareErrorPort } from "./error.js";
import { requireStorableBlob } from "./sqlite.js";

/**
 * How many distinct idempotency keys one capability admits before it must be re-minted.
 * A capability is request-scoped and a mediated call carries one key per claim, so a
 * legitimate holder never approaches this; the ceiling exists because the key is
 * attacker-supplied and the guard that remembers it must not grow without a bound.
 */
export const MAXIMUM_KEYED_CALLS = 64;

/** A key longer than this is not a claim nonce, so it is refused before it is retained. */
export const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * The Tenant's own authority surface, as one Actor's capability reaches it. Every method
 * takes the authenticated caller the capability established, never a caller the payload
 * claims, and every payload stays opaque here: SPEC section 10.3 places the issuance
 * decision in the Tenant Actor, so this profile carries bytes and authenticates who sent
 * them, and decides nothing about them.
 */
export abstract class TenantAuthorityPermitSink {
    /** Answers one permit issuance request from `caller`, keyed for redelivery. */
    public abstract issue(
        caller: ActorRef,
        request: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array>;

    /** Reads back the Tenant's own record of an issued permit, for authentication. */
    public abstract issued(
        caller: ActorRef,
        nonce: string,
        digest: string
    ): Promise<Uint8Array | undefined>;

    /** Projects one source Actor's committed lease attestation, keyed for redelivery. */
    public abstract project(
        caller: ActorRef,
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array>;
}

/**
 * What one Actor holds to reach its Tenant, and the whole of what it holds. A Durable
 * Object stub authenticates nothing about its caller, so an Actor that could name itself
 * in a permit request could name any Actor. This capability closes over the caller the
 * Tenant minted it for, and no method takes a caller argument, so the identity a request
 * is judged under is fixed at mint time by the Tenant and is not reachable from the
 * holder at all.
 *
 * The object is disposable because it is request-scoped. Holding one across execution
 * contexts is what SPEC sections 4 and 10.2 already forbid of any provider resolution,
 * and disposal here is what makes that observable rather than assumed: a disposed
 * capability refuses every later call, and its per-key state is gone.
 */
export class TargetBoundTenantAuthority {
    readonly #tenantActor: ActorRef;
    readonly #caller: ActorRef;
    readonly #sink: TenantAuthorityPermitSink;
    readonly #errors: CloudflareErrorPort;
    /**
     * One canonical digest per key this capability has already carried. It is a guard and
     * never a cache: a repeat of the same key with the same bytes is forwarded again,
     * because the Tenant's own permit record is the single source of truth for whether that
     * issuance already happened, and answering it here would be a second durable copy of an
     * authority decision.
     *
     * A digest rather than the payload, and a bounded number of them, because both are
     * attacker-controlled. Retaining the bytes let one holder of one capability grow this
     * map by the size of everything it sent, inside a 128 MB isolate, for as long as the
     * request lived. A digest is 64 characters whatever arrives, and the key ceiling turns
     * an unbounded map into a refusal.
     */
    readonly #keyed = new Map<string, string>();
    #open = true;

    public constructor(options: {
        readonly tenantActor: ActorRef;
        readonly caller: ActorRef;
        readonly sink: TenantAuthorityPermitSink;
        readonly errors: CloudflareErrorPort;
    }) {
        if (options.tenantActor.kind !== "tenant") {
            throw new TypeError("A target-bound Tenant capability requires a Tenant Actor issuer");
        }
        if (options.caller.kind === "tenant") {
            throw new TypeError("A target-bound Tenant capability requires a non-Tenant caller");
        }
        this.#tenantActor = options.tenantActor;
        this.#caller = options.caller;
        this.#sink = options.sink;
        this.#errors = options.errors;
    }

    /** The Tenant Actor that minted this capability. */
    public get issuer(): ActorRef {
        return this.#tenantActor;
    }

    /** The one Actor every call through this capability is attributed to. */
    public get caller(): ActorRef {
        return this.#caller;
    }

    /** What a Tenant host hands its command authenticator for this call. */
    public transport(): TargetBoundCommandTransport {
        this.#requireOpen();
        return new TargetBoundCommandTransport(this.#caller);
    }

    public async issuePermit(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        this.#admit(request, idempotencyKey, "permit issuance");
        return this.#sink.issue(this.#caller, request.slice(), idempotencyKey);
    }

    public async issuedPermit(nonce: string, digest: string): Promise<Uint8Array | undefined> {
        this.#requireOpen();
        if (nonce.length === 0 || digest.length === 0) {
            operationalFailure(
                this.#errors,
                "operation.invalid-input",
                "An issued-permit lookup requires a non-empty nonce and digest"
            );
        }
        return this.#sink.issued(this.#caller, nonce, digest);
    }

    public async projectLeaseEvidence(
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.#admit(evidence, idempotencyKey, "lease evidence projection");
        return this.#sink.project(this.#caller, evidence.slice(), idempotencyKey);
    }

    public [Symbol.dispose](): void {
        this.#open = false;
        this.#keyed.clear();
    }

    #admit(payload: Uint8Array, idempotencyKey: string, subject: string): void {
        this.#requireOpen();
        if (
            idempotencyKey.length === 0 ||
            idempotencyKey.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
            payload.byteLength === 0
        ) {
            operationalFailure(
                this.#errors,
                "operation.invalid-input",
                `A ${subject} requires a non-empty idempotency key inside ` +
                    `${MAXIMUM_IDEMPOTENCY_KEY_LENGTH} characters and a non-empty payload`
            );
        }
        // Bound the payload before anything reads or retains it: the Tenant's own record
        // cannot exceed what its storage accepts, so a larger payload is invalid input
        // rather than something to carry and let fail partway through a transaction.
        requireStorableBlob(`A ${subject} payload`, payload, this.#errors);
        const digest = Digest.sha256(payload).value;
        const carried = this.#keyed.get(idempotencyKey);
        if (carried === undefined) {
            if (this.#keyed.size >= MAXIMUM_KEYED_CALLS) {
                operationalFailure(
                    this.#errors,
                    "operation.invalid-input",
                    `A capability admits ${MAXIMUM_KEYED_CALLS} distinct idempotency keys ` +
                        "before it must be re-minted"
                );
            }
            this.#keyed.set(idempotencyKey, digest);
            return;
        }
        if (carried !== digest) this.#rebound(subject, idempotencyKey);
    }

    #rebound(subject: string, idempotencyKey: string): never {
        operationalFailure(
            this.#errors,
            "authority.denied",
            `A ${subject} rebound idempotency key ${idempotencyKey} to different bytes`
        );
    }

    #requireOpen(): void {
        if (!this.#open) {
            operationalFailure(
                this.#errors,
                "authority.denied",
                "A disposed target-bound Tenant capability carries no authority"
            );
        }
    }
}

/**
 * The authenticated caller one capability call arrives under. It exists so a Tenant host
 * passes an identity it established rather than one it parsed, and it carries nothing
 * else, because anything else here would be a second place a caller could be decided.
 */
export class TargetBoundCommandTransport {
    public constructor(public readonly caller: ActorRef) {
        if (caller.kind === "tenant") {
            throw new TypeError("A target-bound command transport requires a non-Tenant caller");
        }
        Object.freeze(this);
    }
}

/**
 * Authenticates a Tenant command against the capability it arrived through. The envelope
 * still names its caller, because the command protocol requires it, and this
 * authenticator's whole job is to refuse the case where the two disagree: an Actor that
 * holds a capability minted for itself cannot obtain a decision attributed to another.
 */
export class TargetBoundCommandAuthenticator extends CommandAuthenticator<TargetBoundCommandTransport> {
    public constructor(tenant: TenantId) {
        super(tenant);
    }

    protected authenticateTransport(
        transport: TargetBoundCommandTransport,
        envelope: CommandEnvelope
    ): CommandCaller | undefined {
        const claimed = envelope.caller;
        if (claimed.kind !== "actor" || !claimed.actor.equals(transport.caller)) return undefined;
        return Object.freeze({ kind: "actor", actor: transport.caller });
    }
}
