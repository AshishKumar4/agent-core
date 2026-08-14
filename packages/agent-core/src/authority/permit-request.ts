import { Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../core";
import type { JsonObject } from "./data";
import { requireExact, requireObject, requireSafeInteger, requireString } from "./data";
import { AuthorityCheckRequest } from "./evidence";
import { AuthorityPermitExpectation } from "./permit";

class TargetAuthorityPermitRequestCodec extends RecordCodec<TargetAuthorityPermitRequest> {
    public constructor() {
        super("authority.target-permit-request", { major: 1, minor: 0 });
    }

    protected encodePayload(request: TargetAuthorityPermitRequest): JsonValue {
        return request.toData();
    }

    protected decodePayload(payload: JsonValue): TargetAuthorityPermitRequest {
        return TargetAuthorityPermitRequest.fromData(payload);
    }
}

/** The target-owned immutable request from which its Tenant may issue one permit. */
export class TargetAuthorityPermitRequest {
    public static readonly codec: RecordCodec<TargetAuthorityPermitRequest> =
        new TargetAuthorityPermitRequestCodec();
    readonly #expiresAt: number;

    public constructor(
        public readonly expectation: AuthorityPermitExpectation,
        public readonly authority: AuthorityCheckRequest,
        public readonly nonce: string,
        expiresAt: Date
    ) {
        if (nonce.length === 0 || nonce !== nonce.trim()) {
            throw new TypeError(
                "Target authority permit request nonce must be canonical and nonblank"
            );
        }
        const expiresAtTime = expiresAt.getTime();
        if (!Number.isSafeInteger(expiresAtTime) || expiresAtTime < 0) {
            throw new TypeError("Target authority permit request expiry is invalid");
        }
        requireRequestIdentity(expectation, authority, nonce);
        requireAuthorityBinding(expectation, authority);
        requireAuthorityIntent(expectation, authority);
        this.#expiresAt = expiresAtTime;
        Object.freeze(this);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public digest(): Digest {
        return Digest.sha256(encodeCanonicalJson(this.toData()));
    }

    public toData(): JsonObject {
        return {
            authority: this.authority.toData(),
            expectation: this.expectation.toData(),
            expiresAt: this.#expiresAt,
            nonce: this.nonce
        };
    }

    public static fromData(value: JsonValue | undefined): TargetAuthorityPermitRequest {
        const object = requireObject(value, "Target authority permit request");
        requireExact(
            object,
            ["authority", "expectation", "expiresAt", "nonce"],
            "Target authority permit request"
        );
        return new TargetAuthorityPermitRequest(
            AuthorityPermitExpectation.fromData(object["expectation"]),
            AuthorityCheckRequest.fromData(object["authority"]),
            requireString(object, "nonce", "Target authority permit request nonce"),
            new Date(
                requireSafeInteger(object, "expiresAt", "Target authority permit request expiry")
            )
        );
    }

    public static encode(request: TargetAuthorityPermitRequest): Uint8Array {
        return TargetAuthorityPermitRequest.codec.encode(request);
    }

    public static decode(bytes: Uint8Array): TargetAuthorityPermitRequest {
        return TargetAuthorityPermitRequest.codec.decode(bytes);
    }
}

function requireRequestIdentity(
    expectation: AuthorityPermitExpectation,
    authority: AuthorityCheckRequest,
    nonce: string
): void {
    if (
        !authority.ownerTenant.equals(expectation.tenant) ||
        !authority.owner.equals(expectation.target.actor) ||
        authority.ownerFence !== expectation.target.fence ||
        !authority.principal.equals(expectation.principal) ||
        authority.itemIndex !== expectation.itemIndex ||
        authority.attemptOrdinal !== expectation.attemptOrdinal ||
        authority.nonce !== nonce ||
        expectation.issuer.equals(expectation.target.actor)
    ) {
        throw new TypeError(
            "Target authority permit request does not match its exact target identity"
        );
    }
}

function requireAuthorityBinding(
    expectation: AuthorityPermitExpectation,
    authority: AuthorityCheckRequest
): void {
    const binding = authority.binding;
    if (
        !binding.name.equals(expectation.binding.name) ||
        binding.generation !== expectation.binding.generation.value ||
        !binding.facet.equals(expectation.facet) ||
        !binding.domain.equals(expectation.target.domain) ||
        !binding.scope.equals(expectation.pathEpochs.target.scope) ||
        !authority.expectedPath.equals(expectation.pathEpochs)
    ) {
        throw new TypeError(
            "Target authority permit request does not match its exact Binding and path"
        );
    }
}

function requireAuthorityIntent(
    expectation: AuthorityPermitExpectation,
    authority: AuthorityCheckRequest
): void {
    const intent = authority.intent;
    const operation = expectation.operation;
    if (
        !intent.facet.equals(expectation.facet) ||
        !operation.facet.equals(expectation.facet.packageId) ||
        intent.operation !== operation.operation.value ||
        intent.impact !== expectation.impact ||
        !intent.argumentsDigest.equals(expectation.argumentsDigest) ||
        !authority.invocationDigest.equals(expectation.intentDigest)
    ) {
        throw new TypeError(
            "Target authority permit request does not match its exact authority intent"
        );
    }
}
