import { describe, expect, test } from "vitest";
import { Revision } from "../../../src/core";
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
import { SqliteIdentityReader, type SqliteValue } from "../../../src/substrates/sqlite";
import {
    initializeSqliteIdentitySchema,
    sqliteScopeKey,
    sqliteSubjectKey
} from "../../../src/substrates/sqlite/identity";
import { TestSqlite } from "../../helpers/sqlite";

const tenantAId = new TenantId("tenant-a");
const tenantBId = new TenantId("tenant-b");
const principalId = new PrincipalId("principal-a");
const teamId = new TeamId("team-a");
const projectId = new ProjectId("project-a");
const workspaceId = new WorkspaceId("workspace-a");
const trustId = new GuestTrustId("trust-a");
const roleName = new RoleName("auditor");
const membershipId = new MembershipId("membership-a");
const tenantScope = ScopeRef.tenant(tenantAId);

const tenantA = new Tenant(tenantAId, "organization", "active", new Revision(3));
const principal = new Principal(principalId, "user", "active");
const team = new Team(teamId, tenantAId, "Team A", [principalId], new Revision(2));
const project = new Project(projectId, tenantAId, "Project A", new Revision(1));
const workspace = new Workspace(workspaceId, tenantAId, undefined, new Revision(0));
const trust = new GuestTrust(
    trustId,
    tenantAId,
    tenantBId,
    { kind: "callback", endpoint: "https://example.com/verify" },
    "active",
    new Revision(1)
);
const role = new Role(roleName, []);
const membership = new Membership(
    membershipId,
    tenantScope,
    SubjectRef.principal(principalId),
    roleName,
    "active",
    new Revision(4)
);

const corruptRecord = expect.objectContaining({
    code: "codec.invalid",
    message: "Stored Tenant identity state is malformed"
});

interface DriftCase {
    readonly title: string;
    readonly corrupt: (database: TestSqlite) => void;
    readonly load: (reader: SqliteIdentityReader) => unknown;
}

const driftCases: readonly DriftCase[] = [
    {
        title: "tenant status drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_identities SET status = 'suspended'", []),
        load: (reader) => reader.loadTenant(tenantAId)
    },
    {
        title: "tenant id drift",
        corrupt: (database) => database.run("UPDATE tenant_identities SET id = 'tenant-moved'", []),
        load: (reader) => reader.loadTenant(new TenantId("tenant-moved"))
    },
    {
        title: "team revision drift",
        corrupt: (database) => database.run("UPDATE tenant_teams SET revision = 7", []),
        load: (reader) => reader.loadTeam(teamId)
    },
    {
        title: "team id drift",
        corrupt: (database) => database.run("UPDATE tenant_teams SET id = 'team-moved'", []),
        load: (reader) => reader.loadTeam(new TeamId("team-moved"))
    },
    {
        title: "project revision drift",
        corrupt: (database) => database.run("UPDATE tenant_projects SET revision = 7", []),
        load: (reader) => reader.loadProject(projectId)
    },
    {
        title: "project id drift",
        corrupt: (database) => database.run("UPDATE tenant_projects SET id = 'project-moved'", []),
        load: (reader) => reader.loadProject(new ProjectId("project-moved"))
    },
    {
        title: "workspace id drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_workspaces SET id = 'workspace-moved'", []),
        load: (reader) => reader.loadWorkspace(new WorkspaceId("workspace-moved"))
    },
    {
        title: "workspace revision drift",
        corrupt: (database) => {
            database.run("DROP TABLE tenant_workspaces", []);
            database.run(
                `CREATE TABLE tenant_workspaces (id TEXT PRIMARY KEY, tenant_id TEXT,
                 project_id TEXT, revision INTEGER, record BLOB)`,
                []
            );
            database.run(
                `INSERT INTO tenant_workspaces (id, tenant_id, project_id, revision, record)
                 VALUES (?, ?, ?, ?, ?)`,
                [workspaceId.value, tenantAId.value, null, 1, Workspace.encode(workspace)]
            );
        },
        load: (reader) => reader.loadWorkspace(workspaceId)
    },
    {
        title: "guest trust host drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_guest_trusts SET host_tenant_id = 'tenant-c'", []),
        load: (reader) => reader.loadGuestTrust(trustId)
    },
    {
        title: "guest trust home drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_guest_trusts SET home_tenant_id = 'tenant-c'", []),
        load: (reader) => reader.loadGuestTrust(trustId)
    },
    {
        title: "guest trust verifier drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_guest_trusts SET verifier_kind = 'token'", []),
        load: (reader) => reader.loadGuestTrust(trustId)
    },
    {
        title: "guest trust revision drift",
        corrupt: (database) => database.run("UPDATE tenant_guest_trusts SET revision = 7", []),
        load: (reader) => reader.loadGuestTrust(trustId)
    },
    {
        title: "guest trust id drift",
        corrupt: (database) => database.run("UPDATE tenant_guest_trusts SET id = 'trust-moved'", []),
        load: (reader) => reader.loadGuestTrust(new GuestTrustId("trust-moved"))
    },
    {
        title: "role name drift",
        corrupt: (database) => database.run("UPDATE tenant_roles SET name = 'drifted-role'", []),
        load: (reader) => reader.loadRole(new RoleName("drifted-role"))
    },
    {
        title: "membership scope drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_memberships SET scope_key = 'drifted-scope'", []),
        load: (reader) => reader.loadMembership(membershipId)
    },
    {
        title: "membership subject drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_memberships SET subject_key = 'drifted-subject'", []),
        load: (reader) => reader.loadMembership(membershipId)
    },
    {
        title: "membership role drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_memberships SET role_name = 'drifted-role'", []),
        load: (reader) => reader.loadMembership(membershipId)
    },
    {
        title: "membership revision drift",
        corrupt: (database) => database.run("UPDATE tenant_memberships SET revision = 7", []),
        load: (reader) => reader.loadMembership(membershipId)
    },
    {
        title: "membership id drift",
        corrupt: (database) =>
            database.run("UPDATE tenant_memberships SET id = 'membership-moved'", []),
        load: (reader) => reader.loadMembership(new MembershipId("membership-moved"))
    }
];

describe("SQLite identity reader", () => {
    test("loads stored identity records with their exact persisted fields", { tags: "p1" }, () => {
        const reader = new SqliteIdentityReader(seededDatabase());

        const storedTenant = reader.loadTenant(tenantAId);
        expect(storedTenant?.kind).toBe("organization");
        expect(storedTenant?.status).toBe("active");
        expect(storedTenant?.authorizationRevision.value).toBe(3);
        const storedPrincipal = reader.loadPrincipal(principalId);
        expect(storedPrincipal?.kind).toBe("user");
        expect(storedPrincipal?.status).toBe("active");
        const storedTeam = reader.loadTeam(teamId);
        expect(storedTeam?.tenantId.value).toBe("tenant-a");
        expect(storedTeam?.revision.value).toBe(2);
        expect(storedTeam?.principals.map((member) => member.value)).toEqual(["principal-a"]);
        const storedProject = reader.loadProject(projectId);
        expect(storedProject?.tenantId.value).toBe("tenant-a");
        expect(storedProject?.revision.value).toBe(1);
        const storedWorkspace = reader.loadWorkspace(workspaceId);
        expect(storedWorkspace?.tenantId.value).toBe("tenant-a");
        expect(storedWorkspace?.projectId).toBeUndefined();
        expect(storedWorkspace?.revision.value).toBe(0);
        const storedTrust = reader.loadGuestTrust(trustId);
        expect(storedTrust?.hostTenant.value).toBe("tenant-a");
        expect(storedTrust?.homeTenant.value).toBe("tenant-b");
        expect(storedTrust?.verifier.kind).toBe("callback");
        expect(storedTrust?.state).toBe("active");
        expect(storedTrust?.revision.value).toBe(1);
        expect(reader.loadRole(roleName)?.name.value).toBe("auditor");
        const storedMembership = reader.loadMembership(membershipId);
        expect(storedMembership?.role.value).toBe("auditor");
        expect(storedMembership?.state).toBe("active");
        expect(storedMembership?.revision.value).toBe(4);
        expect(reader.teams().map((item) => item.id.value)).toEqual(["team-a"]);
        expect(reader.memberships().map((item) => item.id.value)).toEqual(["membership-a"]);
        expect(reader.guestTrusts().map((item) => item.id.value)).toEqual(["trust-a"]);
        expect(reader.loadTenant(new TenantId("tenant-missing"))).toBeUndefined();
    });

    test("rejects column drift against the decoded record in every table", { tags: "p0" }, () => {
        for (const item of driftCases) {
            const database = seededDatabase();
            item.corrupt(database);
            const reader = new SqliteIdentityReader(database);
            expect(() => item.load(reader), item.title).toThrow(corruptRecord);
        }
    });

    test("rejects non-byte record storage with the exact corruption error", { tags: "p1" }, () => {
        const database = new TestSqlite();
        initializeSqliteIdentitySchema(database);
        database.run("DROP TABLE tenant_identities", []);
        database.run(
            `CREATE TABLE tenant_identities (id TEXT PRIMARY KEY, kind TEXT,
             status TEXT, revision INTEGER, record BLOB)`,
            []
        );
        database.run(
            `INSERT INTO tenant_identities (id, kind, status, revision, record)
             VALUES ('tenant-a', 'organization', 'active', 3, 'not-bytes')`,
            []
        );

        expect(() => new SqliteIdentityReader(database).loadTenant(tenantAId)).toThrow(
            corruptRecord
        );
    });

    test("maps invalid projected identifiers to the corruption error", { tags: "p1" }, () => {
        const database = new TestSqlite();
        initializeSqliteIdentitySchema(database);
        database.run(
            "INSERT INTO tenant_teams (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)",
            ["t".repeat(257), tenantAId.value, 0, Uint8Array.of(1)]
        );

        expect(() => new SqliteIdentityReader(database).teams()).toThrow(corruptRecord);
    });

    test("wraps substrate read failures in the exact identity read error", { tags: "p1" }, () => {
        const reader = new SqliteIdentityReader(new TestSqlite());

        expect(() => reader.loadTenant(tenantAId)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Tenant identity read failed"
            })
        );
    });

    test("wraps identity schema write failures in the exact schema error", { tags: "p1" }, () => {
        expect(() => initializeSqliteIdentitySchema(new SchemaFaultSqlite())).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Tenant identity schema write failed"
            })
        );
    });
});

function seededDatabase(): TestSqlite {
    const database = new TestSqlite();
    initializeSqliteIdentitySchema(database);
    database.run(
        `INSERT INTO tenant_identities (id, kind, status, revision, record)
         VALUES (?, ?, ?, ?, ?)`,
        [
            tenantA.id.value,
            tenantA.kind,
            tenantA.status,
            tenantA.authorizationRevision.value,
            Tenant.encode(tenantA)
        ]
    );
    database.run("INSERT INTO tenant_principals (id, kind, status, record) VALUES (?, ?, ?, ?)", [
        principal.id.value,
        principal.kind,
        principal.status,
        Principal.encode(principal)
    ]);
    database.run("INSERT INTO tenant_teams (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)", [
        team.id.value,
        team.tenantId.value,
        team.revision.value,
        Team.encode(team)
    ]);
    database.run(
        "INSERT INTO tenant_projects (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)",
        [project.id.value, project.tenantId.value, project.revision.value, Project.encode(project)]
    );
    database.run(
        `INSERT INTO tenant_workspaces (id, tenant_id, project_id, revision, record)
         VALUES (?, ?, ?, ?, ?)`,
        [workspace.id.value, workspace.tenantId.value, null, 0, Workspace.encode(workspace)]
    );
    database.run(
        `INSERT INTO tenant_guest_trusts
         (id, host_tenant_id, home_tenant_id, verifier_kind, state, revision, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            trust.id.value,
            trust.hostTenant.value,
            trust.homeTenant.value,
            trust.verifier.kind,
            trust.state,
            trust.revision.value,
            GuestTrust.encode(trust)
        ]
    );
    database.run("INSERT INTO tenant_roles (name, record) VALUES (?, ?)", [
        role.name.value,
        Role.encode(role)
    ]);
    database.run(
        `INSERT INTO tenant_memberships
         (id, scope_key, subject_key, role_name, state, revision, record)
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
    return database;
}

class SchemaFaultSqlite extends TestSqlite {
    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (statement.includes("tenant_memberships_subject")) {
            throw new TypeError("injected identity schema fault");
        }
        super.run(statement, bindings);
    }
}
