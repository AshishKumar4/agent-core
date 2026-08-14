import { ActorId } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import {
    Membership,
    MembershipId,
    MemoryIdentityRepository,
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
    type IdentityRecordKind,
    type MemoryIdentitySnapshot,
    type StoredIdentityRecord,
    type TenantKind
} from "../identity";
import { bytesEqual } from "./data";
import { Binding } from "./binding";
import {
    AuthorityChangeSet,
    assertAuthorityClosure,
    type AuthorityRecordPresence
} from "./closure";
import { ScopeEpoch } from "./epoch";
import { Grant } from "./grant";
import type { GrantId } from "./id";
import { scopeKey, subjectKey } from "./reference";
import {
    createTenantControlBootstrapPlan,
    type AuthorityMutationStore,
    type TenantControlBootstrapAnchor,
    type TenantControlBootstrapPlan
} from "./service";

export type { TenantControlBootstrapAnchor } from "./service";

/** Version 2 added Tenant-owned canonical Binding records; version 1 snapshots predate them. */
const SNAPSHOT_VERSION = 2 as const;
const IDENTITY_SNAPSHOT_VERSION = 1 as const;

export interface StoredTenantControlRecord {
    readonly id: string;
    readonly bytes: Uint8Array;
}

export interface MemoryTenantControlAnchorSnapshot {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly tenantKind: TenantKind;
    readonly trustAnchor: Uint8Array;
}

export interface MemoryTenantControlMarkerSnapshot {
    readonly tenantId: TenantId;
    readonly ownerPrincipalId: PrincipalId;
    readonly revision: number;
}

export interface MemoryTenantControlSnapshot {
    readonly version: 2;
    readonly anchor: MemoryTenantControlAnchorSnapshot;
    readonly marker: MemoryTenantControlMarkerSnapshot | null;
    readonly identity: MemoryIdentitySnapshot;
    readonly grants: readonly StoredTenantControlRecord[];
    readonly bindings: readonly StoredTenantControlRecord[];
    readonly epochs: readonly StoredTenantControlRecord[];
}

export interface TenantControlBootstrapMarker {
    readonly tenantId: TenantId;
    readonly ownerPrincipalId: PrincipalId;
    readonly revision: Revision;
}

type RecordMap = Map<string, Uint8Array>;

/** Actor-local reference store. It is intentionally absent from the authority package surface. */
export class MemoryTenantControlStore implements AuthorityMutationStore {
    #identity: Map<string, StoredIdentityRecord>;
    #grants: RecordMap;
    #bindings: RecordMap;
    #epochs: RecordMap;
    readonly #anchor: MemoryTenantControlAnchorSnapshot;
    readonly #changes = new AuthorityChangeSet();
    #marker: MemoryTenantControlMarkerSnapshot | null;
    #writable = false;
    #transactionActive = false;
    public readonly tenantId: TenantId;

    private constructor(snapshot: MemoryTenantControlSnapshot) {
        requireSnapshot(snapshot);
        this.#anchor = copyAnchorSnapshot(snapshot.anchor);
        this.tenantId = this.#anchor.tenantId;
        this.#marker = snapshot.marker === null ? null : copyMarkerSnapshot(snapshot.marker);
        const identity = new MemoryIdentityRepository(snapshot.identity).snapshot();
        this.#identity = new Map(
            identity.records.map((record) => [
                identityKey(record.kind, record.id),
                copyIdentityRecord(record)
            ])
        );
        this.#grants = loadRecords(
            snapshot.grants,
            Grant.decode,
            (record) => record.id.value,
            "Grant"
        );
        this.#bindings = loadRecords(
            snapshot.bindings,
            Binding.decode,
            (record) => record.key,
            "Binding"
        );
        this.#epochs = loadRecords(
            snapshot.epochs,
            ScopeEpoch.decode,
            (record) => scopeKey(record.scope),
            "Scope epoch"
        );
        this.assertRestoredState();
    }

    public static create(anchor: TenantControlBootstrapAnchor): MemoryTenantControlStore {
        return new MemoryTenantControlStore(
            Object.freeze({
                version: SNAPSHOT_VERSION,
                anchor: anchorSnapshot(anchor),
                marker: null,
                identity: Object.freeze({
                    version: IDENTITY_SNAPSHOT_VERSION,
                    records: Object.freeze([])
                }),
                grants: Object.freeze([]),
                bindings: Object.freeze([]),
                epochs: Object.freeze([])
            })
        );
    }

    public static restore(snapshot: MemoryTenantControlSnapshot): MemoryTenantControlStore {
        return new MemoryTenantControlStore(snapshot);
    }

    public bootstrapAnchor(): TenantControlBootstrapAnchor {
        return Object.freeze({
            actorId: this.#anchor.actorId,
            tenantId: this.#anchor.tenantId,
            principalId: this.#anchor.principalId,
            tenantKind: this.#anchor.tenantKind,
            trustAnchor: this.#anchor.trustAnchor.slice()
        });
    }

    public bootstrapMarker(): TenantControlBootstrapMarker | undefined {
        if (this.#marker === null) return undefined;
        return Object.freeze({
            tenantId: this.#marker.tenantId,
            ownerPrincipalId: this.#marker.ownerPrincipalId,
            revision: new Revision(this.#marker.revision)
        });
    }

    public isBootstrapEligible(): boolean {
        return (
            this.#marker === null &&
            this.#identity.size === 0 &&
            this.#grants.size === 0 &&
            this.#bindings.size === 0 &&
            this.#epochs.size === 0
        );
    }

    public bootstrap(plan: TenantControlBootstrapPlan): void {
        if (!this.isBootstrapEligible()) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant control is not bootstrap eligible"
            );
        }
        this.commit((candidate) => candidate.applyBootstrap(plan));
    }

    public bootstrapTenant(anchor: TenantControlBootstrapAnchor, expectedRevision: Revision): void {
        if (!anchorsEqual(this.bootstrapAnchor(), anchor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap request does not match its immutable anchor"
            );
        }
        this.bootstrap(createTenantControlBootstrapPlan(anchor, expectedRevision));
    }

    public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
        if (this.#marker === null) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant authority mutations require completed bootstrap"
            );
        }
        return this.commit(operation);
    }

    public snapshot(): MemoryTenantControlSnapshot {
        return Object.freeze({
            version: SNAPSHOT_VERSION,
            anchor: copyAnchorSnapshot(this.#anchor),
            marker: this.#marker === null ? null : copyMarkerSnapshot(this.#marker),
            identity: this.identitySnapshot(),
            grants: snapshotRecords(this.#grants),
            bindings: snapshotRecords(this.#bindings),
            epochs: snapshotRecords(this.#epochs)
        });
    }

    public identitySnapshot(): MemoryIdentitySnapshot {
        return Object.freeze({
            version: IDENTITY_SNAPSHOT_VERSION,
            records: Object.freeze(
                [...this.#identity.values()]
                    .sort((left, right) =>
                        identityKey(left.kind, left.id).localeCompare(
                            identityKey(right.kind, right.id)
                        )
                    )
                    .map(copyIdentityRecord)
            )
        });
    }

    public tenant(id: TenantId): Tenant | undefined {
        return this.identityRecord("tenant", id.value, Tenant.decode);
    }

    public principal(id: PrincipalId): Principal | undefined {
        return this.identityRecord("principal", id.value, Principal.decode);
    }

    public team(id: TeamId): Team | undefined {
        return this.identityRecord("team", id.value, Team.decode);
    }

    public teams(): readonly Team[] {
        return this.identityRecords("team", Team.decode);
    }

    public project(id: ProjectId): Project | undefined {
        return this.identityRecord("project", id.value, Project.decode);
    }

    public projects(): readonly Project[] {
        return this.identityRecords("project", Project.decode);
    }

    public putProject(project: Project): void {
        this.requireWrite();
        if (!project.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError("protocol.invalid-state", "Project belongs to another Tenant");
        }
        const previous = this.project(project.id);
        if (previous === undefined) {
            if (project.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Projects require revision zero"
                );
            }
        } else if (project.revision.value !== previous.revision.value + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Project updates require the next revision"
            );
        }
        this.putIdentity("project", project.id.value, Project.encode(project));
        this.#changes.projects.record(project.id.value, project, presence(previous));
    }

    public workspace(id: WorkspaceId): Workspace | undefined {
        return this.identityRecord("workspace", id.value, Workspace.decode);
    }

    public workspaces(): readonly Workspace[] {
        return this.identityRecords("workspace", Workspace.decode);
    }

    public putWorkspace(workspace: Workspace): void {
        this.requireWrite();
        if (!workspace.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Workspace belongs to another Tenant"
            );
        }
        const previous = this.workspace(workspace.id);
        if (previous !== undefined) {
            throw new AgentCoreError("protocol.invalid-state", "Workspace topology is immutable");
        }
        if (workspace.revision.value !== 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "New Workspaces require revision zero"
            );
        }
        this.putIdentity("workspace", workspace.id.value, Workspace.encode(workspace));
        this.#changes.workspaces.record(workspace.id.value, workspace, "created");
    }

    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.identityRecord("guestTrust", id.value, GuestTrust.decode);
    }

    public guestTrusts(): readonly GuestTrust[] {
        return this.identityRecords("guestTrust", GuestTrust.decode);
    }

    public putGuestTrust(trust: GuestTrust): void {
        this.requireWrite();
        if (!trust.hostTenant.equals(this.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Guest trust belongs to another Tenant"
            );
        }
        const previous = this.guestTrust(trust.id);
        if (previous === undefined) {
            if (trust.revision.value !== 0 || !trust.isActive) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New guest trust requires revision zero and active state"
                );
            }
        } else if (
            !previous.hostTenant.equals(trust.hostTenant) ||
            !previous.homeTenant.equals(trust.homeTenant)
        ) {
            throw new AgentCoreError("protocol.revision-conflict", "Guest trust identity changed");
        } else {
            if (bytesEqual(GuestTrust.encode(previous), GuestTrust.encode(trust))) return;
            previous.assertCanReplace(trust);
        }
        this.putIdentity("guestTrust", trust.id.value, GuestTrust.encode(trust));
        this.#changes.guestTrusts.record(trust.id.value, trust, presence(previous));
    }

    public role(name: RoleName): Role | undefined {
        return this.identityRecord("role", name.value, Role.decode);
    }

    public roles(): readonly Role[] {
        return this.identityRecords("role", Role.decode);
    }

    public membership(id: MembershipId): Membership | undefined {
        return this.identityRecord("membership", id.value, Membership.decode);
    }

    public memberships(): readonly Membership[] {
        return this.identityRecords("membership", Membership.decode);
    }

    public grant(id: GrantId): Grant | undefined {
        return decodeRecord(
            this.#grants,
            id.value,
            Grant.decode,
            (record) => record.id.value,
            "Grant"
        );
    }

    public grants(): readonly Grant[] {
        return decodeRecords(this.#grants, Grant.decode, (record) => record.id.value, "Grant");
    }

    public binding(key: string): Binding | undefined {
        return decodeRecord(this.#bindings, key, Binding.decode, (record) => record.key, "Binding");
    }

    public bindings(): readonly Binding[] {
        return decodeRecords(this.#bindings, Binding.decode, (record) => record.key, "Binding");
    }

    public epoch(scope: ScopeEpoch["scope"]): ScopeEpoch {
        return (
            decodeRecord(
                this.#epochs,
                scopeKey(scope),
                ScopeEpoch.decode,
                (record) => scopeKey(record.scope),
                "Scope epoch"
            ) ?? ScopeEpoch.initial(scope)
        );
    }

    public epochs(): readonly ScopeEpoch[] {
        return decodeRecords(
            this.#epochs,
            ScopeEpoch.decode,
            (record) => scopeKey(record.scope),
            "Scope epoch"
        );
    }

    public putPrincipal(principal: Principal): void {
        this.requireWrite();
        const previous = this.principal(principal.id);
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
        this.putIdentity("principal", principal.id.value, Principal.encode(principal));
    }

    public putTeam(team: Team): void {
        this.requireWrite();
        if (!team.tenantId.equals(this.tenantId)) {
            throw new AgentCoreError("protocol.invalid-state", "Team belongs to another Tenant");
        }
        const previous = this.team(team.id);
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
        this.putIdentity("team", team.id.value, Team.encode(team));
        this.#changes.teams.record(team.id.value, team, presence(previous));
    }

    public putRole(role: Role): void {
        this.requireWrite();
        const previous = this.role(role.name);
        this.putIdentity("role", role.name.value, Role.encode(role));
        this.#changes.roles.record(role.name.value, role, presence(previous));
    }

    public putMembership(membership: Membership): void {
        this.requireWrite();
        requireCanonicalScope(this, membership.scope);
        const previous = this.membership(membership.id);
        if (previous === undefined) {
            if (membership.revision.value !== 0 || membership.state !== "active") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Memberships must be active at revision zero"
                );
            }
        } else if (
            !previous.scope.equals(membership.scope) ||
            subjectKey(previous.subject) !== subjectKey(membership.subject) ||
            membership.revision.value !== previous.revision.value + 1
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Membership subject and Scope are immutable and updates require the next revision"
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
        this.putIdentity("membership", membership.id.value, Membership.encode(membership));
        this.#changes.memberships.record(membership.id.value, membership, presence(previous));
    }

    public putGrant(record: Grant): void {
        this.requireWrite();
        requireCanonicalScope(this, record.scope);
        const previous = this.grant(record.id);
        if (previous !== undefined) {
            if (bytesEqual(Grant.encode(previous), Grant.encode(record))) return;
            previous.assertCanReplace(record);
        }
        putCanonical(
            this.#grants,
            record.id.value,
            Grant.encode(record),
            Grant.decode,
            (value) => value.id.value,
            "Grant"
        );
        this.#changes.grants.record(record.id.value, record, presence(previous));
    }

    public putBinding(record: Binding): void {
        this.requireWrite();
        requireCanonicalScope(this, record.scope);
        const previous = this.binding(record.key);
        if (previous === undefined) {
            if (record.generation !== 0 || record.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "New Bindings require generation and revision zero"
                );
            }
        } else {
            if (bytesEqual(Binding.encode(previous), Binding.encode(record))) return;
            previous.assertCanReplace(record);
        }
        putCanonical(
            this.#bindings,
            record.key,
            Binding.encode(record),
            Binding.decode,
            (value) => value.key,
            "Binding"
        );
        this.#changes.bindings.record(record.key, record, presence(previous));
    }

    public putEpoch(record: ScopeEpoch): void {
        this.requireWrite();
        requireCanonicalScope(this, record.scope);
        const key = scopeKey(record.scope);
        const previous = this.epoch(record.scope);
        if (record.epoch === previous.epoch) return;
        if (record.epoch !== previous.epoch + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Scope epoch writes must advance exactly once"
            );
        }
        putCanonical(
            this.#epochs,
            key,
            ScopeEpoch.encode(record),
            ScopeEpoch.decode,
            (value) => scopeKey(value.scope),
            "Scope epoch"
        );
        this.#changes.epochs.record(key, record, "replaced");
    }

    private applyBootstrap(plan: TenantControlBootstrapPlan): void {
        const anchor = this.bootstrapAnchor();
        if (
            !plan.tenant.id.equals(anchor.tenantId) ||
            !plan.owner.id.equals(anchor.principalId) ||
            plan.tenant.kind !== anchor.tenantKind ||
            plan.tenant.authorizationRevision.value !== Revision.initial().value ||
            plan.ownerMembership.scope.kind !== "tenant" ||
            !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) ||
            plan.ownerMembership.subject.kind !== "principal" ||
            !plan.ownerMembership.subject.principal.principalId.equals(anchor.principalId) ||
            !plan.ownerMembership.isActive ||
            plan.ownerMembership.revision.value !== Revision.initial().value
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap plan does not match its immutable anchor"
            );
        }
        if (
            new Set(plan.roles.map((role) => role.name.value)).size !== plan.roles.length ||
            !plan.roles.some((role) => role.name.equals(plan.ownerMembership.role))
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap Roles are invalid"
            );
        }

        this.putIdentity("tenant", plan.tenant.id.value, Tenant.encode(plan.tenant));
        this.putPrincipal(plan.owner);
        for (const role of plan.roles) this.putRole(role);
        this.putMembership(plan.ownerMembership);
        for (const grant of plan.grants) this.putGrant(grant);
        for (const epoch of plan.epochs) this.putEpoch(epoch);
        this.#marker = Object.freeze({
            tenantId: anchor.tenantId,
            ownerPrincipalId: anchor.principalId,
            revision: plan.tenant.authorizationRevision.value
        });
    }

    private commit<Result>(operation: (store: MemoryTenantControlStore) => Result): Result {
        if (this.#transactionActive) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested Memory Tenant control transactions are not supported"
            );
        }
        this.#transactionActive = true;
        let candidate: MemoryTenantControlStore | undefined;
        try {
            candidate = MemoryTenantControlStore.restore(this.snapshot());
            candidate.#writable = true;
            const result = operation(candidate);
            if (isPromiseLike(result)) {
                if (result instanceof Promise) void result.catch(() => undefined);
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Memory Tenant control transactions must be synchronous"
                );
            }
            candidate.#writable = false;
            candidate.assertRestoredState(candidate.#changes);
            this.replace(candidate);
            return result;
        } finally {
            if (candidate !== undefined) candidate.#writable = false;
            this.#transactionActive = false;
        }
    }

    private identityRecord<Record>(
        kind: IdentityRecordKind,
        id: string,
        decode: (bytes: Uint8Array) => Record
    ): Record | undefined {
        const stored = this.#identity.get(identityKey(kind, id));
        return stored === undefined ? undefined : decode(stored.bytes.slice());
    }

    private identityRecords<Record>(
        kind: IdentityRecordKind,
        decode: (bytes: Uint8Array) => Record
    ): readonly Record[] {
        return Object.freeze(
            [...this.#identity.values()]
                .filter((record) => record.kind === kind)
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((record) => decode(record.bytes.slice()))
        );
    }

    private putIdentity(kind: IdentityRecordKind, id: string, bytes: Uint8Array): void {
        this.requireWrite();
        const record = copyIdentityRecord({ kind, id, bytes });
        new MemoryIdentityRepository({ version: IDENTITY_SNAPSHOT_VERSION, records: [record] });
        this.#identity.set(identityKey(kind, id), record);
    }

    private requireWrite(): void {
        if (!this.#writable) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant control records can only change inside an owned transaction"
            );
        }
    }

    private assertRestoredState(changed?: AuthorityChangeSet): void {
        if (this.#marker === null) {
            if (!this.isBootstrapEligible()) {
                throw corruptMemoryTenantControl("Unmarked Tenant control snapshot is not empty");
            }
            return;
        }
        if (
            !this.#marker.tenantId.equals(this.#anchor.tenantId) ||
            !this.#marker.ownerPrincipalId.equals(this.#anchor.principalId) ||
            this.#marker.revision !== Revision.initial().value
        ) {
            throw corruptMemoryTenantControl("Tenant control marker does not match its anchor");
        }
        const tenant = this.tenant(this.tenantId);
        const owner = this.principal(this.#anchor.principalId);
        const bootstrap = createTenantControlBootstrapPlan(
            this.bootstrapAnchor(),
            Revision.initial()
        );
        if (
            tenant === undefined ||
            owner === undefined ||
            tenant.kind !== this.#anchor.tenantKind ||
            tenant.authorizationRevision.value < this.#marker.revision ||
            this.identityRecords("tenant", Tenant.decode).length !== 1 ||
            this.membership(bootstrap.ownerMembership.id) === undefined ||
            bootstrap.roles.some((role) => this.role(role.name) === undefined) ||
            bootstrap.grants.some((grant) => this.grant(grant.id) === undefined) ||
            this.epoch(bootstrap.epochs[0]!.scope).epoch < bootstrap.epochs[0]!.epoch
        ) {
            throw corruptMemoryTenantControl("Bootstrapped Tenant identity closure is incomplete");
        }
        assertAuthorityClosure(this, changed);
    }

    private replace(candidate: MemoryTenantControlStore): void {
        this.#identity = new Map(
            [...candidate.#identity].map(([key, record]) => [key, copyIdentityRecord(record)])
        );
        this.#grants = copyMap(candidate.#grants);
        this.#bindings = copyMap(candidate.#bindings);
        this.#epochs = copyMap(candidate.#epochs);
        this.#marker = candidate.#marker === null ? null : copyMarkerSnapshot(candidate.#marker);
    }
}

function requireSnapshot(snapshot: MemoryTenantControlSnapshot): void {
    if (!isSnapshotObject(snapshot)) {
        throw corruptMemoryTenantControl("Memory Tenant control snapshot is malformed");
    }
    if (snapshot.version !== SNAPSHOT_VERSION) {
        throw corruptMemoryTenantControl(
            `Memory Tenant control snapshots require version ${SNAPSHOT_VERSION}`
        );
    }
    if (
        !hasExactKeys(snapshot, [
            "anchor",
            "bindings",
            "epochs",
            "grants",
            "identity",
            "marker",
            "version"
        ]) ||
        !Array.isArray(snapshot.grants) ||
        !Array.isArray(snapshot.bindings) ||
        !Array.isArray(snapshot.epochs) ||
        (snapshot.marker !== null && !isSnapshotObject(snapshot.marker))
    ) {
        throw corruptMemoryTenantControl("Memory Tenant control snapshot is malformed");
    }
}

// Only the default Tenant kind separates a bootstrap anchor from the snapshot shape, so
// the validation and the detaching copy are copyAnchorSnapshot's — the one every restore
// already runs. Repeating them here left a second copy of the same guards that nothing
// could reach: whatever this admitted, the constructor immediately re-judged.
function anchorSnapshot(anchor: TenantControlBootstrapAnchor): MemoryTenantControlAnchorSnapshot {
    return copyAnchorSnapshot({
        actorId: anchor.actorId,
        tenantId: anchor.tenantId,
        principalId: anchor.principalId,
        tenantKind: anchor.tenantKind ?? "personal",
        trustAnchor: anchor.trustAnchor
    });
}

function copyAnchorSnapshot(
    anchor: MemoryTenantControlAnchorSnapshot
): MemoryTenantControlAnchorSnapshot {
    if (
        !isSnapshotObject(anchor) ||
        !hasExactKeys(anchor, [
            "actorId",
            "principalId",
            "tenantId",
            "tenantKind",
            "trustAnchor"
        ]) ||
        !(anchor.actorId instanceof ActorId) ||
        !(anchor.tenantId instanceof TenantId) ||
        !(anchor.principalId instanceof PrincipalId) ||
        !(anchor.trustAnchor instanceof Uint8Array) ||
        anchor.trustAnchor.byteLength === 0
    ) {
        throw corruptMemoryTenantControl("Memory Tenant control bootstrap anchor is malformed");
    }
    requireTenantKind(anchor.tenantKind);
    return Object.freeze({
        ...anchor,
        actorId: new ActorId(anchor.actorId.value),
        tenantId: new TenantId(anchor.tenantId.value),
        principalId: new PrincipalId(anchor.principalId.value),
        trustAnchor: anchor.trustAnchor.slice()
    });
}

function copyMarkerSnapshot(
    marker: MemoryTenantControlMarkerSnapshot
): MemoryTenantControlMarkerSnapshot {
    if (
        !isSnapshotObject(marker) ||
        !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) ||
        !(marker.tenantId instanceof TenantId) ||
        !(marker.ownerPrincipalId instanceof PrincipalId) ||
        !Number.isSafeInteger(marker.revision) ||
        marker.revision < 0
    ) {
        throw corruptMemoryTenantControl("Memory Tenant control bootstrap marker is malformed");
    }
    return Object.freeze({
        ...marker,
        tenantId: new TenantId(marker.tenantId.value),
        ownerPrincipalId: new PrincipalId(marker.ownerPrincipalId.value)
    });
}

function copyIdentityRecord(record: StoredIdentityRecord): StoredIdentityRecord {
    return Object.freeze({ kind: record.kind, id: record.id, bytes: record.bytes.slice() });
}

function loadRecords<Record>(
    records: readonly StoredTenantControlRecord[],
    decode: (bytes: Uint8Array) => Record,
    key: (record: Record) => string,
    name: string
): RecordMap {
    const map: RecordMap = new Map();
    for (const stored of records) {
        if (
            !isSnapshotObject(stored) ||
            !hasExactKeys(stored, ["bytes", "id"]) ||
            !isStoredRecordId(stored.id) ||
            stored.id.length === 0 ||
            !(stored.bytes instanceof Uint8Array)
        ) {
            throw corruptMemoryTenantControl(
                `Memory Tenant control ${name} snapshot record is malformed`
            );
        }
        if (map.has(stored.id)) {
            throw corruptMemoryTenantControl(
                `Memory Tenant control snapshot contains duplicate ${name} records`
            );
        }
        const bytes = stored.bytes.slice();
        const record = decode(bytes);
        if (key(record) !== stored.id) {
            throw corruptMemoryTenantControl(`${name} snapshot key does not match codec bytes`);
        }
        map.set(stored.id, bytes);
    }
    return map;
}

function snapshotRecords(map: RecordMap): readonly StoredTenantControlRecord[] {
    return Object.freeze(
        [...map.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, bytes]) => Object.freeze({ id, bytes: bytes.slice() }))
    );
}

function decodeRecord<Record>(
    map: RecordMap,
    id: string,
    decode: (bytes: Uint8Array) => Record,
    key: (record: Record) => string,
    name: string
): Record | undefined {
    const bytes = map.get(id);
    if (bytes === undefined) return undefined;
    const record = decode(bytes.slice());
    if (key(record) !== id) {
        throw corruptMemoryTenantControl(`${name} key does not match codec bytes`);
    }
    return record;
}

function decodeRecords<Record>(
    map: RecordMap,
    decode: (bytes: Uint8Array) => Record,
    key: (record: Record) => string,
    name: string
): readonly Record[] {
    return Object.freeze(
        [...map.keys()].sort().map((id) => decodeRecord(map, id, decode, key, name)!)
    );
}

function putCanonical<Record>(
    map: RecordMap,
    id: string,
    bytes: Uint8Array,
    decode: (bytes: Uint8Array) => Record,
    key: (record: Record) => string,
    name: string
): void {
    const record = decode(bytes);
    if (key(record) !== id) {
        throw corruptMemoryTenantControl(`${name} key does not match codec bytes`);
    }
    map.set(id, bytes.slice());
}

function identityKey(kind: IdentityRecordKind, id: string): string {
    return `${kind}\u0000${id}`;
}

function copyMap(map: RecordMap): RecordMap {
    return new Map([...map].map(([key, bytes]) => [key, bytes.slice()]));
}

function requireCanonicalScope(store: MemoryTenantControlStore, scope: ScopeEpoch["scope"]): void {
    requireLocalTenant(store.tenantId, scope.tenantId, "Authority Scope");
    if (
        scope.kind === "project" &&
        (scope.projectId === undefined || store.project(scope.projectId) === undefined)
    ) {
        throw corruptMemoryTenantControl("Authority Project Scope is not canonical");
    }
    if (scope.kind === "workspace") {
        const workspace =
            scope.workspaceId === undefined ? undefined : store.workspace(scope.workspaceId);
        if (workspace === undefined || !workspace.scope.equals(scope)) {
            throw corruptMemoryTenantControl("Authority Workspace Scope is not canonical");
        }
    }
}

function presence<Record>(previous: Record | undefined): AuthorityRecordPresence {
    return previous === undefined ? "created" : "replaced";
}

function requireLocalTenant(expected: TenantId, actual: TenantId, subject: string): void {
    if (!actual.equals(expected)) {
        throw new AgentCoreError("protocol.invalid-state", `${subject} belongs to another Tenant`);
    }
}

function anchorsEqual(
    left: TenantControlBootstrapAnchor,
    right: TenantControlBootstrapAnchor
): boolean {
    return (
        left.actorId.equals(right.actorId) &&
        left.tenantId.equals(right.tenantId) &&
        left.principalId.equals(right.principalId) &&
        (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") &&
        bytesEqual(left.trustAnchor, right.trustAnchor)
    );
}

function requireTenantKind(value: string): asserts value is TenantKind {
    if (value !== "personal" && value !== "organization" && value !== "service") {
        throw corruptMemoryTenantControl("Memory Tenant control bootstrap Tenant kind is invalid");
    }
}

function corruptMemoryTenantControl(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function hasExactKeys(
    value:
        | MemoryTenantControlSnapshot
        | MemoryTenantControlAnchorSnapshot
        | MemoryTenantControlMarkerSnapshot
        | StoredTenantControlRecord,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSnapshotObject(value: unknown): value is object {
    return value !== null && typeof value === "object";
}

function isStoredRecordId(value: unknown): value is string {
    return typeof value === "string";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? "then" in value
        : false;
}
