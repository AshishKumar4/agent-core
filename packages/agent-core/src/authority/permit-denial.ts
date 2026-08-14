import { Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../core";
import type { JsonObject } from "./data";
import { requireExact, requireObject } from "./data";
import { AuthorityCheckEvidence } from "./evidence";
import { TargetAuthorityPermitRequest } from "./permit-request";

class TargetAuthorityPermitDenialCodec extends RecordCodec<TargetAuthorityPermitDenial> {
    public constructor() {
        super("authority.target-permit-denial", { major: 1, minor: 0 });
    }

    protected encodePayload(denial: TargetAuthorityPermitDenial): JsonValue {
        return denial.toData();
    }

    protected decodePayload(payload: JsonValue): TargetAuthorityPermitDenial {
        return TargetAuthorityPermitDenial.fromData(payload);
    }
}

/** The exact denied Tenant decision for one target-owned permit request. */
export class TargetAuthorityPermitDenial {
    public static readonly codec: RecordCodec<TargetAuthorityPermitDenial> =
        new TargetAuthorityPermitDenialCodec();

    public constructor(
        public readonly request: TargetAuthorityPermitRequest,
        public readonly evidence: AuthorityCheckEvidence
    ) {
        if (
            evidence.allowed ||
            !evidence.binds(request.authority) ||
            !evidence.issuer.equals(request.expectation.issuer) ||
            !evidence.issuerTenant.equals(request.expectation.tenant) ||
            evidence.checkedAt.getTime() >= request.expiresAt.getTime()
        ) {
            throw new TypeError(
                "Target authority permit denial requires exact timely denied Tenant evidence"
            );
        }
        Object.freeze(this);
    }

    public digest(): Digest {
        return Digest.sha256(encodeCanonicalJson(this.toData()));
    }

    public toData(): JsonObject {
        return {
            evidence: this.evidence.toData(),
            request: this.request.toData()
        };
    }

    public static fromData(value: JsonValue | undefined): TargetAuthorityPermitDenial {
        const object = requireObject(value, "Target authority permit denial");
        requireExact(object, ["evidence", "request"], "Target authority permit denial");
        return new TargetAuthorityPermitDenial(
            TargetAuthorityPermitRequest.fromData(object["request"]),
            AuthorityCheckEvidence.fromData(object["evidence"])
        );
    }

    public static encode(denial: TargetAuthorityPermitDenial): Uint8Array {
        return TargetAuthorityPermitDenial.codec.encode(denial);
    }

    public static decode(bytes: Uint8Array): TargetAuthorityPermitDenial {
        return TargetAuthorityPermitDenial.codec.decode(bytes);
    }
}
