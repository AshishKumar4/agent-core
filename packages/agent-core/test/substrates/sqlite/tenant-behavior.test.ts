import { describe, expect, test } from "vitest";
import { ActorId } from "../../../src/actors";
import {
    Grant,
    GrantId,
    ScopeEpoch,
    createTenantControlBootstrapPlan
} from "../../../src/authority";
import { Revision, encodeCanonicalJson, type JsonValue } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { CapabilitySpec } from "../../../src/facets";
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
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../../src/identity";
import { TenantBootstrapAnchorRecord } from "../../../src/protocol";
import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite";
import { sqliteScopeKey, sqliteSubjectKey } from "../../../src/substrates/sqlite/identity";
import { createSqliteTenantControlStore } from "../../../src/substrates/sqlite/tenant";
import { TestSqlite } from "../../helpers/sqlite";

const tenantId = new TenantId("behavior-exact-tenant");
const principalId = new PrincipalId("behavior-exact-owner");
const tenantScope = ScopeRef.tenant(tenantId);
const foreignTenantId = new TenantId("alien-tenant");
const anchor = {
    actorId: new ActorId("behavior-exact-actor"),
    tenantId,
    principalId,
    tenantKind: "organization" as const,
    trustAnchor: Uint8Array.of(3, 2, 1)
};
const corrupt = { code: "codec.invalid", message: "Stored Tenant control state is malformed" };

type RoleGrantOrigin = Extract<Grant["origin"], { kind: "role" }>;

function bootstrappedStore(database: TestSqlite) {
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return store;
}

function allowGrant(id: string, scope = tenantScope, subject: SubjectRef = SubjectRef.principal(principalId)) {
    return new Grant(
        new GrantId(id),
        scope,
        subject,
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
}

function markerRecord(payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind: "protocol.tenant-bootstrap-marker",
        payload,
        version: { major: 1, minor: 0 }
    });
}

function insertMembershipRow(database: TestSqlite, membership: Membership): void {
    database.run(
        `INSERT INTO tenant_memberships (id, scope_key, subject_key, role_name, state, revision, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            membership.id.value,
            sqliteScopeKey(membership.scope),
            sqliteSubjectKey(membership.subject),
            membership.role.value,
            membership.state,
            membership.revision.value,
            Membership.encode(membership)
        ]
    );
}

function insertRoleRow(database: TestSqlite, role: Role): void {
    database.run("INSERT INTO tenant_roles (name, record) VALUES (?, ?)", [
        role.name.value,
        Role.encode(role)
    ]);
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

class SchemaFaultSqlite extends TestSqlite {
    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (statement.includes("CREATE TABLE IF NOT EXISTS tenant_bootstrap_marker")) {
            throw new Error("injected schema fault");
        }
        super.run(statement, bindings);
    }
}

class ReadFaultSqlite extends TestSqlite {
    public fault: Error | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.fault !== undefined && statement.includes("tenant_bootstrap_marker")) {
            throw this.fault;
        }
        return super.all(statement, bindings);
    }
}

class MarkerRowTamperSqlite extends TestSqlite {
    public tamper: ((row: SqliteRow) => SqliteRow) | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        const tamper = this.tamper;
        if (tamper === undefined || !statement.includes("FROM tenant_bootstrap_marker")) {
            return rows;
        }
        return rows.map((row) => tamper(row));
    }
}

describe("SQLite Tenant control construction and transaction gating", () => {
    test("wraps schema initialization faults into an exact revision conflict", { tags: "p1" }, () => {
        expect(() => createSqliteTenantControlStore(new SchemaFaultSqlite(), anchor)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Tenant control schema initialization failed"
            })
        );
    });

    test("requires an immutable bootstrap anchor to construct", { tags: "p0" }, () => {
        expect(() => createSqliteTenantControlStore(new TestSqlite())).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant control storage requires an immutable Tenant bootstrap anchor"
            })
        );
    });

    test("fails closed on identity rows without a marker and anchors eligibility", { tags: "p0" }, () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);
        const stray = new Principal(new PrincipalId("stray-principal"), "user", "active");
        database.run("INSERT INTO tenant_principals (id, kind, status, record) VALUES (?, ?, ?, ?)", [
            stray.id.value,
            stray.kind,
            stray.status,
            Principal.encode(stray)
        ]);
        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining(corrupt)
        );

        const anchorless = new TestSqlite();
        const store = createSqliteTenantControlStore(anchorless, anchor);
        expect(store.isBootstrapEligible()).toBe(true);
        anchorless.run("DELETE FROM tenant_bootstrap_anchor", []);
        expect(store.isBootstrapEligible()).toBe(false);
    });

    test("gates authority mutations on completed bootstrap", { tags: "p0" }, () => {
        const store = createSqliteTenantControlStore(new TestSqlite(), anchor);
        expect(() => store.transaction(() => undefined)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant authority mutations require completed bootstrap"
            })
        );
    });

    test("rejects nested Tenant control transactions", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Nested SQLite Tenant control transactions are not supported"
            })
        );
    });

    test("wraps foreign transaction faults and preserves domain faults", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        expect(() =>
            store.transaction(() => {
                throw new TypeError("injected fault");
            })
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Tenant control write failed"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putTeam(
                    new Team(new TeamId("alien-team"), foreignTenantId, "Alien", [], Revision.initial())
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Team belongs to another Tenant"
            })
        );
    });
});

describe("SQLite Tenant bootstrap anchor verification", () => {
    test("verifies bootstrap requests against every stored anchor field", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        const other = new TestSqlite();
        createSqliteTenantControlStore(other, anchor);
        expect(() => store.bootstrapTenant(other, anchor, Revision.initial())).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant bootstrap transaction belongs to another store"
            })
        );

        const mismatch = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Tenant bootstrap request does not match its immutable anchor"
        });
        const variants = [
            { ...anchor, actorId: new ActorId("other-actor") },
            { ...anchor, tenantId: foreignTenantId },
            { ...anchor, principalId: new PrincipalId("other-owner") },
            { ...anchor, tenantKind: "service" as const },
            { ...anchor, trustAnchor: Uint8Array.of(3, 2, 2) },
            { ...anchor, trustAnchor: Uint8Array.of(3, 2, 1, 0) }
        ];
        for (const variant of variants) {
            expect(() =>
                database.transaction(() =>
                    store.bootstrapTenant(database, variant, Revision.initial())
                )
            ).toThrow(mismatch);
        }

        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        expect(store.bootstrapMarker()?.tenantId.equals(tenantId)).toBe(true);
    });

    test("requires the stored anchor row when bootstrapping", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.run("DELETE FROM tenant_bootstrap_anchor", []);
        expect(() =>
            database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant bootstrap anchor is missing"
            })
        );
    });

    test("refuses rebinding a different anchor and a second bootstrap", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = bootstrappedStore(database);
        expect(() =>
            createSqliteTenantControlStore(database, { ...anchor, trustAnchor: Uint8Array.of(9) })
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "The immutable Tenant bootstrap anchor is already bound differently"
            })
        );
        expect(() =>
            database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant control is not bootstrap eligible"
            })
        );
    });

    test("defaults omitted Tenant kind to personal across bootstrap", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const personal = {
            actorId: new ActorId("personal-actor"),
            tenantId,
            principalId,
            trustAnchor: Uint8Array.of(3, 2, 1)
        };
        const store = createSqliteTenantControlStore(database, personal);
        database.transaction(() => store.bootstrapTenant(database, personal, Revision.initial()));
        expect(store.bootstrapAnchor()?.tenantKind).toBe("personal");
        expect(store.loadTenant(tenantId)?.kind).toBe("personal");
    });

    test("wraps bootstrap write faults and surfaces concurrent overwrites exactly", { tags: "p0" }, () => {
        const abortDatabase = new TestSqlite();
        const abortStore = createSqliteTenantControlStore(abortDatabase, anchor);
        abortDatabase.run(
            `CREATE TRIGGER fail_marker BEFORE INSERT ON tenant_bootstrap_marker
             BEGIN SELECT RAISE(ABORT, 'injected marker fault'); END`,
            []
        );
        expect(() =>
            abortDatabase.transaction(() =>
                abortStore.bootstrapTenant(abortDatabase, anchor, Revision.initial())
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Tenant bootstrap write failed"
            })
        );

        const ignoreDatabase = new TestSqlite();
        const ignoreStore = createSqliteTenantControlStore(ignoreDatabase, anchor);
        ignoreDatabase.run(
            `CREATE TRIGGER ignore_tenant BEFORE INSERT ON tenant_identities
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );
        expect(() =>
            ignoreDatabase.transaction(() =>
                ignoreStore.bootstrapTenant(ignoreDatabase, anchor, Revision.initial())
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Tenant control record changed concurrently"
            })
        );
        expect(ignoreStore.isBootstrapEligible()).toBe(true);
    });

    test("verifies the marker against an anchor swapped during bootstrap", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        const swapped = new TenantBootstrapAnchorRecord({
            ...anchor,
            trustAnchor: Uint8Array.of(9, 9, 9)
        });
        database.run(
            `CREATE TRIGGER swap_anchor AFTER INSERT ON tenant_scope_epochs
             BEGIN UPDATE tenant_bootstrap_anchor
                SET trust_anchor = X'090909',
                    record = X'${hex(TenantBootstrapAnchorRecord.encode(swapped))}'
                WHERE singleton = 1; END`,
            []
        );
        expect(() =>
            database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Bootstrap marker does not match its anchor"
            })
        );
        expect(store.isBootstrapEligible()).toBe(true);
        expect(Array.from(store.bootstrapAnchor()?.trustAnchor ?? Uint8Array.of())).toEqual([3, 2, 1]);
    });

    test("requires the bootstrap Tenant row when sealing the marker", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.run(
            `CREATE TRIGGER drop_tenant AFTER INSERT ON tenant_scope_epochs
             BEGIN DELETE FROM tenant_identities; END`,
            []
        );
        expect(() =>
            database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Bootstrap Tenant is not stored"
            })
        );
        expect(store.isBootstrapEligible()).toBe(true);
    });
});

describe("SQLite Tenant bootstrap marker projection and read faults", () => {
    test("validates the persisted marker against its projection columns", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = bootstrappedStore(database);
        expect(store.bootstrapMarker()?.revision.value).toBe(0);

        database.run("UPDATE tenant_bootstrap_marker SET tenant_id = 'other-tenant'", []);
        expect(() => store.bootstrapMarker()).toThrow(expect.objectContaining(corrupt));
        database.run("UPDATE tenant_bootstrap_marker SET tenant_id = ?", [tenantId.value]);

        database.run("UPDATE tenant_bootstrap_marker SET owner_principal_id = 'other-owner'", []);
        expect(() => store.bootstrapMarker()).toThrow(expect.objectContaining(corrupt));
        database.run("UPDATE tenant_bootstrap_marker SET owner_principal_id = ?", [principalId.value]);

        database.run("UPDATE tenant_bootstrap_marker SET revision = 7", []);
        expect(() => store.bootstrapMarker()).toThrow(expect.objectContaining(corrupt));
        database.run("UPDATE tenant_bootstrap_marker SET revision = 0", []);
        expect(store.bootstrapMarker()?.ownerPrincipalId.equals(principalId)).toBe(true);
    });

    test("surfaces malformed marker payloads with exact codec diagnoses", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = bootstrappedStore(database);
        const malformed = expect.objectContaining({
            code: "codec.invalid",
            message:
                "Invalid protocol.tenant-bootstrap-marker record: Tenant bootstrap marker payload is malformed"
        });
        const wellFormed = {
            ownerPrincipalId: principalId.value,
            revision: 0,
            tenantId: tenantId.value
        };
        const cases: readonly { payload: JsonValue; expected: ReturnType<typeof expect.objectContaining> }[] = [
            { payload: { ...wellFormed, extra: 1 }, expected: malformed },
            { payload: null, expected: malformed },
            { payload: { ...wellFormed, tenantId: 7 }, expected: malformed },
            { payload: { ...wellFormed, ownerPrincipalId: 7 }, expected: malformed },
            { payload: { ...wellFormed, revision: "0" }, expected: malformed }
        ];
        for (const { payload, expected } of cases) {
            database.run("UPDATE tenant_bootstrap_marker SET record = ?", [markerRecord(payload)]);
            expect(() => store.bootstrapMarker()).toThrow(expected);
        }
    });

    test("translates raw read faults into exact codec errors", { tags: "p1" }, () => {
        const database = new ReadFaultSqlite();
        const store = bootstrappedStore(database);

        database.fault = new Error("raw sqlite fault");
        expect(() => store.bootstrapMarker()).toThrow(
            expect.objectContaining({ code: "codec.invalid", message: "Tenant control read failed" })
        );

        database.fault = new AgentCoreError("authority.denied", "preserved read fault");
        expect(() => store.bootstrapMarker()).toThrow(
            expect.objectContaining({ code: "authority.denied", message: "preserved read fault" })
        );

        database.fault = undefined;
        expect(store.bootstrapMarker()?.tenantId.equals(tenantId)).toBe(true);
    });

    test("rejects non-blob marker records", { tags: "p1" }, () => {
        const database = new MarkerRowTamperSqlite();
        const store = bootstrappedStore(database);
        database.tamper = (row) => ({ ...row, record: "not-bytes" });
        expect(() => store.bootstrapMarker()).toThrow(expect.objectContaining(corrupt));
    });
});

describe("SQLite Tenant control topology and lifecycle guards", () => {
    test("pins every record type to its own Tenant", { tags: "p0" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        expect(() =>
            store.transaction(() =>
                store.saveTenant(new Tenant(foreignTenantId, "organization", "active", Revision.initial()))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant record belongs to another Tenant"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putProject(
                    new Project(new ProjectId("alien-project"), foreignTenantId, "Alien", Revision.initial())
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Project belongs to another Tenant"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putWorkspace(
                    new Workspace(new WorkspaceId("alien-workspace"), foreignTenantId, undefined, Revision.initial())
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Workspace belongs to another Tenant"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putGuestTrust(
                    new GuestTrust(
                        new GuestTrustId("alien-trust"),
                        foreignTenantId,
                        tenantId,
                        { kind: "callback", endpoint: "https://home.example/verify" },
                        "active",
                        Revision.initial()
                    )
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Guest trust belongs to another Tenant"
            })
        );
    });

    test("requires an owned transaction for record writes", { tags: "p0" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
        const outside = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Tenant control records require an active owned transaction"
        });
        expect(() => store.saveTenant(plan.tenant)).toThrow(outside);
        expect(() => store.savePrincipal(plan.owner)).toThrow(outside);
        expect(() => store.putGrant(allowGrant("outside-grant"))).toThrow(outside);
        expect(store.grant(new GrantId("outside-grant"))).toBeUndefined();
    });

    test("enforces principal kind immutability and disabled terminality", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const id = new PrincipalId("lifecycle-principal");
        store.transaction((control) => control.putPrincipal(new Principal(id, "user", "active")));
        store.transaction((control) => control.putPrincipal(new Principal(id, "user", "active")));
        store.transaction((control) => control.putPrincipal(new Principal(id, "user", "disabled")));
        store.transaction((control) => control.putPrincipal(new Principal(id, "user", "disabled")));
        expect(() =>
            store.transaction((control) => control.putPrincipal(new Principal(id, "user", "active")))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Disabled Principals cannot be reactivated"
            })
        );
        expect(() =>
            store.transaction((control) => control.putPrincipal(new Principal(id, "service", "disabled")))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Principal kind is immutable"
            })
        );
        expect(store.principal(id)?.status).toBe("disabled");
        expect(store.principal(id)?.kind).toBe("user");
    });

    test("requires initial revisions and exact successors for Teams and Projects", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        expect(() =>
            store.transaction((control) =>
                control.putTeam(new Team(new TeamId("late-team"), tenantId, "Late", [], new Revision(1)))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "New Teams require revision zero"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putProject(new Project(new ProjectId("late-project"), tenantId, "Late", new Revision(1)))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "New Projects require revision zero"
            })
        );

        const team = new Team(new TeamId("steady-team"), tenantId, "Steady", [], Revision.initial());
        const project = new Project(new ProjectId("steady-project"), tenantId, "Steady", Revision.initial());
        store.transaction((control) => {
            control.putTeam(team);
            control.putProject(project);
        });
        expect(() =>
            store.transaction((control) =>
                control.putTeam(new Team(team.id, tenantId, "Skipped", [], new Revision(2)))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Team updates require the stored Tenant identity and next revision"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putProject(new Project(project.id, tenantId, "Skipped", new Revision(2)))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Project updates require the next revision"
            })
        );
        expect(store.team(team.id)?.revision.value).toBe(0);
        expect(store.project(project.id)?.revision.value).toBe(0);
    });

    test("keeps Workspace topology immutable with exact diagnoses", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const workspace = new Workspace(new WorkspaceId("fixed-workspace"), tenantId, undefined, Revision.initial());
        store.transaction((control) => control.putWorkspace(workspace));
        expect(() => store.transaction((control) => control.putWorkspace(workspace))).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Workspace topology is immutable"
            })
        );
        expect(() =>
            store.transaction((control) =>
                control.putWorkspace(
                    new Workspace(
                        new WorkspaceId("orphan-workspace"),
                        tenantId,
                        new ProjectId("ghost-project"),
                        Revision.initial()
                    )
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Workspace requires revision zero and an existing Project"
            })
        );
        expect(store.workspace(new WorkspaceId("orphan-workspace"))).toBeUndefined();
    });

    test("creates and replays guest trust exactly", { tags: "p1" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const newTrustFault = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "New guest trust requires revision zero and active state"
        });
        const verifier = { kind: "callback", endpoint: "https://home.example/verify" } as const;
        const home = new TenantId("guest-home-tenant");
        expect(() =>
            store.transaction((control) =>
                control.putGuestTrust(
                    new GuestTrust(new GuestTrustId("late-trust"), tenantId, home, verifier, "active", new Revision(1))
                )
            )
        ).toThrow(newTrustFault);
        expect(() =>
            store.transaction((control) =>
                control.putGuestTrust(
                    new GuestTrust(new GuestTrustId("dead-trust"), tenantId, home, verifier, "revoked", Revision.initial())
                )
            )
        ).toThrow(newTrustFault);

        const trust = new GuestTrust(new GuestTrustId("steady-trust"), tenantId, home, verifier, "active", Revision.initial());
        store.transaction((control) => control.putGuestTrust(trust));
        store.transaction((control) => control.putGuestTrust(trust));
        expect(store.guestTrust(trust.id)?.revision.value).toBe(0);
        store.transaction((control) =>
            control.putGuestTrust(trust.rotate({ kind: "callback", endpoint: "https://home.example/v2" }))
        );
        expect(store.guestTrust(trust.id)?.revision.value).toBe(1);
    });

    test("enforces the Membership lifecycle exactly", { tags: "p0" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const hollow = new Role(new RoleName("hollow-role"), []);
        const member = new Principal(new PrincipalId("member-principal"), "user", "active");
        const project = new Project(new ProjectId("scope-project"), tenantId, "Scoped", Revision.initial());
        const membership = new Membership(
            new MembershipId("steady-membership"),
            tenantScope,
            SubjectRef.principal(member.id),
            hollow.name,
            "active",
            Revision.initial()
        );
        store.transaction((control) => {
            control.putRole(hollow);
            control.putPrincipal(member);
            control.putProject(project);
            control.putMembership(membership);
        });

        const revised = (
            state: "active" | "suspended" | "revoked",
            revision: number,
            subject = membership.subject,
            scope = membership.scope
        ) => new Membership(membership.id, scope, subject, hollow.name, state, new Revision(revision));

        expect(() =>
            store.transaction((control) =>
                control.putMembership(
                    new Membership(
                        new MembershipId("late-membership"),
                        tenantScope,
                        SubjectRef.principal(member.id),
                        hollow.name,
                        "active",
                        new Revision(1)
                    )
                )
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "New Memberships must be active at revision zero"
            })
        );

        const immutable = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Membership subject and Scope are immutable"
        });
        expect(() =>
            store.transaction((control) =>
                control.putMembership(revised("active", 1, SubjectRef.principal(principalId)))
            )
        ).toThrow(immutable);
        expect(() =>
            store.transaction((control) =>
                control.putMembership(
                    revised("active", 1, membership.subject, ScopeRef.project(tenantId, project.id))
                )
            )
        ).toThrow(immutable);

        expect(() =>
            store.transaction((control) => control.putMembership(revised("active", 2)))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Membership updates require the next stored revision"
            })
        );

        store.transaction((control) => control.putMembership(revised("suspended", 1)));
        expect(() =>
            store.transaction((control) => control.putMembership(revised("active", 2)))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Suspended Memberships require replacement rather than reactivation"
            })
        );

        store.transaction((control) => control.putMembership(revised("revoked", 2)));
        store.transaction((control) => control.putMembership(revised("revoked", 3)));
        expect(() =>
            store.transaction((control) => control.putMembership(revised("active", 4)))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Revoked Memberships cannot reactivate"
            })
        );
        expect(store.membership(membership.id)?.state).toBe("revoked");
        expect(store.membership(membership.id)?.revision.value).toBe(3);
    });
});

describe("SQLite Tenant control canonical Scope enforcement", () => {
    test("requires canonical authority Scopes for Grants and epochs", { tags: "p0" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const project = new Project(new ProjectId("scoped-project"), tenantId, "Scoped", Revision.initial());
        const workspace = new Workspace(new WorkspaceId("scoped-workspace"), tenantId, project.id, Revision.initial());
        store.transaction((control) => {
            control.putProject(project);
            control.putWorkspace(workspace);
        });

        expect(() =>
            store.transaction((control) =>
                control.putGrant(allowGrant("foreign-scope-grant", ScopeRef.tenant(foreignTenantId)))
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Authority Scope belongs to another Tenant"
            })
        );

        const notCanonicalProject = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Authority Project Scope is not canonical"
        });
        expect(() =>
            store.transaction((control) =>
                control.putGrant(
                    allowGrant("ghost-project-grant", ScopeRef.project(tenantId, new ProjectId("ghost-project")))
                )
            )
        ).toThrow(notCanonicalProject);
        expect(() =>
            store.transaction((control) =>
                control.putEpoch(new ScopeEpoch(ScopeRef.project(tenantId, new ProjectId("ghost-project")), 1))
            )
        ).toThrow(notCanonicalProject);

        const notCanonicalWorkspace = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Authority Workspace Scope is not canonical"
        });
        expect(() =>
            store.transaction((control) =>
                control.putGrant(
                    allowGrant("ghost-workspace-grant", ScopeRef.workspace(tenantId, new WorkspaceId("ghost-workspace")))
                )
            )
        ).toThrow(notCanonicalWorkspace);
        expect(() =>
            store.transaction((control) =>
                control.putGrant(allowGrant("detached-workspace-grant", ScopeRef.workspace(tenantId, workspace.id)))
            )
        ).toThrow(notCanonicalWorkspace);

        store.transaction((control) => {
            control.putGrant(allowGrant("project-grant", ScopeRef.project(tenantId, project.id)));
            control.putGrant(allowGrant("workspace-grant", workspace.scope));
        });
        expect(store.grant(new GrantId("project-grant"))?.isLive).toBe(true);
        expect(store.grant(new GrantId("workspace-grant"))?.isLive).toBe(true);
        expect(store.grant(new GrantId("ghost-workspace-grant"))).toBeUndefined();
    });
});

describe("SQLite Tenant control closure integrity", () => {
    test("fails closed when relational rows reference ghosts", { tags: "p0" }, () => {
        const hollow = new Role(new RoleName("hollow-role"), []);

        const projectDatabase = new TestSqlite();
        bootstrappedStore(projectDatabase);
        const alienProject = new Project(new ProjectId("alien-project"), foreignTenantId, "Alien", Revision.initial());
        projectDatabase.run(
            "INSERT INTO tenant_projects (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)",
            [alienProject.id.value, foreignTenantId.value, 0, Project.encode(alienProject)]
        );
        expect(() => createSqliteTenantControlStore(projectDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );

        const teamDatabase = new TestSqlite();
        bootstrappedStore(teamDatabase);
        const alienTeam = new Team(new TeamId("alien-team"), foreignTenantId, "Alien", [], Revision.initial());
        teamDatabase.run(
            "INSERT INTO tenant_teams (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)",
            [alienTeam.id.value, foreignTenantId.value, 0, Team.encode(alienTeam)]
        );
        expect(() => createSqliteTenantControlStore(teamDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );

        const principalDatabase = new TestSqlite();
        bootstrappedStore(principalDatabase);
        insertRoleRow(principalDatabase, hollow);
        insertMembershipRow(
            principalDatabase,
            new Membership(
                new MembershipId("ghost-subject-membership"),
                tenantScope,
                SubjectRef.principal(new PrincipalId("ghost-principal")),
                hollow.name,
                "active",
                Revision.initial()
            )
        );
        expect(() => createSqliteTenantControlStore(principalDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );

        const teamSubjectDatabase = new TestSqlite();
        bootstrappedStore(teamSubjectDatabase);
        insertRoleRow(teamSubjectDatabase, hollow);
        insertMembershipRow(
            teamSubjectDatabase,
            new Membership(
                new MembershipId("ghost-team-membership"),
                tenantScope,
                SubjectRef.team(new TeamId("ghost-team")),
                hollow.name,
                "active",
                Revision.initial()
            )
        );
        expect(() => createSqliteTenantControlStore(teamSubjectDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );

        const workspaceDatabase = new TestSqlite();
        bootstrappedStore(workspaceDatabase);
        const orphan = new Workspace(
            new WorkspaceId("orphan-workspace"),
            tenantId,
            new ProjectId("ghost-project"),
            Revision.initial()
        );
        workspaceDatabase.run(
            "INSERT INTO tenant_workspaces (id, tenant_id, project_id, revision, record) VALUES (?, ?, ?, ?, ?)",
            [orphan.id.value, tenantId.value, "ghost-project", 0, Workspace.encode(orphan)]
        );
        expect(() => createSqliteTenantControlStore(workspaceDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );

        const trustDatabase = new TestSqlite();
        bootstrappedStore(trustDatabase);
        const alienTrust = new GuestTrust(
            new GuestTrustId("alien-trust"),
            foreignTenantId,
            tenantId,
            { kind: "callback", endpoint: "https://home.example/verify" },
            "active",
            Revision.initial()
        );
        trustDatabase.run(
            `INSERT INTO tenant_guest_trusts (
                id, host_tenant_id, home_tenant_id, verifier_kind, state, revision, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [alienTrust.id.value, foreignTenantId.value, tenantId.value, "callback", "active", 0, GuestTrust.encode(alienTrust)]
        );
        expect(() => createSqliteTenantControlStore(trustDatabase)).toThrow(
            expect.objectContaining(corrupt)
        );
    });

    test("surfaces foreign Membership Scopes as Scope ownership faults", { tags: "p0" }, () => {
        const database = new TestSqlite();
        bootstrappedStore(database);
        const hollow = new Role(new RoleName("hollow-role"), []);
        insertRoleRow(database, hollow);
        insertMembershipRow(
            database,
            new Membership(
                new MembershipId("foreign-scope-membership"),
                ScopeRef.tenant(foreignTenantId),
                SubjectRef.principal(principalId),
                hollow.name,
                "active",
                Revision.initial()
            )
        );
        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Authority Scope belongs to another Tenant"
            })
        );
    });

    test("fails closed on marker, Tenant, revision, epoch, and Role closure drift", { tags: "p0" }, () => {
        const failsClosed = (mutate: (database: TestSqlite) => void) => {
            const database = new TestSqlite();
            bootstrappedStore(database);
            mutate(database);
            expect(() => createSqliteTenantControlStore(database)).toThrow(
                expect.objectContaining(corrupt)
            );
        };

        failsClosed((database) => {
            database.run("UPDATE tenant_bootstrap_marker SET owner_principal_id = ?, record = ?", [
                "other-owner",
                markerRecord({ ownerPrincipalId: "other-owner", revision: 0, tenantId: tenantId.value })
            ]);
        });
        failsClosed((database) => {
            database.run("UPDATE tenant_bootstrap_marker SET tenant_id = ?, record = ?", [
                "other-tenant",
                markerRecord({ ownerPrincipalId: principalId.value, revision: 0, tenantId: "other-tenant" })
            ]);
        });
        failsClosed((database) => {
            const advanced = new Tenant(tenantId, "organization", "active", new Revision(1));
            database.run("UPDATE tenant_identities SET revision = 1, record = ? WHERE id = ?", [
                Tenant.encode(advanced),
                tenantId.value
            ]);
            database.run("UPDATE tenant_bootstrap_marker SET revision = 1, record = ?", [
                markerRecord({ ownerPrincipalId: principalId.value, revision: 1, tenantId: tenantId.value })
            ]);
        });
        failsClosed((database) => {
            const rekinded = new Tenant(tenantId, "service", "active", Revision.initial());
            database.run("UPDATE tenant_identities SET kind = 'service', record = ? WHERE id = ?", [
                Tenant.encode(rekinded),
                tenantId.value
            ]);
        });
        failsClosed((database) => {
            database.run("DELETE FROM tenant_scope_epochs", []);
        });
        failsClosed((database) => {
            database.run("DELETE FROM tenant_roles WHERE name = 'reader'", []);
        });
    });

    test("rejects Grants that break the closure inside the writing transaction", { tags: "p0" }, () => {
        const store = bootstrappedStore(new TestSqlite());
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
        const capability = new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] });
        const rejects = (id: string, grant: Grant) => {
            expect(() => store.transaction((control) => control.putGrant(grant))).toThrow(
                expect.objectContaining(corrupt)
            );
            expect(store.grant(new GrantId(id))).toBeUndefined();
        };

        rejects(
            "ghost-principal-grant",
            allowGrant("ghost-principal-grant", tenantScope, SubjectRef.principal(new PrincipalId("ghost-principal")))
        );
        rejects(
            "ghost-team-grant",
            allowGrant("ghost-team-grant", tenantScope, SubjectRef.team(new TeamId("ghost-team")))
        );

        const ghostOrigin: RoleGrantOrigin = {
            kind: "role",
            membershipId: new MembershipId("ghost-membership"),
            roleName: plan.ownerMembership.role.value,
            ruleOrdinal: 0,
            guest: false
        };
        rejects(
            "ghost-origin-grant",
            new Grant(
                new GrantId("ghost-origin-grant"),
                tenantScope,
                SubjectRef.principal(principalId),
                "allow",
                capability,
                ghostOrigin
            )
        );

        const surplusOrigin: RoleGrantOrigin = {
            kind: "role",
            membershipId: plan.ownerMembership.id,
            roleName: plan.ownerMembership.role.value,
            ruleOrdinal: 999,
            guest: false
        };
        rejects(
            "surplus-owner-grant",
            new Grant(
                new GrantId("surplus-owner-grant"),
                tenantScope,
                SubjectRef.principal(principalId),
                "allow",
                capability,
                surplusOrigin
            )
        );

        rejects(
            "self-attenuated-grant",
            new Grant(
                new GrantId("self-attenuated-grant"),
                tenantScope,
                SubjectRef.principal(principalId),
                "allow",
                capability,
                { kind: "direct" },
                new GrantId("self-attenuated-grant")
            )
        );
    });
});
