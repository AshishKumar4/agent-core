import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    AuthorityMutationService,
    Binding,
    Grant,
    GrantId,
    MemoryTenantControlStore,
    ScopeEpoch,
    scopeKey,
    type AuthorityMutationStore
} from "../../../src/authority";
import { MemoryContentStore } from "../../../src/content";
import { Digest, Revision } from "../../../src/core";
import {
    DeploymentId,
    DeploymentKey,
    MaterializationGenerationPointer
} from "../../../src/definition";
import {
    GuestTrust,
    GuestTrustId,
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    PrincipalRef,
    Project,
    ProjectId,
    Role,
    RoleName,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../../src/identity";
import { CommandAuthenticator } from "../../../src/protocol";
import {
    SqliteMaterializationStore,
    SqlitePackageStore,
    createSqliteTenantControlStore,
    createSqliteTenantBootstrap,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates";
import { SqliteWorkspaceSlotStore } from "../../../src/substrates/sqlite/slot";
import { TestSqlite } from "../../helpers/sqlite";
import {
    actorRef,
    installGeneration,
    materializationState
} from "../../definition/materialization-store-contract";
import { packageRelease } from "../../definition/package-store-contract";
import { slot } from "../../w3/slot-store-contract";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    ProtectionDomain,
    SlotName
} from "../../../src/facets";

const tenantId = new TenantId("behavior-tenant");
const ownerId = new PrincipalId("behavior-owner");
const anchor = {
    actorId: new ActorId("behavior-tenant-actor"),
    tenantId,
    principalId: ownerId,
    tenantKind: "organization" as const,
    trustAnchor: Uint8Array.of(1, 3, 5)
};

describe("SQLite Tenant control behavior branches", () => {
    test(
        "[C13-OWNERSHIP-AUTHORITY-RECORDS] [authority-mutation-store] [identity-repository] memory and SQLite keep Binding transitions and path epochs in one Tenant control plane",
        { tags: "p1" },
        () => {
            const memory = MemoryTenantControlStore.create(anchor);
            memory.bootstrapTenant(anchor, Revision.initial());
            const stores = [memory, bootstrappedTenant(new TestSqlite())];

            for (const [index, store] of stores.entries()) {
                const service = new AuthorityMutationService(store);
                const principal = new Principal(
                    new PrincipalId(`seam-principal-${index}`),
                    "user",
                    "active"
                );
                service.createPrincipal(principal);
                expect(store.principal(principal.id)?.kind).toBe("user");

                const workspace = new Workspace(
                    new WorkspaceId(`seam-workspace-${index}`),
                    tenantId,
                    undefined,
                    Revision.initial()
                );
                service.createWorkspace(workspace);
                const subject = SubjectRef.principal(new PrincipalRef(tenantId, principal.id));
                const grant = new Grant(
                    new GrantId(`seam-binding-grant-${index}`),
                    workspace.scope,
                    subject,
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                service.createGrant(grant);
                const binding = Binding.active(
                    workspace.scope,
                    subject,
                    new ProtectionDomain("backend", `seam-${index}`, "no-secrets"),
                    new BindingName("canonical"),
                    grant.id,
                    new FacetRef("core:canonical")
                );
                const before = store.epoch(workspace.scope).epoch;

                service.createBinding(binding);
                const replacement = service.replaceBinding(
                    binding.key,
                    grant.id,
                    new FacetRef("core:replacement")
                );
                const inactive = service.deactivateBinding(binding.key);
                const unchanged = service.deactivateBinding(binding.key);

                expect(inactive.state).toBe("inactive");
                expect(inactive.revision.value).toBe(replacement.revision.value + 1);
                expect(unchanged).toEqual(inactive);
                expect(store.binding(binding.key)).toEqual(inactive);
                expect(store.bindings()).toEqual([inactive]);
                expect(store.epoch(workspace.scope).epoch).toBe(before + 3);
            }
        }
    );

    test.each(["memory", "sqlite"] as const)(
        "[C13-OWNERSHIP-AUTHORITY-RECORDS] %s rolls back a Binding write when its same-transaction epoch advance fails",
        { tags: "p0" },
        (adapter) => {
            let store: AuthorityMutationStore;
            let fixture: ReturnType<typeof bindingFixture>;
            if (adapter === "memory") {
                const memory = MemoryTenantControlStore.create(anchor);
                memory.bootstrapTenant(anchor, Revision.initial());
                fixture = bindingFixture(memory, `rollback-${adapter}`);
                const snapshot = memory.snapshot();
                const saturated = new ScopeEpoch(fixture.workspace.scope, Number.MAX_SAFE_INTEGER);
                store = MemoryTenantControlStore.restore({
                    ...snapshot,
                    epochs: snapshot.epochs.map((record) =>
                        record.id === scopeKey(fixture.workspace.scope)
                            ? { ...record, bytes: ScopeEpoch.encode(saturated) }
                            : record
                    )
                });
            } else {
                const database = new TestSqlite();
                const sqlite = bootstrappedTenant(database);
                fixture = bindingFixture(sqlite, `rollback-${adapter}`);
                store = saturateSqliteEpoch(
                    database,
                    new ScopeEpoch(fixture.workspace.scope, Number.MAX_SAFE_INTEGER)
                );
            }
            const { binding, workspace } = fixture;
            const saturated = new ScopeEpoch(workspace.scope, Number.MAX_SAFE_INTEGER);

            expect(() => new AuthorityMutationService(store).createBinding(binding)).toThrow(
                "Authority epoch is exhausted"
            );
            expect(store.binding(binding.key)).toBeUndefined();
            expect(store.epoch(workspace.scope).equals(saturated)).toBe(true);
        }
    );

    test(
        "persists a complete topology and lifecycle closure across adapter restart",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = bootstrappedTenant(database);
            const principal = new Principal(new PrincipalId("member"), "user", "active");
            const project = new Project(
                new ProjectId("project"),
                tenantId,
                "Project",
                Revision.initial()
            );
            const workspace = new Workspace(
                new WorkspaceId("workspace"),
                tenantId,
                project.id,
                Revision.initial()
            );
            const team = new Team(
                new TeamId("team"),
                tenantId,
                "Team",
                [principal.id],
                Revision.initial()
            );
            const role = new Role(new RoleName("empty-role"), []);
            const membership = new Membership(
                new MembershipId("membership"),
                workspace.scope,
                SubjectRef.principal(new PrincipalRef(tenantId, principal.id)),
                role.name,
                "active",
                Revision.initial()
            );
            const trust = new GuestTrust(
                new GuestTrustId("guest-trust"),
                tenantId,
                new TenantId("home-tenant"),
                { kind: "callback", endpoint: "https://home.example/verify" },
                "active",
                Revision.initial()
            );

            store.transaction((control) => {
                control.putPrincipal(principal);
                control.putProject(project);
                control.putWorkspace(workspace);
                control.putTeam(team);
                control.putRole(role);
                control.putMembership(membership);
                control.putGuestTrust(trust);
            });
            store.transaction((control) => {
                control.putProject(project.rename("Renamed"));
                control.putTeam(team.revise("Renamed team", [principal.id]));
                control.putMembership(membership.suspend());
                control.putGuestTrust(
                    trust.rotate({ kind: "callback", endpoint: "https://home.example/v2" })
                );
            });

            const restarted = createSqliteTenantControlStore(database);
            expect(restarted.project(project.id)?.name).toBe("Renamed");
            expect(restarted.workspace(workspace.id)?.projectId?.equals(project.id)).toBe(true);
            expect(restarted.team(team.id)?.name).toBe("Renamed team");
            expect(restarted.membership(membership.id)?.state).toBe("suspended");
            expect(restarted.guestTrust(trust.id)?.revision.value).toBe(1);
        }
    );

    test(
        "rolls back earlier valid writes when a later topology write is foreign",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = bootstrappedTenant(database);
            const transient = new PrincipalId("rolled-back-principal");

            expect(() =>
                store.transaction((control) => {
                    control.putPrincipal(new Principal(transient, "user", "active"));
                    control.putTeam(
                        new Team(
                            new TeamId("foreign-team"),
                            new TenantId("foreign-tenant"),
                            "Foreign",
                            [],
                            Revision.initial()
                        )
                    );
                })
            ).toThrow(/another Tenant/);

            expect(store.principal(transient)).toBeUndefined();
            expect(store.team(new TeamId("foreign-team"))).toBeUndefined();
        }
    );

    test(
        "rejects immutable, skipped-revision, and noncanonical topology conflicts",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = bootstrappedTenant(database);
            const principal = new Principal(new PrincipalId("stable-principal"), "user", "active");
            const project = new Project(
                new ProjectId("stable-project"),
                tenantId,
                "Stable",
                Revision.initial()
            );
            const workspace = new Workspace(
                new WorkspaceId("stable-workspace"),
                tenantId,
                project.id,
                Revision.initial()
            );
            store.transaction((control) => {
                control.putPrincipal(principal);
                control.putProject(project);
                control.putWorkspace(workspace);
            });

            expect(() =>
                store.transaction((control) =>
                    control.putPrincipal(new Principal(principal.id, "service", "active"))
                )
            ).toThrow(/kind is immutable/);
            expect(() =>
                store.transaction((control) =>
                    control.putProject(
                        new Project(project.id, tenantId, "Skipped", new Revision(2))
                    )
                )
            ).toThrow(/next revision/);
            expect(() => store.transaction((control) => control.putWorkspace(workspace))).toThrow(
                /topology is immutable/
            );
            expect(() =>
                store.transaction((control) =>
                    control.putWorkspace(
                        new Workspace(
                            new WorkspaceId("orphan-workspace"),
                            tenantId,
                            new ProjectId("missing-project"),
                            Revision.initial()
                        )
                    )
                )
            ).toThrow(/existing Project/);

            expect(store.principal(principal.id)?.kind).toBe("user");
            expect(store.project(project.id)?.revision.value).toBe(0);
        }
    );

    test(
        "fails closed when marker codec bytes or the bootstrap closure are lost",
        { tags: "p0" },
        () => {
            const markerDatabase = new TestSqlite();
            bootstrappedTenant(markerDatabase);
            markerDatabase.run("UPDATE tenant_bootstrap_marker SET record = ?", [Uint8Array.of(0)]);
            expect(() => createSqliteTenantControlStore(markerDatabase)).toThrow(
                expect.objectContaining({ code: "codec.invalid" })
            );

            const closureDatabase = new TestSqlite();
            bootstrappedTenant(closureDatabase);
            closureDatabase.run("DELETE FROM tenant_principals WHERE id = ?", [ownerId.value]);
            expect(() => createSqliteTenantControlStore(closureDatabase)).toThrow(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );
});

describe("SQLite materialization CAS behavior", () => {
    test.each(["zero", "multiple", "malformed"] as const)(
        "treats %s RETURNING rows as an exact CAS outcome and rolls back rejected writes",
        { tags: "p0" },
        (fault) => {
            const database = new PointerCardinalitySqlite();
            const actor = actorRef(`pointer-${fault}`);
            const store = new SqliteMaterializationStore(database, actor);
            const fixture = materializationState(actor, 1, `pointer-${fault}`);
            installGeneration(store, fixture);
            const deployment = DeploymentId.derive(
                new TenantId("tenant"),
                new DeploymentKey("platform")
            );
            const pointer = MaterializationGenerationPointer.initial(
                actor,
                deployment,
                fixture.materialization.generation.id
            );
            database.fault = fault;

            if (fault === "zero") {
                expect(
                    store.transaction((transaction) =>
                        store.compareAndSetGenerationPointer(
                            transaction,
                            actor,
                            deployment,
                            undefined,
                            pointer
                        )
                    )
                ).toBe(false);
            } else {
                expect(() =>
                    store.transaction((transaction) =>
                        store.compareAndSetGenerationPointer(
                            transaction,
                            actor,
                            deployment,
                            undefined,
                            pointer
                        )
                    )
                ).toThrow(/CAS returned malformed state/);
            }

            database.fault = "none";
            expect(store.getGenerationPointer(actor, deployment)).toBeUndefined();
        }
    );
});

describe("SQLite package, bootstrap, and Slot failure behavior", () => {
    test(
        "keeps the first package release when the immutable version key conflicts",
        { tags: "p0" },
        () => {
            const store = new SqlitePackageStore(new TestSqlite());
            const original = packageRelease("immutable", "1.0.0");
            const conflict = packageRelease("immutable", "1.0.0", new Digest("1".repeat(64)));
            store.add(original);

            expect(() => store.add(conflict)).toThrow(/immutable/);
            expect(store.get(original.id, original.version)).toEqual(original);
        }
    );

    test("translates a malformed bootstrap ID schema without replacing it", { tags: "p1" }, () => {
        const database = new TestSqlite();
        database.run(
            "CREATE TABLE tenant_bootstrap_protocol_ids (singleton INTEGER PRIMARY KEY) STRICT",
            []
        );
        const actor = new ActorRef("tenant", anchor.actorId);
        const contentStore = new MemoryContentStore();
        contentStore.retention(tenantId, actor);

        expect(() =>
            createSqliteTenantBootstrap({
                actor,
                anchor,
                authenticator: new RejectingAuthenticator(),
                content: contentStore.transient(tenantId, actor),
                database
            })
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        expect(
            database.all(
                "SELECT sql FROM sqlite_master WHERE name = 'tenant_bootstrap_protocol_ids'",
                []
            )[0]?.["sql"]
        ).not.toContain("next_id");
    });

    test(
        "fails closed on missing Slot revision, ignored CAS, and declaration projection drift",
        { tags: "p0" },
        () => {
            const missingDatabase = new TestSqlite();
            const owner = new WorkspaceId("slot-owner");
            const missing = new SqliteWorkspaceSlotStore(owner, missingDatabase);
            missingDatabase.run("DELETE FROM facet_slot_revision", []);
            expect(() => missing.revision()).toThrow(/revision is missing/);

            const casDatabase = new TestSqlite();
            const cas = new SqliteWorkspaceSlotStore(owner, casDatabase);
            casDatabase.run(
                `CREATE TRIGGER ignore_slot_revision BEFORE UPDATE ON facet_slot_revision
             BEGIN SELECT RAISE(IGNORE); END`,
                []
            );
            expect(() =>
                cas.transaction((transaction) =>
                    cas.saveRevision(transaction, cas.loadRevision(transaction).next())
                )
            ).toThrow(/did not persist/);
            expect(cas.revision().value).toBe(0);

            const projectionDatabase = new TestSqlite();
            const projection = new SqliteWorkspaceSlotStore(owner, projectionDatabase);
            projection.install(slot());
            projectionDatabase.run("UPDATE facet_slots SET name = 'forged-slot'", []);
            expect(() => projection.slot(new SlotName("forged-slot"))).toThrow(/projection/);
        }
    );
});

function bootstrappedTenant(database: TestSqlite) {
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return store;
}

function bindingFixture(store: AuthorityMutationStore, suffix: string) {
    const service = new AuthorityMutationService(store);
    const principal = new Principal(new PrincipalId(`${suffix}-principal`), "user", "active");
    service.createPrincipal(principal);
    const workspace = new Workspace(
        new WorkspaceId(`${suffix}-workspace`),
        tenantId,
        undefined,
        Revision.initial()
    );
    service.createWorkspace(workspace);
    const subject = SubjectRef.principal(new PrincipalRef(tenantId, principal.id));
    const grant = new Grant(
        new GrantId(`${suffix}-grant`),
        workspace.scope,
        subject,
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
    service.createGrant(grant);
    return {
        workspace,
        binding: Binding.active(
            workspace.scope,
            subject,
            new ProtectionDomain("backend", suffix, "no-secrets"),
            new BindingName("canonical"),
            grant.id,
            new FacetRef("core:canonical")
        )
    };
}

function saturateSqliteEpoch(database: TestSqlite, saturated: ScopeEpoch): AuthorityMutationStore {
    database.run("UPDATE tenant_scope_epochs SET epoch = ?, record = ? WHERE scope_key = ?", [
        saturated.epoch,
        ScopeEpoch.encode(saturated),
        scopeKey(saturated.scope)
    ]);
    return createSqliteTenantControlStore(database);
}

class PointerCardinalitySqlite extends TestSqlite {
    public fault: "none" | "zero" | "multiple" | "malformed" = "none";

    protected override query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (!statement.includes("INSERT INTO definition_materialization_pointers")) {
            return super.query(statement, bindings);
        }
        if (this.fault === "zero") return [];
        const rows = super.query(statement, bindings);
        if (this.fault === "multiple") return [...rows, ...rows];
        if (this.fault === "malformed" && rows[0] !== undefined) {
            return [{ ...rows[0], record: Uint8Array.of(0) }];
        }
        return rows;
    }
}

class RejectingAuthenticator extends CommandAuthenticator<undefined> {
    public constructor() {
        super(tenantId);
    }

    protected authenticateTransport(): undefined {
        return undefined;
    }
}
