import { Digest, RecordCodec, Revision, SecretRef, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { GuestTrustId, TenantId } from "./id";

export type GuestTrustState = "active" | "revoked";
export type GuestTrustVerifier = TokenGuestTrustVerifier | CallbackGuestTrustVerifier;

export interface TokenGuestTrustVerifier {
    readonly kind: "token";
    readonly issuer: string;
    readonly key: SecretRef;
}

export interface CallbackGuestTrustVerifier {
    readonly kind: "callback";
    readonly endpoint: string;
}

abstract class GuestTrustLifecycle {
    public abstract readonly name: GuestTrustState;
    public abstract rotate(): GuestTrustLifecycle;
    public abstract revoke(): GuestTrustLifecycle;

    public static from(state: GuestTrustState): GuestTrustLifecycle {
        return state === "active" ? activeGuestTrust : revokedGuestTrust;
    }
}

class ActiveGuestTrustLifecycle extends GuestTrustLifecycle {
    public readonly name = "active" as const;
    public rotate(): GuestTrustLifecycle {
        return this;
    }
    public revoke(): GuestTrustLifecycle {
        return revokedGuestTrust;
    }
}

class RevokedGuestTrustLifecycle extends GuestTrustLifecycle {
    public readonly name = "revoked" as const;
    public rotate(): GuestTrustLifecycle {
        throw new AgentCoreError("protocol.invalid-state", "Revoked guest trust cannot rotate");
    }
    public revoke(): GuestTrustLifecycle {
        return this;
    }
}

const activeGuestTrust = Object.freeze(new ActiveGuestTrustLifecycle());
const revokedGuestTrust = Object.freeze(new RevokedGuestTrustLifecycle());

class GuestTrustRecordCodec extends RecordCodec<GuestTrust> {
    public constructor() {
        super("identity.guest-trust", { major: 1, minor: 0 });
    }

    protected encodePayload(trust: GuestTrust): JsonValue {
        return {
            handshakeDigest: trust.handshakeDigest?.value ?? null,
            homeTenant: trust.homeTenant.value,
            hostTenant: trust.hostTenant.value,
            id: trust.id.value,
            revision: trust.revision.value,
            state: trust.state,
            verifier: encodeVerifier(trust.verifier)
        };
    }

    protected decodePayload(payload: JsonValue): GuestTrust {
        const object = requireIdentityObject(payload, "Guest trust payload");
        requireIdentityFields(
            object,
            ["handshakeDigest", "homeTenant", "hostTenant", "id", "revision", "state", "verifier"],
            "Guest trust payload"
        );
        const handshakeDigest = object["handshakeDigest"];
        if (handshakeDigest !== null && typeof handshakeDigest !== "string") {
            throw new TypeError("Guest trust handshake digest must be a string or null");
        }
        return new GuestTrust(
            new GuestTrustId(requireIdentityString(object["id"], "Guest trust ID")),
            new TenantId(requireIdentityString(object["hostTenant"], "Guest host Tenant")),
            new TenantId(requireIdentityString(object["homeTenant"], "Guest home Tenant")),
            decodeVerifier(object["verifier"]!),
            requireTrustState(object["state"]),
            requireIdentityRevision(object["revision"], "Guest trust revision"),
            handshakeDigest === null ? undefined : new Digest(handshakeDigest)
        );
    }
}

export class GuestTrust {
    public static readonly codec: RecordCodec<GuestTrust> = new GuestTrustRecordCodec();
    public readonly verifier: GuestTrustVerifier;
    readonly #lifecycle: GuestTrustLifecycle;

    public constructor(
        public readonly id: GuestTrustId,
        public readonly hostTenant: TenantId,
        public readonly homeTenant: TenantId,
        verifier: GuestTrustVerifier,
        state: GuestTrustState,
        public readonly revision: Revision,
        public readonly handshakeDigest?: Digest
    ) {
        if (hostTenant.equals(homeTenant)) {
            throw new TypeError("Guest trust requires distinct host and home Tenants");
        }
        this.verifier = copyVerifier(verifier);
        this.#lifecycle = GuestTrustLifecycle.from(requireTrustState(state));
        Object.freeze(this);
    }

    public static encode(trust: GuestTrust): Uint8Array {
        return GuestTrust.codec.encode(trust);
    }

    public static decode(bytes: Uint8Array): GuestTrust {
        return GuestTrust.codec.decode(bytes);
    }

    public get isActive(): boolean {
        return this.#lifecycle.name === "active";
    }

    public get state(): GuestTrustState {
        return this.#lifecycle.name;
    }

    public rotate(verifier: GuestTrustVerifier): GuestTrust {
        this.#lifecycle.rotate();
        if (this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Guest trust revision is exhausted");
        }
        try {
            return new GuestTrust(
                this.id,
                this.hostTenant,
                this.homeTenant,
                verifier,
                this.state,
                this.revision.next(),
                this.handshakeDigest
            );
        } catch (error) {
            if (error instanceof TypeError) {
                throw new AgentCoreError("protocol.invalid-state", error.message);
            }
            throw error;
        }
    }

    public revoke(): GuestTrust {
        const next = this.#lifecycle.revoke();
        if (next !== this.#lifecycle && this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Guest trust revision is exhausted");
        }
        return next === this.#lifecycle
            ? this
            : new GuestTrust(
                  this.id,
                  this.hostTenant,
                  this.homeTenant,
                  this.verifier,
                  "revoked",
                  this.revision.next(),
                  this.handshakeDigest
              );
    }

    public assertCanReplace(next: GuestTrust): void {
        if (
            !this.id.equals(next.id) ||
            !this.hostTenant.equals(next.hostTenant) ||
            !this.homeTenant.equals(next.homeTenant) ||
            this.handshakeDigest?.value !== next.handshakeDigest?.value ||
            next.revision.value !== this.revision.value + 1
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Guest trust updates require immutable identity and the next revision"
            );
        }
        if (!this.isActive) {
            throw new AgentCoreError("protocol.invalid-state", "Revoked guest trust is terminal");
        }
        if (
            next.state === "revoked" &&
            JSON.stringify(encodeVerifier(this.verifier)) !==
                JSON.stringify(encodeVerifier(next.verifier))
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Guest trust revocation must preserve verifier configuration"
            );
        }
    }
}

function encodeVerifier(verifier: GuestTrustVerifier): JsonValue {
    return verifier.kind === "token"
        ? {
              issuer: verifier.issuer,
              key: {
                  id: verifier.key.id,
                  provider: verifier.key.provider,
                  source: verifier.key.source
              },
              kind: verifier.kind
          }
        : { endpoint: verifier.endpoint, kind: verifier.kind };
}

function decodeVerifier(value: JsonValue): GuestTrustVerifier {
    const object = requireIdentityObject(value, "Guest trust verifier");
    if (object["kind"] === "token") {
        requireIdentityFields(object, ["issuer", "key", "kind"], "Token guest trust verifier");
        const key = requireIdentityObject(object["key"]!, "Guest trust key");
        requireIdentityFields(key, ["id", "provider", "source"], "Guest trust key");
        return copyVerifier({
            kind: "token",
            issuer: requireIdentityString(object["issuer"], "Guest token issuer"),
            key: new SecretRef(
                requireIdentityString(key["source"], "Guest key source"),
                requireIdentityString(key["provider"], "Guest key provider"),
                requireIdentityString(key["id"], "Guest key ID")
            )
        });
    }
    if (object["kind"] === "callback") {
        requireIdentityFields(object, ["endpoint", "kind"], "Callback guest trust verifier");
        return copyVerifier({
            kind: "callback",
            endpoint: requireIdentityString(object["endpoint"], "Guest callback endpoint")
        });
    }
    throw new TypeError("Guest trust verifier kind is invalid");
}

function copyVerifier(verifier: GuestTrustVerifier): GuestTrustVerifier {
    if (verifier.kind === "token") {
        if (verifier.issuer.trim() !== verifier.issuer || verifier.issuer.length === 0) {
            throw new TypeError("Guest token issuer must be canonical and nonblank");
        }
        return Object.freeze({
            kind: verifier.kind,
            issuer: verifier.issuer,
            key: Object.freeze(
                new SecretRef(verifier.key.source, verifier.key.provider, verifier.key.id)
            )
        });
    }
    let endpoint: URL;
    try {
        endpoint = new URL(verifier.endpoint);
    } catch {
        throw new TypeError("Guest callback endpoint must be an absolute HTTPS URL");
    }
    if (endpoint.protocol !== "https:" || endpoint.toString() !== verifier.endpoint) {
        throw new TypeError("Guest callback endpoint must be a canonical HTTPS URL");
    }
    return Object.freeze({ kind: verifier.kind, endpoint: verifier.endpoint });
}

function requireTrustState(value: JsonValue | undefined): GuestTrustState {
    if (value === "active" || value === "revoked") return value;
    throw new TypeError("Guest trust state is invalid");
}
