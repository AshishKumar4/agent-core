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
    Binding,
    Grant,
    GrantId,
    ScopeEpoch,
    domainKey,
    scopeKey,
    subjectKey
} from "../../../src/authority";
import { GuestTrust, GuestTrustId, PrincipalRef, Workspace } from "../../identity/internal-fixture";
import { InvalidationWatermark, watermarkKey } from "../../authority/internal-fixture";
import {
    initializeSqliteAuthoritySchema,
    listSqliteBindings,
    listSqliteEpochs,
    listSqliteGrants,
    loadSqliteBinding,
    loadSqliteEpoch,
    loadSqliteGrant,
    saveSqliteBinding,
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
    test("requires anchor, completed bootstrap, and nonnested transactions", { tags: "p0" }, () => {
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

    test(
        "rejects bootstrap through a foreign transaction without partial writes",
        { tags: "p0" },
        () => {
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
        }
    );

    test("rejects Tenant kind drift from the immutable anchor", { tags: "p0" }, () => {
        const { database } = fixture();
        const drifted = new Tenant(tenantId, "organization", "active", Revision.initial());
        database.run(`UPDATE tenant_identities SET kind = ?, record = ? WHERE id = ?`, [
            drifted.kind,
            Tenant.encode(drifted),
            tenantId.value
        ]);
        expect(() => createSqliteTenantControlStore(database)).toThrow(AgentCoreError);
    });

    test(
        "enforces SQLite Project, Workspace, Team, Principal, and trust revisions",
        { tags: "p0" },
        () => {
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
                    candidate.putProject(
                        new Project(project.id, tenantId, "Skipped", new Revision(2))
                    )
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
            expect(() =>
                store.transaction((candidate) => candidate.putWorkspace(workspace))
            ).toThrow(AgentCoreError);

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
        }
    );

    test.each([
        ["tenant_identities", "kind", "organization"],
        ["tenant_principals", "kind", "service"],
        ["tenant_roles", "record", Uint8Array.of(0)]
    ] as const)(
        "rejects corrupt %s projections eagerly",
        { tags: "p0" },
        (table, column, value) => {
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
        }
    );

    test(
        "cross-checks every identity projection through SqliteIdentityReader",
        { tags: "p1" },
        () => {
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
        }
    );

    test("rejects each mismatched identity query projection", { tags: "p0" }, () => {
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

    test("rejects malformed low-level identity row types", { tags: "p1" }, () => {
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

    test("enforces every mutable identity writer before commit", { tags: "p0" }, () => {
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
                        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
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
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
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
            ({ database }: TenantAuthorityFixture) => {
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
            ({ database }: TenantAuthorityFixture) => {
                database.run("DELETE FROM tenant_principals WHERE id = ?", [ownerId.value]);
            }
        ],
        [
            "missing bootstrap Membership",
            ({ database }: TenantAuthorityFixture) => {
                database.run("DELETE FROM tenant_memberships", []);
            }
        ],
        [
            "missing built-in Role",
            ({ database }: TenantAuthorityFixture) => {
                database.run("DELETE FROM tenant_roles WHERE name = 'owner'", []);
            }
        ],
        [
            "missing bootstrap Grant",
            ({ database }: TenantAuthorityFixture) => {
                database.run("DELETE FROM tenant_grants", []);
            }
        ],
        [
            "foreign Project",
            (state: TenantAuthorityFixture) => {
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
            (state: TenantAuthorityFixture) => {
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
            (state: TenantAuthorityFixture) => {
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
            (state: TenantAuthorityFixture) => {
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
            (state: TenantAuthorityFixture) => {
                const grant = new Grant(
                    new GrantId("closure-principal-grant"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                state.service.createGrant(grant);
                const corrupt = new Grant(
                    grant.id,
                    grant.scope,
                    SubjectRef.principal(new PrincipalRef(tenantId, new PrincipalId("missing"))),
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
            (state: TenantAuthorityFixture) => {
                const grant = new Grant(
                    new GrantId("closure-child"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
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
            (state: TenantAuthorityFixture) => {
                const parent = new Grant(
                    new GrantId("closure-parent"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
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
            "malformed Binding record",
            (state: TenantAuthorityFixture) => {
                const binding = closureBinding(state);
                state.database.run("UPDATE tenant_bindings SET record = ? WHERE binding_key = ?", [
                    Uint8Array.of(0),
                    binding.key
                ]);
            }
        ],
        [
            "Binding missing Grant authority",
            (state: TenantAuthorityFixture) => {
                const binding = closureBinding(state);
                const corrupt = binding.replace(new GrantId("missing"), binding.facet);
                state.database.run(
                    `UPDATE tenant_bindings SET grant_id = ?, generation = ?, revision = ?, record = ?
                     WHERE binding_key = ?`,
                    [
                        corrupt.grantId.value,
                        corrupt.generation,
                        corrupt.revision.value,
                        Binding.encode(corrupt),
                        binding.key
                    ]
                );
            }
        ],
        [
            "foreign Scope epoch",
            (state: TenantAuthorityFixture) => {
                const foreign = new ScopeEpoch(ScopeRef.tenant(new TenantId("foreign")), 1);
                state.database.run(
                    `INSERT INTO tenant_scope_epochs (scope_key, epoch, record) VALUES (?, ?, ?)`,
                    [sqliteScopeKey(foreign.scope), foreign.epoch, ScopeEpoch.encode(foreign)]
                );
            }
        ],
        [
            "overlength Project key",
            (state: TenantAuthorityFixture) => {
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
    ] as const)("rejects %s relational corruption on restart", { tags: "p0" }, (_name, corrupt) => {
        const state = fixture();
        corrupt(state);
        expect(() => createSqliteTenantControlStore(state.database)).toThrow(AgentCoreError);
    });
});

describe("SQLite watermark hard gates", () => {
    const owner = new ActorRef("workspace", new ActorId("sqlite-binding-owner"));
    const principal = new PrincipalRef(tenantId, ownerId);

    test("anchors stores and enforces monotonic revisions", { tags: "p0" }, () => {
        const database = new TestSqlite();
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

    test("rejects foreign owner records", { tags: "p0" }, () => {
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

    test("rejects malformed SQLite driver row types and lost writes", { tags: "p0" }, () => {
        const typedFailure = new AgentCoreError("protocol.invalid-state", "typed failure");
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
        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );

    test("round-trips and idempotently rewrites Grant and epoch records", { tags: "p0" }, () => {
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

    test(
        "converts missing writes and malformed projections to AgentCoreError",
        { tags: "p1" },
        () => {
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
            expect(() =>
                listSqliteGrants(new StubSqlite({ ...grantRow, state: "revoked" }))
            ).toThrow(AgentCoreError);

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
        }
    );
});

/** A bootstrapped Tenant control store with the mutation service that writes through it. */
interface TenantAuthorityFixture {
    readonly database: TestSqlite;
    readonly store: SqliteTenantControlStore;
    readonly service: AuthorityMutationService;
}

function fixture(): TenantAuthorityFixture {
    const database = new TestSqlite();
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return { database, store, service: new AuthorityMutationService(store) };
}

function closureBinding(state: TenantAuthorityFixture): Binding {
    const workspace = new Workspace(
        new WorkspaceId("closure-binding-workspace"),
        tenantId,
        undefined,
        Revision.initial()
    );
    state.service.createWorkspace(workspace);
    const grant = new Grant(
        new GrantId("closure-binding-grant"),
        workspace.scope,
        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
    state.service.createGrant(grant);
    const binding = Binding.active(
        workspace.scope,
        grant.subject,
        new ProtectionDomain("backend", "closure", "no-secrets"),
        new BindingName("closure-binding"),
        grant.id,
        new FacetRef("core:closure")
    );
    state.service.createBinding(binding);
    return binding;
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

describe("SQLite authority adapter mutation gates", () => {
    const scope = ScopeRef.tenant(tenantId);
    const foreignScope = ScopeRef.tenant(new TenantId("gate-foreign"));
    const grant = new Grant(
        new GrantId("gate-grant"),
        scope,
        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
    const corruptMessage = "Stored Tenant authority state is malformed";

    test("grant revocation persists and revoked grants cannot reactivate", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        saveSqliteGrant(database, grant);
        saveSqliteGrant(database, grant.revoke());
        expect(loadSqliteGrant(database, grant.id)?.state.name).toBe("revoked");
        expectExactFailure(
            () => saveSqliteGrant(database, grant),
            "protocol.invalid-state",
            "Revoked Grants cannot reactivate"
        );
        expect(loadSqliteGrant(database, grant.id)?.state.name).toBe("revoked");
    });

    test(
        "rejects a same-length direct Grant mutation instead of ignoring it",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            initializeSqliteAuthoritySchema(database);
            saveSqliteGrant(database, grant);
            const mutated = new Grant(
                grant.id,
                scope,
                SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                "allow",
                new CapabilitySpec({ facetPattern: "q", impacts: ["observe"] }),
                { kind: "direct" }
            );

            expect(() => saveSqliteGrant(database, mutated)).toThrow(
                expect.objectContaining({ code: "protocol.invalid-state" })
            );
            expect(Grant.encode(loadSqliteGrant(database, grant.id)!)).toEqual(Grant.encode(grant));
        }
    );

    test("fails closed when the parent Grant projection column is absent", { tags: "p1" }, () => {
        const row = {
            id: grant.id.value,
            scope_key: scopeKey(grant.scope),
            subject_key: subjectKey(grant.subject),
            effect: grant.effect,
            state: grant.state.name,
            record: Grant.encode(grant)
        } satisfies SqliteRow;

        expect(() => loadSqliteGrant(new StubSqlite(row), grant.id)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test(
        "grant writes that do not land fail with the exact concurrent-change conflict",
        { tags: "p0" },
        () => {
            const database = new TamperedSqlite();
            initializeSqliteAuthoritySchema(database);
            database.dropRuns = true;
            expectExactFailure(
                () => saveSqliteGrant(database, grant),
                "protocol.revision-conflict",
                "Grant changed concurrently"
            );
        }
    );

    test("grant projections must match their stored columns", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        saveSqliteGrant(database, grant);
        const sibling = new Grant(
            new GrantId("gate-grant-sibling"),
            scope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        );
        const drifts: readonly (readonly [string, SqliteValue, SqliteValue])[] = [
            ["record", Grant.encode(sibling), Grant.encode(grant)],
            ["scope_key", "tampered", scopeKey(grant.scope)],
            ["subject_key", "tampered", subjectKey(grant.subject)],
            ["effect", "deny", grant.effect],
            ["parent_grant_id", "phantom", null]
        ];
        for (const [column, drifted, restored] of drifts) {
            database.run(`UPDATE tenant_grants SET ${column} = ? WHERE id = ?`, [
                drifted,
                grant.id.value
            ]);
            expectExactFailure(
                () => loadSqliteGrant(database, grant.id),
                "codec.invalid",
                corruptMessage
            );
            database.run(`UPDATE tenant_grants SET ${column} = ? WHERE id = ?`, [
                restored,
                grant.id.value
            ]);
        }
        expect(loadSqliteGrant(database, grant.id)?.id.equals(grant.id)).toBe(true);
    });

    test("grant driver rows must belong to the queried id", { tags: "p0" }, () => {
        const database = new StubSqlite({
            id: "foreign-row",
            scope_key: scopeKey(grant.scope),
            subject_key: subjectKey(grant.subject),
            effect: grant.effect,
            parent_grant_id: null,
            state: grant.state.name,
            record: Grant.encode(grant)
        });
        expectExactFailure(
            () => loadSqliteGrant(database, grant.id),
            "codec.invalid",
            corruptMessage
        );
    });

    test("text and byte columns fail closed as typed corruption", { tags: "p1" }, () => {
        const grantRow = {
            id: "",
            scope_key: scopeKey(grant.scope),
            subject_key: subjectKey(grant.subject),
            effect: grant.effect,
            parent_grant_id: null,
            state: grant.state.name,
            record: Grant.encode(grant)
        } satisfies SqliteRow;
        expectExactFailure(
            () => listSqliteGrants(new StubSqlite(grantRow)),
            "codec.invalid",
            corruptMessage
        );
        expectExactFailure(
            () =>
                loadSqliteEpoch(
                    new StubSqlite({ scope_key: scopeKey(scope), epoch: 1, record: 42 }),
                    scope
                ),
            "codec.invalid",
            corruptMessage
        );
    });

    test("epoch writes advance exactly once from the stored epoch", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        expectExactFailure(
            () => saveSqliteEpoch(database, new ScopeEpoch(scope, 2)),
            "protocol.revision-conflict",
            "Scope epoch writes must advance exactly once"
        );
        expect(loadSqliteEpoch(database, scope).epoch).toBe(0);
        saveSqliteEpoch(database, new ScopeEpoch(scope, 1));
        saveSqliteEpoch(database, new ScopeEpoch(scope, 1));
        expectExactFailure(
            () => saveSqliteEpoch(database, new ScopeEpoch(scope, 3)),
            "protocol.revision-conflict",
            "Scope epoch writes must advance exactly once"
        );
        expect(loadSqliteEpoch(database, scope).epoch).toBe(1);
    });

    test(
        "epoch writes that do not land fail with the exact concurrent-change conflict",
        { tags: "p0" },
        () => {
            const database = new TamperedSqlite();
            initializeSqliteAuthoritySchema(database);
            database.dropRuns = true;
            expectExactFailure(
                () => saveSqliteEpoch(database, new ScopeEpoch(scope, 1)),
                "protocol.revision-conflict",
                "Scope epoch changed concurrently"
            );
        }
    );

    test("epoch projections must match their stored columns", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        saveSqliteEpoch(database, new ScopeEpoch(scope, 1));
        database.run("UPDATE tenant_scope_epochs SET epoch = 2 WHERE scope_key = ?", [
            scopeKey(scope)
        ]);
        expectExactFailure(() => loadSqliteEpoch(database, scope), "codec.invalid", corruptMessage);
        expectExactFailure(() => listSqliteEpochs(database), "codec.invalid", corruptMessage);
        database.run("UPDATE tenant_scope_epochs SET epoch = 1 WHERE scope_key = ?", [
            scopeKey(scope)
        ]);
        database.run("UPDATE tenant_scope_epochs SET record = ? WHERE scope_key = ?", [
            ScopeEpoch.encode(new ScopeEpoch(foreignScope, 1)),
            scopeKey(scope)
        ]);
        expectExactFailure(() => loadSqliteEpoch(database, scope), "codec.invalid", corruptMessage);
        expectExactFailure(() => listSqliteEpochs(database), "codec.invalid", corruptMessage);
        database.run("UPDATE tenant_scope_epochs SET record = ? WHERE scope_key = ?", [
            ScopeEpoch.encode(new ScopeEpoch(scope, 1)),
            scopeKey(scope)
        ]);
        database.run("UPDATE tenant_scope_epochs SET scope_key = 'tampered' WHERE scope_key = ?", [
            scopeKey(scope)
        ]);
        expectExactFailure(() => listSqliteEpochs(database), "codec.invalid", corruptMessage);
        expect(loadSqliteEpoch(database, scope).epoch).toBe(0);
    });

    test("epoch driver rows must match the queried scope key", { tags: "p0" }, () => {
        const database = new StubSqlite({
            scope_key: "foreign-key",
            epoch: 1,
            record: ScopeEpoch.encode(new ScopeEpoch(scope, 1))
        });
        expectExactFailure(() => loadSqliteEpoch(database, scope), "codec.invalid", corruptMessage);
    });

    test("a stored zero epoch round-trips", { tags: "p1" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        database.run(
            "INSERT INTO tenant_scope_epochs (scope_key, epoch, record) VALUES (?, ?, ?)",
            [scopeKey(scope), 0, ScopeEpoch.encode(new ScopeEpoch(scope, 0))]
        );
        expect(loadSqliteEpoch(database, scope).epoch).toBe(0);
        expect(
            listSqliteEpochs(database).some(
                (record) => record.scope.equals(scope) && record.epoch === 0
            )
        ).toBe(true);
    });

    test("grant read-back rejects a same-length record substitution", { tags: "p0" }, () => {
        const database = new SwappedRecordSqlite("tenant_grants");
        initializeSqliteAuthoritySchema(database);
        const variant = new Grant(
            grant.id,
            scope,
            SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["execute"] }),
            { kind: "direct" }
        );
        expect(Grant.encode(variant).byteLength).toBe(Grant.encode(grant).byteLength);
        database.swapped = Grant.encode(variant);

        expectExactFailure(
            () => saveSqliteGrant(database, grant),
            "protocol.revision-conflict",
            "Grant changed concurrently"
        );
    });

    test("grant rows fail closed on an absent nullable text column", { tags: "p1" }, () => {
        const database = new StubSqlite({
            id: grant.id.value,
            scope_key: scopeKey(grant.scope),
            subject_key: subjectKey(grant.subject),
            effect: grant.effect,
            state: grant.state.name,
            record: Grant.encode(grant)
        });

        expectExactFailure(
            () => loadSqliteGrant(database, grant.id),
            "codec.invalid",
            corruptMessage
        );
    });

    test("epoch rows must match the queried Scope when self-consistent", { tags: "p0" }, () => {
        const foreignEpoch = new ScopeEpoch(foreignScope, 1);
        const database = new StubSqlite({
            scope_key: scopeKey(foreignScope),
            epoch: foreignEpoch.epoch,
            record: ScopeEpoch.encode(foreignEpoch)
        });

        expectExactFailure(() => loadSqliteEpoch(database, scope), "codec.invalid", corruptMessage);
    });

    // The Binding half of this adapter is reached only through SqliteTenantControlStore,
    // whose writers refuse every state these gates reject before a row is written. Driving
    // the adapter directly is what leaves each gate as the only thing standing between a
    // disagreeing ledger and a Binding the caller would have trusted.
    const binding = Binding.active(
        workspaceScope,
        SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
        new ProtectionDomain("backend", "gate", "no-secrets"),
        new BindingName("gate-binding"),
        new GrantId("gate-binding-grant"),
        new FacetRef("core:gate")
    );

    test("holds new Bindings to generation and revision zero", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);

        for (const [generation, revision] of [
            [1, 0],
            [0, 1]
        ] as const) {
            expectExactFailure(
                () =>
                    saveSqliteBinding(
                        database,
                        new Binding(
                            binding.scope,
                            binding.subject,
                            binding.domain,
                            binding.name,
                            binding.grantId,
                            binding.facet,
                            generation,
                            "active",
                            new Revision(revision)
                        )
                    ),
                "protocol.revision-conflict",
                "New Bindings require generation and revision zero"
            );
        }
        expect(listSqliteBindings(database)).toEqual([]);
    });

    test(
        "binding writes that do not land fail with the exact concurrent-change conflict",
        { tags: "p0" },
        () => {
            const database = new TamperedSqlite();
            initializeSqliteAuthoritySchema(database);
            database.dropRuns = true;
            expectExactFailure(
                () => saveSqliteBinding(database, binding),
                "protocol.revision-conflict",
                "Binding changed concurrently"
            );
        }
    );

    test("binding projections must match their stored columns", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        saveSqliteBinding(database, binding);
        const sibling = Binding.active(
            binding.scope,
            binding.subject,
            binding.domain,
            new BindingName("gate-binding-sibling"),
            binding.grantId,
            binding.facet
        );
        const drifts: readonly (readonly [string, SqliteValue, SqliteValue])[] = [
            ["record", Binding.encode(sibling), Binding.encode(binding)],
            ["scope_key", "tampered", scopeKey(binding.scope)],
            ["subject_key", "tampered", subjectKey(binding.subject)],
            ["domain_key", "tampered", domainKey(binding.domain)],
            ["name", "tampered", binding.name.value],
            ["grant_id", "phantom", binding.grantId.value],
            ["facet_ref", "core:phantom", binding.facet.value],
            ["generation", 1, binding.generation],
            ["revision", 1, binding.revision.value],
            ["state", "inactive", binding.state]
        ];
        for (const [column, drifted, restored] of drifts) {
            database.run(`UPDATE tenant_bindings SET ${column} = ? WHERE binding_key = ?`, [
                drifted,
                binding.key
            ]);
            expectExactFailure(
                () => loadSqliteBinding(database, binding.key),
                "codec.invalid",
                corruptMessage
            );
            database.run(`UPDATE tenant_bindings SET ${column} = ? WHERE binding_key = ?`, [
                restored,
                binding.key
            ]);
        }
        expect(loadSqliteBinding(database, binding.key)?.key).toBe(binding.key);
    });

    test("binding driver rows must belong to the queried key", { tags: "p0" }, () => {
        const row = {
            binding_key: binding.key,
            scope_key: scopeKey(binding.scope),
            subject_key: subjectKey(binding.subject),
            domain_key: domainKey(binding.domain),
            name: binding.name.value,
            grant_id: binding.grantId.value,
            facet_ref: binding.facet.value,
            generation: binding.generation,
            revision: binding.revision.value,
            state: binding.state,
            record: Binding.encode(binding)
        } satisfies SqliteRow;

        expectExactFailure(
            () => loadSqliteBinding(new StubSqlite(row), "gate-binding-elsewhere"),
            "codec.invalid",
            corruptMessage
        );
        expectExactFailure(
            () =>
                loadSqliteBinding(
                    new StubSqlite({ ...row, binding_key: "gate-binding-elsewhere" }),
                    binding.key
                ),
            "codec.invalid",
            corruptMessage
        );
    });

    test("replaces a stored Binding only by its exact successor", { tags: "p0" }, () => {
        const database = new TestSqlite();
        initializeSqliteAuthoritySchema(database);
        saveSqliteBinding(database, binding);
        saveSqliteBinding(database, binding);

        expect(() =>
            saveSqliteBinding(database, binding.replace(binding.grantId, new FacetRef("core:next")))
        ).not.toThrow();
        expect(loadSqliteBinding(database, binding.key)?.facet.value).toBe("core:next");
        expect(() =>
            saveSqliteBinding(database, binding.replace(binding.grantId, new FacetRef("core:skip")))
        ).toThrow(expect.objectContaining({ code: "binding.invalid" }));
        expect(loadSqliteBinding(database, binding.key)?.facet.value).toBe("core:next");
    });

    test("read and write failures carry their exact taxonomy", { tags: "p1" }, () => {
        const failingWrite = new StubSqlite();
        failingWrite.failRuns = true;
        expectExactFailure(
            () => initializeSqliteAuthoritySchema(failingWrite),
            "protocol.revision-conflict",
            "Authority write failed"
        );
        const failingRead = new StubSqlite();
        failingRead.failReads = true;
        expectExactFailure(
            () => loadSqliteGrant(failingRead, grant.id),
            "codec.invalid",
            "Authority read failed"
        );
    });
});

class SwappedRecordSqlite extends TestSqlite {
    public swapped: Uint8Array | undefined;

    public constructor(private readonly table: string) {
        super();
    }

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        const swapped = this.swapped;
        if (swapped === undefined || !statement.includes(`FROM ${this.table}`)) return rows;
        return rows.map((row) => ({ ...row, record: swapped }));
    }
}

class TamperedSqlite extends TransactionalSqlite {
    readonly #database = new TestSqlite();
    public dropRuns = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.all(statement, bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (!this.dropRuns) this.#database.run(statement, bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(operation, ...guard);
    }
}

function expectExactFailure(
    operation: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (error instanceof AgentCoreError) {
            expect(error.code).toBe(code);
            expect(error.message).toBe(message);
        }
        return;
    }
    throw new TypeError(`Expected AgentCoreError ${code}`);
}
