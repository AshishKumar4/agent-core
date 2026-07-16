// @ts-nocheck
import {
    Grant,
    GrantId,
    ScopeEpoch,
    RoleGrantMaterializer,
    createTenantControlBootstrapPlan,
    type AuthorityMutationStore
} from "../../authority";
import type { SynchronousResultGuard } from "../../actors";
import { RecordCodec, Revision, type JsonValue } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    Membership,
    MembershipId,
    GuestTrust,
    GuestTrustId,
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
    type ScopeRef
} from "../../identity";
import { TenantBootstrapAnchorRecord, type TenantBootstrapAnchor } from "../../protocol";
import {
    initializeSqliteAuthoritySchema,
    listSqliteEpochs,
    listSqliteGrants,
    loadSqliteEpoch,
    loadSqliteGrant,
    saveSqliteEpoch,
    saveSqliteGrant
} from "./authority";
import {
    SqliteIdentityReader,
    initializeSqliteIdentitySchema,
    sqliteScopeKey,
    sqliteSubjectKey
} from "./identity";
import type { SqliteRow, SqliteValue } from "./sqlite";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite";

class BootstrapMarkerCodec extends RecordCodec<TenantBootstrapMarker> {
    public constructor() {
        super("protocol.tenant-bootstrap-marker", { major: 1, minor: 0 });
    }

    protected encodePayload(marker: TenantBootstrapMarker): JsonValue {
        return {
            ownerPrincipalId: marker.ownerPrincipalId.value,
            revision: marker.revision.value,
            tenantId: marker.tenantId.value
        };
    }

    protected decodePayload(payload: JsonValue): TenantBootstrapMarker {
        if (
            payload === null ||
            Array.isArray(payload) ||
            typeof payload !== "object" ||
            Object.keys(payload).length !== 3
        ) {
            throw new TypeError("Tenant bootstrap marker payload is malformed");
        }
        const object = payload as { readonly [key: string]: JsonValue };
        if (
            typeof object["tenantId"] !== "string" ||
            typeof object["ownerPrincipalId"] !== "string" ||
            typeof object["revision"] !== "number"
        ) {
            throw new TypeError("Tenant bootstrap marker payload is malformed");
        }
        return new TenantBootstrapMarker(
            new TenantId(object["tenantId"]),
            new PrincipalId(object["ownerPrincipalId"]),
            new Revision(object["revision"])
        );
    }
}

class TenantBootstrapMarker {
    public static readonly codec: RecordCodec<TenantBootstrapMarker> = new BootstrapMarkerCodec();

    public constructor(
        public readonly tenantId: TenantId,
        public readonly ownerPrincipalId: PrincipalId,
        public readonly revision: Revision
    ) {
        Object.freeze(this);
    }

    public static encode(marker: TenantBootstrapMarker): Uint8Array {
        return TenantBootstrapMarker.codec.encode(marker);
    }

    public static decode(bytes: Uint8Array): TenantBootstrapMarker {
        return TenantBootstrapMarker.codec.decode(bytes);
    }
}

const CREATE_BOOTSTRAP_ANCHOR = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_anchor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor_id TEXT NOT NULL UNIQUE CHECK (length(actor_id) > 0),
    tenant_id TEXT NOT NULL UNIQUE CHECK (length(tenant_id) > 0),
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    tenant_kind TEXT NOT NULL CHECK (tenant_kind IN ('personal', 'organization', 'service')),
    trust_anchor BLOB NOT NULL CHECK (length(trust_anchor) > 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_BOOTSTRAP_MARKER = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_marker (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL UNIQUE CHECK (length(tenant_id) > 0),
    owner_principal_id TEXT NOT NULL CHECK (length(owner_principal_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

export class SqliteTenantControlStore
    extends SqliteIdentityReader
    implements AuthorityMutationStore
{
    public readonly tenantId: TenantId;
    #activeWrite: TransactionalSqlite | undefined;

    public constructor(
        private readonly database: TransactionalSqlite,
        anchor?: TenantBootstrapAnchor
    ) {
        super(database);
        try {
            database.transaction(() => {
                initializeSqliteIdentitySchema(database);
                initializeSqliteAuthoritySchema(database);
                database.run(CREATE_BOOTSTRAP_ANCHOR, []);
                database.run(CREATE_BOOTSTRAP_MARKER, []);
                if (anchor !== undefined) this.bindBootstrapAnchor(anchor);
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Tenant control schema initialization failed"
            );
        }
        const storedAnchor = this.bootstrapAnchor();
        if (storedAnchor === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant control storage requires an immutable Tenant bootstrap anchor"
            );
        }
        this.tenantId = storedAnchor.tenantId;
        if (this.bootstrapMarker() === undefined) {
            if (!this.isBootstrapEligible()) throw corruptTenantControl();
        } else {
            this.assertCompleteClosure();
        }
    }

    public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
        if (this.bootstrapMarker() === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant authority mutations require completed bootstrap"
            );
        }
        if (this.#activeWrite !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested SQLite Tenant control transactions are not supported"
            );
        }
        try {
            return this.database.transaction(
                () => {
                    this.#activeWrite = this.database;
                    try {
                        const result = operation(this);
                        this.assertCompleteClosure();
                        return result;
                    } finally {
                        this.#activeWrite = undefined;
                    }
                },
                ...([] as SynchronousResultGuard<Result>)
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError("protocol.revision-conflict", "Tenant control write failed");
        }
    }

    public bootstrapTenant(
        transaction: TransactionalSqlite,
        anchor: TenantBootstrapAnchor,
        expectedRevision: Revision
    ): void {
        if (transaction !== this.database) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap transaction belongs to another store"
            );
        }
        const storedAnchor = this.bootstrapAnchor();
        if (storedAnchor === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap anchor is missing"
            );
        }
        if (!anchorsEqual(storedAnchor, anchor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap request does not match its immutable anchor"
            );
        }
        if (!this.isBootstrapEligible()) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant control is not bootstrap eligible"
            );
        }
        if (this.#activeWrite !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested SQLite Tenant control transactions are not supported"
            );
        }
        try {
            this.#activeWrite = transaction;
            try {
                const plan = createTenantControlBootstrapPlan(anchor, expectedRevision);
                this.saveTenant(plan.tenant);
                this.savePrincipal(plan.owner);
                for (const role of plan.roles) this.saveRole(role);
                this.saveMembership(plan.ownerMembership);
                for (const grant of plan.grants) this.saveGrant(grant);
                for (const epoch of plan.epochs) this.saveEpoch(epoch);
                this.saveMarker(anchor);
                this.assertCompleteClosure();
            } finally {
                this.#activeWrite = undefined;
            }
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap write failed");
        }
    }

    public bootstrapAnchor(): TenantBootstrapAnchor | undefined {
        return loadBootstrapAnchor(this.database);
    }

    public bootstrapMarker(): TenantBootstrapMarker | undefined {
        const row = readTenant(
            this.database,
            "SELECT * FROM tenant_bootstrap_marker WHERE singleton = 1",
            []
        )[0];
        if (row === undefined) return undefined;
        const marker = TenantBootstrapMarker.decode(bytes(row, "record").slice());
        if (
            marker.tenantId.value !== text(row, "tenant_id") ||
            marker.ownerPrincipalId.value !== text(row, "owner_principal_id") ||
            marker.revision.value !== integer(row, "revision")
        ) {
            throw corruptTenantControl();
        }
        return marker;
    }

    public isBootstrapEligible(): boolean {
        return (
            this.bootstrapAnchor() !== undefined &&
            readTenant(
                this.database,
                `SELECT 1 AS present FROM tenant_bootstrap_marker
             UNION ALL SELECT 1 AS present FROM tenant_identities
             UNION ALL SELECT 1 AS present FROM tenant_principals
             UNION ALL SELECT 1 AS present FROM tenant_teams
             UNION ALL SELECT 1 AS present FROM tenant_projects
             UNION ALL SELECT 1 AS present FROM tenant_workspaces
             UNION ALL SELECT 1 AS present FROM tenant_guest_trusts
             UNION ALL SELECT 1 AS present FROM tenant_roles
             UNION ALL SELECT 1 AS present FROM tenant_memberships
             UNION ALL SELECT 1 AS present FROM tenant_grants
             UNION ALL SELECT 1 AS present FROM tenant_scope_epochs
             LIMIT 1`,
                []
            ).length === 0
        );
    }

    public principal(id: PrincipalId): Principal | undefined {
        return this.loadPrincipal(id);
    }

    public putPrincipal(principal: Principal): void {
        this.savePrincipal(principal);
    }

    public team(id: TeamId): Team | undefined {
        return this.loadTeam(id);
    }

    public project(id: import("../../identity").ProjectId): Project | undefined {
        return this.loadProject(id);
    }

    public putProject(project: Project): void {
        this.saveProject(project);
    }

    public workspace(id: WorkspaceId): Workspace | undefined {
        return this.loadWorkspace(id);
    }

    public putWorkspace(workspace: Workspace): void {
        this.saveWorkspace(workspace);
    }

    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.loadGuestTrust(id);
    }

    public guestTrusts(): readonly GuestTrust[] {
        return super.guestTrusts();
    }

    public putGuestTrust(trust: GuestTrust): void {
        this.saveGuestTrust(trust);
    }

    public putTeam(team: Team): void {
        this.saveTeam(team);
    }

    public role(name: RoleName): Role | undefined {
        return this.loadRole(name);
    }

    public putRole(role: Role): void {
        this.saveRole(role);
    }

    public membership(id: MembershipId): Membership | undefined {
        return this.loadMembership(id);
    }

    public putMembership(membership: Membership): void {
        this.saveMembership(membership);
    }

    public grant(id: GrantId): Grant | undefined {
        return loadSqliteGrant(this.database, id);
    }

    public grants(): readonly Grant[] {
        return listSqliteGrants(this.database);
    }

    public putGrant(grant: Grant): void {
        requireCanonicalScope(this, grant.scope);
        saveSqliteGrant(this.writeDatabase(), grant);
    }

    public epochs(): readonly ScopeEpoch[] {
        return listSqliteEpochs(this.database);
    }

    public epoch(scope: ScopeRef): ScopeEpoch {
        return loadSqliteEpoch(this.database, scope);
    }

    public putEpoch(epoch: ScopeEpoch): void {
        requireCanonicalScope(this, epoch.scope);
        saveSqliteEpoch(this.writeDatabase(), epoch);
    }

    public saveTenant(tenant: Tenant): void {
        if (!tenant.id.equals(this.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant record belongs to another Tenant"
            );
        }
        this.writeDatabase().run(
            `INSERT INTO tenant_identities (id, kind, status, revision, record)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status,
                revision = excluded.revision, record = excluded.record`,
            [
                tenant.id.value,
                tenant.kind,
                tenant.status,
                tenant.authorizationRevision.value,
                Tenant.encode(tenant)
            ]
        );
        requireSaved(this.loadTenant(tenant.id), tenant, Tenant.encode);
    }

    public savePrincipal(principal: Principal): void {
        const database = this.writeDatabase();
        const previous = this.loadPrincipal(principal.id);
        if (previous !== undefined) {
            if (previous.kind !== principal.kind) {
                throw new AgentCoreError("protocol.invalid-state", "Principal kind is immutable");
            }
            if (previous.status === "disabled" && principal.status !== "disabled") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Disabled Principals cannot be reactivated"
                );
            }
        }
        database.run(
            `INSERT INTO tenant_principals (id, kind, status, record) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind, status = excluded.status, record = excluded.record`,
            [principal.id.value, principal.kind, principal.status, Principal.encode(principal)]
        );
        requireSaved(this.loadPrincipal(principal.id), principal, Principal.encode);
    }

    public saveTeam(team: Team): void {
        if (!team.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError("protocol.invalid-state", "Team belongs to another Tenant");
        }
        const database = this.writeDatabase();
        const previous = this.loadTeam(team.id);
        if (previous === undefined) {
            if (team.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Teams require revision zero"
                );
            }
        } else if (
            !previous.tenantId.equals(team.tenantId) ||
            team.revision.value !== previous.revision.value + 1
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Team updates require the stored Tenant identity and next revision"
            );
        }
        database.run(
            `INSERT INTO tenant_teams (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id,
                revision = excluded.revision, record = excluded.record`,
            [team.id.value, team.tenantId.value, team.revision.value, Team.encode(team)]
        );
        requireSaved(this.loadTeam(team.id), team, Team.encode);
    }

    public saveProject(project: Project): void {
        if (!project.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError("protocol.invalid-state", "Project belongs to another Tenant");
        }
        const previous = this.loadProject(project.id);
        if (previous === undefined) {
            if (project.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Projects require revision zero"
                );
            }
            this.writeDatabase().run(
                "INSERT INTO tenant_projects (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)",
                [
                    project.id.value,
                    project.tenantId.value,
                    project.revision.value,
                    Project.encode(project)
                ]
            );
        } else {
            if (project.revision.value !== previous.revision.value + 1) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "Project updates require the next revision"
                );
            }
            this.writeDatabase().run(
                `UPDATE tenant_projects SET revision = ?, record = ?
                 WHERE id = ? AND tenant_id = ? AND revision = ?`,
                [
                    project.revision.value,
                    Project.encode(project),
                    project.id.value,
                    project.tenantId.value,
                    previous.revision.value
                ]
            );
        }
        requireSaved(this.loadProject(project.id), project, Project.encode);
    }

    public saveWorkspace(workspace: Workspace): void {
        if (!workspace.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Workspace belongs to another Tenant"
            );
        }
        if (this.loadWorkspace(workspace.id) !== undefined) {
            throw new AgentCoreError("protocol.invalid-state", "Workspace topology is immutable");
        }
        if (
            workspace.revision.value !== 0 ||
            (workspace.projectId !== undefined &&
                this.loadProject(workspace.projectId) === undefined)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Workspace requires revision zero and an existing Project"
            );
        }
        this.writeDatabase().run(
            `INSERT INTO tenant_workspaces (id, tenant_id, project_id, revision, record)
             VALUES (?, ?, ?, ?, ?)`,
            [
                workspace.id.value,
                workspace.tenantId.value,
                workspace.projectId?.value ?? null,
                workspace.revision.value,
                Workspace.encode(workspace)
            ]
        );
        requireSaved(this.loadWorkspace(workspace.id), workspace, Workspace.encode);
    }

    public saveGuestTrust(trust: GuestTrust): void {
        if (!trust.hostTenant.equals(this.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Guest trust belongs to another Tenant"
            );
        }
        const previous = this.loadGuestTrust(trust.id);
        if (previous === undefined) {
            if (trust.revision.value !== 0 || !trust.isActive) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New guest trust requires revision zero and active state"
                );
            }
            this.writeDatabase().run(
                `INSERT INTO tenant_guest_trusts (
                    id, host_tenant_id, home_tenant_id, verifier_kind, state, revision, record
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        } else {
            if (equalBytes(GuestTrust.encode(previous), GuestTrust.encode(trust))) return;
            previous.assertCanReplace(trust);
            this.writeDatabase().run(
                `UPDATE tenant_guest_trusts SET verifier_kind = ?, state = ?, revision = ?, record = ?
                 WHERE id = ? AND revision = ?`,
                [
                    trust.verifier.kind,
                    trust.state,
                    trust.revision.value,
                    GuestTrust.encode(trust),
                    trust.id.value,
                    previous.revision.value
                ]
            );
        }
        requireSaved(this.loadGuestTrust(trust.id), trust, GuestTrust.encode);
    }

    public saveRole(role: Role): void {
        this.writeDatabase().run(
            `INSERT INTO tenant_roles (name, record) VALUES (?, ?)
             ON CONFLICT(name) DO UPDATE SET record = excluded.record`,
            [role.name.value, Role.encode(role)]
        );
        requireSaved(this.loadRole(role.name), role, Role.encode);
    }

    public saveMembership(membership: Membership): void {
        requireCanonicalScope(this, membership.scope);
        const database = this.writeDatabase();
        const previous = this.loadMembership(membership.id);
        if (previous === undefined) {
            if (membership.revision.value !== 0 || membership.state !== "active") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Memberships must be active at revision zero"
                );
            }
        } else if (
            sqliteScopeKey(previous.scope) !== sqliteScopeKey(membership.scope) ||
            sqliteSubjectKey(previous.subject) !== sqliteSubjectKey(membership.subject)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Membership subject and Scope are immutable"
            );
        } else if (membership.revision.value !== previous.revision.value + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Membership updates require the next stored revision"
            );
        } else if (previous.state === "revoked" && membership.state !== "revoked") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Revoked Memberships cannot reactivate"
            );
        } else if (previous.state === "suspended" && membership.state === "active") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Suspended Memberships require replacement rather than reactivation"
            );
        }
        database.run(
            `INSERT INTO tenant_memberships (
                id, scope_key, subject_key, role_name, state, revision, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key,
                subject_key = excluded.subject_key, role_name = excluded.role_name,
                state = excluded.state, revision = excluded.revision, record = excluded.record`,
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
        requireSaved(this.loadMembership(membership.id), membership, Membership.encode);
    }

    public saveGrant(grant: Grant): void {
        this.putGrant(grant);
    }

    public saveEpoch(epoch: ScopeEpoch): void {
        this.putEpoch(epoch);
    }

    private saveMarker(anchor: TenantBootstrapAnchor): void {
        const storedAnchor = this.bootstrapAnchor();
        const tenant = this.loadTenant(anchor.tenantId);
        if (storedAnchor === undefined || !anchorsEqual(storedAnchor, anchor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Bootstrap marker does not match its anchor"
            );
        }
        if (tenant === undefined) {
            throw new AgentCoreError("protocol.invalid-state", "Bootstrap Tenant is not stored");
        }
        this.saveBootstrapMarker(anchor.tenantId, anchor.principalId, tenant.authorizationRevision);
    }

    private saveBootstrapMarker(
        tenantId: TenantId,
        ownerPrincipalId: PrincipalId,
        revision: Revision
    ): void {
        const marker = new TenantBootstrapMarker(tenantId, ownerPrincipalId, revision);
        const anchor = this.bootstrapAnchor();
        if (
            anchor === undefined ||
            !anchor.tenantId.equals(marker.tenantId) ||
            !anchor.principalId.equals(marker.ownerPrincipalId)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Bootstrap marker does not match its anchor"
            );
        }
        this.writeDatabase().run(
            `INSERT INTO tenant_bootstrap_marker (
                singleton, tenant_id, owner_principal_id, revision, record
             ) VALUES (1, ?, ?, ?, ?)`,
            [
                marker.tenantId.value,
                marker.ownerPrincipalId.value,
                marker.revision.value,
                TenantBootstrapMarker.encode(marker)
            ]
        );
        this.bootstrapMarker();
    }

    private writeDatabase(): TransactionalSqlite {
        if (this.#activeWrite === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant control records require an active owned transaction"
            );
        }
        return this.#activeWrite;
    }

    private assertCompleteClosure(): void {
        try {
            this.assertCompleteClosureUnchecked();
        } catch (error) {
            if (error instanceof TypeError) throw corruptTenantControl();
            throw error;
        }
    }

    private assertCompleteClosureUnchecked(): void {
        const anchor = this.bootstrapAnchor();
        const marker = this.bootstrapMarker();
        const tenant = anchor === undefined ? undefined : this.loadTenant(anchor.tenantId);
        if (
            anchor === undefined ||
            marker === undefined ||
            !anchor.tenantId.equals(marker.tenantId) ||
            !anchor.principalId.equals(marker.ownerPrincipalId) ||
            marker.revision.value !== Revision.initial().value ||
            tenant === undefined ||
            tenant.kind !== anchor.tenantKind ||
            tenant.authorizationRevision.value < marker.revision.value ||
            this.loadPrincipal(anchor.principalId) === undefined
        ) {
            throw corruptTenantControl();
        }
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
        if (
            this.loadMembership(plan.ownerMembership.id) === undefined ||
            plan.roles.some((role) => this.loadRole(role.name) === undefined) ||
            plan.grants.some((grant) => this.grant(grant.id) === undefined) ||
            this.epoch(plan.epochs[0]!.scope).epoch < plan.epochs[0]!.epoch
        ) {
            throw corruptTenantControl();
        }
        this.assertRelationalClosure();
    }

    private assertRelationalClosure(): void {
        const tenantRows = readTenant(
            this.database,
            "SELECT id FROM tenant_identities ORDER BY id",
            []
        );
        if (tenantRows.length !== 1) throw corruptTenantControl();
        for (const row of tenantRows) {
            const tenant = this.loadTenant(new TenantId(text(row, "id")));
            if (tenant === undefined || !tenant.id.equals(this.tenantId)) {
                throw corruptTenantControl();
            }
        }
        for (const row of readTenant(
            this.database,
            "SELECT id FROM tenant_principals ORDER BY id",
            []
        )) {
            if (this.loadPrincipal(new PrincipalId(text(row, "id"))) === undefined) {
                throw corruptTenantControl();
            }
        }
        for (const row of readTenant(
            this.database,
            "SELECT name FROM tenant_roles ORDER BY name",
            []
        )) {
            if (this.loadRole(new RoleName(text(row, "name"))) === undefined) {
                throw corruptTenantControl();
            }
        }
        for (const row of readTenant(
            this.database,
            "SELECT id FROM tenant_projects ORDER BY id",
            []
        )) {
            const project = this.loadProject(new ProjectId(text(row, "id")));
            if (project === undefined || !project.tenantId.equals(this.tenantId)) {
                throw corruptTenantControl();
            }
        }
        for (const team of this.teams()) {
            if (!team.tenantId.equals(this.tenantId)) throw corruptTenantControl();
            for (const principal of team.principals) {
                if (this.loadPrincipal(principal) === undefined) throw corruptTenantControl();
            }
        }
        for (const membership of this.memberships()) {
            requireCanonicalScope(this, membership.scope);
            if (this.loadRole(membership.role) === undefined) throw corruptTenantControl();
            if (
                membership.subject.kind === "principal" &&
                this.loadPrincipal(membership.subject.principalId) === undefined
            ) {
                throw corruptTenantControl();
            }
            if (
                membership.subject.kind === "team" &&
                this.loadTeam(membership.subject.teamId) === undefined
            ) {
                throw corruptTenantControl();
            }
            if (membership.subject.kind === "foreign") {
                const verification = membership.guestVerification;
                const trust =
                    verification === undefined
                        ? undefined
                        : this.loadGuestTrust(verification.trustId);
                if (
                    verification === undefined ||
                    trust === undefined ||
                    !trust.hostTenant.equals(this.tenantId) ||
                    !trust.homeTenant.equals(membership.subject.homeTenant) ||
                    (membership.state === "active" &&
                        (trust.revision.value !== verification.trustRevision.value ||
                            trust.verifier.kind !== verification.method ||
                            !trust.isActive))
                ) {
                    throw corruptTenantControl();
                }
            }
        }
        for (const row of readTenant(
            this.database,
            "SELECT id FROM tenant_workspaces ORDER BY id",
            []
        )) {
            const workspace = this.loadWorkspace(new WorkspaceId(text(row, "id")));
            if (
                workspace === undefined ||
                !workspace.tenantId.equals(this.tenantId) ||
                (workspace.projectId !== undefined &&
                    this.loadProject(workspace.projectId) === undefined)
            ) {
                throw corruptTenantControl();
            }
        }
        for (const trust of this.guestTrusts()) {
            if (!trust.hostTenant.equals(this.tenantId)) throw corruptTenantControl();
        }
        const grants = this.grants();
        const grantsById = new Map(grants.map((grant) => [grant.id.value, grant]));
        for (const grant of grants) {
            requireCanonicalScope(this, grant.scope);
            if (
                grant.subject.kind === "principal" &&
                this.loadPrincipal(grant.subject.principalId) === undefined
            ) {
                throw corruptTenantControl();
            }
            if (
                grant.subject.kind === "team" &&
                this.loadTeam(grant.subject.teamId) === undefined
            ) {
                throw corruptTenantControl();
            }
            if (grant.origin.kind === "role") {
                const membership = this.loadMembership(grant.origin.membershipId);
                if (
                    membership === undefined ||
                    membership.role.value !== grant.origin.roleName ||
                    sqliteSubjectKey(membership.subject) !== sqliteSubjectKey(grant.subject)
                ) {
                    throw corruptTenantControl();
                }
            }
            const seen = new Set([grant.id.value]);
            let child = grant;
            while (child.attenuationOf !== undefined) {
                if (seen.has(child.attenuationOf.value)) throw corruptTenantControl();
                seen.add(child.attenuationOf.value);
                const parent = grantsById.get(child.attenuationOf.value);
                if (parent === undefined || !parent.canAttenuate(child)) {
                    throw corruptTenantControl();
                }
                child = parent;
            }
        }
        for (const membership of this.memberships()) {
            const role = this.loadRole(membership.role);
            if (role === undefined) throw corruptTenantControl();
            const owned = grants.filter(
                (grant) =>
                    grant.origin.kind === "role" && grant.origin.membershipId.equals(membership.id)
            );
            const expected = new RoleGrantMaterializer().materialize({
                membership,
                role,
                existing: owned
            }).desiredRecords;
            if (
                expected.length !== owned.length ||
                expected.some((record) => {
                    const actual = owned.find((candidate) => candidate.id.equals(record.id));
                    return (
                        actual === undefined ||
                        !equalBytes(Grant.encode(actual), Grant.encode(record))
                    );
                })
            ) {
                throw corruptTenantControl();
            }
        }
        for (const epoch of this.epochs()) requireCanonicalScope(this, epoch.scope);
    }

    private bindBootstrapAnchor(anchor: TenantBootstrapAnchor): void {
        const detached = new TenantBootstrapAnchorRecord(anchor);
        this.database.run(
            `INSERT OR IGNORE INTO tenant_bootstrap_anchor (
                singleton, actor_id, tenant_id, principal_id, tenant_kind, trust_anchor, record
             ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
            [
                detached.actorId.value,
                detached.tenantId.value,
                detached.principalId.value,
                detached.tenantKind,
                detached.trustAnchor,
                TenantBootstrapAnchorRecord.encode(detached)
            ]
        );
        const stored = this.bootstrapAnchor();
        if (stored === undefined || !anchorsEqual(stored, detached)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "The immutable Tenant bootstrap anchor is already bound differently"
            );
        }
    }
}

export function createSqliteTenantControlStore(
    database: TransactionalSqlite,
    anchor?: TenantBootstrapAnchor
): SqliteTenantControlStore {
    return new SqliteTenantControlStore(database, anchor);
}

function requireSaved<Record>(
    actual: Record | undefined,
    expected: Record,
    encode: (record: Record) => Uint8Array
): void {
    if (actual === undefined || !equalBytes(encode(actual), encode(expected))) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Tenant control record changed concurrently"
        );
    }
}

function loadBootstrapAnchor(database: ReadableSqlite): TenantBootstrapAnchor | undefined {
    const row = readTenant(
        database,
        `SELECT actor_id, tenant_id, principal_id, tenant_kind, trust_anchor, record
         FROM tenant_bootstrap_anchor WHERE singleton = 1`,
        []
    )[0];
    if (row === undefined) return undefined;
    const anchor = TenantBootstrapAnchorRecord.decode(bytes(row, "record").slice());
    if (
        anchor.actorId.value !== text(row, "actor_id") ||
        anchor.tenantId.value !== text(row, "tenant_id") ||
        anchor.principalId.value !== text(row, "principal_id") ||
        anchor.tenantKind !== text(row, "tenant_kind") ||
        !equalBytes(anchor.trustAnchor, bytes(row, "trust_anchor"))
    ) {
        throw corruptTenantControl();
    }
    return anchor;
}

function readTenant(
    database: ReadableSqlite,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    try {
        return database.all(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Tenant control read failed");
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corruptTenantControl();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptTenantControl();
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corruptTenantControl();
    return value;
}

function anchorsEqual(left: TenantBootstrapAnchor, right: TenantBootstrapAnchor): boolean {
    return (
        left.actorId.equals(right.actorId) &&
        left.tenantId.equals(right.tenantId) &&
        left.principalId.equals(right.principalId) &&
        (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") &&
        equalBytes(left.trustAnchor, right.trustAnchor)
    );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function requireCanonicalScope(store: SqliteTenantControlStore, scope: ScopeRef): void {
    if (!scope.tenantId.equals(store.tenantId)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority Scope belongs to another Tenant"
        );
    }
    if (
        scope.kind === "project" &&
        (scope.projectId === undefined || store.loadProject(scope.projectId) === undefined)
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority Project Scope is not canonical"
        );
    }
    if (scope.kind === "workspace") {
        const workspace =
            scope.workspaceId === undefined ? undefined : store.loadWorkspace(scope.workspaceId);
        if (workspace === undefined || !workspace.scope.equals(scope)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Authority Workspace Scope is not canonical"
            );
        }
    }
}

function corruptTenantControl(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored Tenant control state is malformed");
}
