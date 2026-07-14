import { encodeCanonicalJson, type JsonValue } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    Membership,
    MembershipId,
    GuestTrust,
    GuestTrustId,
    IdentityRepository,
    Principal,
    PrincipalId,
    Project,
    ProjectId,
    Role,
    RoleName,
    Team,
    TeamId,
    Tenant,
    TenantId,
    WorkspaceId,
    Workspace,
    encodeScopeRef,
    encodeSubjectRef
} from "../../identity";
import type { SqliteRow, SqliteValue } from "./sqlite";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite";

const CREATE_TENANTS = `CREATE TABLE IF NOT EXISTS tenant_identities (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'organization', 'service')),
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_PRINCIPALS = `CREATE TABLE IF NOT EXISTS tenant_principals (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('user', 'service', 'agent')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    record BLOB NOT NULL
) STRICT`;

const CREATE_TEAMS = `CREATE TABLE IF NOT EXISTS tenant_teams (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_PROJECTS = `CREATE TABLE IF NOT EXISTS tenant_projects (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_WORKSPACES = `CREATE TABLE IF NOT EXISTS tenant_workspaces (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    project_id TEXT CHECK (project_id IS NULL OR length(project_id) > 0),
    revision INTEGER NOT NULL CHECK (revision = 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_GUEST_TRUSTS = `CREATE TABLE IF NOT EXISTS tenant_guest_trusts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    host_tenant_id TEXT NOT NULL CHECK (length(host_tenant_id) > 0),
    home_tenant_id TEXT NOT NULL CHECK (length(home_tenant_id) > 0),
    verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('token', 'callback')),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    CHECK (host_tenant_id <> home_tenant_id)
) STRICT`;

const CREATE_ROLES = `CREATE TABLE IF NOT EXISTS tenant_roles (
    name TEXT PRIMARY KEY CHECK (length(name) > 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_MEMBERSHIPS = `CREATE TABLE IF NOT EXISTS tenant_memberships (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    role_name TEXT NOT NULL CHECK (length(role_name) > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_MEMBERSHIP_INDEX = `CREATE INDEX IF NOT EXISTS tenant_memberships_subject
    ON tenant_memberships (subject_key, scope_key, state)`;

export function initializeSqliteIdentitySchema(database: TransactionalSqlite): void {
    runIdentityWrite(database, CREATE_TENANTS);
    runIdentityWrite(database, CREATE_PRINCIPALS);
    runIdentityWrite(database, CREATE_TEAMS);
    runIdentityWrite(database, CREATE_PROJECTS);
    runIdentityWrite(database, CREATE_WORKSPACES);
    runIdentityWrite(database, CREATE_GUEST_TRUSTS);
    runIdentityWrite(database, CREATE_ROLES);
    runIdentityWrite(database, CREATE_MEMBERSHIPS);
    runIdentityWrite(database, CREATE_MEMBERSHIP_INDEX);
}

export class SqliteIdentityReader extends IdentityRepository {
    public constructor(protected readonly readDatabase: ReadableSqlite) {
        super();
    }

    public loadPrincipal(id: PrincipalId): Principal | undefined {
        const row = select(this.readDatabase, "tenant_principals", "id", id.value);
        if (row === undefined) return undefined;
        const principal = Principal.decode(bytes(row, "record").slice());
        if (
            !principal.id.equals(id) ||
            principal.id.value !== text(row, "id") ||
            principal.kind !== text(row, "kind") ||
            principal.status !== text(row, "status")
        ) {
            throw corruptIdentity();
        }
        return principal;
    }

    public loadTenant(id: TenantId): Tenant | undefined {
        const row = select(this.readDatabase, "tenant_identities", "id", id.value);
        if (row === undefined) return undefined;
        const tenant = Tenant.decode(bytes(row, "record").slice());
        if (
            !tenant.id.equals(id) ||
            tenant.id.value !== text(row, "id") ||
            tenant.kind !== text(row, "kind") ||
            tenant.status !== text(row, "status") ||
            tenant.authorizationRevision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return tenant;
    }

    public loadTeam(id: TeamId): Team | undefined {
        const row = select(this.readDatabase, "tenant_teams", "id", id.value);
        if (row === undefined) return undefined;
        const team = Team.decode(bytes(row, "record").slice());
        if (
            !team.id.equals(id) ||
            team.id.value !== text(row, "id") ||
            team.tenantId.value !== text(row, "tenant_id") ||
            team.revision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return team;
    }

    public loadProject(id: ProjectId): Project | undefined {
        const row = select(this.readDatabase, "tenant_projects", "id", id.value);
        if (row === undefined) return undefined;
        const project = Project.decode(bytes(row, "record").slice());
        if (
            !project.id.equals(id) ||
            project.id.value !== text(row, "id") ||
            project.tenantId.value !== text(row, "tenant_id") ||
            project.revision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return project;
    }

    public loadWorkspace(id: WorkspaceId): Workspace | undefined {
        const row = select(this.readDatabase, "tenant_workspaces", "id", id.value);
        if (row === undefined) return undefined;
        const workspace = Workspace.decode(bytes(row, "record").slice());
        if (
            !workspace.id.equals(id) ||
            workspace.id.value !== text(row, "id") ||
            workspace.tenantId.value !== text(row, "tenant_id") ||
            (workspace.projectId?.value ?? null) !== nullableText(row, "project_id") ||
            workspace.revision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return workspace;
    }

    public loadGuestTrust(id: GuestTrustId): GuestTrust | undefined {
        const row = select(this.readDatabase, "tenant_guest_trusts", "id", id.value);
        if (row === undefined) return undefined;
        const trust = GuestTrust.decode(bytes(row, "record").slice());
        if (
            !trust.id.equals(id) ||
            trust.id.value !== text(row, "id") ||
            trust.hostTenant.value !== text(row, "host_tenant_id") ||
            trust.homeTenant.value !== text(row, "home_tenant_id") ||
            trust.verifier.kind !== text(row, "verifier_kind") ||
            trust.state !== text(row, "state") ||
            trust.revision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return trust;
    }

    public loadRole(name: RoleName): Role | undefined {
        const row = select(this.readDatabase, "tenant_roles", "name", name.value);
        if (row === undefined) return undefined;
        const role = Role.decode(bytes(row, "record").slice());
        if (!role.name.equals(name) || role.name.value !== text(row, "name")) {
            throw corruptIdentity();
        }
        return role;
    }

    public loadMembership(id: MembershipId): Membership | undefined {
        const row = select(this.readDatabase, "tenant_memberships", "id", id.value);
        if (row === undefined) return undefined;
        const membership = Membership.decode(bytes(row, "record").slice());
        if (
            !membership.id.equals(id) ||
            membership.id.value !== text(row, "id") ||
            sqliteScopeKey(membership.scope) !== text(row, "scope_key") ||
            sqliteSubjectKey(membership.subject) !== text(row, "subject_key") ||
            membership.role.value !== text(row, "role_name") ||
            membership.state !== text(row, "state") ||
            membership.revision.value !== integer(row, "revision")
        ) {
            throw corruptIdentity();
        }
        return membership;
    }

    public teams(): readonly Team[] {
        return Object.freeze(
            readIdentity(this.readDatabase, "SELECT id FROM tenant_teams ORDER BY id", []).map(
                (row) => this.loadTeam(projectedId(TeamId, text(row, "id")))!
            )
        );
    }

    public memberships(): readonly Membership[] {
        return Object.freeze(
            readIdentity(
                this.readDatabase,
                "SELECT id FROM tenant_memberships ORDER BY id",
                []
            ).map((row) => this.loadMembership(projectedId(MembershipId, text(row, "id")))!)
        );
    }

    public guestTrusts(): readonly GuestTrust[] {
        return Object.freeze(
            readIdentity(
                this.readDatabase,
                "SELECT id FROM tenant_guest_trusts ORDER BY id",
                []
            ).map((row) => this.loadGuestTrust(projectedId(GuestTrustId, text(row, "id")))!)
        );
    }
}

export function sqliteScopeKey(scope: Membership["scope"]): string {
    return canonicalKey(encodeScopeRef(scope));
}

export function sqliteSubjectKey(subject: Membership["subject"]): string {
    return canonicalKey(encodeSubjectRef(subject));
}

function select(
    database: ReadableSqlite,
    table: string,
    keyColumn: string,
    key: string
): SqliteRow | undefined {
    return readIdentity(database, `SELECT * FROM ${table} WHERE ${keyColumn} = ?`, [key])[0];
}

function readIdentity(
    database: ReadableSqlite,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    try {
        return database.all(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Tenant identity read failed");
    }
}

function runIdentityWrite(database: TransactionalSqlite, statement: string): void {
    try {
        database.run(statement, []);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Tenant identity schema write failed"
        );
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corruptIdentity();
    return value;
}

function nullableText(row: SqliteRow, column: string): string | null {
    const value = row[column];
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0) throw corruptIdentity();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptIdentity();
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corruptIdentity();
    return value;
}

function canonicalKey(value: JsonValue): string {
    return new TextDecoder().decode(encodeCanonicalJson(value));
}

function projectedId<Id>(Constructor: new (value: string) => Id, value: string): Id {
    try {
        return new Constructor(value);
    } catch {
        throw corruptIdentity();
    }
}

function corruptIdentity(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored Tenant identity state is malformed");
}
