import {
    Digest,
    RecordCodec,
    encodeCanonicalJson,
    type JsonValue,
    Revision,
    SecretRef,
    SemVer,
    TextId
} from "../core";
import { RunId, TurnId } from "../agents";
import { ActorId, ActorRef } from "../actors";
import { PackageId, PackagePin } from "../definition";
import {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationName,
    OperationRef,
    ProtectionDomain
} from "../facets";
import { ClaimWorkerId, ItemClaimId } from "../invocation-references";
import { InvocationId } from "../interaction-references";
import type { JsonObject } from "./data";
import { requireExact, requireObject } from "./data";
import { Binding, BindingCredentialCustody, BindingLifecycle } from "./binding";
import { AuthorityCheckEvidence, AuthorityCheckRequest } from "./evidence";
import { PathEpochEvidence, ScopeEpoch } from "./epoch";
import { AuthorityPermitExpectation } from "./permit";
import { TargetAuthorityPermitRequest } from "./permit-request";
import {
    TargetLeaseEvidenceKey,
    TargetLeaseEvidenceReference
} from "./target-lease-evidence";
import {
    GuestVerificationScheme,
    PrincipalId,
    PrincipalRef,
    ProjectId,
    ScopeRef,
    TeamId,
    TenantId,
    WorkspaceId
} from "../identity";
import { GrantId } from "./id";

class TargetAuthorityPermitDenialCodec extends RecordCodec<TargetAuthorityPermitDenial> {
    public constructor() {
        super(
            [
                TargetAuthorityPermitDenial,
                ActorRef,
                GuestVerificationScheme,
                Revision,
                ScopeRef,
                TextId,
                SemVer,
                AuthorityCheckRequest,
                AuthorityPermitExpectation,
                Binding,
                AuthorityCheckEvidence,
                BindingLifecycle,
                TargetAuthorityPermitRequest,
                TargetLeaseEvidenceKey,
                TargetLeaseEvidenceReference,
                BindingCredentialCustody,
                PathEpochEvidence,
                PackagePin,
                ScopeEpoch,
                FacetRef,
                ProtectionDomain,
                Digest,
                OperationRef,
                SecretRef,
                PrincipalRef,
                RunId,
                BindingName,
                InvocationId,
                ActorId,
                FacetPackageId,
                PackageId,
                TeamId,
                ItemClaimId,
                OperationName,
                ClaimWorkerId,
                TenantId,
                WorkspaceId,
                TurnId,
                GrantId,
                ProjectId,
                PrincipalId
            ],
            "authority.target-permit-denial",
            { major: 1, minor: 0 }
        );
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
    public static get codec(): RecordCodec<TargetAuthorityPermitDenial> {
        return targetAuthorityPermitDenialCodecInstance;
    }

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

const targetAuthorityPermitDenialCodecInstance = new TargetAuthorityPermitDenialCodec();
