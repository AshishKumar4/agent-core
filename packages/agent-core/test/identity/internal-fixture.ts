export { GuestTrust } from "../../src/identity/guest-trust";
import type { Digest, RecordCodec, Revision } from "../../src/core";
import {
    GuestVerification as GuestVerificationValue,
    type GuestVerificationMethod
} from "../../src/identity/guest-verification";
import { guestVerificationCodec, mintGuestVerification } from "../../src/identity/internal";
import type { GuestTrustId } from "../../src/identity/id";
import type { PrincipalRef } from "../../src/identity/principal-ref";
export { GuestTrustId } from "../../src/identity/id";
export { PrincipalRef } from "../../src/identity/principal-ref";
export { Workspace } from "../../src/identity/workspace";

interface GuestVerificationTestConstructor {
    new (
        principal: PrincipalRef,
        trustId: GuestTrustId,
        trustRevision: Revision,
        method: GuestVerificationMethod,
        evidenceDigest: Digest,
        verifiedAt: Date,
        expiresAt: Date
    ): GuestVerificationValue;
    readonly codec: RecordCodec<GuestVerificationValue>;
    encode(verification: GuestVerificationValue): Uint8Array;
    decode(bytes: Uint8Array): GuestVerificationValue;
}

const createGuestVerification = function (
    principal: PrincipalRef,
    trustId: GuestTrustId,
    trustRevision: Revision,
    method: GuestVerificationMethod,
    evidenceDigest: Digest,
    verifiedAt: Date,
    expiresAt: Date
): GuestVerificationValue {
    return mintGuestVerification(
        principal,
        trustId,
        trustRevision,
        method,
        evidenceDigest,
        verifiedAt,
        expiresAt
    );
} as unknown as GuestVerificationTestConstructor;

Object.defineProperties(createGuestVerification, {
    codec: { value: guestVerificationCodec },
    encode: {
        value: (verification: GuestVerificationValue) => GuestVerificationValue.encode(verification)
    },
    decode: { value: (bytes: Uint8Array) => guestVerificationCodec.decode(bytes) }
});

export { createGuestVerification as GuestVerification };
