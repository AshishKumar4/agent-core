import { PathEpochEvidence } from "../authority";
import { Digest, SemVer, encodeCanonicalJson, type JsonValue } from "../core";
import { PackageId, mergePolicySets } from "../definition";
import { AgentCoreError } from "../errors";
import {
    BindingName,
    FacetPackageId,
    OperationRef,
    ProtectionDomain,
    type FacetRef
} from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { TurnId, type LeaseToken } from "../agents";
import {
    ApprovalCodec,
    EffectAttemptCodec,
    InvocationContinuationCodec,
    ItemClaimCodec,
    OperationPin,
    PreparedInvocation,
    PreparedInvocationCodec,
    ReceiptCodec,
    requireExactObject,
    requireNonnegativeInteger,
    requireString,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchPreparationPort,
    type InvocationPersistence,
    type InvocationPreparationPort,
    type InvocationMemoryCodecs,
    type InvocationTransactionPort,
    type PreparedInvocationCodecs,
    type StructuralCodec,
    type UnpreparedPayload
} from "../invocations";
import type { MediatedAuthorityIntent } from "./authority";
import type { DerivedMediationIdentities } from "./mediation-identity";

/**
 * SPEC §7.3's `InvocationAuthority`: the authenticated Principal and the Binding its
 * authority came through, plus whether the Invocation acts for its own initiator or on
 * delegated authority routed from another Actor.
 */
export class MediatedInvocationAuthority {
    public constructor(
        public readonly kind: "initiator" | "delegated",
        public readonly principal: PrincipalRef,
        public readonly binding: BindingName
    ) {
        if (kind !== "initiator" && kind !== "delegated") {
            throw new TypeError("Invocation authority kind is invalid");
        }
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            binding: this.binding.value,
            kind: this.kind,
            principal: {
                principal: this.principal.principalId.value,
                tenant: this.principal.tenantId.value
            }
        };
    }

    public static fromData(value: JsonValue): MediatedInvocationAuthority {
        const object = requireExactObject(
            value,
            ["binding", "kind", "principal"],
            "Invocation authority"
        );
        const principal = requireExactObject(
            object["principal"],
            ["principal", "tenant"],
            "Invocation authority principal"
        );
        const kind = requireString(object, "kind");
        if (kind !== "initiator" && kind !== "delegated") {
            throw new TypeError("Invocation authority kind is invalid");
        }
        return new MediatedInvocationAuthority(
            kind,
            new PrincipalRef(
                new TenantId(requireString(principal, "tenant")),
                new PrincipalId(requireString(principal, "principal"))
            ),
            new BindingName(requireString(object, "binding"))
        );
    }
}

export const mediatedInvocationAuthorityCodec: StructuralCodec<MediatedInvocationAuthority> =
    Object.freeze({
        encode: (value: MediatedInvocationAuthority): JsonValue => value.toData(),
        decode: (value: JsonValue): MediatedInvocationAuthority =>
            MediatedInvocationAuthority.fromData(value)
    });

export const leaseTokenCodec: StructuralCodec<LeaseToken> = Object.freeze({
    encode: (value: LeaseToken): JsonValue => ({
        epoch: value.epoch,
        holder: {
            principal: value.holder.principalId.value,
            tenant: value.holder.tenantId.value
        },
        turn: value.turn.value
    }),
    decode: (value: JsonValue): LeaseToken => {
        const object = requireExactObject(value, ["epoch", "holder", "turn"], "Lease token");
        const holder = requireExactObject(
            object["holder"],
            ["principal", "tenant"],
            "Lease token holder"
        );
        return Object.freeze({
            turn: new TurnId(requireString(object, "turn")),
            holder: new PrincipalRef(
                new TenantId(requireString(holder, "tenant")),
                new PrincipalId(requireString(holder, "principal"))
            ),
            epoch: requireNonnegativeInteger(object, "epoch")
        });
    }
});

export const protectionDomainCodec: StructuralCodec<ProtectionDomain> = Object.freeze({
    encode: (value: ProtectionDomain): JsonValue => ({
        kind: value.kind,
        label: value.label,
        secretPolicy: value.secretPolicy
    }),
    decode: (value: JsonValue): ProtectionDomain => {
        const object = requireExactObject(
            value,
            ["kind", "label", "secretPolicy"],
            "Protection domain"
        );
        const kind = requireString(object, "kind");
        const secretPolicy = requireString(object, "secretPolicy");
        if (
            (kind !== "frontend" && kind !== "backend") ||
            (secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets")
        ) {
            throw new TypeError("Protection domain kind or secret policy is invalid");
        }
        return new ProtectionDomain(kind, requireString(object, "label"), secretPolicy);
    }
});

export const pathEpochEvidenceCodec: StructuralCodec<PathEpochEvidence> = Object.freeze({
    encode: (value: PathEpochEvidence): JsonValue => value.toData(),
    decode: (value: JsonValue): PathEpochEvidence => PathEpochEvidence.fromData(value)
});

export function mediationInvocationCodecs<Admission>(
    admission: StructuralCodec<Admission>
): InvocationMemoryCodecs<
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence,
    Admission
> {
    return Object.freeze({
        prepared: new PreparedInvocationCodec(mediationPreparedCodecs),
        approval: ApprovalCodec,
        continuation: new InvocationContinuationCodec(leaseTokenCodec),
        claim: new ItemClaimCodec(leaseTokenCodec),
        attempt: new EffectAttemptCodec(leaseTokenCodec, admission),
        receipt: ReceiptCodec
    });
}

export const mediationPreparedCodecs: PreparedInvocationCodecs<
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence
> = Object.freeze({
    lease: leaseTokenCodec,
    authority: mediatedInvocationAuthorityCodec,
    domain: protectionDomainCodec,
    pathEpochs: pathEpochEvidenceCodec
});

/**
 * The activation facts an OperationPin commits that authority resolution does not carry:
 * which configured runtime the host actually activated for this Facet, and under which
 * activation generation and registration it declared the Operation. Only the component
 * that activated the Facet knows these, so the pipeline is told rather than guessing.
 */
export interface FacetActivationPin {
    readonly configurationDigest: Digest;
    readonly runtimeDigest: Digest;
    readonly activationGeneration: string;
    readonly registration: string;
}

export interface FacetActivationPinPort {
    pin(facet: FacetRef): FacetActivationPin | undefined;
}

export type MediationPreparedInvocation = PreparedInvocation<
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence
>;

export type MediationPersistence<Transaction, Admission> = InvocationPersistence<
    Transaction,
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence,
    Admission
>;

/**
 * Freezes the whole effect intent before policy or approval (§7.3), from the authority
 * resolution the gateway already produced and the activation pin of the Facet the host
 * actually activated.
 *
 * A routed Invocation is not prepared here. Its InvocationId, authority, projection
 * digest, and audit bridge belong to the authenticated RouteReservation, and
 * `RoutedInvocationAdmissionPort` has already made that preparation durable; this port
 * returns that exact record rather than deriving a second one that could disagree.
 */
export class CanonicalMediationPreparation<Transaction, Admission> implements CanonicalBatchPreparationPort<
    MediatedAuthorityIntent,
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence
> {
    public constructor(
        private readonly identities: DerivedMediationIdentities,
        private readonly activations: FacetActivationPinPort,
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: MediationPersistence<Transaction, Admission>
    ) {}

    public prepare(
        request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>
    ): MediationPreparedInvocation {
        const intent = request.request.authorization;
        if (intent.route !== undefined) return this.routed(request);
        if (intent.lease === undefined) {
            throw invalid("Mediated preparation requires an exact lease or a routed reservation");
        }
        const invocation = request.invocation;
        return PreparedInvocation.create(
            {
                id: invocation,
                operation: this.operationPin(request),
                domain: intent.domain,
                actor: intent.owner,
                authority: new MediatedInvocationAuthority(
                    "initiator",
                    intent.principal,
                    intent.binding.name
                ),
                pathEpochs: intent.pathEpochs,
                lease: intent.lease,
                auditCause: this.identities.invocationAudit(invocation),
                idempotencySeed: this.identities.idempotencySeed(invocation)
            },
            payload(request),
            mediationPreparedCodecs
        );
    }

    private routed(
        request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>
    ): MediationPreparedInvocation {
        const existing = this.transactions.transact((transaction) =>
            this.persistence.prepared(transaction, request.invocation)
        );
        if (existing === undefined) {
            throw invalid(
                "Routed mediation requires the RouteReservation's durable PreparedInvocation"
            );
        }
        return existing;
    }

    private operationPin(
        request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>
    ): OperationPin {
        const intent = request.request.authorization;
        const facet = request.request.facet;
        const activation = this.activations.pin(facet);
        if (activation === undefined) {
            throw invalid(`Facet ${facet.value} has no activation pin to freeze into the intent`);
        }
        const descriptor = request.request.descriptor;
        return OperationPin.create({
            operation: new OperationRef(
                `${facetPackage(facet).value}:${descriptor.name.value}`
            ),
            target: facet.value,
            package: new PackageId(intent.packagePin.id.value),
            version: new SemVer(intent.packagePin.version.toString()),
            manifestDigest: intent.packagePin.manifestDigest,
            descriptorDigest: Digest.sha256(encodeCanonicalJson(descriptor.toData())),
            configurationDigest: activation.configurationDigest,
            runtimeDigest: activation.runtimeDigest,
            activationGeneration: activation.activationGeneration,
            registration: activation.registration,
            impact: descriptor.impact,
            approvalRequired: mergePolicySets(intent.policies).requiresApproval(descriptor.impact),
            placement: intent.placement
        });
    }
}

/**
 * The ledger's preparation gate for locally prepared Invocations: the audit cause must
 * be the derived Invocation audit root for this exact Invocation, and a header that
 * carries neither a lease nor a route cannot be prepared at all (§7.3).
 */
export class DerivedPreparationAdmission<Transaction> implements InvocationPreparationPort<
    Transaction,
    LeaseToken,
    MediatedInvocationAuthority,
    ProtectionDomain,
    PathEpochEvidence
> {
    public constructor(private readonly identities: DerivedMediationIdentities) {}

    public admits(_transaction: Transaction, invocation: MediationPreparedInvocation): boolean {
        const header = invocation.header;
        if (header.route !== undefined) return header.projectionDigest !== undefined;
        return (
            header.lease !== undefined &&
            header.auditCause.equals(this.identities.invocationAudit(header.id)) &&
            header.idempotencySeed === this.identities.idempotencySeed(header.id)
        );
    }
}

function payload(
    request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>
): UnpreparedPayload {
    const inputs = request.request.inputs;
    if (request.request.shape.kind === "single") {
        if (inputs.length !== 1) throw invalid("A single mediated payload carries one item");
        return { kind: "single", item: inputs[0]! };
    }
    if (inputs.length === 0) throw invalid("A batch mediated payload must be nonempty");
    return { kind: "batch", items: inputs as readonly [(typeof inputs)[number], ...typeof inputs] };
}

function facetPackage(facet: FacetRef): FacetPackageId {
    const separator = facet.value.indexOf(":");
    if (separator <= 0) throw invalid(`Facet reference ${facet.value} names no Package`);
    return new FacetPackageId(facet.value.slice(0, separator));
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
