import { Database } from "bun:sqlite";
import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { AuthorityMutationService, Grant, GrantId } from "../../src/authority";
import { CapabilitySpec } from "../../src/facets";
import { requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { Digest, Revision, SecretRef } from "../../src/core";
import {
    Membership,
    MembershipId,
    GuestVerificationScheme,
    PrincipalId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerification,
    PrincipalRef,
    Workspace
} from "../identity/internal-fixture";
import {
    createSqliteTenantControlStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";

const tenantId = new TenantId("tenant-sqlite");
const principalId = new PrincipalId("principal-sqlite");
const tenantScope = ScopeRef.tenant(tenantId);
const anchor = {
    actorId: new ActorId("tenant-sqlite-actor"),
    tenantId,
    principalId,
    trustAnchor: Uint8Array.of(1, 2, 3)
};

describe("SQLite Tenant authority mutation storage", () => {
    test("[C13-AUTH-EPOCH-ADVANCEMENT] SQLite advances durable path epochs for allow and deny changes", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const initial = store.epoch(tenantScope).epoch;
        const allow = allowGrant("sqlite-epoch-allow");
        const deny = new Grant(
            new GrantId("sqlite-epoch-deny"),
            tenantScope,
            SubjectRef.principal(principalId),
            "deny",
            allow.capability,
            { kind: "direct" }
        );

        service.createGrant(allow);
        expect(store.epoch(tenantScope).epoch).toBe(initial + 1);
        service.createGrant(deny);
        expect(store.epoch(tenantScope).epoch).toBe(initial + 2);
        service.revokeGrant(allow.id);
        expect(store.epoch(tenantScope).epoch).toBe(initial + 3);
        service.revokeGrant(deny.id);
        expect(store.epoch(tenantScope).epoch).toBe(initial + 4);

        expect(createSqliteTenantControlStore(database).epoch(tenantScope).epoch).toBe(initial + 4);
    });

    test("reconciles Membership Grants and bumps exactly once on revoke", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const role = observeRole("member-reader");
        const membership = new Membership(
            new MembershipId("membership-service"),
            tenantScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );

        service.createRole(role);
        service.assignMembership(membership);

        expect(store.grants()).toHaveLength(2);
        expect(store.epoch(tenantScope).epoch).toBe(2);
        service.changeRole(Role.decode(Role.encode(role)));
        expect(store.epoch(tenantScope).epoch).toBe(2);

        service.revokeMembership(membership.id);
        expect(store.loadMembership(membership.id)?.state).toBe("revoked");
        expect(
            store
                .grants()
                .find(
                    (grant) =>
                        grant.origin.kind === "role" &&
                        grant.origin.membershipId.equals(membership.id)
                )?.isLive
        ).toBe(false);
        expect(store.epoch(tenantScope).epoch).toBe(3);

        const restarted = createSqliteTenantControlStore(database);
        expect(restarted.loadMembership(membership.id)?.state).toBe("revoked");
        expect(restarted.epoch(tenantScope).epoch).toBe(3);
    });

    test("bumps team and principal resolver-input mutations", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const teamId = new TeamId("team-service");
        const team = new Team(teamId, tenantId, "Readers", [principalId], Revision.initial());
        service.createTeam(team);
        service.createGrant(
            new Grant(
                new GrantId("grant-team-service"),
                tenantScope,
                SubjectRef.team(teamId),
                "allow",
                new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                { kind: "direct" }
            )
        );
        service.createGrant(allowGrant("grant-principal-service"));
        let epoch = store.epoch(tenantScope).epoch;

        service.changeTeam(teamId, "Readers 2", []);
        expect(store.epoch(tenantScope).epoch).toBe(++epoch);
        service.disablePrincipal(principalId);
        expect(store.epoch(tenantScope).epoch).toBe(++epoch);
    });

    test("enforces Tenant and immutable record boundaries", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const role = observeRole("invariant-role");
        const membership = new Membership(
            new MembershipId("membership-invariant"),
            tenantScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(membership);

        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        membership.id,
                        ScopeRef.tenant(new TenantId("scope-swap")),
                        membership.subject,
                        membership.role,
                        "active",
                        membership.revision.next()
                    )
                )
            )
        ).toThrow(/another Tenant|immutable/);
        expect(() =>
            service.createGrant(
                new Grant(
                    new GrantId("foreign-grant"),
                    ScopeRef.tenant(new TenantId("foreign-tenant")),
                    SubjectRef.principal(principalId),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                )
            )
        ).toThrow(/another Tenant/);

        const orphan = new Membership(
            new MembershipId("orphan-membership"),
            tenantScope,
            SubjectRef.principal(principalId),
            new RoleName("missing-role"),
            "active",
            Revision.initial()
        );
        expect(() => store.transaction((candidate) => candidate.putMembership(orphan))).toThrow(
            /malformed/
        );
        expect(store.loadMembership(orphan.id)).toBeUndefined();
    });

    test("enforces narrowing and recursively revokes delegated Grant chains", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const parent = new Grant(
            new GrantId("sqlite-parent"),
            tenantScope,
            SubjectRef.principal(principalId),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "mutate"] }),
            { kind: "direct" }
        );
        const child = new Grant(
            new GrantId("sqlite-child"),
            tenantScope,
            parent.subject,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" },
            parent.id
        );
        const grandchild = new Grant(
            new GrantId("sqlite-grandchild"),
            tenantScope,
            parent.subject,
            "allow",
            child.capability,
            { kind: "direct" },
            child.id
        );
        service.createGrant(parent);
        service.createGrant(child);
        service.createGrant(grandchild);
        expect(() =>
            service.createGrant(
                new Grant(
                    new GrantId("sqlite-widened"),
                    tenantScope,
                    parent.subject,
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
                    { kind: "direct" },
                    parent.id
                )
            )
        ).toThrow(/live attenuation/);

        service.revokeGrant(parent.id);
        expect([parent.id, child.id, grandchild.id].map((id) => store.grant(id)?.isLive)).toEqual([
            false,
            false,
            false
        ]);
    });

    test("persists canonical Workspace topology and verified guest lifecycle across restart", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const workspace = new Workspace(
            new WorkspaceId("sqlite-workspace"),
            tenantId,
            undefined,
            Revision.initial()
        );
        const home = new TenantId("sqlite-guest-home");
        const guest = new PrincipalId("sqlite-guest");
        const trust = new GuestTrust(
            new GuestTrustId("sqlite-guest-trust"),
            tenantId,
            home,
            {
                kind: "token",
                issuer: "https://issuer.example/",
                key: new SecretRef("tenant", "oidc", "guest-key")
            },
            "active",
            Revision.initial()
        );
        const role = observeRole("sqlite-guest-reader");
        const membership = new Membership(
            new MembershipId("sqlite-guest-membership"),
            workspace.scope,
            SubjectRef.foreign(home, guest, GuestVerificationScheme.token),
            role.name,
            "active",
            Revision.initial()
        );
        service.createWorkspace(workspace);
        service.createGuestTrust(trust);
        service.createRole(role);
        service.assignGuestMembership(
            membership,
            new GuestVerification(
                new PrincipalRef(home, guest),
                trust.id,
                trust.revision,
                "token",
                Digest.sha256(Uint8Array.of(8)),
                new Date(1_000),
                new Date(2_000)
            ),
            new Date(1_500)
        );

        const restarted = createSqliteTenantControlStore(database);
        expect(restarted.workspace(workspace.id)?.scope.equals(workspace.scope)).toBe(true);
        expect(restarted.guestTrust(trust.id)?.isActive).toBe(true);
        expect(
            restarted
                .grants()
                .some(
                    (candidate) =>
                        candidate.origin.kind === "role" &&
                        candidate.origin.membershipId.equals(membership.id) &&
                        candidate.isLive
                )
        ).toBe(true);
    });

    test("rejects malformed orphan identity rows before serving after restart", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        database.run(
            `INSERT INTO tenant_principals (id, kind, status, record)
             VALUES (?, 'user', 'active', ?)`,
            ["orphan-principal", Uint8Array.of(0)]
        );

        expect(() => createSqliteTenantControlStore(database)).toThrow(/malformed|canonical/);
    });
});

function allowGrant(id: string): Grant {
    return new Grant(
        new GrantId(id),
        tenantScope,
        SubjectRef.principal(principalId),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
}

function observeRole(name: string): Role {
    return new Role(new RoleName(name), [
        new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }))
    ]);
}

class TestSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }
}
