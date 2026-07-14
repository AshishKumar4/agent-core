import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { MemoryTenantControlStore } from "../../../src/authority";
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
import { SlotName } from "../../../src/facets";

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
    test("[authority-mutation-store] [identity-repository] memory and SQLite satisfy one shared Tenant control contract", () => {
        const memory = MemoryTenantControlStore.create(anchor);
        memory.bootstrapTenant(anchor, Revision.initial());
        const stores = [memory, bootstrappedTenant(new TestSqlite())];

        for (const [index, store] of stores.entries()) {
            const principal = new Principal(
                new PrincipalId(`seam-principal-${index}`),
                "user",
                "active"
            );
            store.transaction((control) => control.putPrincipal(principal));
            expect(store.principal(principal.id)?.kind).toBe("user");
        }
    });

    test("persists a complete topology and lifecycle closure across adapter restart", () => {
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
            SubjectRef.principal(principal.id),
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
    });

    test("rolls back earlier valid writes when a later topology write is foreign", () => {
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
    });

    test("rejects immutable, skipped-revision, and noncanonical topology conflicts", () => {
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
                control.putProject(new Project(project.id, tenantId, "Skipped", new Revision(2)))
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
    });

    test("fails closed when marker codec bytes or the bootstrap closure are lost", () => {
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
    });
});

describe("SQLite materialization CAS behavior", () => {
    test.each(["zero", "multiple", "malformed"] as const)(
        "treats %s RETURNING rows as an exact CAS outcome and rolls back rejected writes",
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
    test("keeps the first package release when the immutable version key conflicts", () => {
        const store = new SqlitePackageStore(new TestSqlite());
        const original = packageRelease("immutable", "1.0.0");
        const conflict = packageRelease("immutable", "1.0.0", new Digest("1".repeat(64)));
        store.add(original);

        expect(() => store.add(conflict)).toThrow(/immutable/);
        expect(store.get(original.id, original.version)).toEqual(original);
    });

    test("translates a malformed bootstrap ID schema without replacing it", () => {
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

    test("fails closed on missing Slot revision, ignored CAS, and declaration projection drift", () => {
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
    });
});

function bootstrappedTenant(database: TestSqlite) {
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return store;
}

class PointerCardinalitySqlite extends TestSqlite {
    public fault: "none" | "zero" | "multiple" | "malformed" = "none";

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (!statement.includes("INSERT INTO definition_materialization_pointers")) {
            return super.all(statement, bindings);
        }
        if (this.fault === "zero") return [];
        const rows = super.all(statement, bindings);
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
