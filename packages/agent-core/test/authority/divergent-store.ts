import type {
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
    Team,
    TeamId,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../src/identity";
import type { Binding } from "../../src/authority/binding";
import type { ScopeEpoch } from "../../src/authority/epoch";
import type { Grant } from "../../src/authority/grant";
import type { GrantId } from "../../src/authority/id";
import { scopeKey } from "../../src/authority/reference";
import type { AuthorityMutationStore } from "../../src/authority/service";

/**
 * What one authority record table answers instead of what it holds, and how many list
 * reads it has served.
 *
 * Guards that re-read what the writers just wrote cannot be reached by varying the
 * writes: they screen the storage layer, not the logic, so the only thing that separates
 * them from their absence is a store that accepts every write and then answers a later
 * read with something else.
 *
 * The read budget is what turns a walk that stopped making progress into an observable
 * failure. A cyclic Grant graph makes a closure loop synchronously, and no test timeout
 * fires while the event loop is blocked. The budget is loose — a two-Grant closure reads
 * the table twice — so only a walk that is no longer progressing exhausts it.
 */
export class RecordDivergence<Record> {
    public reads = 0;
    public readonly budget = 64;
    public readonly records = new Map<string, Record | undefined>();

    /** Answers this key with `record`, whether or not the store underneath holds it. */
    public answer(key: string, record: Record): this {
        this.records.set(key, record);
        return this;
    }

    /** Answers this key as absent, whatever the store underneath holds. */
    public absent(key: string): this {
        this.records.set(key, undefined);
        return this;
    }

    public point(key: string, stored: Record | undefined): Record | undefined {
        return this.records.has(key) ? this.records.get(key) : stored;
    }

    public list(stored: readonly Record[], key: (record: Record) => string): readonly Record[] {
        this.reads += 1;
        if (this.reads > this.budget) {
            throw new Error(`Authority table read more than ${this.budget} times`);
        }
        const held = new Set(stored.map(key));
        return [
            ...stored.map((record) => this.point(key(record), record)),
            ...[...this.records]
                .filter(([id]) => !held.has(id))
                .map(([, record]) => record)
        ].filter((record): record is Record => record !== undefined);
    }

    /** Where a write lands: the divergence keeps the keys it already answers for. */
    public wrote(key: string, record: Record): boolean {
        if (!this.records.has(key)) return false;
        this.records.set(key, record);
        return true;
    }
}

/** One divergence per authority record table, all empty until a test says otherwise. */
export class AuthorityDivergence {
    public readonly teams = new RecordDivergence<Team>();
    public readonly projects = new RecordDivergence<Project>();
    public readonly workspaces = new RecordDivergence<Workspace>();
    public readonly guestTrusts = new RecordDivergence<GuestTrust>();
    public readonly roles = new RecordDivergence<Role>();
    public readonly memberships = new RecordDivergence<Membership>();
    public readonly grants = new RecordDivergence<Grant>();
    public readonly bindings = new RecordDivergence<Binding>();
    public readonly epochs = new RecordDivergence<ScopeEpoch>();
}

/**
 * A store that accepts every write and then answers a later read with something else.
 * Records the divergence names are served from it and written back to it; everything else
 * passes through to the store underneath, so the records it does not diverge on stay
 * consistent and the transaction commits.
 */
export class DivergentAuthorityStore implements AuthorityMutationStore {
    public constructor(
        private readonly inner: AuthorityMutationStore,
        private readonly divergence: AuthorityDivergence
    ) {}

    public get tenantId(): TenantId {
        return this.inner.tenantId;
    }

    public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
        return this.inner.transaction((candidate) =>
            operation(new DivergentAuthorityStore(candidate, this.divergence))
        );
    }

    public principal(id: PrincipalId): Principal | undefined {
        return this.inner.principal(id);
    }

    public putPrincipal(principal: Principal): void {
        this.inner.putPrincipal(principal);
    }

    public team(id: TeamId): Team | undefined {
        return this.divergence.teams.point(id.value, this.inner.team(id));
    }

    public teams(): readonly Team[] {
        return this.divergence.teams.list(this.inner.teams(), (team) => team.id.value);
    }

    public putTeam(team: Team): void {
        if (!this.divergence.teams.wrote(team.id.value, team)) this.inner.putTeam(team);
    }

    public project(id: ProjectId): Project | undefined {
        return this.divergence.projects.point(id.value, this.inner.project(id));
    }

    public projects(): readonly Project[] {
        return this.divergence.projects.list(
            this.inner.projects(),
            (project) => project.id.value
        );
    }

    public putProject(project: Project): void {
        if (!this.divergence.projects.wrote(project.id.value, project)) {
            this.inner.putProject(project);
        }
    }

    public workspace(id: WorkspaceId): Workspace | undefined {
        return this.divergence.workspaces.point(id.value, this.inner.workspace(id));
    }

    public workspaces(): readonly Workspace[] {
        return this.divergence.workspaces.list(
            this.inner.workspaces(),
            (workspace) => workspace.id.value
        );
    }

    public putWorkspace(workspace: Workspace): void {
        if (!this.divergence.workspaces.wrote(workspace.id.value, workspace)) {
            this.inner.putWorkspace(workspace);
        }
    }

    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.divergence.guestTrusts.point(id.value, this.inner.guestTrust(id));
    }

    public guestTrusts(): readonly GuestTrust[] {
        return this.divergence.guestTrusts.list(
            this.inner.guestTrusts(),
            (trust) => trust.id.value
        );
    }

    public putGuestTrust(trust: GuestTrust): void {
        if (!this.divergence.guestTrusts.wrote(trust.id.value, trust)) {
            this.inner.putGuestTrust(trust);
        }
    }

    public role(name: RoleName): Role | undefined {
        return this.divergence.roles.point(name.value, this.inner.role(name));
    }

    public putRole(role: Role): void {
        if (!this.divergence.roles.wrote(role.name.value, role)) this.inner.putRole(role);
    }

    public membership(id: MembershipId): Membership | undefined {
        return this.divergence.memberships.point(id.value, this.inner.membership(id));
    }

    public memberships(): readonly Membership[] {
        return this.divergence.memberships.list(
            this.inner.memberships(),
            (membership) => membership.id.value
        );
    }

    public putMembership(membership: Membership): void {
        if (!this.divergence.memberships.wrote(membership.id.value, membership)) {
            this.inner.putMembership(membership);
        }
    }

    public grant(id: GrantId): Grant | undefined {
        return this.divergence.grants.point(id.value, this.inner.grant(id));
    }

    public grants(): readonly Grant[] {
        return this.divergence.grants.list(this.inner.grants(), (grant) => grant.id.value);
    }

    public putGrant(grant: Grant): void {
        if (!this.divergence.grants.wrote(grant.id.value, grant)) this.inner.putGrant(grant);
    }

    public binding(key: string): Binding | undefined {
        return this.divergence.bindings.point(key, this.inner.binding(key));
    }

    public bindings(): readonly Binding[] {
        return this.divergence.bindings.list(this.inner.bindings(), (binding) => binding.key);
    }

    public putBinding(binding: Binding): void {
        if (!this.divergence.bindings.wrote(binding.key, binding)) this.inner.putBinding(binding);
    }

    public epoch(scope: ScopeEpoch["scope"]): ScopeEpoch {
        const stored = this.inner.epoch(scope);
        return this.divergence.epochs.point(scopeKey(scope), stored) ?? stored;
    }

    public epochs(): readonly ScopeEpoch[] {
        return this.divergence.epochs.list(this.inner.epochs(), (epoch) => scopeKey(epoch.scope));
    }

    public putEpoch(epoch: ScopeEpoch): void {
        if (!this.divergence.epochs.wrote(scopeKey(epoch.scope), epoch)) {
            this.inner.putEpoch(epoch);
        }
    }
}
