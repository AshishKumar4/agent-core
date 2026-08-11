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
    type MembershipState,
    type SubjectRef as SubjectReference
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerification,
    PrincipalRef,
    Workspace
} from "../identity/internal-fixture";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import {
    AuthorityMutationService,
    createTenantControlBootstrapPlan
} from "../../src/authority/service";

const tenantId = new TenantId("mutation-gate-tenant");
const ownerId = new PrincipalId("mutation-gate-owner");
const workspaceId = new WorkspaceId("mutation-gate-workspace");
const tenantScope = ScopeRef.tenant(tenantId);
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const guestHome = new TenantId("mutation-gate-guest-home");
const guestId = new PrincipalId("mutation-gate-guest");
const anchor = {
    actorId: new ActorId("mutation-gate-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(4, 5, 6)
};

describe("createTenantControlBootstrapPlan anchor validation", () => {
    test("rejects an empty trust anchor as malformed", { tags: "p0" }, () => {
        expectAgentError(
            () =>
                createTenantControlBootstrapPlan(
                    { ...anchor, trustAnchor: new Uint8Array() },
                    Revision.initial()
                ),
            "protocol.invalid-state",
            "Tenant bootstrap anchor is malformed"
        );
    });

    test(
        "derives the owner Membership ID deterministically from the anchor",
        { tags: "p1" },
        () => {
            const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
            const replay = createTenantControlBootstrapPlan(anchor, Revision.initial());
            const other = createTenantControlBootstrapPlan(
                { ...anchor, principalId: new PrincipalId("mutation-gate-other-owner") },
                Revision.initial()
            );
            expect(plan.ownerMembership.id.value).toBe(replay.ownerMembership.id.value);
            expect(plan.ownerMembership.id.value).not.toBe(other.ownerMembership.id.value);
        }
    );
});

describe("AuthorityMutationService record-existence taxonomy", () => {
    test("names the record in every already-exists rejection", { tags: "p1" }, () => {
        const { service } = fixture();
        const principal = new Principal(new PrincipalId("dup-principal"), "user", "active");
        service.createPrincipal(principal);
        expectAgentError(
            () => service.createPrincipal(principal),
            "protocol.invalid-state",
            "Principal already exists"
        );

        const team = new Team(new TeamId("dup-team"), tenantId, "Dup", [], Revision.initial());
        service.createTeam(team);
        expectAgentError(
            () => service.createTeam(team),
            "protocol.invalid-state",
            "Team already exists"
        );

        const project = new Project(
            new ProjectId("dup-project"),
            tenantId,
            "Dup",
            Revision.initial()
        );
        service.createProject(project);
        expectAgentError(
            () => service.createProject(project),
            "protocol.invalid-state",
            "Project already exists"
        );

        const workspace = new Workspace(
            new WorkspaceId("dup-workspace"),
            tenantId,
            undefined,
            Revision.initial()
        );
        service.createWorkspace(workspace);
        expectAgentError(
            () => service.createWorkspace(workspace),
            "protocol.invalid-state",
            "Workspace already exists"
        );

        const trust = callbackTrust("dup-trust");
        service.createGuestTrust(trust);
        expectAgentError(
            () => service.createGuestTrust(trust),
            "protocol.invalid-state",
            "Guest trust already exists"
        );

        const reader = role("dup-role");
        service.createRole(reader);
        expectAgentError(
            () => service.createRole(reader),
            "protocol.invalid-state",
            "Role already exists"
        );

        const member = new Membership(
            new MembershipId("dup-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        expectAgentError(
            () => service.assignMembership(member),
            "protocol.invalid-state",
            "Membership already exists"
        );

        const record = grant(
            "dup-grant",
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            { kind: "direct" }
        );
        service.createGrant(record);
        expectAgentError(
            () => service.createGrant(record),
            "protocol.invalid-state",
            "Grant already exists"
        );
    });

    test("names the record in every does-not-exist rejection", { tags: "p1" }, () => {
        const { service } = fixture();
        const reader = role("missing-taxonomy-role");
        service.createRole(reader);
        expectAgentError(
            () => service.disablePrincipal(new PrincipalId("missing")),
            "protocol.invalid-state",
            "Principal does not exist"
        );
        expectAgentError(
            () =>
                service.createTeam(
                    new Team(
                        new TeamId("missing-principal-team"),
                        tenantId,
                        "Missing",
                        [new PrincipalId("missing")],
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Principal does not exist"
        );
        expectAgentError(
            () => service.changeTeam(new TeamId("missing"), "Missing", []),
            "protocol.invalid-state",
            "Team does not exist"
        );
        expectAgentError(
            () => service.renameProject(new ProjectId("missing"), "Missing"),
            "protocol.invalid-state",
            "Project does not exist"
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
            "protocol.invalid-state",
            "Workspace Project does not exist"
        );
        expectAgentError(
            () =>
                service.rotateGuestTrust(new GuestTrustId("missing"), {
                    kind: "callback",
                    endpoint: "https://missing.example/verify"
                }),
            "protocol.invalid-state",
            "Guest trust does not exist"
        );
        expectAgentError(
            () => service.revokeGuestTrust(new GuestTrustId("missing")),
            "protocol.invalid-state",
            "Guest trust does not exist"
        );
        expectAgentError(
            () => service.changeRole(role("missing")),
            "protocol.invalid-state",
            "Role does not exist"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-role-member"),
                        workspaceScope,
                        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                        new RoleName("missing"),
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Role does not exist"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-principal-member"),
                        workspaceScope,
                        SubjectRef.principal(
                            new PrincipalRef(tenantId, new PrincipalId("missing"))
                        ),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Principal does not exist"
        );
        expectAgentError(
            () =>
                service.assignMembership(
                    new Membership(
                        new MembershipId("missing-team-member"),
                        workspaceScope,
                        SubjectRef.team(new TeamId("missing")),
                        reader.name,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Team does not exist"
        );
        expectAgentError(
            () =>
                service.changeMembership(new MembershipId("missing"), {
                    role: reader.name,
                    state: "active"
                }),
            "protocol.invalid-state",
            "Membership does not exist"
        );
        const member = new Membership(
            new MembershipId("taxonomy-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        expectAgentError(
            () =>
                service.changeMembership(member.id, {
                    role: new RoleName("missing"),
                    state: "active"
                }),
            "protocol.invalid-state",
            "Role does not exist"
        );
        expectAgentError(
            () => service.revokeMembership(new MembershipId("missing")),
            "protocol.invalid-state",
            "Membership does not exist"
        );
        expectAgentError(
            () => service.revokeGrant(new GrantId("missing")),
            "protocol.invalid-state",
            "Grant does not exist"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    new Grant(
                        new GrantId("missing-parent-child"),
                        workspaceScope,
                        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                        "allow",
                        observeCapability(),
                        { kind: "direct" },
                        new GrantId("missing")
                    )
                ),
            "protocol.invalid-state",
            "Parent Grant does not exist"
        );
    });

    test("missing Grant subjects stay in the protocol taxonomy", { tags: "p0" }, () => {
        const { service } = fixture();
        expectAgentError(
            () =>
                service.createGrant(
                    grant(
                        "missing-principal-grant",
                        SubjectRef.principal(
                            new PrincipalRef(tenantId, new PrincipalId("missing"))
                        ),
                        {
                            kind: "direct"
                        }
                    )
                ),
            "protocol.invalid-state",
            "Principal does not exist"
        );
        expectAgentError(
            () =>
                service.createGrant(
                    grant("missing-team-grant", SubjectRef.team(new TeamId("missing")), {
                        kind: "direct"
                    })
                ),
            "protocol.invalid-state",
            "Team does not exist"
        );
    });
});

describe("AuthorityMutationService creation gate precedence", () => {
    test("Team creation checks tenant, then revision, then Principals", { tags: "p0" }, () => {
        const { service } = fixture();
        expectAgentError(
            () =>
                service.createTeam(
                    new Team(
                        new TeamId("foreign-revised-team"),
                        new TenantId("foreign"),
                        "Foreign",
                        [],
                        new Revision(1)
                    )
                ),
            "protocol.invalid-state",
            "Team belongs to another Tenant"
        );
        expectAgentError(
            () =>
                service.createTeam(
                    new Team(
                        new TeamId("revised-missing-team"),
                        tenantId,
                        "Revised",
                        [new PrincipalId("missing")],
                        new Revision(1)
                    )
                ),
            "protocol.invalid-state",
            "New Teams require revision zero"
        );
    });

    test(
        "Workspace creation validates tenant and revision before its Project",
        { tags: "p0" },
        () => {
            const { service } = fixture();
            expectAgentError(
                () =>
                    service.createWorkspace(
                        new Workspace(
                            new WorkspaceId("foreign-workspace"),
                            new TenantId("foreign"),
                            new ProjectId("missing"),
                            Revision.initial()
                        )
                    ),
                "protocol.invalid-state",
                "New Workspaces require the local Tenant and revision zero"
            );
        }
    );

    test("Project creation rejects foreign tenants and non-zero revisions", { tags: "p0" }, () => {
        const { service } = fixture();
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
            "protocol.invalid-state",
            "New Projects require the local Tenant and revision zero"
        );
        expectAgentError(
            () =>
                service.createProject(
                    new Project(
                        new ProjectId("revised-project"),
                        tenantId,
                        "Revised",
                        new Revision(1)
                    )
                ),
            "protocol.invalid-state",
            "New Projects require the local Tenant and revision zero"
        );
    });

    test(
        "guest trust creation gate covers host, state, and revision faults",
        { tags: "p0" },
        () => {
            const { service } = fixture();
            const message =
                "New guest trust requires the local host Tenant, active state, and revision zero";
            expectAgentError(
                () =>
                    service.createGuestTrust(
                        new GuestTrust(
                            new GuestTrustId("foreign-host-trust"),
                            new TenantId("foreign-host"),
                            guestHome,
                            { kind: "callback", endpoint: "https://foreign-host.example/verify" },
                            "active",
                            Revision.initial()
                        )
                    ),
                "protocol.invalid-state",
                message
            );
            expectAgentError(
                () =>
                    service.createGuestTrust(
                        new GuestTrust(
                            new GuestTrustId("revoked-new-trust"),
                            tenantId,
                            guestHome,
                            { kind: "callback", endpoint: "https://revoked-new.example/verify" },
                            "revoked",
                            Revision.initial()
                        )
                    ),
                "protocol.invalid-state",
                message
            );
            expectAgentError(
                () =>
                    service.createGuestTrust(
                        new GuestTrust(
                            new GuestTrustId("revised-new-trust"),
                            tenantId,
                            guestHome,
                            { kind: "callback", endpoint: "https://revised-new.example/verify" },
                            "active",
                            new Revision(1)
                        )
                    ),
                "protocol.invalid-state",
                message
            );
        }
    );

    test(
        "Membership admission rejects revision and state faults before Role lookup",
        { tags: "p0" },
        () => {
            const { service } = fixture();
            const message = "New Memberships must be active at revision zero";
            expectAgentError(
                () =>
                    service.assignMembership(
                        new Membership(
                            new MembershipId("revised-member"),
                            workspaceScope,
                            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                            new RoleName("missing"),
                            "active",
                            new Revision(1)
                        )
                    ),
                "protocol.invalid-state",
                message
            );
            expectAgentError(
                () =>
                    service.assignMembership(
                        new Membership(
                            new MembershipId("suspended-member"),
                            workspaceScope,
                            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                            new RoleName("missing"),
                            "suspended",
                            Revision.initial()
                        )
                    ),
                "protocol.invalid-state",
                message
            );
        }
    );

    test("Scope tenant validation precedes Grant subject existence", { tags: "p0" }, () => {
        const { service } = fixture();
        expectAgentError(
            () =>
                service.createGrant(
                    grant(
                        "foreign-scope-missing-subject",
                        SubjectRef.principal(
                            new PrincipalRef(new TenantId("foreign"), new PrincipalId("missing"))
                        ),
                        { kind: "direct" },
                        ScopeRef.tenant(new TenantId("foreign"))
                    )
                ),
            "protocol.invalid-state",
            "Authority Scope belongs to another Tenant"
        );
    });

    test("canonical Project Scopes admit Memberships and bump their epoch", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const reader = role("project-scope-role");
        service.createRole(reader);
        const project = new Project(
            new ProjectId("canonical-project"),
            tenantId,
            "Canonical",
            Revision.initial()
        );
        service.createProject(project);
        const projectScope = ScopeRef.project(tenantId, project.id);
        const before = store.epoch(projectScope).epoch;
        const member = new Membership(
            new MembershipId("project-scope-member"),
            projectScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            reader.name,
            "active",
            Revision.initial()
        );
        expect(service.assignMembership(member).isActive).toBe(true);
        expect(store.epoch(projectScope).epoch).toBe(before + 1);
    });
});

describe("AuthorityMutationService guest admission membrane", () => {
    test("rejects verification without host provenance", { tags: "p0" }, () => {
        const { service, trust, reader } = guestFixture();
        const restored = GuestVerification.decode(GuestVerification.encode(mintProof(trust)));
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("restored-proof-member", reader.name),
                    restored,
                    new Date(150)
                ),
            "authority.denied",
            "Guest verification was not host minted"
        );
    });

    test(
        "guest shape gate rejects revision and state faults before admission",
        { tags: "p0" },
        () => {
            const { service, trust, reader } = guestFixture();
            const message =
                "New guest Memberships require a foreign active subject at revision zero";
            expectAgentError(
                () =>
                    service.assignGuestMembership(
                        guestMembership("revised-guest-member", reader.name, {
                            revision: new Revision(1)
                        }),
                        mintProof(trust),
                        new Date(150)
                    ),
                "protocol.invalid-state",
                message
            );
            expectAgentError(
                () =>
                    service.assignGuestMembership(
                        guestMembership("suspended-guest-member", reader.name, {
                            state: "suspended"
                        }),
                        mintProof(trust),
                        new Date(150)
                    ),
                "protocol.invalid-state",
                message
            );
        }
    );

    test("denies inactive trust with matching evidence", { tags: "p0" }, () => {
        const { service, trust, reader } = guestFixture();
        service.revokeGuestTrust(trust.id);
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("revoked-trust-member", reader.name),
                    mintProof(trust, { trustRevision: new Revision(1) }),
                    new Date(150)
                ),
            "authority.denied",
            "Guest verification is not currently valid"
        );
    });

    test("denies trust revision drift", { tags: "p0" }, () => {
        const { service, trust, reader } = guestFixture();
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("revision-drift-member", reader.name),
                    mintProof(trust, { trustRevision: new Revision(1) }),
                    new Date(150)
                ),
            "authority.denied",
            "Guest verification is not currently valid"
        );
    });

    test("denies verifier method drift", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const reader = role("method-drift-role");
        service.createRole(reader);
        const trust = new GuestTrust(
            new GuestTrustId("token-trust"),
            tenantId,
            guestHome,
            { kind: "token", issuer: "issuer", key: new SecretRef("tenant", "oidc", "key") },
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("method-drift-member", reader.name),
                    mintProof(trust),
                    new Date(150)
                ),
            "authority.denied",
            "Guest verification is not currently valid"
        );
        expect(store.membership(new MembershipId("method-drift-member"))).toBeUndefined();
    });

    test("missing trust and Role records interrupt guest admission by name", { tags: "p0" }, () => {
        const { service, trust, reader } = guestFixture();
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("missing-trust-member", reader.name),
                    mintProof(trust, { trustId: new GuestTrustId("missing") }),
                    new Date(150)
                ),
            "protocol.invalid-state",
            "Guest trust does not exist"
        );
        expectAgentError(
            () =>
                service.assignGuestMembership(
                    guestMembership("missing-role-member", new RoleName("missing")),
                    mintProof(trust),
                    new Date(150)
                ),
            "protocol.invalid-state",
            "Role does not exist"
        );
    });

    test("admits a verified guest once and bumps the Scope epoch", { tags: "p0" }, () => {
        const { store, service, trust, reader } = guestFixture();
        const membership = guestMembership("admitted-guest-member", reader.name);
        const proof = mintProof(trust);
        const before = store.epoch(workspaceScope).epoch;
        expect(service.assignGuestMembership(membership, proof, new Date(150)).isActive).toBe(true);
        expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
        expectAgentError(
            () => service.assignGuestMembership(membership, mintProof(trust), new Date(150)),
            "protocol.invalid-state",
            "Membership already exists"
        );
    });

    test(
        "[C13-AUTH-GUEST-VERIFICATION] verifies provenance before materializing any guest Grant and a failure denies",
        { tags: "p0" },
        () => {
            const { store, service, trust, reader } = guestFixture();
            const membership = guestMembership("verified-before-grant-member", reader.name);
            expectAgentError(
                () => service.assignGuestMembership(membership, mintProof(trust), new Date(250)),
                "authority.denied",
                "Guest verification is not currently valid"
            );
            expect(store.membership(membership.id)).toBeUndefined();
            expect(store.grant(GrantId.forRole(membership.id, 0))).toBeUndefined();
            service.assignGuestMembership(membership, mintProof(trust), new Date(150));
            const materialized = store.grant(GrantId.forRole(membership.id, 0));
            expect(materialized?.isLive).toBe(true);
            expect(materialized?.subject.kind).toBe("foreign");
            expect(materialized?.origin).toMatchObject({ kind: "role", guest: true });
        }
    );

    test(
        "[C13-AUTH-GUEST-VERIFICATION] never materializes a subject still stamped handshake",
        { tags: "p0" },
        () => {
            const { store, service, trust, reader } = guestFixture();
            const membership = new Membership(
                new MembershipId("handshake-guest-member"),
                workspaceScope,
                SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.handshake),
                reader.name,
                "active",
                Revision.initial()
            );
            expectAgentError(
                () => service.assignGuestMembership(membership, mintProof(trust), new Date(150)),
                "authority.denied",
                "Guest verification is not currently valid"
            );
            expect(store.membership(membership.id)).toBeUndefined();
            expect(store.grant(GrantId.forRole(membership.id, 0))).toBeUndefined();
        }
    );

    test(
        "[C13-AUTH-GUEST-VERIFICATION] denies a direct Grant to a foreign subject",
        { tags: "p0" },
        () => {
            const { store, service } = guestFixture();
            const record = grant(
                "direct-guest-grant",
                SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback),
                { kind: "direct" }
            );
            expectAgentError(
                () => service.createGrant(record),
                "authority.denied",
                "Guest Grants materialize only through verified guest Memberships"
            );
            expect(store.grant(record.id)).toBeUndefined();
        }
    );
});

describe("AuthorityMutationService closure and epoch effects", () => {
    test(
        "suspending a Membership revokes replaced role Grants and delegations",
        { tags: "p0" },
        () => {
            const { store, service } = fixture();
            const reader = role("suspend-closure-role");
            service.createRole(reader);
            const member = new Membership(
                new MembershipId("suspend-closure-member"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                reader.name,
                "active",
                Revision.initial()
            );
            service.assignMembership(member);
            const roleGrantId = GrantId.forRole(member.id, 0);
            const child = new Grant(
                new GrantId("suspend-closure-child"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                "allow",
                observeCapability(),
                { kind: "direct" },
                roleGrantId
            );
            service.createGrant(child);
            const before = store.epoch(workspaceScope).epoch;
            const suspended = service.changeMembership(member.id, {
                role: reader.name,
                state: "suspended"
            });
            expect(suspended.state).toBe("suspended");
            expect(store.grant(roleGrantId)?.isLive).toBe(false);
            expect(store.grant(child.id)?.isLive).toBe(false);
            expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
        }
    );

    test("role swap rematerializes live Grants at stable IDs", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const reader = role("swap-reader-role");
        const writer = role("swap-writer-role", "execute");
        service.createRole(reader);
        service.createRole(writer);
        const member = new Membership(
            new MembershipId("swap-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        const changed = service.changeMembership(member.id, {
            role: writer.name,
            state: "active"
        });
        expect(changed.role.equals(writer.name)).toBe(true);
        const materialized = store.grant(GrantId.forRole(member.id, 0));
        expect(materialized?.isLive).toBe(true);
        expect(materialized?.capability.impacts).toEqual(["execute"]);
    });

    test("changeRole reconciles Grants, bumps epochs, and detects no-ops", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const original = role("reconcile-role");
        service.createRole(original);
        const member = new Membership(
            new MembershipId("reconcile-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            original.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        const changed = role("reconcile-role", "execute");
        const before = store.epoch(workspaceScope).epoch;
        service.changeRole(changed);
        expect(Role.encode(service.changeRole(changed))).toEqual(Role.encode(changed));
        const stored = store.role(changed.name);
        expect(stored === undefined ? undefined : Role.encode(stored)).toEqual(
            Role.encode(changed)
        );
        expect(store.grant(GrantId.forRole(member.id, 0))?.capability.impacts).toEqual(["execute"]);
        expect(store.epoch(workspaceScope).epoch).toBe(before + 1);

        const clone = Role.decode(Role.encode(changed));
        const afterChange = store.epoch(workspaceScope).epoch;
        const noop = service.changeRole(clone);
        expect(noop).not.toBe(clone);
        expect(Role.encode(noop)).toEqual(Role.encode(changed));
        expect(store.epoch(workspaceScope).epoch).toBe(afterChange);
    });

    test("revoking a Membership is idempotent for revision and epoch", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const reader = role("idempotent-revoke-role");
        service.createRole(reader);
        const member = new Membership(
            new MembershipId("idempotent-revoke-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        const revoked = service.revokeMembership(member.id);
        expect(revoked.state).toBe("revoked");
        const epochAfter = store.epoch(workspaceScope).epoch;
        const again = service.revokeMembership(member.id);
        expect(again.state).toBe("revoked");
        expect(again.revision.value).toBe(revoked.revision.value);
        expect(store.epoch(workspaceScope).epoch).toBe(epochAfter);
    });

    test(
        "disabling a Principal invalidates team-derived Grant Scopes exactly once",
        { tags: "p0" },
        () => {
            const { store, service } = fixture();
            const principal = new Principal(
                new PrincipalId("team-scoped-principal"),
                "user",
                "active"
            );
            service.createPrincipal(principal);
            const team = new Team(
                new TeamId("scoped-team"),
                tenantId,
                "Scoped",
                [principal.id],
                Revision.initial()
            );
            service.createTeam(team);
            service.createGrant(
                grant("scoped-team-grant", SubjectRef.team(team.id), { kind: "direct" })
            );
            const before = store.epoch(workspaceScope).epoch;
            expect(service.disablePrincipal(principal.id).canAct).toBe(false);
            expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
            expect(service.disablePrincipal(principal.id).canAct).toBe(false);
            expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
        }
    );

    test("disabling an unrelated Principal leaves epochs untouched", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const bystander = new Principal(new PrincipalId("bystander-principal"), "user", "active");
        service.createPrincipal(bystander);
        const team = new Team(
            new TeamId("owner-team"),
            tenantId,
            "Owners",
            [ownerId],
            Revision.initial()
        );
        service.createTeam(team);
        service.createGrant(
            grant("owner-team-grant", SubjectRef.team(team.id), { kind: "direct" })
        );
        const workspaceBefore = store.epoch(workspaceScope).epoch;
        const tenantBefore = store.epoch(tenantScope).epoch;
        expect(service.disablePrincipal(bystander.id).canAct).toBe(false);
        expect(store.epoch(workspaceScope).epoch).toBe(workspaceBefore);
        expect(store.epoch(tenantScope).epoch).toBe(tenantBefore);
    });

    test("disabling a Principal tolerates foreign-subject Grants", { tags: "p0" }, () => {
        const { service, trust, reader } = guestFixture();
        service.assignGuestMembership(
            guestMembership("foreign-grant-member", reader.name),
            mintProof(trust),
            new Date(150)
        );
        const principal = new Principal(new PrincipalId("post-guest-principal"), "user", "active");
        service.createPrincipal(principal);
        expect(service.disablePrincipal(principal.id).canAct).toBe(false);
    });

    test("changing a Team invalidates its Membership Scopes", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const ruleless = new Role(new RoleName("ruleless-role"), []);
        service.createRole(ruleless);
        const team = new Team(
            new TeamId("member-team"),
            tenantId,
            "Members",
            [ownerId],
            Revision.initial()
        );
        service.createTeam(team);
        service.assignMembership(
            new Membership(
                new MembershipId("team-subject-member"),
                workspaceScope,
                SubjectRef.team(team.id),
                ruleless.name,
                "active",
                Revision.initial()
            )
        );
        const before = store.epoch(workspaceScope).epoch;
        expect(service.changeTeam(team.id, "Renamed", [ownerId]).revision.value).toBe(1);
        expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
    });

    test("changing an unrelated Team is epoch-quiescent", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const team = new Team(
            new TeamId("unrelated-team"),
            tenantId,
            "Unrelated",
            [],
            Revision.initial()
        );
        service.createTeam(team);
        const workspaceBefore = store.epoch(workspaceScope).epoch;
        const tenantBefore = store.epoch(tenantScope).epoch;
        expect(service.changeTeam(team.id, "Still unrelated", []).revision.value).toBe(1);
        expect(store.epoch(workspaceScope).epoch).toBe(workspaceBefore);
        expect(store.epoch(tenantScope).epoch).toBe(tenantBefore);
    });

    test("revoking guest trust cascades through delegated Grants", { tags: "p0" }, () => {
        const { store, service, trust, reader } = guestFixture();
        const membership = guestMembership("cascade-guest-member", reader.name, {
            scope: tenantScope
        });
        service.assignGuestMembership(membership, mintProof(trust), new Date(150));
        const roleGrantId = GrantId.forRole(membership.id, 0);
        const child = new Grant(
            new GrantId("cascade-child"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            "allow",
            observeCapability(),
            { kind: "direct" },
            roleGrantId
        );
        service.createGrant(child);
        const tenantBefore = store.epoch(tenantScope).epoch;
        const workspaceBefore = store.epoch(workspaceScope).epoch;
        expect(service.revokeGuestTrust(trust.id).state).toBe("revoked");
        expect(store.membership(membership.id)?.state).toBe("revoked");
        expect(store.grant(roleGrantId)?.isLive).toBe(false);
        expect(store.grant(child.id)?.isLive).toBe(false);
        expect(store.epoch(tenantScope).epoch).toBe(tenantBefore + 1);
        expect(store.epoch(workspaceScope).epoch).toBe(workspaceBefore + 1);
    });

    test("rotating guest trust twice leaves revoked Memberships untouched", { tags: "p0" }, () => {
        const { store, service, trust, reader } = guestFixture();
        const membership = guestMembership("rotate-guest-member", reader.name);
        service.assignGuestMembership(membership, mintProof(trust), new Date(150));
        service.rotateGuestTrust(trust.id, {
            kind: "callback",
            endpoint: "https://rotated-once.example/verify"
        });
        const revoked = store.membership(membership.id);
        expect(revoked?.state).toBe("revoked");
        const workspaceBefore = store.epoch(workspaceScope).epoch;
        const tenantBefore = store.epoch(tenantScope).epoch;
        service.rotateGuestTrust(trust.id, {
            kind: "callback",
            endpoint: "https://rotated-twice.example/verify"
        });
        expect(store.membership(membership.id)?.revision.value).toBe(revoked?.revision.value);
        expect(store.epoch(workspaceScope).epoch).toBe(workspaceBefore);
        expect(store.epoch(tenantScope).epoch).toBe(tenantBefore);
    });

    test("revoked delegations do not re-enter the revocation closure", { tags: "p0" }, () => {
        const { store, service } = fixture();
        const parent = grant(
            "closure-parent",
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            { kind: "direct" },
            tenantScope
        );
        service.createGrant(parent);
        const child = new Grant(
            new GrantId("closure-child"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            "allow",
            observeCapability(),
            { kind: "direct" },
            parent.id
        );
        service.createGrant(child);
        expect(service.revokeGrant(child.id).isLive).toBe(false);
        const workspaceAfterChild = store.epoch(workspaceScope).epoch;
        const tenantBefore = store.epoch(tenantScope).epoch;
        expect(service.revokeGrant(parent.id).isLive).toBe(false);
        expect(store.epoch(tenantScope).epoch).toBe(tenantBefore + 1);
        expect(store.epoch(workspaceScope).epoch).toBe(workspaceAfterChild);
    });
});

function fixture(): { store: MemoryTenantControlStore; service: AuthorityMutationService } {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    return { store, service };
}

function guestFixture(): {
    store: MemoryTenantControlStore;
    service: AuthorityMutationService;
    trust: GuestTrust;
    reader: Role;
} {
    const { store, service } = fixture();
    const trust = callbackTrust("membrane-trust");
    const reader = role("membrane-reader");
    service.createGuestTrust(trust);
    service.createRole(reader);
    return { store, service, trust, reader };
}

function role(name: string, impact: "observe" | "execute" = "observe"): Role {
    return new Role(new RoleName(name), [
        new RoleRule(
            "allow",
            new CapabilitySpec({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: [impact],
                operations: []
            })
        )
    ]);
}

function observeCapability(): CapabilitySpec {
    return new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] });
}

function callbackTrust(id: string, home = guestHome): GuestTrust {
    return new GuestTrust(
        new GuestTrustId(id),
        tenantId,
        home,
        { kind: "callback", endpoint: `https://${id}.example/verify` },
        "active",
        Revision.initial()
    );
}

function mintProof(
    trust: GuestTrust,
    options: { readonly trustRevision?: Revision; readonly trustId?: GuestTrustId } = {}
) {
    return new GuestVerification(
        new PrincipalRef(guestHome, guestId),
        options.trustId ?? trust.id,
        options.trustRevision ?? trust.revision,
        "callback",
        Digest.sha256(Uint8Array.of(9)),
        new Date(100),
        new Date(200)
    );
}

function guestMembership(
    id: string,
    roleName: RoleName,
    options: {
        readonly state?: MembershipState;
        readonly revision?: Revision;
        readonly scope?: ScopeRef;
    } = {}
): Membership {
    return new Membership(
        new MembershipId(id),
        options.scope ?? workspaceScope,
        SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback),
        roleName,
        options.state ?? "active",
        options.revision ?? Revision.initial()
    );
}

function grant(
    id: string,
    subject: SubjectReference,
    origin: ConstructorParameters<typeof Grant>[5],
    scope = workspaceScope
): Grant {
    return new Grant(new GrantId(id), scope, subject, "allow", observeCapability(), origin);
}

function expectAgentError(action: () => unknown, code: AgentCoreErrorCode, message: string): void {
    try {
        action();
        throw new Error("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code, message });
    }
}
