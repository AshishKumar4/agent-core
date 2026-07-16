// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { Digest, Revision, SecretRef } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { CapabilitySpec } from "../../src/facets";
import {
    Membership,
    MembershipId,
    GuestVerificationScheme,
    Principal,
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
import { ScopeEpoch } from "../../src/authority/epoch";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import {
    AuthorityMutationService,
    createTenantControlBootstrapPlan
} from "../../src/authority/service";

const tenantId = new TenantId("memory-hard-tenant");
const ownerId = new PrincipalId("memory-hard-owner");
const workspaceId = new WorkspaceId("memory-hard-workspace");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const anchor = {
    actorId: new ActorId("memory-hard-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(1, 2, 3)
};

describe("AuthorityMutationService hard gates", () => {
    test("[C13-AUTH-TEAM-SUBJECT] covers Principal, Team, Project, and Workspace lifecycle errors", () => {
        const { store, service } = fixture(false);
        const principal = new Principal(new PrincipalId("new-principal"), "user", "active");
        expect(service.createPrincipal(principal)).toBe(principal);
        expectAgentError(() => service.createPrincipal(principal), "protocol.invalid-state");
        expectAgentError(
            () => service.disablePrincipal(new PrincipalId("missing")),
            "protocol.invalid-state"
        );
        expect(service.disablePrincipal(principal.id).canAct).toBe(false);
        expect(service.disablePrincipal(principal.id).canAct).toBe(false);

        expectAgentError(
            () =>
                service.createTeam(
                    new Team(
                        new TeamId("foreign-team"),
                        new TenantId("foreign"),
                        "Foreign",
                        [],
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createTeam(
                    new Team(new TeamId("revised-team"), tenantId, "Revised", [], new Revision(1))
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createTeam(
                    new Team(
                        new TeamId("missing-principal-team"),
                        tenantId,
                        "Missing principal",
                        [new PrincipalId("missing")],
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        const team = new Team(new TeamId("team"), tenantId, "Team", [ownerId], Revision.initial());
        service.createTeam(team);
        expectAgentError(() => service.createTeam(team), "protocol.invalid-state");
        expectAgentError(
            () => service.changeTeam(new TeamId("missing"), "Missing", []),
            "protocol.invalid-state"
        );
        expect(service.changeTeam(team.id, "Changed", []).revision.value).toBe(1);

        expectAgentError(
            () =>
                service.createProject(
                    new Project(
                        new ProjectId("foreign-project"),
                        new TenantId("foreign"),
                        "Foreign",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        const project = new Project(
            new ProjectId("project"),
            tenantId,
            "Project",
            Revision.initial()
        );
        service.createProject(project);
        expectAgentError(() => service.createProject(project), "protocol.invalid-state");
        expectAgentError(
            () => service.renameProject(new ProjectId("missing"), "Missing"),
            "protocol.invalid-state"
        );

        expectAgentError(
            () =>
                service.createWorkspace(
                    new Workspace(
                        new WorkspaceId("foreign-workspace"),
                        new TenantId("foreign"),
                        undefined,
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createWorkspace(
                    new Workspace(
                        new WorkspaceId("missing-project-workspace"),
                        tenantId,
                        new ProjectId("missing"),
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        const workspace = new Workspace(workspaceId, tenantId, project.id, Revision.initial());
        service.createWorkspace(workspace);
        expectAgentError(() => service.createWorkspace(workspace), "protocol.invalid-state");
        expect(store.workspace(workspace.id)?.projectId?.equals(project.id)).toBe(true);
    });

    test("covers guest trust and Role lifecycle errors", () => {
        const { service } = fixture();
        const home = new TenantId("guest-home");
        const trust = guestTrust("trust", home);
        expectAgentError(
            () =>
                service.createGuestTrust(
                    new GuestTrust(
                        new GuestTrustId("foreign-trust"),
                        new TenantId("foreign"),
                        home,
                        trust.verifier,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(() => service.createGuestTrust(trust.revoke()), "protocol.invalid-state");
        service.createGuestTrust(trust);
        expectAgentError(() => service.createGuestTrust(trust), "protocol.invalid-state");
        expectAgentError(
            () => service.rotateGuestTrust(new GuestTrustId("missing"), trust.verifier),
            "protocol.invalid-state"
        );
        const rotated = service.rotateGuestTrust(trust.id, {
            kind: "token",
            issuer: "issuer",
            key: new SecretRef("tenant", "oidc", "key")
        });
        expect(rotated.revision.value).toBe(1);
        expect(service.revokeGuestTrust(trust.id).state).toBe("revoked");
        expect(service.revokeGuestTrust(trust.id).state).toBe("revoked");

        const existingRole = role("role");
        service.createRole(existingRole);
        expectAgentError(() => service.createRole(existingRole), "protocol.invalid-state");
        expectAgentError(() => service.changeRole(role("missing")), "protocol.invalid-state");
        expect(Role.encode(service.changeRole(Role.decode(Role.encode(existingRole))))).toEqual(
            Role.encode(existingRole)
        );
    });

    test("covers Membership admission and transition errors", () => {
        const { store, service } = fixture();
        const reader = role("hard-reader");
        service.createRole(reader);
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("suspended-new"),
                        workspaceScope,
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "suspended",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-project"),
                        ScopeRef.project(tenantId, new ProjectId("missing")),
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        const missingProjectId = {
            kind: "project" as const,
            tenantId,
            projectId: undefined,
            workspaceId: undefined,
            path: [],
            equals: () => false
        } as unknown as ScopeRef;
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-project-id"),
                        missingProjectId,
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        const missingWorkspaceId = {
            kind: "workspace" as const,
            tenantId,
            projectId: undefined,
            workspaceId: undefined,
            path: [],
            equals: () => false
        } as unknown as ScopeRef;
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-workspace-id"),
                        missingWorkspaceId,
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-role"),
                        workspaceScope,
                        SubjectRef.principal(ownerId),
                        new RoleName("missing"),
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("foreign-scope"),
                        ScopeRef.tenant(new TenantId("foreign")),
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-principal"),
                        workspaceScope,
                        SubjectRef.principal(new PrincipalId("missing")),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-team"),
                        workspaceScope,
                        SubjectRef.team(new TeamId("missing")),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("unverified-guest"),
                        workspaceScope,
                        SubjectRef.foreign(
                            new TenantId("home"),
                            new PrincipalId("guest"),
                            GuestVerificationScheme.callback
                        ),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "authority.denied"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("future-workspace"),
                        ScopeRef.workspace(tenantId, new WorkspaceId("future")),
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state"
        );

        const member = new Membership(
            new MembershipId("member"),
            workspaceScope,
            SubjectRef.principal(ownerId),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        expectAgentError(() => service.assignMembership(member), "protocol.invalid-state");
        expectAgentError(
            () =>
                service.changeMembership(new MembershipId("missing"), {
                    role: reader.name,
                    state: "active"
                }),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.changeMembership(member.id, {
                    role: new RoleName("missing"),
                    state: "active"
                }),
            "protocol.invalid-state"
        );
        expect(
            service.changeMembership(member.id, {
                role: reader.name,
                state: "suspended"
            }).state
        ).toBe("suspended");
        expect(service.revokeMembership(member.id).state).toBe("revoked");
        expect(service.revokeMembership(member.id).state).toBe("revoked");
        expect(store.membership(member.id)?.state).toBe("revoked");
    });

    test("covers verified guest admission failures", () => {
        const { service } = fixture();
        const home = new TenantId("verified-home");
        const guest = new PrincipalId("verified-guest");
        const trust = guestTrust("verified-trust", home);
        const reader = role("guest-reader");
        service.createGuestTrust(trust);
        service.createRole(reader);
        const proof = new GuestVerification(
            new PrincipalRef(home, guest),
            trust.id,
            trust.revision,
            "callback",
            Digest.sha256(Uint8Array.of(7)),
            new Date(100),
            new Date(200)
        );
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    new Membership(
                        new MembershipId("local-as-guest"),
                        workspaceScope,
                        SubjectRef.principal(ownerId),
                        reader.name,
                        "active",
                        Revision.initial()
                    ),
                    proof,
                    new Date(150)
                ),
            "protocol.invalid-state"
        );
        const membership = new Membership(
            new MembershipId("verified-member"),
            workspaceScope,
            SubjectRef.foreign(home, guest, GuestVerificationScheme.callback),
            reader.name,
            "active",
            Revision.initial()
        );
        expectAgentError(
            () => service.assignGuestMembership(membership, proof, new Date(200)),
            "authority.denied"
        );
        expect(service.assignGuestMembership(membership, proof, new Date(150)).isActive).toBe(true);
    });

    test("[C13-AUTH-MEDIATED-ADMISSION] covers Grant admission, delegation, and revocation errors", () => {
        const { service } = fixture();
        expectAgentError(
            () =>
                service.createGrant(
                    grant("role-origin", SubjectRef.principal(ownerId), {
                        kind: "role",
                        membershipId: new MembershipId("member"),
                        roleName: "role",
                        ruleOrdinal: 0,
                        guest: false
                    })
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    grant(
                        "foreign-scope",
                        SubjectRef.principal(ownerId),
                        { kind: "direct" },
                        ScopeRef.tenant(new TenantId("foreign"))
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    grant(
                        "future-workspace-grant",
                        SubjectRef.principal(ownerId),
                        { kind: "direct" },
                        ScopeRef.workspace(tenantId, new WorkspaceId("future"))
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    grant("missing-principal", SubjectRef.principal(new PrincipalId("missing")), {
                        kind: "direct"
                    })
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    grant(
                        "guest-direct",
                        SubjectRef.foreign(
                            new TenantId("home"),
                            new PrincipalId("guest"),
                            GuestVerificationScheme.callback
                        ),
                        { kind: "direct" }
                    )
                ),
            "protocol.invalid-state"
        );
        const parent = grant("parent", SubjectRef.principal(ownerId), { kind: "direct" });
        service.createGrant(parent);
        expectAgentError(
            () =>
                service.createGrant(
                    new Grant(
                        new GrantId("wider-child"),
                        workspaceScope,
                        parent.subject,
                        "allow",
                        new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
                        { kind: "direct" },
                        parent.id
                    )
                ),
            "authority.denied"
        );
        expectAgentError(() => service.createGrant(parent), "protocol.invalid-state");
        expectAgentError(
            () => service.revokeGrant(new GrantId("missing")),
            "protocol.invalid-state"
        );
        expect(service.revokeGrant(parent.id).isLive).toBe(false);
        expect(service.revokeGrant(parent.id).isLive).toBe(false);

        const secondParent = grant("second-parent", SubjectRef.principal(ownerId), {
            kind: "direct"
        });
        const secondChild = new Grant(
            new GrantId("second-child"),
            workspaceScope,
            secondParent.subject,
            "allow",
            secondParent.capability,
            { kind: "direct" },
            secondParent.id
        );
        service.createGrant(secondParent);
        service.createGrant(secondChild);
        service.revokeGrant(secondChild.id);
        expect(service.revokeGrant(secondParent.id).isLive).toBe(false);
    });
});

describe("MemoryTenantControlStore operational taxonomy", () => {
    test("uses AgentCoreError for transaction and write-state failures", () => {
        const { store } = fixture();
        expectAgentError(
            () =>
                store.putGrant(grant("outside", SubjectRef.principal(ownerId), { kind: "direct" })),
            "protocol.invalid-state"
        );
        expectAgentError(
            () => store.transaction(() => store.transaction(() => undefined)),
            "protocol.invalid-state"
        );
        expectAgentError(() => store.transaction(async () => undefined), "protocol.invalid-state");
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putEpoch(
                        new ScopeEpoch(workspaceScope, candidate.epoch(workspaceScope).epoch + 2)
                    )
                ),
            "protocol.revision-conflict"
        );
    });

    test("keeps bootstrap failures attributable", () => {
        expectAgentError(
            () =>
                createTenantControlBootstrapPlan(
                    { ...anchor, actorId: "" as never },
                    Revision.initial()
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () => createTenantControlBootstrapPlan(anchor, new Revision(1)),
            "protocol.revision-conflict"
        );
    });

    test("[C13-AUTH-DIRECT-DEADLINE] enforces every direct memory writer invariant", () => {
        const { store, service } = fixture();
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putProject(
                        new Project(
                            new ProjectId("foreign-direct-project"),
                            new TenantId("foreign"),
                            "Foreign",
                            Revision.initial()
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putProject(
                        new Project(
                            new ProjectId("revised-direct-project"),
                            tenantId,
                            "Revised",
                            new Revision(1)
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        const project = new Project(
            new ProjectId("direct-project"),
            tenantId,
            "Direct",
            Revision.initial()
        );
        service.createProject(project);
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putProject(
                        new Project(project.id, tenantId, "Skipped", new Revision(2))
                    )
                ),
            "protocol.revision-conflict"
        );

        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putWorkspace(
                        new Workspace(
                            new WorkspaceId("foreign-direct-workspace"),
                            new TenantId("foreign"),
                            undefined,
                            Revision.initial()
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        const workspace = store.workspace(workspaceId)!;
        expectAgentError(
            () => store.transaction((candidate) => candidate.putWorkspace(workspace)),
            "protocol.invalid-state"
        );

        const trust = guestTrust("direct-trust", new TenantId("direct-home"));
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putGuestTrust(
                        new GuestTrust(
                            new GuestTrustId("foreign-direct-trust"),
                            new TenantId("foreign"),
                            trust.homeTenant,
                            trust.verifier,
                            "active",
                            Revision.initial()
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () => store.transaction((candidate) => candidate.putGuestTrust(trust.revoke())),
            "protocol.invalid-state"
        );
        service.createGuestTrust(trust);
        store.transaction((candidate) => candidate.putGuestTrust(trust));
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putGuestTrust(
                        new GuestTrust(
                            trust.id,
                            tenantId,
                            new TenantId("other-home"),
                            trust.verifier,
                            "active",
                            trust.revision.next()
                        )
                    )
                ),
            "protocol.revision-conflict"
        );

        const extra = new Principal(new PrincipalId("direct-principal"), "user", "active");
        service.createPrincipal(extra);
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putPrincipal(new Principal(extra.id, "service", "active"))
                ),
            "protocol.invalid-state"
        );
        service.disablePrincipal(extra.id);
        expectAgentError(
            () => store.transaction((candidate) => candidate.putPrincipal(extra)),
            "protocol.invalid-state"
        );

        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putTeam(
                        new Team(
                            new TeamId("foreign-direct-team"),
                            new TenantId("foreign"),
                            "Foreign",
                            [],
                            Revision.initial()
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putTeam(
                        new Team(
                            new TeamId("missing-principal-direct-team"),
                            tenantId,
                            "Missing principal",
                            [new PrincipalId("missing")],
                            Revision.initial()
                        )
                    )
                ),
            "codec.invalid"
        );
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putTeam(
                        new Team(
                            new TeamId("revised-direct-team"),
                            tenantId,
                            "Revised",
                            [],
                            new Revision(1)
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        const team = new Team(
            new TeamId("direct-team"),
            tenantId,
            "Direct",
            [],
            Revision.initial()
        );
        service.createTeam(team);
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putTeam(new Team(team.id, tenantId, "Skipped", [], new Revision(2)))
                ),
            "protocol.revision-conflict"
        );

        const ownerMembership = store
            .memberships()
            .find(
                (member) =>
                    member.subject.kind === "principal" &&
                    member.subject.principalId.equals(ownerId)
            )!;
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putMembership(
                        new Membership(
                            new MembershipId("suspended-direct-member"),
                            workspaceScope,
                            SubjectRef.principal(ownerId),
                            ownerMembership.role,
                            "suspended",
                            Revision.initial()
                        )
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putMembership(
                        new Membership(
                            ownerMembership.id,
                            workspaceScope,
                            ownerMembership.subject,
                            ownerMembership.role,
                            "active",
                            ownerMembership.revision.next()
                        )
                    )
                ),
            "protocol.revision-conflict"
        );

        const directRole = role("direct-membership-role");
        service.createRole(directRole);
        const directMember = new Membership(
            new MembershipId("direct-suspended-member"),
            workspaceScope,
            SubjectRef.principal(ownerId),
            directRole.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(directMember);
        const suspended = service.changeMembership(directMember.id, {
            role: directRole.name,
            state: "suspended"
        });
        expectAgentError(
            () =>
                store.transaction((candidate) =>
                    candidate.putMembership(
                        new Membership(
                            suspended.id,
                            suspended.scope,
                            suspended.subject,
                            suspended.role,
                            "active",
                            suspended.revision.next(),
                            suspended.guestVerification
                        )
                    )
                ),
            "protocol.invalid-state"
        );

        const directGrantRecord = grant("direct-write-grant", SubjectRef.principal(ownerId), {
            kind: "direct"
        });
        service.createGrant(directGrantRecord);
        store.transaction((candidate) => candidate.putGrant(directGrantRecord));
        store.transaction((candidate) => candidate.putEpoch(candidate.epoch(workspaceScope)));
    });

    test("rejects constituent bootstrap-plan substitution", () => {
        const fresh = MemoryTenantControlStore.create(anchor);
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
        expectAgentError(
            () =>
                fresh.bootstrap({
                    ...plan,
                    owner: new Principal(new PrincipalId("substitute"), "user", "active")
                }),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                fresh.bootstrap({
                    ...plan,
                    roles: [plan.roles[0]!, plan.roles[0]!, plan.roles[1]!] as never
                }),
            "protocol.invalid-state"
        );
    });
});

function fixture(withWorkspace = true): {
    store: MemoryTenantControlStore;
    service: AuthorityMutationService;
} {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    if (withWorkspace) {
        service.createWorkspace(
            new Workspace(workspaceId, tenantId, undefined, Revision.initial())
        );
    }
    return { store, service };
}

function role(name: string): Role {
    return new Role(new RoleName(name), [
        new RoleRule(
            "allow",
            new CapabilitySpec({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["observe"],
                operations: []
            })
        )
    ]);
}

function guestTrust(id: string, home: TenantId): GuestTrust {
    return new GuestTrust(
        new GuestTrustId(id),
        tenantId,
        home,
        { kind: "callback", endpoint: `https://${id}.example/verify` },
        "active",
        Revision.initial()
    );
}

function grant(
    id: string,
    subject: SubjectReference,
    origin: ConstructorParameters<typeof Grant>[5],
    scope = workspaceScope
): Grant {
    return new Grant(
        new GrantId(id),
        scope,
        subject,
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        origin
    );
}

function expectAgentError(action: () => unknown, code: AgentCoreErrorCode): void {
    try {
        action();
        throw new Error("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
