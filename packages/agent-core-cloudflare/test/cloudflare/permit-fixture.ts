import { Digest, SemVer, TenantId, Revision, encodeCanonicalJson } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    WorkspaceId
} from "@agent-core/core/identity";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "@agent-core/core/facets";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermitExpectation,
    Binding,
    GrantId,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitRequest
} from "@agent-core/core/authority";
import { ClaimWorkerId, InvocationId, ItemClaimId } from "@agent-core/core/invocations";
import { RunId } from "@agent-core/core/agents/runs";
import { PackageId, PackagePin } from "@agent-core/core/definition";

/**
 * The variable parts of one mediated call, as plain data. Real records cannot cross an RPC
 * boundary, so a scenario names what it wants to differ and the object it addresses builds
 * the records itself. Every field here is one an adversarial case varies.
 */
export interface PermitSpec {
    readonly tenant: string;
    readonly targetActor: string;
    readonly targetFence: number;
    readonly sourceWorkspace: string;
    readonly nonce: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly itemKey: string;
    readonly tenantEpoch: number;
    readonly recipient: string;
}

export const BASE_PERMIT_SPEC: PermitSpec = Object.freeze({
    tenant: "tenant-permit",
    targetActor: "run-permit-1",
    targetFence: 1,
    sourceWorkspace: "workspace-permit-1",
    nonce: "nonce-permit-1",
    issuedAtMs: 1_000,
    expiresAtMs: 3_600_000,
    itemKey: "item-permit-1",
    tenantEpoch: 7,
    recipient: "someone@example.test"
});

const BINDING_NAME = new BindingName("mailer");
const FACET = new FacetRef("mail:instance");
const GRANT = new GrantId("grant-permit-1");
const DOMAIN = new ProtectionDomain("backend", "run-domain", "may-hold-secrets");
const BINDING_GENERATION = 1;

export function tenantActorRef(spec: PermitSpec): ActorRef {
    return new ActorRef("tenant", new ActorId(spec.tenant));
}

export function targetActorRef(spec: PermitSpec): ActorRef {
    return new ActorRef("run", new ActorId(spec.targetActor));
}

function principalRef(spec: PermitSpec): PrincipalRef {
    return new PrincipalRef(new TenantId(spec.tenant), new PrincipalId("principal-permit-1"));
}

/**
 * The Scope path the Binding resolves under. The target entry is the Workspace Scope
 * because a Binding lives in one, and the Tenant entry above it is what ties the path to
 * the issuing Tenant.
 */
function pathEpochs(spec: PermitSpec): PathEpochEvidence {
    const tenant = new TenantId(spec.tenant);
    return new PathEpochEvidence([
        new ScopeEpoch(ScopeRef.tenant(tenant), spec.tenantEpoch),
        new ScopeEpoch(
            ScopeRef.workspace(tenant, new WorkspaceId(spec.sourceWorkspace)),
            spec.tenantEpoch
        )
    ]);
}

function binding(spec: PermitSpec): Binding {
    const tenant = new TenantId(spec.tenant);
    return new Binding(
        ScopeRef.workspace(tenant, new WorkspaceId(spec.sourceWorkspace)),
        SubjectRef.principal(principalRef(spec)),
        DOMAIN,
        BINDING_NAME,
        GRANT,
        FACET,
        BINDING_GENERATION,
        "active",
        Revision.initial()
    );
}

function operationArguments(spec: PermitSpec): Readonly<Record<string, string>> {
    return Object.freeze({ to: spec.recipient });
}

function argumentsDigest(spec: PermitSpec): Digest {
    return Digest.sha256(encodeCanonicalJson(operationArguments(spec)));
}

/** What the target asks its Tenant to decide, in the Tenant's own vocabulary. */
export function buildCheckRequest(spec: PermitSpec): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
        ownerTenant: new TenantId(spec.tenant),
        owner: targetActorRef(spec),
        ownerFence: spec.targetFence,
        principal: principalRef(spec),
        binding: binding(spec),
        intent: {
            facet: FACET,
            operation: "send",
            impact: "externalSend",
            arguments: operationArguments(spec),
            argumentsDigest: argumentsDigest(spec)
        },
        expectedPath: pathEpochs(spec),
        invocationDigest: Digest.sha256(new Uint8Array([4])),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: spec.nonce
    });
}

export function buildExpectation(spec: PermitSpec): AuthorityPermitExpectation {
    const tenant = new TenantId(spec.tenant);
    const principal = principalRef(spec);
    const invocation = new InvocationId("invocation-permit-1");
    return new AuthorityPermitExpectation({
        tenant,
        issuer: tenantActorRef(spec),
        source: new ActorRef("workspace", new ActorId(spec.sourceWorkspace)),
        target: { actor: targetActorRef(spec), fence: spec.targetFence, domain: DOMAIN },
        principal,
        binding: { name: BINDING_NAME, generation: new Revision(BINDING_GENERATION) },
        facet: FACET,
        operation: new OperationRef("mail:send"),
        package: new PackagePin(
            new PackageId("mail"),
            new SemVer("1.0.0"),
            Digest.sha256(new Uint8Array([1])),
            Digest.sha256(new Uint8Array([2]))
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId(spec.targetActor),
            registryEpoch: 2,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey: spec.itemKey }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("claim-permit-1"),
        claimOwner: {
            kind: "system",
            actor: targetActorRef(spec),
            worker: new ClaimWorkerId("worker-permit-1")
        },
        itemKey: spec.itemKey,
        argumentsDigest: argumentsDigest(spec),
        intentDigest: Digest.sha256(new Uint8Array([4])),
        pathEpochs: pathEpochs(spec),
        authority: { kind: "initiator", principal, binding: BINDING_NAME }
    });
}

/** The immutable target request the target retains before it asks the Tenant anything. */
export function buildTargetRequest(spec: PermitSpec): TargetAuthorityPermitRequest {
    return new TargetAuthorityPermitRequest(
        buildExpectation(spec),
        buildCheckRequest(spec),
        spec.nonce,
        new Date(spec.expiresAtMs),
        undefined
    );
}

/**
 * The Tenant's decision on one request, derived from the request itself. The Tenant reads
 * the Grant the Binding names rather than being told which Grants matched, so a scenario
 * cannot smuggle a decision through the fixture.
 */
export function tenantDecision(
    request: TargetAuthorityPermitRequest,
    decision: "allow" | "deny",
    checkedAt: Date
): AuthorityCheckEvidence {
    const allowed = decision === "allow";
    return new AuthorityCheckEvidence(
        request.expectation.tenant,
        request.expectation.issuer,
        request.authority.digest(),
        request.authority.binding.key,
        request.authority.binding.generation,
        decision,
        allowed ? "allowed" : "noMatchingAllow",
        allowed ? [request.authority.binding.grantId] : [],
        [],
        request.expectation.pathEpochs,
        checkedAt
    );
}
