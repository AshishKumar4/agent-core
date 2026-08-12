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
import type { AuthorityMutationStore } from "../../src/authority/service";

/**
 * The diverged Grant records, plus the budget of Grant-table reads the store will answer.
 * A walk that does not terminate blocks the event loop, so no test timeout can catch it;
 * refusing the read is what turns non-termination into an observable failure. The budget
 * is loose — a two-Grant closure reads the table twice — so only a walk that has stopped
 * making progress can exhaust it.
 */
export class GrantDivergence {
    public reads = 0;
    public readonly budget = 64;
    public constructor(public readonly records: Map<string, Grant>) {}

    public spend(): void {
        this.reads += 1;
        if (this.reads > this.budget) {
            throw new Error(`Grant walk read the table more than ${this.budget} times`);
        }
    }
}

/**
 * A store that accepts every write and then answers a later read with something else. Grant
 * records the divergence names are served from it and written back to it; everything else
 * passes through to the store underneath, so the records the service does not diverge on
 * stay consistent and the transaction commits.
 */
export class DivergentGrantStore implements AuthorityMutationStore {
    public constructor(
        private readonly inner: AuthorityMutationStore,
        private readonly divergence: GrantDivergence
    ) {}

    public get tenantId(): TenantId {
        return this.inner.tenantId;
    }

    public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
        return this.inner.transaction((candidate) =>
            operation(new DivergentGrantStore(candidate, this.divergence))
        );
    }

    public grant(id: GrantId): Grant | undefined {
        return this.divergence.records.get(id.value) ?? this.inner.grant(id);
    }

    public grants(): readonly Grant[] {
        this.divergence.spend();
        return this.inner
            .grants()
            .map((grant) => this.divergence.records.get(grant.id.value) ?? grant);
    }

    public putGrant(grant: Grant): void {
        if (this.divergence.records.has(grant.id.value)) {
            this.divergence.records.set(grant.id.value, grant);
        } else {
            this.inner.putGrant(grant);
        }
    }

    public principal(id: PrincipalId): Principal | undefined {
        return this.inner.principal(id);
    }
    public putPrincipal(principal: Principal): void {
        this.inner.putPrincipal(principal);
    }
    public team(id: TeamId): Team | undefined {
        return this.inner.team(id);
    }
    public teams(): readonly Team[] {
        return this.inner.teams();
    }
    public putTeam(team: Team): void {
        this.inner.putTeam(team);
    }
    public project(id: ProjectId): Project | undefined {
        return this.inner.project(id);
    }
    public projects(): readonly Project[] {
        return this.inner.projects();
    }
    public putProject(project: Project): void {
        this.inner.putProject(project);
    }
    public workspace(id: WorkspaceId): Workspace | undefined {
        return this.inner.workspace(id);
    }
    public workspaces(): readonly Workspace[] {
        return this.inner.workspaces();
    }
    public putWorkspace(workspace: Workspace): void {
        this.inner.putWorkspace(workspace);
    }
    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.inner.guestTrust(id);
    }
    public guestTrusts(): readonly GuestTrust[] {
        return this.inner.guestTrusts();
    }
    public putGuestTrust(trust: GuestTrust): void {
        this.inner.putGuestTrust(trust);
    }
    public role(name: RoleName): Role | undefined {
        return this.inner.role(name);
    }
    public putRole(role: Role): void {
        this.inner.putRole(role);
    }
    public membership(id: MembershipId): Membership | undefined {
        return this.inner.membership(id);
    }
    public memberships(): readonly Membership[] {
        return this.inner.memberships();
    }
    public putMembership(membership: Membership): void {
        this.inner.putMembership(membership);
    }
    public binding(key: string): Binding | undefined {
        return this.inner.binding(key);
    }
    public bindings(): readonly Binding[] {
        return this.inner.bindings();
    }
    public putBinding(binding: Binding): void {
        this.inner.putBinding(binding);
    }
    public epochs(): readonly ScopeEpoch[] {
        return this.inner.epochs();
    }
    public epoch(scope: ScopeEpoch["scope"]): ScopeEpoch {
        return this.inner.epoch(scope);
    }
    public putEpoch(epoch: ScopeEpoch): void {
        this.inner.putEpoch(epoch);
    }
}
