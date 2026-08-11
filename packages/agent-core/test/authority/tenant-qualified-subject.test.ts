import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    PrincipalRef,
    RoleName,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId,
    decodeSubjectRef,
    encodeSubjectRef
} from "../../src/identity";
import { Workspace } from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import {
    BindingValidationEvidence,
    BindingValidationRequest
} from "../../src/authority/binding-evidence";
import { PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { AuthorityCheckRequest } from "../../src/authority/evidence";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { subjectKey } from "../../src/authority/reference";
import { TenantAuthorityRuntime } from "../../src/authority/runtime";
import { AuthorityMutationService } from "../../src/authority/service";

const hostTenantId = new TenantId("qualified-host");
const otherTenantId = new TenantId("qualified-other");
const sharedPrincipalId = new PrincipalId("shared-principal");
const workspaceId = new WorkspaceId("qualified-workspace");
const workspaceScope = ScopeRef.workspace(hostTenantId, workspaceId);
const tenantActor = new ActorRef("tenant", new ActorId("qualified-tenant-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("qualified-workspace-actor"));
const domain = new ProtectionDomain("backend", "qualified", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const capability = new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] });
const host = new PrincipalRef(hostTenantId, sharedPrincipalId);
const stranger = new PrincipalRef(otherTenantId, sharedPrincipalId);
const roleName = new RoleName("owner");
const grantId = new GrantId("qualified-grant");
const checkArguments = { folder: "inbox" } as const;
const checkArgumentsDigest = Digest.sha256(encodeCanonicalJson(checkArguments));

describe("tenant-qualified Principal subjects", () => {
    test(
        "[C13-AUTH-PRINCIPAL-REF] separates equal Principal IDs from different Tenants in every subject key",
        { tags: "p0" },
        () => {
            expect(subjectKey(SubjectRef.principal(host))).not.toBe(
                subjectKey(SubjectRef.principal(stranger))
            );
            expect(encodeSubjectRef(SubjectRef.principal(host))).toEqual({
                kind: "principal",
                principal: sharedPrincipalId.value,
                tenant: hostTenantId.value
            });

            const restored = decodeSubjectRef(encodeSubjectRef(SubjectRef.principal(stranger)));
            expect(restored.kind === "principal" && restored.principal.equals(stranger)).toBe(true);
            expect(restored.kind === "principal" && restored.principal.equals(host)).toBe(false);
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] refuses a record whose Principal subject belongs to another Tenant",
        { tags: "p0" },
        () => {
            const foreign = SubjectRef.principal(stranger);
            expect(
                () =>
                    new Grant(grantId, workspaceScope, foreign, "allow", capability, {
                        kind: "direct"
                    })
            ).toThrow(/Grant Principal subject belongs to another Tenant/);
            expect(
                () =>
                    new Membership(
                        new MembershipId("qualified-membership"),
                        workspaceScope,
                        foreign,
                        roleName,
                        "active",
                        Revision.initial()
                    )
            ).toThrow(/Membership Principal subject belongs to another Tenant/);
            expect(() =>
                Binding.active(
                    workspaceScope,
                    foreign,
                    domain,
                    new BindingName("mail"),
                    grantId,
                    facet
                )
            ).toThrow(/Binding Principal subject belongs to another Tenant/);
            expect(
                () =>
                    new BindingValidationEvidence(
                        hostTenantId,
                        tenantActor,
                        Digest.sha256(Uint8Array.of(1)),
                        workspaceScope,
                        foreign,
                        grantId,
                        currentPath(),
                        new Date(1_000)
                    )
            ).toThrow(/Binding validation evidence Principal subject belongs to another Tenant/);
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] rejects an unqualified stored Principal subject rather than inferring its Tenant",
        { tags: "p0" },
        () => {
            const unqualified = { kind: "principal", principal: sharedPrincipalId.value } as const;
            expect(() => decodeSubjectRef(unqualified)).toThrow(/Principal subject reference/);

            const grant = new Grant(
                grantId,
                workspaceScope,
                SubjectRef.principal(host),
                "allow",
                capability,
                { kind: "direct" }
            );
            const membership = new Membership(
                new MembershipId("qualified-membership"),
                workspaceScope,
                SubjectRef.principal(host),
                roleName,
                "active",
                Revision.initial()
            );
            const binding = Binding.active(
                workspaceScope,
                SubjectRef.principal(host),
                domain,
                new BindingName("mail"),
                grantId,
                facet
            );

            expect(() => Grant.decode(withUnqualifiedSubject(Grant.encode(grant)))).toThrow(
                /Principal subject reference/
            );
            expect(() =>
                Membership.decode(withUnqualifiedSubject(Membership.encode(membership)))
            ).toThrow(/Principal subject reference/);
            expect(() => Binding.decode(withUnqualifiedSubject(Binding.encode(binding)))).toThrow(
                /Principal subject reference/
            );
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] fails a restored Tenant control snapshot closed on an unqualified stored subject",
        { tags: "p0" },
        () => {
            const { store, service } = bootstrapped();
            service.createGrant(
                new Grant(
                    grantId,
                    workspaceScope,
                    SubjectRef.principal(host),
                    "allow",
                    capability,
                    {
                        kind: "direct"
                    }
                )
            );
            const snapshot = store.snapshot();

            expect(() =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: snapshot.grants.map((record) => ({
                        id: record.id,
                        bytes: withUnqualifiedSubject(record.bytes)
                    }))
                })
            ).toThrow(/Principal subject reference/);
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] does not let the host Tenant's identically named Principal stand in for a stranger at admission",
        { tags: "p0" },
        () => {
            const { store, service } = bootstrapped();
            expect(store.principal(sharedPrincipalId)?.id.equals(sharedPrincipalId)).toBe(true);

            expect(() =>
                service.createGrant(
                    new Grant(
                        new GrantId("stranger-grant"),
                        workspaceScope,
                        SubjectRef.principal(stranger),
                        "allow",
                        capability,
                        { kind: "direct" }
                    )
                )
            ).toThrow(/Grant Principal subject belongs to another Tenant/);
            expect(() =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("stranger-membership"),
                        workspaceScope,
                        SubjectRef.principal(stranger),
                        roleName,
                        "active",
                        Revision.initial()
                    )
                )
            ).toThrow(/Membership Principal subject belongs to another Tenant/);
            expect(store.grant(new GrantId("stranger-grant"))).toBeUndefined();
            expect(store.membership(new MembershipId("stranger-membership"))).toBeUndefined();
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] denies a same-PrincipalId Principal from another Tenant at mediated admission",
        { tags: "p0" },
        () => {
            const { store, service, runtime } = bootstrapped();
            const allow = new Grant(
                grantId,
                workspaceScope,
                SubjectRef.principal(host),
                "allow",
                capability,
                { kind: "direct" }
            );
            service.createGrant(allow);
            const binding = Binding.active(
                workspaceScope,
                allow.subject,
                domain,
                new BindingName("mail"),
                allow.id,
                facet
            );
            service.createBinding(binding);
            const validation = runtime.validateBinding(validationRequest(), new Date(1_000));

            expect(
                runtime.check(checkRequest(binding, host, validation), new Date(1_001)).allowed
            ).toBe(true);
            const denied = runtime.check(
                checkRequest(binding, stranger, validation),
                new Date(1_001)
            );
            expect(denied.allowed).toBe(false);
            expect(denied.reason).toBe("missingPrincipal");
            expect(store.grant(allow.id)?.subject).toEqual(SubjectRef.principal(host));
            expect(() =>
                Binding.active(
                    workspaceScope,
                    SubjectRef.principal(stranger),
                    domain,
                    new BindingName("mail"),
                    allow.id,
                    facet
                )
            ).toThrow(/Binding Principal subject belongs to another Tenant/);
        }
    );
});

function bootstrapped(): {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    readonly runtime: TenantAuthorityRuntime;
} {
    const anchor = {
        actorId: tenantActor.id,
        tenantId: hostTenantId,
        principalId: sharedPrincipalId,
        trustAnchor: Uint8Array.of(1, 2, 3)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createPrincipal(new Principal(new PrincipalId("qualified-extra"), "user", "active"));
    service.createWorkspace(
        new Workspace(workspaceId, hostTenantId, undefined, Revision.initial())
    );
    return { store, service, runtime: new TenantAuthorityRuntime(store, tenantActor) };
}

function currentPath(): PathEpochEvidence {
    return new PathEpochEvidence([
        new ScopeEpoch(ScopeRef.tenant(hostTenantId), 1),
        new ScopeEpoch(workspaceScope, 1)
    ]);
}

function validationRequest(): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: hostTenantId,
        workspaceActor,
        workspaceFence: 1,
        scope: workspaceScope,
        domain,
        name: new BindingName("mail"),
        grantId,
        facet,
        nonce: "qualified-validation"
    });
}

function checkRequest(
    binding: Binding,
    principal: PrincipalRef,
    validation: BindingValidationEvidence
): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
        ownerTenant: hostTenantId,
        owner: workspaceActor,
        ownerFence: 1,
        principal,
        binding,
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: checkArguments,
            argumentsDigest: checkArgumentsDigest
        },
        expectedPath: validation.pathEpochs,
        invocationDigest: Digest.sha256(Uint8Array.of(3)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "qualified-check"
    });
}

/** The pre-qualification wire shape: a Principal subject naming an id and no Tenant. */
function withUnqualifiedSubject(bytes: Uint8Array): Uint8Array {
    const envelope = requireObject(decodeCanonicalJson(bytes));
    const payload = requireObject(envelope["payload"]);
    const subject = requireObject(payload["subject"]);
    return encodeCanonicalJson({
        ...envelope,
        payload: {
            ...payload,
            subject: { kind: subject["kind"]!, principal: subject["principal"]! }
        }
    });
}

function requireObject(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
    if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        throw new TypeError("Expected a JSON object");
    }
    return value as { readonly [key: string]: JsonValue };
}
