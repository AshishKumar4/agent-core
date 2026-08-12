import { PathEpochEvidence } from "../authority";
import { Digest, SemVer, encodeCanonicalJson, type JsonValue } from "../core";
import { PackageId, mergePolicySets } from "../definition";
import { AgentCoreError } from "../errors";
import { FacetPackageId, OperationRef, type FacetRef, type ProtectionDomain } from "../facets";
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
    requireArray,
    requireExactObject,
    requireNonnegativeInteger,
    requireString,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchPreparationPort,
    type InvocationMemoryCodecs,
    type InvocationPersistence,
    type InvocationPreparationPort,
    type InvocationTransactionPort,
    type PreparedInvocationCodecs,
    type StructuralCodec,
    type UnpreparedPayload
} from "../invocations";
import type { MediatedAuthorityIntent } from "./authority";
import type { DerivedMediationIdentities } from "./mediation-identity";

/**
 * A PreparedInvocation's Lease, Authority, Domain, and PathEpochs are *structural
 * references*: the invocations context never interprets them, persists them through a
 * codec, and requires them to be immutable data carrying no behavior (§8.3). Each is
 * therefore declared here as the canonical data shape of the domain value it stands for,
 * with the conversion at this boundary rather than a domain class smuggled into the
 * record.
 */
export interface MediationLeaseReference {
    readonly turn: string;
    readonly tenant: string;
    readonly principal: string;
    readonly epoch: number;
}

/** SPEC §7.3's `InvocationAuthority`, as a structural reference. */
export interface MediationAuthorityReference {
    readonly kind: "initiator" | "delegated";
    readonly tenant: string;
    readonly principal: string;
    readonly binding: string;
}

export interface MediationDomainReference {
    readonly kind: "frontend" | "backend";
    readonly label: string;
    readonly secretPolicy: "no-secrets" | "may-hold-secrets";
}

export interface MediationPathEpochReference {
    readonly path: readonly JsonValue[];
}

export function leaseReference(token: LeaseToken): MediationLeaseReference {
    return Object.freeze({
        turn: token.turn.value,
        tenant: token.holder.tenantId.value,
        principal: token.holder.principalId.value,
        epoch: token.epoch
    });
}

export function leaseToken(reference: MediationLeaseReference): LeaseToken {
    return Object.freeze({
        turn: new TurnId(reference.turn),
        holder: new PrincipalRef(
            new TenantId(reference.tenant),
            new PrincipalId(reference.principal)
        ),
        epoch: reference.epoch
    });
}

export function sameLeaseReference(
    left: MediationLeaseReference,
    right: MediationLeaseReference
): boolean {
    return (
        left.turn === right.turn &&
        left.tenant === right.tenant &&
        left.principal === right.principal &&
        left.epoch === right.epoch
    );
}

export function domainReference(domain: ProtectionDomain): MediationDomainReference {
    return Object.freeze({
        kind: domain.kind,
        label: domain.label,
        secretPolicy: domain.secretPolicy
    });
}

export function pathEpochReference(evidence: PathEpochEvidence): MediationPathEpochReference {
    return Object.freeze({
        path: Object.freeze(requireArray(evidence.toData(), "path"))
    });
}

export const leaseReferenceCodec: StructuralCodec<MediationLeaseReference> = Object.freeze({
    encode: (value: MediationLeaseReference): JsonValue => ({
        epoch: value.epoch,
        principal: value.principal,
        tenant: value.tenant,
        turn: value.turn
    }),
    decode: (value: JsonValue): MediationLeaseReference => {
        const object = requireExactObject(
            value,
            ["epoch", "principal", "tenant", "turn"],
            "Invocation lease reference"
        );
        return Object.freeze({
            turn: requireString(object, "turn"),
            tenant: requireString(object, "tenant"),
            principal: requireString(object, "principal"),
            epoch: requireNonnegativeInteger(object, "epoch")
        });
    }
});

export const authorityReferenceCodec: StructuralCodec<MediationAuthorityReference> = Object.freeze({
    encode: (value: MediationAuthorityReference): JsonValue => ({
        binding: value.binding,
        kind: value.kind,
        principal: value.principal,
        tenant: value.tenant
    }),
    decode: (value: JsonValue): MediationAuthorityReference => {
        const object = requireExactObject(
            value,
            ["binding", "kind", "principal", "tenant"],
            "Invocation authority reference"
        );
        const kind = requireString(object, "kind");
        if (kind !== "initiator" && kind !== "delegated") {
            throw malformed("Invocation authority kind is invalid");
        }
        return Object.freeze({
            kind,
            tenant: requireString(object, "tenant"),
            principal: requireString(object, "principal"),
            binding: requireString(object, "binding")
        });
    }
});

export const domainReferenceCodec: StructuralCodec<MediationDomainReference> = Object.freeze({
    encode: (value: MediationDomainReference): JsonValue => ({
        kind: value.kind,
        label: value.label,
        secretPolicy: value.secretPolicy
    }),
    decode: (value: JsonValue): MediationDomainReference => {
        const object = requireExactObject(
            value,
            ["kind", "label", "secretPolicy"],
            "Protection domain reference"
        );
        const kind = requireString(object, "kind");
        const secretPolicy = requireString(object, "secretPolicy");
        if (
            (kind !== "frontend" && kind !== "backend") ||
            (secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets")
        ) {
            throw malformed("Protection domain kind or secret policy is invalid");
        }
        return Object.freeze({ kind, label: requireString(object, "label"), secretPolicy });
    }
});

export const pathEpochReferenceCodec: StructuralCodec<MediationPathEpochReference> = Object.freeze({
    encode: (value: MediationPathEpochReference): JsonValue =>
        PathEpochEvidence.fromData({ path: [...value.path] }).toData(),
    decode: (value: JsonValue): MediationPathEpochReference =>
        pathEpochReference(PathEpochEvidence.fromData(value))
});

export const mediationPreparedCodecs: PreparedInvocationCodecs<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
> = Object.freeze({
    lease: leaseReferenceCodec,
    authority: authorityReferenceCodec,
    domain: domainReferenceCodec,
    pathEpochs: pathEpochReferenceCodec
});

export function mediationInvocationCodecs<Admission>(
    admission: StructuralCodec<Admission>
): InvocationMemoryCodecs<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    Admission
> {
    return Object.freeze({
        prepared: new PreparedInvocationCodec(mediationPreparedCodecs),
        approval: ApprovalCodec,
        continuation: new InvocationContinuationCodec(leaseReferenceCodec),
        claim: new ItemClaimCodec(leaseReferenceCodec),
        attempt: new EffectAttemptCodec(leaseReferenceCodec, admission),
        receipt: ReceiptCodec
    });
}

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
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
>;

export type MediationPersistence<Transaction, Admission> = InvocationPersistence<
    Transaction,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
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
export class CanonicalMediationPreparation<
    Transaction,
    Admission
> implements CanonicalBatchPreparationPort<
    MediatedAuthorityIntent,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
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
                domain: domainReference(intent.domain),
                actor: intent.owner,
                authority: Object.freeze({
                    kind: "initiator" as const,
                    tenant: intent.principal.tenantId.value,
                    principal: intent.principal.principalId.value,
                    binding: intent.binding.name.value
                }),
                pathEpochs: pathEpochReference(intent.pathEpochs),
                lease: leaseReference(intent.lease),
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
            operation: new OperationRef(`${facetPackage(facet).value}:${descriptor.name.value}`),
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
 * The ledger's preparation gate for locally prepared Invocations: the audit cause and
 * idempotency seed must be the ones this Invocation's own identity derives, and a header
 * carrying neither a lease nor a route cannot be prepared at all (§7.3).
 */
export class DerivedPreparationAdmission<Transaction> implements InvocationPreparationPort<
    Transaction,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
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
    const [first, ...rest] = request.request.inputs;
    if (first === undefined) throw invalid("A mediated payload must be nonempty");
    if (request.request.shape.kind === "single") {
        if (rest.length !== 0) throw invalid("A single mediated payload carries one item");
        return { kind: "single", item: first };
    }
    return { kind: "batch", items: [first, ...rest] };
}

function facetPackage(facet: FacetRef): FacetPackageId {
    const separator = facet.value.indexOf(":");
    if (separator <= 0) throw invalid(`Facet reference ${facet.value} names no Package`);
    return new FacetPackageId(facet.value.slice(0, separator));
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}

function malformed(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
