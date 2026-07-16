// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../../src/actors";
import { Revision, SecretRef } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../../src/facets";
import {
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    Project,
    ProjectId,
    Role,
    RoleName,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    WorkspaceId
} from "../../../src/identity";
import {
    AuthorityMutationService,
    Grant,
    GrantId,
    ScopeEpoch,
    scopeKey,
    subjectKey
} from "../../../src/authority";
import { GuestTrust, GuestTrustId, PrincipalRef, Workspace } from "../../identity/internal-fixture";
import {
    Binding,
    InvalidationWatermark,
    domainKey,
    watermarkKey
} from "../../authority/internal-fixture";
import { SqliteBindingStore } from "../../../src/substrates/sqlite/binding";
import {
    listSqliteEpochs,
    listSqliteGrants,
    loadSqliteEpoch,
    loadSqliteGrant,
    saveSqliteEpoch,
    saveSqliteGrant
} from "../../../src/substrates/sqlite/authority";
import { SqliteIdentityReader } from "../../../src/substrates/sqlite/identity";
import { sqliteScopeKey, sqliteSubjectKey } from "../../../src/substrates/sqlite/identity";
import {
    SqliteTenantControlStore,
    createSqliteTenantControlStore
} from "../../../src/substrates/sqlite/tenant";
import { SqliteInvalidationWatermarkStore } from "../../../src/substrates/sqlite/watermark";
import {
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

const tenantId = new TenantId("sqlite-hard-tenant");
const ownerId = new PrincipalId("sqlite-hard-owner");
const workspaceId = new WorkspaceId("sqlite-hard-workspace");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const anchor = {
    actorId: new ActorId("sqlite-hard-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(1, 2, 3)
};

describe("SQLite Tenant and identity hard gates", () => {
    test("requires anchor, completed bootstrap, and nonnested transactions", () => {
        expect(() => createSqliteTenantControlStore(new TestSqlite())).toThrow(AgentCoreError);
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        expect(() => store.transaction(() => undefined)).toThrow(AgentCoreError);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(
            AgentCoreError
        );
        expect(() => store.putEpoch(new ScopeEpoch(workspaceScope, 1))).toThrow(AgentCoreError);
        expect(() => store.bootstrapTenant(database, anchor, Revision.initial())).toThrow(
            AgentCoreError
        );
    });

    test("rejects bootstrap through a foreign transaction without partial writes", () => {
        const source = new TestSqlite();
        const foreign = new TestSqlite();
        const store = createSqliteTenantControlStore(source, anchor);
        expect(() => store.bootstrapTenant(foreign, anchor, Revision.initial())).toThrow(
            AgentCoreError
        );
        expect(store.isBootstrapEligible()).toBe(true);
        expect(
            foreign.all(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tenant_%'",
                []
            )
        ).toEqual([]);

        const cloned = new TestSqlite();
        createSqliteTenantControlStore(cloned, anchor);
        expect(() => store.bootstrapTenant(cloned, anchor, Revision.initial())).toThrow(
            AgentCoreError
        );
        expect(cloned.all("SELECT * FROM tenant_identities", [])).toEqual([]);
    });

    test("rejects Tenant kind drift from the immutable anchor", () => {
        const { database } = fixture();
        const drifted = new Tenant(tenantId, "organization", "active", Revision.initial());
        database.run(`UPDATE tenant_identities SET kind = ?, record = ? WHERE id = ?`, [
            drifted.kind,
            Tenant.encode(drifted),
            tenantId.value
        ]);
        expect(() => createSqliteTenantControlStore(database)).toThrow(AgentCoreError);
    });

    test("enforces SQLite Project, Workspace, Team, Principal, and trust revisions", () => {
        const { store, service } = fixture();
        const project = new Project(
            new ProjectId("sqlite-hard-project"),
            tenantId,
            "Project",
            Revision.initial()
        );
        service.createProject(project);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putProject(new Project(project.id, tenantId, "Skipped", new Revision(2)))
            )
        ).toThrow(AgentCoreError);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putProject(
                    new Project(
                        new ProjectId("revised-new"),
                        tenantId,
                        "Revised new",
                        new Revision(1)
                    )
                )
            )
        ).toThrow(AgentCoreError);

        const workspace = new Workspace(workspaceId, tenantId, project.id, Revision.initial());
        service.createWorkspace(workspace);
        expect(() => store.transaction((candidate) => candidate.putWorkspace(workspace))).toThrow(
            AgentCoreError
        );

        const team = new Team(
            new TeamId("sqlite-hard-team"),
            tenantId,
            "Team",
            [ownerId],
            Revision.initial()
        );
        service.createTeam(team);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putTeam(new Team(team.id, tenantId, "Skipped", [], new Revision(2)))
            )
        ).toThrow(AgentCoreError);

        const home = new TenantId("sqlite-hard-home");
        const trust = new GuestTrust(
            new GuestTrustId("sqlite-hard-trust"),
            tenantId,
            home,
            {
                kind: "token",
                issuer: "issuer",
                key: new SecretRef("tenant", "oidc", "key")
            },
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putGuestTrust(
                    new GuestTrust(
                        trust.id,
                        tenantId,
                        home,
                        trust.verifier,
                        "active",
                        new Revision(2)
                    )
                )
            )
        ).toThrow();
    });

    test.each([
        ["tenant_identities", "kind", "organization"],
        ["tenant_principals", "kind", "service"],
        ["tenant_roles", "record", Uint8Array.of(0)]
    ] as const)("rejects corrupt %s projections eagerly", (table, column, value) => {
        const { database } = fixture();
        const keyColumn = table === "tenant_roles" ? "name" : "id";
        const key =
            table === "tenant_roles"
                ? "owner"
                : table === "tenant_principals"
                  ? ownerId.value
                  : tenantId.value;
        database.run(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`, [value, key]);
        expect(() => createSqliteTenantControlStore(database)).toThrow();
    });

    test("cross-checks every identity projection through SqliteIdentityReader", () => {
        const { database, service } = fixture();
        const project = new Project(
            new ProjectId("reader-project"),
            tenantId,
            "Reader",
            Revision.initial()
        );
        service.createProject(project);
        const workspace = new Workspace(
            new WorkspaceId("reader-workspace"),
            tenantId,
            project.id,
            Revision.initial()
        );
        service.createWorkspace(workspace);
        const reader = new SqliteIdentityReader(database);
        expect(reader.loadProject(project.id)?.name).toBe("Reader");
        expect(reader.loadWorkspace(workspace.id)?.scope.equals(workspace.scope)).toBe(true);
        expect(reader.loadPrincipal(ownerId)?.kind).toBe("user");
        expect(reader.loadTenant(tenantId)?.status).toBe("active");
        expect(reader.loadRole(new RoleName("owner"))?.rules.length).toBeGreaterThan(0);
        expect(reader.loadTeam(new TeamId("missing"))).toBeUndefined();
        expect(reader.loadMembership(new MembershipId("missing"))).toBeUndefined();
        expect(reader.loadGuestTrust(new GuestTrustId("missing"))).toBeUndefined();
    });

    test("rejects each mismatched identity query projection", () => {
        {
            const state = fixture();
            const team = new Team(
                new TeamId("projection-team"),
                tenantId,
                "Projection",
                [ownerId],
                Revision.initial()
            );
            state.service.createTeam(team);
            state.database.run("UPDATE tenant_teams SET tenant_id = ? WHERE id = ?", [
                "foreign",
                team.id.value
            ]);
            expect(() => state.store.loadTeam(team.id)).toThrow(AgentCoreError);
        }
        {
            const state = fixture();
            const project = new Project(
                new ProjectId("projection-project"),
                tenantId,
                "Projection",
                Revision.initial()
            );
            state.service.createProject(project);
            state.database.run("UPDATE tenant_projects SET tenant_id = ? WHERE id = ?", [
                "foreign",
                project.id.value
            ]);
            expect(() => state.store.loadProject(project.id)).toThrow(AgentCoreError);
        }
        {
            const state = fixture();
            const workspace = new Workspace(
                new WorkspaceId("projection-workspace"),
                tenantId,
                undefined,
                Revision.initial()
            );
            state.service.createWorkspace(workspace);
            state.database.run("UPDATE tenant_workspaces SET tenant_id = ? WHERE id = ?", [
                "foreign",
                workspace.id.value
            ]);
            expect(() => state.store.loadWorkspace(workspace.id)).toThrow(AgentCoreError);
        }
        {
            const state = fixture();
            const trust = new GuestTrust(
                new GuestTrustId("projection-trust"),
                tenantId,
                new TenantId("projection-home"),
                { kind: "callback", endpoint: "https://projection.example/verify" },
                "active",
                Revision.initial()
            );
            state.service.createGuestTrust(trust);
            state.database.run("UPDATE tenant_guest_trusts SET state = 'revoked' WHERE id = ?", [
                trust.id.value
            ]);
            expect(() => state.store.loadGuestTrust(trust.id)).toThrow(AgentCoreError);
        }
        {
            const state = fixture();
            const ownerRole = state.store.loadRole(new RoleName("owner"))!;
            state.database.run("UPDATE tenant_roles SET record = ? WHERE name = 'owner'", [
                Role.encode(new Role(new RoleName("other-role"), ownerRole.rules))
            ]);
            expect(() => state.store.loadRole(new RoleName("owner"))).toThrow(AgentCoreError);
        }
        {
            const state = fixture();
            const membership = state.store.memberships()[0]!;
            state.database.run("UPDATE tenant_memberships SET state = 'suspended' WHERE id = ?", [
                membership.id.value
            ]);
            expect(() => state.store.loadMembership(membership.id)).toThrow(AgentCoreError);
        }
    });

    test("rejects malformed low-level identity row types", () => {
        const principal = new Principal(ownerId, "user", "active");
        expect(() =>
            new SqliteIdentityReader(
                new StubSqlite({
                    id: 3,
                    kind: principal.kind,
                    status: principal.status,
                    record: Principal.encode(principal)
                })
            ).loadPrincipal(ownerId)
        ).toThrow(AgentCoreError);
        const tenant = new Tenant(tenantId, "personal", "active", Revision.initial());
        expect(() =>
            new SqliteIdentityReader(
                new StubSqlite({
                    id: tenant.id.value,
                    kind: tenant.kind,
                    status: tenant.status,
                    revision: "bad",
                    record: Tenant.encode(tenant)
                })
            ).loadTenant(tenant.id)
        ).toThrow(AgentCoreError);
        expect(() =>
            new SqliteIdentityReader(
                new StubSqlite({
                    id: principal.id.value,
                    kind: principal.kind,
                    status: principal.status,
                    record: "bad"
                })
            ).loadPrincipal(principal.id)
        ).toThrow(AgentCoreError);
        const workspace = new Workspace(
            new WorkspaceId("malformed-project-column"),
            tenantId,
            undefined,
            Revision.initial()
        );
        expect(() =>
            new SqliteIdentityReader(
                new StubSqlite({
                    id: workspace.id.value,
                    tenant_id: tenantId.value,
                    project_id: 3,
                    revision: 0,
                    record: Workspace.encode(workspace)
                })
            ).loadWorkspace(workspace.id)
        ).toThrow(AgentCoreError);
    });

    test("enforces every mutable identity writer before commit", () => {
        const { store, service } = fixture();
        service.createWorkspace(
            new Workspace(workspaceId, tenantId, undefined, Revision.initial())
        );
        const extra = new Principal(new PrincipalId("writer-principal"), "user", "active");
        service.createPrincipal(extra);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putPrincipal(new Principal(extra.id, "service", "active"))
            )
        ).toThrow(AgentCoreError);
        service.disablePrincipal(extra.id);
        expect(() => store.transaction((candidate) => candidate.putPrincipal(extra))).toThrow(
            AgentCoreError
        );

        expect(() =>
            store.transaction((candidate) =>
                candidate.putTeam(
                    new Team(
                        new TeamId("foreign-writer-team"),
                        new TenantId("foreign"),
                        "Foreign",
                        [],
                        Revision.initial()
                    )
                )
            )
        ).toThrow(AgentCoreError);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putTeam(
                    new Team(
                        new TeamId("revised-writer-team"),
                        tenantId,
                        "Revised",
                        [],
                        new Revision(1)
                    )
                )
            )
        ).toThrow(AgentCoreError);

        expect(() =>
            store.transaction((candidate) =>
                candidate.putProject(
                    new Project(
                        new ProjectId("foreign-writer-project"),
                        new TenantId("foreign"),
                        "Foreign",
                        Revision.initial()
                    )
                )
            )
        ).toThrow(AgentCoreError);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putWorkspace(
                    new Workspace(
                        new WorkspaceId("foreign-writer-workspace"),
                        new TenantId("foreign"),
                        undefined,
                        Revision.initial()
                    )
                )
            )
        ).toThrow(AgentCoreError);

        const role = new RoleName("owner");
        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        new MembershipId("suspended-writer-member"),
                        workspaceScope,
                        SubjectRef.principal(ownerId),
                        role,
                        "suspended",
                        Revision.initial()
                    )
                )
            )
        ).toThrow(AgentCoreError);
        const member = new Membership(
            new MembershipId("writer-member"),
            workspaceScope,
            SubjectRef.principal(ownerId),
            role,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        member.id,
                        ScopeRef.tenant(tenantId),
                        member.subject,
                        member.role,
                        "active",
                        member.revision.next()
                    )
                )
            )
        ).toThrow(AgentCoreError);
        const suspended = service.changeMembership(member.id, {
            role: member.role,
            state: "suspended"
        });
        expect(() =>
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
            )
        ).toThrow(AgentCoreError);
        service.revokeMembership(member.id);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        member.id,
                        member.scope,
                        member.subject,
                        member.role,
                        "active",
                        new Revision(2)
                    )
                )
            )
        ).toThrow(AgentCoreError);
    });

    test.each([
        [
            "extra Tenant",
            ({ database }: ReturnType<typeof fixture>) => {
                const tenant = new Tenant(
                    new TenantId("extra-tenant"),
                    "organization",
                    "active",
                    Revision.initial()
                );
                database.run(
                    `INSERT INTO tenant_identities (id, kind, status, revision, record)
                 VALUES (?, ?, ?, ?, ?)`,
                    [
                        tenant.id.value,
                        tenant.kind,
                        tenant.status,
                        tenant.authorizationRevision.value,
                        Tenant.encode(tenant)
                    ]
                );
            }
        ],
        [
            "missing owner Principal",
            ({ database }: ReturnType<typeof fixture>) => {
                database.run("DELETE FROM tenant_principals WHERE id = ?", [ownerId.value]);
            }
        ],
        [
            "missing bootstrap Membership",
            ({ database }: ReturnType<typeof fixture>) => {
                database.run("DELETE FROM tenant_memberships", []);
            }
        ],
        [
            "missing built-in Role",
            ({ database }: ReturnType<typeof fixture>) => {
                database.run("DELETE FROM tenant_roles WHERE name = 'owner'", []);
            }
        ],
        [
            "missing bootstrap Grant",
            ({ database }: ReturnType<typeof fixture>) => {
                database.run("DELETE FROM tenant_grants", []);
            }
        ],
        [
            "foreign Project",
            (state: ReturnType<typeof fixture>) => {
                const project = new Project(
                    new ProjectId("closure-project"),
                    tenantId,
                    "Closure",
                    Revision.initial()
                );
                state.service.createProject(project);
                const foreign = new Project(
                    project.id,
                    new TenantId("foreign"),
                    project.name,
                    project.revision
                );
                state.database.run(
                    "UPDATE tenant_projects SET tenant_id = ?, record = ? WHERE id = ?",
                    [foreign.tenantId.value, Project.encode(foreign), project.id.value]
                );
            }
        ],
        [
            "Team missing Principal",
            (state: ReturnType<typeof fixture>) => {
                const team = new Team(
                    new TeamId("closure-team"),
                    tenantId,
                    "Closure",
                    [ownerId],
                    Revision.initial()
                );
                state.service.createTeam(team);
                const corrupt = new Team(
                    team.id,
                    tenantId,
                    team.name,
                    [new PrincipalId("missing")],
                    team.revision
                );
                state.database.run("UPDATE tenant_teams SET record = ? WHERE id = ?", [
                    Team.encode(corrupt),
                    team.id.value
                ]);
            }
        ],
        [
            "Workspace missing Project",
            (state: ReturnType<typeof fixture>) => {
                const workspace = new Workspace(
                    new WorkspaceId("closure-workspace"),
                    tenantId,
                    undefined,
                    Revision.initial()
                );
                state.service.createWorkspace(workspace);
                const corrupt = new Workspace(
                    workspace.id,
                    tenantId,
                    new ProjectId("missing"),
                    Revision.initial()
                );
                state.database.run(
                    "UPDATE tenant_workspaces SET project_id = ?, record = ? WHERE id = ?",
                    [corrupt.projectId!.value, Workspace.encode(corrupt), workspace.id.value]
                );
            }
        ],
        [
            "foreign guest trust",
            (state: ReturnType<typeof fixture>) => {
                const trust = new GuestTrust(
                    new GuestTrustId("closure-trust"),
                    tenantId,
                    new TenantId("home"),
                    { kind: "callback", endpoint: "https://closure.example/verify" },
                    "active",
                    Revision.initial()
                );
                state.service.createGuestTrust(trust);
                const corrupt = new GuestTrust(
                    trust.id,
                    new TenantId("foreign"),
                    trust.homeTenant,
                    trust.verifier,
                    trust.state,
                    trust.revision
                );
                state.database.run(
                    `UPDATE tenant_guest_trusts SET host_tenant_id = ?, record = ? WHERE id = ?`,
                    [corrupt.hostTenant.value, GuestTrust.encode(corrupt), trust.id.value]
                );
            }
        ],
        [
            "Grant missing Principal",
            (state: ReturnType<typeof fixture>) => {
                const grant = new Grant(
                    new GrantId("closure-principal-grant"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(ownerId),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                state.service.createGrant(grant);
                const corrupt = new Grant(
                    grant.id,
                    grant.scope,
                    SubjectRef.principal(new PrincipalId("missing")),
                    grant.effect,
                    grant.capability,
                    grant.origin
                );
                state.database.run(
                    "UPDATE tenant_grants SET subject_key = ?, record = ? WHERE id = ?",
                    [sqliteSubjectKey(corrupt.subject), Grant.encode(corrupt), grant.id.value]
                );
            }
        ],
        [
            "Grant missing attenuation parent",
            (state: ReturnType<typeof fixture>) => {
                const grant = new Grant(
                    new GrantId("closure-child"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(ownerId),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                state.service.createGrant(grant);
                const corrupt = new Grant(
                    grant.id,
                    grant.scope,
                    grant.subject,
                    grant.effect,
                    grant.capability,
                    grant.origin,
                    new GrantId("missing")
                );
                state.database.run(
                    "UPDATE tenant_grants SET parent_grant_id = ?, record = ? WHERE id = ?",
                    ["missing", Grant.encode(corrupt), grant.id.value]
                );
            }
        ],
        [
            "revoked Grant attenuation parent",
            (state: ReturnType<typeof fixture>) => {
                const parent = new Grant(
                    new GrantId("closure-parent"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(ownerId),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                const child = new Grant(
                    new GrantId("closure-child-with-parent"),
                    parent.scope,
                    parent.subject,
                    "allow",
                    parent.capability,
                    { kind: "direct" },
                    parent.id
                );
                state.service.createGrant(parent);
                state.service.createGrant(child);
                const revoked = parent.revoke();
                state.database.run("UPDATE tenant_grants SET state = ?, record = ? WHERE id = ?", [
                    revoked.state.name,
                    Grant.encode(revoked),
                    parent.id.value
                ]);
            }
        ],
        [
            "foreign Scope epoch",
            (state: ReturnType<typeof fixture>) => {
                const foreign = new ScopeEpoch(ScopeRef.tenant(new TenantId("foreign")), 1);
                state.database.run(
                    `INSERT INTO tenant_scope_epochs (scope_key, epoch, record) VALUES (?, ?, ?)`,
                    [sqliteScopeKey(foreign.scope), foreign.epoch, ScopeEpoch.encode(foreign)]
                );
            }
        ],
        [
            "overlength Project key",
            (state: ReturnType<typeof fixture>) => {
                const record = new Project(
                    new ProjectId("valid-project-record"),
                    tenantId,
                    "Valid",
                    Revision.initial()
                );
                state.database.run(
                    `INSERT INTO tenant_projects (id, tenant_id, revision, record)
                 VALUES (?, ?, 0, ?)`,
                    ["x".repeat(257), tenantId.value, Project.encode(record)]
                );
            }
        ]
    ] as const)("rejects %s relational corruption on restart", (_name, corrupt) => {
        const state = fixture();
        corrupt(state);
        expect(() => createSqliteTenantControlStore(state.database)).toThrow(AgentCoreError);
    });
});

describe("SQLite Binding and watermark hard gates", () => {
    const owner = new ActorRef("workspace", new ActorId("sqlite-binding-owner"));
    const principal = new PrincipalRef(tenantId, ownerId);
    const binding = Binding.active(
        workspaceScope,
        SubjectRef.principal(ownerId),
        new ProtectionDomain("backend", "sqlite", "no-secrets"),
        new BindingName("sqlite-binding"),
        new GrantId("sqlite-binding-grant"),
        new FacetRef("workspace:sqlite.binding.facet")
    );

    test("anchors stores and enforces monotonic revisions", () => {
        expect(() => new SqliteBindingStore(new TestSqlite(), ScopeRef.tenant(tenantId))).toThrow(
            TypeError
        );
        const database = new TestSqlite();
        const bindings = new SqliteBindingStore(database, workspaceScope);
        expect(bindings.load(binding.key)).toBeUndefined();
        expect(() =>
            bindings.save(
                binding.replace(new GrantId("unstaged"), new FacetRef("workspace:unstaged"))
            )
        ).toThrow(AgentCoreError);
        bindings.save(binding);
        bindings.save(binding);
        expect(bindings.list()).toHaveLength(1);
        const replacement = binding.replace(
            new GrantId("next"),
            new FacetRef("workspace:next.facet")
        );
        bindings.save(replacement);
        expect(bindings.load(binding.key)?.generation).toBe(1);

        const watermarks = new SqliteInvalidationWatermarkStore(database, tenantId, owner);
        const watermark = InvalidationWatermark.empty(tenantId, owner, principal);
        expect(watermarks.load("missing")).toBeUndefined();
        expect(() => watermarks.save(watermark.join([new ScopeEpoch(workspaceScope, 1)]))).toThrow(
            AgentCoreError
        );
        watermarks.save(watermark);
        watermarks.save(watermark);
        expect(() => watermarks.join("missing", [])).toThrow(AgentCoreError);
        expect(watermarks.join(watermarkKey(watermark), []).revision.value).toBe(0);
    });

    test("rejects foreign owner records and projection corruption", () => {
        const database = new TestSqlite();
        const bindings = new SqliteBindingStore(database, workspaceScope);
        expect(() =>
            bindings.save(
                Binding.active(
                    ScopeRef.workspace(tenantId, new WorkspaceId("other")),
                    binding.subject,
                    binding.domain,
                    binding.name,
                    binding.grantId,
                    binding.facet
                )
            )
        ).toThrow(AgentCoreError);
        bindings.save(binding);
        database.run("UPDATE workspace_bindings SET generation = 2 WHERE binding_key = ?", [
            binding.key
        ]);
        expect(() => bindings.load(binding.key)).toThrow();

        const second = new TestSqlite();
        const watermarks = new SqliteInvalidationWatermarkStore(second, tenantId, owner);
        expect(() =>
            watermarks.save(
                InvalidationWatermark.empty(
                    tenantId,
                    new ActorRef("workspace", new ActorId("other")),
                    principal
                )
            )
        ).toThrow(AgentCoreError);
        const third = new TestSqlite();
        const localWatermarks = new SqliteInvalidationWatermarkStore(third, tenantId, owner);
        const foreignOwner = new ActorRef("workspace", new ActorId("foreign-owner"));
        const foreignWatermark = InvalidationWatermark.empty(tenantId, foreignOwner, principal);
        new SqliteInvalidationWatermarkStore(third, tenantId, foreignOwner).save(foreignWatermark);
        expect(() => localWatermarks.load(watermarkKey(foreignWatermark))).toThrow(AgentCoreError);
        expect(() => new SqliteInvalidationWatermarkStore(third, tenantId, owner)).toThrow(
            AgentCoreError
        );
    });

    test("rejects foreign rows loaded after store initialization", () => {
        const database = new TestSqlite();
        const local = new SqliteBindingStore(database, workspaceScope);
        const otherScope = ScopeRef.workspace(tenantId, new WorkspaceId("other-binding-workspace"));
        const foreign = Binding.active(
            otherScope,
            binding.subject,
            binding.domain,
            new BindingName("foreign-row"),
            binding.grantId,
            binding.facet
        );
        new SqliteBindingStore(database, otherScope).save(foreign);
        expect(() => local.load(foreign.key)).toThrow(AgentCoreError);
        expect(() => new SqliteBindingStore(database, workspaceScope)).toThrow(AgentCoreError);
    });

    test("rejects malformed SQLite driver row types and lost writes", () => {
        const bindingRow = bindingProjection(binding);
        expect(
            () =>
                new SqliteBindingStore(
                    new StubSqlite({
                        ...bindingRow,
                        binding_key: 3
                    }),
                    workspaceScope
                )
        ).toThrow(AgentCoreError);
        expect(
            () =>
                new SqliteBindingStore(
                    new StubSqlite({
                        ...bindingRow,
                        record: "not-bytes"
                    }),
                    workspaceScope
                )
        ).toThrow(AgentCoreError);
        expect(
            () =>
                new SqliteBindingStore(
                    new StubSqlite({
                        ...bindingRow,
                        generation: "bad"
                    }),
                    workspaceScope
                )
        ).toThrow(AgentCoreError);
        expect(() =>
            new SqliteBindingStore(new StubSqlite(), workspaceScope).save(binding)
        ).toThrow(AgentCoreError);
        const bindingSchemaFailure = new StubSqlite();
        bindingSchemaFailure.failRuns = true;
        expect(() => new SqliteBindingStore(bindingSchemaFailure, workspaceScope)).toThrow(
            AgentCoreError
        );
        const bindingReadFailure = new StubSqlite();
        const readableBindings = new SqliteBindingStore(bindingReadFailure, workspaceScope);
        bindingReadFailure.failReads = true;
        expect(() => readableBindings.load(binding.key)).toThrow(AgentCoreError);
        const typedFailure = new AgentCoreError("protocol.invalid-state", "typed failure");
        const typedBindingSchemaFailure = new StubSqlite();
        typedBindingSchemaFailure.runFailure = typedFailure;
        expect(() => new SqliteBindingStore(typedBindingSchemaFailure, workspaceScope)).toThrow(
            typedFailure
        );
        const typedBindingReadFailure = new StubSqlite();
        const typedReadableBindings = new SqliteBindingStore(
            typedBindingReadFailure,
            workspaceScope
        );
        typedBindingReadFailure.readFailure = typedFailure;
        expect(() => typedReadableBindings.load(binding.key)).toThrow(typedFailure);

        const watermark = InvalidationWatermark.empty(tenantId, owner, principal);
        const watermarkRow = watermarkProjection(watermark);
        expect(
            () =>
                new SqliteInvalidationWatermarkStore(
                    new StubSqlite({
                        ...watermarkRow,
                        watermark_key: 3
                    }),
                    tenantId,
                    owner
                )
        ).toThrow(AgentCoreError);
        expect(
            () =>
                new SqliteInvalidationWatermarkStore(
                    new StubSqlite({
                        ...watermarkRow,
                        watermark_key: "wrong-key"
                    }),
                    tenantId,
                    owner
                )
        ).toThrow(AgentCoreError);
        expect(
            () =>
                new SqliteInvalidationWatermarkStore(
                    new StubSqlite({
                        ...watermarkRow,
                        record: "not-bytes"
                    }),
                    tenantId,
                    owner
                )
        ).toThrow(AgentCoreError);
        expect(
            () =>
                new SqliteInvalidationWatermarkStore(
                    new StubSqlite({
                        ...watermarkRow,
                        revision: "bad"
                    }),
                    tenantId,
                    owner
                )
        ).toThrow(AgentCoreError);
        expect(() =>
            new SqliteInvalidationWatermarkStore(new StubSqlite(), tenantId, owner).save(watermark)
        ).toThrow(AgentCoreError);
        const watermarkSchemaFailure = new StubSqlite();
        watermarkSchemaFailure.failRuns = true;
        expect(
            () => new SqliteInvalidationWatermarkStore(watermarkSchemaFailure, tenantId, owner)
        ).toThrow(AgentCoreError);
        const watermarkReadFailure = new StubSqlite();
        const readableWatermarks = new SqliteInvalidationWatermarkStore(
            watermarkReadFailure,
            tenantId,
            owner
        );
        watermarkReadFailure.failReads = true;
        expect(() => readableWatermarks.load("missing")).toThrow(AgentCoreError);
        const typedWatermarkSchemaFailure = new StubSqlite();
        typedWatermarkSchemaFailure.runFailure = typedFailure;
        expect(
            () => new SqliteInvalidationWatermarkStore(typedWatermarkSchemaFailure, tenantId, owner)
        ).toThrow(typedFailure);
        const typedWatermarkReadFailure = new StubSqlite();
        const typedReadableWatermarks = new SqliteInvalidationWatermarkStore(
            typedWatermarkReadFailure,
            tenantId,
            owner
        );
        typedWatermarkReadFailure.readFailure = typedFailure;
        expect(() => typedReadableWatermarks.load("missing")).toThrow(typedFailure);

        const identityReadFailure = new StubSqlite();
        identityReadFailure.failReads = true;
        expect(() => new SqliteIdentityReader(identityReadFailure).loadPrincipal(ownerId)).toThrow(
            AgentCoreError
        );
        const typedIdentityReadFailure = new StubSqlite();
        typedIdentityReadFailure.readFailure = typedFailure;
        expect(() =>
            new SqliteIdentityReader(typedIdentityReadFailure).loadPrincipal(ownerId)
        ).toThrow(typedFailure);
        const tenantSchemaFailure = new StubSqlite();
        tenantSchemaFailure.failRuns = true;
        expect(() => createSqliteTenantControlStore(tenantSchemaFailure, anchor)).toThrow(
            AgentCoreError
        );
        const typedTenantSchemaFailure = new StubSqlite();
        typedTenantSchemaFailure.runFailure = typedFailure;
        expect(() => createSqliteTenantControlStore(typedTenantSchemaFailure, anchor)).toThrow(
            typedFailure
        );

        const throwingBindingDatabase = new StubSqlite();
        const throwingBindings = new SqliteBindingStore(throwingBindingDatabase, workspaceScope);
        throwingBindingDatabase.failRuns = true;
        expect(() => throwingBindings.save(binding)).toThrow(AgentCoreError);
        const throwingWatermarkDatabase = new StubSqlite();
        const throwingWatermarks = new SqliteInvalidationWatermarkStore(
            throwingWatermarkDatabase,
            tenantId,
            owner
        );
        throwingWatermarkDatabase.failRuns = true;
        expect(() => throwingWatermarks.save(watermark)).toThrow(AgentCoreError);
        const throwingAuthorityDatabase = new StubSqlite();
        throwingAuthorityDatabase.failRuns = true;
        expect(() =>
            saveSqliteEpoch(throwingAuthorityDatabase, new ScopeEpoch(ScopeRef.tenant(tenantId), 1))
        ).toThrow(AgentCoreError);

        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenantId, owner);
        store.save(watermark);
        expect(() =>
            store.save(new InvalidationWatermark(tenantId, owner, principal, [], new Revision(2)))
        ).toThrow(AgentCoreError);
        const advanced = store.join(watermarkKey(watermark), [new ScopeEpoch(workspaceScope, 2)]);
        expect(() =>
            store.save(
                new InvalidationWatermark(tenantId, owner, principal, [], advanced.revision.next())
            )
        ).toThrow(AgentCoreError);
    });
});

describe("SQLite authority adapter taxonomy", () => {
    const scope = ScopeRef.tenant(tenantId);
    const grant = new Grant(
        new GrantId("adapter-grant"),
        scope,
        SubjectRef.principal(ownerId),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );

    test("round-trips and idempotently rewrites Grant and epoch records", () => {
        const state = fixture();
        state.store.transaction(() => {
            saveSqliteGrant(state.database, grant);
            saveSqliteGrant(state.database, grant);
            saveSqliteEpoch(state.database, new ScopeEpoch(scope, 2));
            saveSqliteEpoch(state.database, new ScopeEpoch(scope, 2));
        });
        expect(loadSqliteGrant(state.database, grant.id)?.id.equals(grant.id)).toBe(true);
        expect(listSqliteGrants(state.database).some((record) => record.id.equals(grant.id))).toBe(
            true
        );
        expect(loadSqliteEpoch(state.database, scope).epoch).toBe(2);
        expect(listSqliteEpochs(state.database).some((record) => record.scope.equals(scope))).toBe(
            true
        );
    });

    test("converts missing writes and malformed projections to AgentCoreError", () => {
        expectErrorCode(
            () => saveSqliteGrant(new StubSqlite(), grant),
            "protocol.revision-conflict"
        );
        expect(() => saveSqliteEpoch(new StubSqlite(), new ScopeEpoch(scope, 1))).toThrow(
            AgentCoreError
        );

        const grantRow = {
            id: grant.id.value,
            scope_key: sqliteScopeKey(grant.scope),
            subject_key: sqliteSubjectKey(grant.subject),
            effect: grant.effect,
            parent_grant_id: null,
            state: grant.state.name,
            record: Grant.encode(grant)
        } satisfies SqliteRow;
        expect(() => listSqliteGrants(new StubSqlite({ ...grantRow, id: 3 }))).toThrow(
            AgentCoreError
        );
        expect(() => listSqliteGrants(new StubSqlite({ ...grantRow, record: "bad" }))).toThrow(
            AgentCoreError
        );
        expect(() => listSqliteGrants(new StubSqlite({ ...grantRow, state: "revoked" }))).toThrow(
            AgentCoreError
        );

        const epoch = new ScopeEpoch(scope, 1);
        const epochRow = {
            scope_key: scopeKey(scope),
            epoch: epoch.epoch,
            record: ScopeEpoch.encode(epoch)
        } satisfies SqliteRow;
        expect(() => listSqliteEpochs(new StubSqlite({ ...epochRow, epoch: "bad" }))).toThrow(
            AgentCoreError
        );
        expect(() =>
            loadSqliteEpoch(new StubSqlite({ ...epochRow, record: "bad" }), scope)
        ).toThrow(AgentCoreError);

        const rawReadFailure = new StubSqlite();
        rawReadFailure.failReads = true;
        expectErrorCode(() => loadSqliteGrant(rawReadFailure, grant.id), "codec.invalid");
        const typedFailure = new AgentCoreError("protocol.invalid-state", "typed failure");
        const typedReadFailure = new StubSqlite();
        typedReadFailure.readFailure = typedFailure;
        expect(() => loadSqliteGrant(typedReadFailure, grant.id)).toThrow(typedFailure);
        const typedWriteFailure = new StubSqlite();
        typedWriteFailure.runFailure = typedFailure;
        expect(() => saveSqliteGrant(typedWriteFailure, grant)).toThrow(typedFailure);
        expect(() => saveSqliteEpoch(new StubSqlite(), new ScopeEpoch(scope, 2))).toThrow(
            AgentCoreError
        );
        expect(() =>
            listSqliteGrants(
                new StubSqlite({
                    ...grantRow,
                    parent_grant_id: 3
                })
            )
        ).toThrow(AgentCoreError);
        const foreignEpoch = new ScopeEpoch(ScopeRef.tenant(new TenantId("foreign")), 1);
        expect(() =>
            loadSqliteEpoch(
                new StubSqlite({
                    ...epochRow,
                    record: ScopeEpoch.encode(foreignEpoch)
                }),
                scope
            )
        ).toThrow(AgentCoreError);
    });
});

function fixture(): {
    database: TestSqlite;
    store: SqliteTenantControlStore;
    service: AuthorityMutationService;
} {
    const database = new TestSqlite();
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return { database, store, service: new AuthorityMutationService(store) };
}

function expectErrorCode(operation: () => void, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error(`Expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

class StubSqlite extends TransactionalSqlite {
    public failRuns = false;
    public failReads = false;
    public readFailure: unknown;
    public runFailure: unknown;
    public constructor(private readonly row?: SqliteRow) {
        super();
    }
    public all(statement: string, _bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.readFailure !== undefined) throw this.readFailure;
        if (this.failReads) throw new Error("injected SQLite read failure");
        return this.row !== undefined && statement.includes("SELECT *") ? [this.row] : [];
    }
    public run(_statement: string, _bindings: readonly SqliteValue[]): void {
        if (this.runFailure !== undefined) throw this.runFailure;
        if (this.failRuns) throw new Error("injected SQLite failure");
    }
    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

function bindingProjection(record: Binding): SqliteRow {
    return {
        binding_key: record.key,
        scope_key: scopeKey(record.scope),
        subject_key: subjectKey(record.subject),
        domain_key: domainKey(record.domain),
        name: record.name.value,
        grant_id: record.grantId.value,
        facet_ref: record.facet.value,
        generation: record.generation,
        revision: record.revision.value,
        state: record.state,
        record: Binding.encode(record)
    };
}

function watermarkProjection(record: InvalidationWatermark): SqliteRow {
    return {
        watermark_key: watermarkKey(record),
        owner_tenant_id: record.ownerTenant.value,
        owner_kind: record.owner.kind,
        owner_id: record.owner.id.value,
        holder_tenant_id: record.holder.tenantId.value,
        holder_principal_id: record.holder.principalId.value,
        revision: record.revision.value,
        record: InvalidationWatermark.encode(record)
    };
}
