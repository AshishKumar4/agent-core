import { Digest, RecordCodec, Revision, type JsonValue, TextId } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { GuestTrustId, PrincipalId, TenantId } from "./id";
import { PrincipalRef } from "./principal-ref";
import { GuestVerificationScheme, type ForeignPrincipalRef } from "./subject";

class GuestVerificationCodec extends RecordCodec<GuestVerification> {
    public constructor() {
        super(
            [
                GuestVerification,
                GuestVerificationScheme,
                Revision,
                TextId,
                Digest,
                GuestTrustId,
                TenantId,
                PrincipalId,
                PrincipalRef
            ],
            "identity.guest-verification",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(verification: GuestVerification): JsonValue {
        return verification.toData();
    }

    protected decodePayload(payload: JsonValue): GuestVerification {
        return restoreGuestVerification(payload);
    }
}

const constructionToken = Symbol("guest-verification-construction");
const freshVerifications = new WeakSet<GuestVerification>();
const restoredVerifications = new WeakSet<GuestVerification>();

export class GuestVerification {
    public static get codec(): RecordCodec<GuestVerification> {
        return guestVerificationCodec;
    }
    readonly #verifiedAt: number;
    readonly #expiresAt: number;

    public constructor(
        public readonly principal: PrincipalRef,
        public readonly trustId: GuestTrustId,
        public readonly trustRevision: Revision,
        public readonly verifiedVia: GuestVerificationScheme,
        public readonly evidenceDigest: Digest,
        verifiedAt: Date,
        expiresAt: Date,
        token: symbol
    ) {
        if (token !== constructionToken) {
            throw new TypeError("Guest verification must be minted or restored by the host");
        }
        if (verifiedVia.equals(GuestVerificationScheme.handshake)) {
            throw new TypeError("Guest verification is never minted via the handshake scheme");
        }
        this.#verifiedAt = validDate(verifiedAt, "Guest verification time");
        this.#expiresAt = validDate(expiresAt, "Guest verification expiry");
        if (this.#expiresAt <= this.#verifiedAt) {
            throw new TypeError("Guest verification must expire after verification");
        }
        Object.freeze(this);
    }

    public static encode(verification: GuestVerification): Uint8Array {
        return guestVerificationCodec.encode(verification);
    }

    public static decode(bytes: Uint8Array): GuestVerification {
        return guestVerificationCodec.decode(bytes);
    }

    public get verifiedAt(): Date {
        return new Date(this.#verifiedAt);
    }
    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public get isHostMinted(): boolean {
        return freshVerifications.has(this);
    }

    public admits(subject: ForeignPrincipalRef, now: Date): boolean {
        const checkedAt = now.getTime();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Guest verification check time is invalid"
            );
        }
        return (
            this.principal.tenantId.equals(subject.homeTenant) &&
            this.principal.principalId.equals(subject.principalId) &&
            this.verifiedVia.equals(subject.verifiedVia) &&
            this.#verifiedAt <= checkedAt &&
            checkedAt < this.#expiresAt
        );
    }

    public toData(): JsonValue {
        return {
            evidenceDigest: this.evidenceDigest.value,
            expiresAt: this.#expiresAt,
            principal: {
                principal: this.principal.principalId.value,
                tenant: this.principal.tenantId.value
            },
            trust: this.trustId.value,
            trustRevision: this.trustRevision.value,
            verifiedAt: this.#verifiedAt,
            verifiedVia: this.verifiedVia.value
        };
    }
}

export const guestVerificationCodec: RecordCodec<GuestVerification> = new GuestVerificationCodec();

export function mintGuestVerification(
    principal: PrincipalRef,
    trustId: GuestTrustId,
    trustRevision: Revision,
    verifiedVia: GuestVerificationScheme,
    evidenceDigest: Digest,
    verifiedAt: Date,
    expiresAt: Date
): GuestVerification {
    const verification = new GuestVerification(
        principal,
        trustId,
        trustRevision,
        verifiedVia,
        evidenceDigest,
        verifiedAt,
        expiresAt,
        constructionToken
    );
    freshVerifications.add(verification);
    return verification;
}

export function restoreGuestVerification(payload: JsonValue): GuestVerification {
    const object = requireIdentityObject(payload, "Guest verification");
    requireIdentityFields(
        object,
        [
            "evidenceDigest",
            "expiresAt",
            "principal",
            "trust",
            "trustRevision",
            "verifiedAt",
            "verifiedVia"
        ],
        "Guest verification"
    );
    const principal = requireIdentityObject(object["principal"]!, "Verified guest Principal");
    requireIdentityFields(principal, ["principal", "tenant"], "Verified guest Principal");
    const verification = new GuestVerification(
        new PrincipalRef(
            new TenantId(requireIdentityString(principal["tenant"], "Guest Tenant")),
            new PrincipalId(requireIdentityString(principal["principal"], "Guest Principal"))
        ),
        new GuestTrustId(requireIdentityString(object["trust"], "Guest trust ID")),
        requireIdentityRevision(object["trustRevision"], "Guest trust revision"),
        requireMintedScheme(object["verifiedVia"]),
        new Digest(requireIdentityString(object["evidenceDigest"], "Guest evidence digest")),
        requireDate(object["verifiedAt"], "Guest verification time"),
        requireDate(object["expiresAt"], "Guest verification expiry"),
        constructionToken
    );
    restoredVerifications.add(verification);
    return verification;
}

export function isFreshGuestVerification(verification: GuestVerification): boolean {
    return freshVerifications.has(verification);
}

export function isRestoredGuestVerification(verification: GuestVerification): boolean {
    return restoredVerifications.has(verification);
}

function requireMintedScheme(value: JsonValue | undefined): GuestVerificationScheme {
    if (value === "token" || value === "callback") return GuestVerificationScheme.from(value);
    throw new TypeError("Guest verification is only minted via the token or callback scheme");
}

function requireDate(value: JsonValue | undefined, subject: string): Date {
    if (!isGuestVerificationTime(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
    return new Date(value);
}

function isGuestVerificationTime(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

function validDate(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
    return time;
}
