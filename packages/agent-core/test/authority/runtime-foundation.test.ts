import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Membership,
    MembershipId,
    GuestVerificationScheme,
    PrincipalId,
    Project,
    ProjectId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId,
    type SubjectRef as SubjectReference
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerification,
    PrincipalRef,
    Workspace
} from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import { BindingValidationRequest } from "../../src/authority/binding-evidence";
import { AuthorityCheckRequest } from "../../src/authority/evidence";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { authorityKey } from "../../src/authority/key";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { TenantAuthorityRuntime } from "../../src/authority/runtime";
import { AuthorityMutationService } from "../../src/authority/service";

const tenantId = new TenantId("tenant-runtime");
const principalId = new PrincipalId("principal-runtime");
const workspaceId = new WorkspaceId("workspace-runtime");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const tenantActor = new ActorRef("tenant", new ActorId("tenant-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("workspace-actor"));
const domain = new ProtectionDomain("backend", "runtime", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const argumentsValue = { folder: "inbox" } as const;
const argumentsDigest = Digest.sha256(encodeCanonicalJson(argumentsValue));

describe("Tenant authority runtime", () => {
    test("persists immutable Tenant Project and Workspace topology", () => {
        const { store, service } = fixture();
        const project = new Project(
            new ProjectId("runtime-project"),
            tenantId,
            "Runtime",
            Revision.initial()
        );
        service.createProject(project);
        const renamed = service.renameProject(project.id, "Runtime renamed");
        const nested = new Workspace(
            new WorkspaceId("nested-workspace"),
            tenantId,
            project.id,
            Revision.initial()
        );
        service.createWorkspace(nested);

        expect(store.project(project.id)?.name).toBe("Runtime renamed");
        expect(store.workspace(nested.id)?.scope.path.map((scope) => scope.kind)).toEqual([
            "tenant",
            "project",
            "workspace"
        ]);
        expect(renamed.revision.value).toBe(1);
    });

    test("[C13-ADV-NEW-DENY] derives canonical topology and deny closure from Tenant stores", () => {
        const { store, service, runtime } = fixture();
        const allow = grant("allow", SubjectRef.principal(principalId), "allow");
        service.createGrant(allow);
        const validation = runtime.validateBinding(validationRequest(allow.id), new Date(1_000));
        const binding = Binding.active(
            workspaceScope,
            validation.subject,
            domain,
            new BindingName("mail"),
            allow.id,
            facet
        );
        const allowed = runtime.check(
            checkRequest(binding, new PrincipalRef(tenantId, principalId), validation.pathEpochs),
            new Date(1_001)
        );

        expect(allowed.allowed).toBe(true);
        expect(allowed.pathEpochs.path.map((entry) => entry.scope.kind)).toEqual([
            "tenant",
            "workspace"
        ]);

        service.createGrant(
            grant("deny", SubjectRef.principal(principalId), "deny", ScopeRef.tenant(tenantId))
        );
        const currentPath = runtime.validateBinding(
            validationRequest(allow.id),
            new Date(1_002)
        ).pathEpochs;
        const denied = runtime.check(
            checkRequest(binding, new PrincipalRef(tenantId, principalId), currentPath),
            new Date(1_002)
        );
        expect(denied.allowed).toBe(false);
        expect(denied.reason).toBe("matchingDeny");
        expect(denied.matchedDeny.map((id) => id.value)).toEqual(["deny"]);
        expect(store.grants()).toHaveLength(3);
    });

    test("[C13-AUTH-DIRECT-SUBJECT] unions direct and Team subjects without allowing unrelated principals", () => {
        const { service, runtime } = fixture();
        const team = new Team(
            new TeamId("team"),
            tenantId,
            "Operators",
            [principalId],
            Revision.initial()
        );
        service.createTeam(team);
        const allow = grant("team-allow", SubjectRef.team(team.id), "allow");
        service.createGrant(allow);
        const binding = Binding.active(
            workspaceScope,
            SubjectRef.team(team.id),
            domain,
            new BindingName("team-mail"),
            allow.id,
            facet
        );

        const currentPath = runtime.validateBinding(
            validationRequest(allow.id),
            new Date(2_000)
        ).pathEpochs;
        expect(
            runtime.check(
                checkRequest(binding, new PrincipalRef(tenantId, principalId), currentPath),
                new Date(2_000)
            ).allowed
        ).toBe(true);
        const wrong = checkRequest(
            binding,
            new PrincipalRef(tenantId, new PrincipalId("other")),
            currentPath
        );
        expect(runtime.check(wrong, new Date(2_001)).reason).toBe("missingPrincipal");
    });

    test("[C13-AUTH-MEDIATED-STALE] returns current path evidence and detects stale mediated evidence", () => {
        const { service, runtime } = fixture();
        const allow = grant("allow-stale", SubjectRef.principal(principalId), "allow");
        service.createGrant(allow);
        const binding = Binding.active(
            workspaceScope,
            allow.subject,
            domain,
            new BindingName("stale"),
            allow.id,
            facet
        );
        const resolvedPath = runtime.validateBinding(
            validationRequest(allow.id),
            new Date(3_000)
        ).pathEpochs;
        const initial = runtime.check(
            checkRequest(binding, new PrincipalRef(tenantId, principalId), resolvedPath),
            new Date(3_000)
        );
        service.createGrant(grant("unrelated-new-allow", allow.subject, "allow"));

        const stale = runtime.check(
            checkRequest(binding, new PrincipalRef(tenantId, principalId), initial.pathEpochs),
            new Date(3_001)
        );
        expect(stale.reason).toBe("stalePath");
        expect(stale.pathEpochs.equals(initial.pathEpochs)).toBe(false);
    });

    test("fails closed for inactive Bindings, missing Grants, and inactive Principals", () => {
        const { service, runtime } = fixture();
        const allow = grant("denial-allow", SubjectRef.principal(principalId), "allow");
        service.createGrant(allow);
        const currentPath = runtime.validateBinding(
            validationRequest(allow.id),
            new Date(3_100)
        ).pathEpochs;
        const active = Binding.active(
            workspaceScope,
            allow.subject,
            domain,
            new BindingName("denials"),
            allow.id,
            facet
        );

        expect(
            runtime.check(
                checkRequest(
                    active.deactivate(),
                    new PrincipalRef(tenantId, principalId),
                    currentPath
                ),
                new Date(3_101)
            ).reason
        ).toBe("invalidBinding");
        expect(
            runtime.check(
                checkRequest(
                    Binding.active(
                        workspaceScope,
                        allow.subject,
                        domain,
                        new BindingName("missing"),
                        new GrantId("missing"),
                        facet
                    ),
                    new PrincipalRef(tenantId, principalId),
                    currentPath
                ),
                new Date(3_101)
            ).reason
        ).toBe("missingGrant");

        service.disablePrincipal(principalId);
        const disabledPath = runtime.validateBinding(
            validationRequest(allow.id),
            new Date(3_102)
        ).pathEpochs;
        expect(
            runtime.check(
                checkRequest(active, new PrincipalRef(tenantId, principalId), disabledPath),
                new Date(3_102)
            ).reason
        ).toBe("inactivePrincipal");
    });

    test("rejects revoked backing Grants and facet substitution", () => {
        const { service, runtime } = fixture();
        const backing = grant("revoked-backing", SubjectRef.principal(principalId), "allow");
        const pathSource = grant("path-source", SubjectRef.principal(principalId), "allow");
        service.createGrant(backing);
        service.createGrant(pathSource);
        const binding = Binding.active(
            workspaceScope,
            backing.subject,
            domain,
            new BindingName("revoked"),
            backing.id,
            facet
        );
        service.revokeGrant(backing.id);
        const currentPath = runtime.validateBinding(
            validationRequest(pathSource.id),
            new Date(3_200)
        ).pathEpochs;

        expect(
            runtime.check(
                checkRequest(binding, new PrincipalRef(tenantId, principalId), currentPath),
                new Date(3_201)
            ).reason
        ).toBe("revokedGrant");
        const substituted = Binding.active(
            workspaceScope,
            pathSource.subject,
            domain,
            new BindingName("substituted"),
            pathSource.id,
            new FacetRef("workspace:other.instance")
        );
        expect(
            runtime.check(
                checkRequest(substituted, new PrincipalRef(tenantId, principalId), currentPath),
                new Date(3_201)
            ).reason
        ).toBe("noMatchingAllow");
    });
});

describe("verified guest lifecycle", () => {
    test("materializes attenuated guest Grants and revokes them when trust is revoked", () => {
        const { store, service, runtime } = fixture();
        const home = new TenantId("guest-home");
        const guest = new PrincipalId("guest-principal");
        const trust = new GuestTrust(
            new GuestTrustId("guest-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://guest.example/verify" },
            "active",
            Revision.initial()
        );
        const role = new Role(new RoleName("guest-reader"), [
            new RoleRule(
                "allow",
                new CapabilitySpec({
                    facetPattern: "workspace:mail.*",
                    impacts: ["observe"]
                })
            ),
            new RoleRule(
                "allow",
                new CapabilitySpec({
                    facetPattern: "workspace:mail.*",
                    impacts: ["delegate"]
                })
            ),
            new RoleRule(
                "deny",
                new CapabilitySpec({
                    facetPattern: "workspace:mail.secret",
                    impacts: ["observe"]
                })
            )
        ]);
        const membership = new Membership(
            new MembershipId("guest-membership"),
            workspaceScope,
            SubjectRef.foreign(home, guest, GuestVerificationScheme.callback),
            role.name,
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);
        service.createRole(role);
        service.assignGuestMembership(
            membership,
            new GuestVerification(
                new PrincipalRef(home, guest),
                trust.id,
                trust.revision,
                "callback",
                Digest.sha256(Uint8Array.of(7)),
                new Date(4_000),
                new Date(5_000)
            ),
            new Date(4_500)
        );

        const guestGrants = store
            .grants()
            .filter(
                (candidate) =>
                    candidate.origin.kind === "role" &&
                    candidate.origin.membershipId.equals(membership.id)
            );
        expect(guestGrants.map((candidate) => candidate.effect).sort()).toEqual(["allow", "deny"]);
        expect(guestGrants.some((candidate) => candidate.capability.grantsElevation())).toBe(false);

        service.changeRole(
            new Role(role.name, [
                ...role.rules,
                new RoleRule(
                    "allow",
                    new CapabilitySpec({
                        facetPattern: "workspace:calendar.*",
                        impacts: ["observe"]
                    })
                )
            ])
        );
        expect(
            store
                .grants()
                .filter(
                    (candidate) =>
                        candidate.origin.kind === "role" &&
                        candidate.origin.membershipId.equals(membership.id) &&
                        candidate.effect === "deny"
                )
                .every((candidate) => candidate.isLive)
        ).toBe(true);

        const backing = store
            .grants()
            .find(
                (candidate) =>
                    candidate.origin.kind === "role" &&
                    candidate.origin.membershipId.equals(membership.id) &&
                    candidate.effect === "allow" &&
                    candidate.capability.facetPattern === "workspace:mail.*"
            )!;
        const guestBinding = Binding.active(
            workspaceScope,
            membership.subject,
            domain,
            new BindingName("guest-mail"),
            backing.id,
            facet
        );
        const guestPath = runtime.validateBinding(
            validationRequest(backing.id),
            new Date(4_999)
        ).pathEpochs;
        expect(
            runtime.check(
                checkRequest(guestBinding, new PrincipalRef(home, guest), guestPath),
                new Date(5_000)
            ).reason
        ).toBe("guestVerificationExpired");

        const unrelatedTrust = new GuestTrust(
            new GuestTrustId("unrelated-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://other.example/verify" },
            "active",
            Revision.initial()
        );
        service.createGuestTrust(unrelatedTrust);
        service.revokeGuestTrust(unrelatedTrust.id);
        expect(store.membership(membership.id)?.state).toBe("active");

        service.revokeGuestTrust(trust.id);
        expect(store.membership(membership.id)?.state).toBe("revoked");
        expect(
            store
                .grants()
                .filter(
                    (candidate) =>
                        candidate.origin.kind === "role" &&
                        candidate.origin.membershipId.equals(membership.id)
                )
                .every((candidate) => !candidate.isLive)
        ).toBe(true);
    });

    test("rejects verification issued in the future without persisting guest state", () => {
        const { store, service } = fixture();
        const home = new TenantId("future-home");
        const guest = new PrincipalId("future-guest");
        const trust = new GuestTrust(
            new GuestTrustId("future-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://future.example/verify" },
            "active",
            Revision.initial()
        );
        const role = new Role(new RoleName("future-role"), [
            new RoleRule(
                "allow",
                new CapabilitySpec({
                    facetPattern: "workspace:mail.*",
                    impacts: ["observe"]
                })
            )
        ]);
        const membership = new Membership(
            new MembershipId("future-membership"),
            workspaceScope,
            SubjectRef.foreign(home, guest, GuestVerificationScheme.callback),
            role.name,
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);
        expect(
            service.rotateGuestTrust(trust.id, {
                kind: "callback",
                endpoint: "https://future.example/verify-rotated"
            }).revision.value
        ).toBe(1);
        const rotatedTrust = store.guestTrust(trust.id)!;
        service.createRole(role);

        expect(() =>
            service.assignGuestMembership(
                membership,
                new GuestVerification(
                    new PrincipalRef(home, guest),
                    rotatedTrust.id,
                    rotatedTrust.revision,
                    "callback",
                    Digest.sha256(Uint8Array.of(5)),
                    new Date(10_000),
                    new Date(20_000)
                ),
                new Date(9_999)
            )
        ).toThrow(/not currently valid/);
        expect(store.membership(membership.id)).toBeUndefined();
    });
});

describe("canonical authority keys", () => {
    test("does not collide at component boundaries", () => {
        expect(authorityKey("binding", ["a:b", "c"])).not.toBe(
            authorityKey("binding", ["a", "b:c"])
        );
    });
});

function fixture(): {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    readonly runtime: TenantAuthorityRuntime;
} {
    const anchor = {
        actorId: tenantActor.id,
        tenantId,
        principalId,
        trustAnchor: Uint8Array.of(1, 2, 3)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    return { store, service, runtime: new TenantAuthorityRuntime(store, tenantActor) };
}

function grant(
    id: string,
    subject: SubjectReference,
    effect: "allow" | "deny",
    scope = workspaceScope
): Grant {
    return new Grant(
        new GrantId(id),
        scope,
        subject,
        effect,
        new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] }),
        { kind: "direct" }
    );
}

function validationRequest(grantId: GrantId): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: tenantId,
        workspaceActor,
        workspaceFence: 1,
        scope: workspaceScope,
        domain,
        name: new BindingName("mail"),
        grantId,
        facet,
        nonce: "validation-1"
    });
}

function checkRequest(
    binding: Binding,
    principal: PrincipalRef,
    expectedPath: import("../../src/authority/epoch").PathEpochEvidence
): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
        ownerTenant: tenantId,
        owner: workspaceActor,
        ownerFence: 1,
        principal,
        binding,
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: argumentsValue,
            argumentsDigest
        },
        expectedPath,
        invocationDigest: Digest.sha256(Uint8Array.of(3)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "check-1"
    });
}
