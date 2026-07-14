import { describe, expect, test } from "vitest";
import { Revision, SecretRef } from "../../src/core";
import { CapabilitySpec } from "../../src/facets";
import {
    IdentityRepository,
    Membership,
    MembershipId,
    MemoryIdentityRepository,
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
    Tenant,
    TenantId,
    WorkspaceId,
    type MemoryIdentitySnapshot,
    type StoredIdentityRecord
} from "../../src/identity";
import { GuestTrust } from "../../src/identity/guest-trust";
import { GuestTrustId } from "../../src/identity/id";
import { Workspace } from "../../src/identity/workspace";

const tenantId = new TenantId("tenant-store");
const principalId = new PrincipalId("principal-store");
const role = new Role(new RoleName("reader-store"), [
    new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }))
]);
const records = Object.freeze({
    tenant: new Tenant(tenantId, "organization", "active", Revision.initial()),
    principal: new Principal(principalId, "service", "active"),
    team: new Team(
        new TeamId("team-store"),
        tenantId,
        "Readers",
        [principalId],
        Revision.initial()
    ),
    project: new Project(
        new ProjectId("project-store"),
        tenantId,
        "Stored project",
        Revision.initial()
    ),
    workspace: new Workspace(
        new WorkspaceId("workspace-store"),
        tenantId,
        new ProjectId("project-store"),
        Revision.initial()
    ),
    guestTrust: new GuestTrust(
        new GuestTrustId("guest-trust-store"),
        tenantId,
        new TenantId("guest-home-store"),
        {
            kind: "token",
            issuer: "https://issuer.example/",
            key: new SecretRef("tenant", "oidc", "guest-store-key")
        },
        "active",
        Revision.initial()
    ),
    role,
    membership: new Membership(
        new MembershipId("membership-store"),
        ScopeRef.tenant(tenantId),
        SubjectRef.principal(principalId),
        role.name,
        "active",
        Revision.initial()
    )
});

describe("MemoryIdentityRepository", () => {
    test("is a synchronous read-only view over detached codec bytes", () => {
        const source = identitySnapshot();
        const repository: IdentityRepository = new MemoryIdentityRepository(source);
        source.records[0]!.bytes.fill(0);

        const first = repository.loadPrincipal(principalId);
        const second = repository.loadPrincipal(principalId);

        expect(first).toBeInstanceOf(Principal);
        expect(second).not.toBe(first);
        expect(first?.id.equals(principalId)).toBe(true);
        expect(repository.loadPrincipal(principalId)).not.toBeInstanceOf(Promise);
        expect("savePrincipal" in repository).toBe(false);
        expect("saveMembership" in repository).toBe(false);
    });

    test("[identity.principal] [identity.tenant] [identity.team] [identity.project] [identity.workspace] [identity.role] [identity.membership] [identity.guest-trust] restores every identity kind and returns a detached versioned snapshot", () => {
        const repository = new MemoryIdentityRepository(identitySnapshot());
        const snapshot = repository.snapshot();
        const restarted = new MemoryIdentityRepository(snapshot);
        snapshot.records[0]!.bytes.fill(0);

        expect(snapshot.version).toBe(1);
        expect(restarted.loadTenant(tenantId)?.kind).toBe("organization");
        expect(restarted.loadPrincipal(principalId)?.kind).toBe("service");
        expect(restarted.loadTeam(records.team.id)?.has(principalId)).toBe(true);
        expect(restarted.loadProject(records.project.id)?.name).toBe("Stored project");
        expect(
            restarted.loadWorkspace(records.workspace.id)?.scope.equals(records.workspace.scope)
        ).toBe(true);
        expect(restarted.loadGuestTrust(records.guestTrust.id)?.isActive).toBe(true);
        expect(restarted.loadRole(role.name)?.rules).toHaveLength(1);
        expect(restarted.loadMembership(records.membership.id)?.role.equals(role.name)).toBe(true);
        expect(repository.loadTenant(tenantId)?.status).toBe("active");
    });

    test("strictly rejects malformed snapshots and codec-key disagreement", () => {
        const snapshot = identitySnapshot();
        expect(
            () =>
                new MemoryIdentityRepository({
                    records: snapshot.records
                } as unknown as MemoryIdentitySnapshot)
        ).toThrow(/snapshot is malformed/);
        expect(
            () =>
                new MemoryIdentityRepository({
                    ...snapshot,
                    extra: true
                } as unknown as MemoryIdentitySnapshot)
        ).toThrow(/snapshot is malformed/);
        expect(
            () =>
                new MemoryIdentityRepository({
                    ...snapshot,
                    records: [{ ...snapshot.records[0]!, id: "different" }]
                })
        ).toThrow(/does not match/);
    });
});

function identitySnapshot(): MemoryIdentitySnapshot {
    return {
        version: 1,
        records: [
            stored("tenant", records.tenant.id.value, Tenant.encode(records.tenant)),
            stored("principal", records.principal.id.value, Principal.encode(records.principal)),
            stored("team", records.team.id.value, Team.encode(records.team)),
            stored("project", records.project.id.value, Project.encode(records.project)),
            stored("workspace", records.workspace.id.value, Workspace.encode(records.workspace)),
            stored(
                "guestTrust",
                records.guestTrust.id.value,
                GuestTrust.encode(records.guestTrust)
            ),
            stored("role", records.role.name.value, Role.encode(records.role)),
            stored("membership", records.membership.id.value, Membership.encode(records.membership))
        ]
    };
}

function stored(
    kind: StoredIdentityRecord["kind"],
    id: string,
    bytes: Uint8Array
): StoredIdentityRecord {
    return { kind, id, bytes };
}
