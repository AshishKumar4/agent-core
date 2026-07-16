// @ts-nocheck
import { ActorId } from "../actors";
import { Digest, Revision, encodeBase64, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import {
    Membership,
    MembershipId,
    GuestTrust,
    GuestTrustId,
    GuestVerification,
    BUILT_IN_ROLES,
    OWNER_ROLE,
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
    WorkspaceId,
    Workspace,
    type GuestTrustVerifier,
    type MembershipState,
    type TenantKind
} from "../identity";
import { ScopeEpoch } from "./epoch";
import { Grant } from "./grant";
import { GrantId } from "./id";
import { RoleGrantMaterializer } from "./materializer";
import { EpochPlanner, type ResolverInputMutation } from "./planner";
import { scopeKey, subjectKey } from "./reference";

export interface TenantControlBootstrapAnchor {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly trustAnchor: Uint8Array;
    readonly tenantKind?: TenantKind;
}

export interface TenantControlBootstrapPlan {
    readonly tenant: Tenant;
    readonly owner: Principal;
    readonly ownerMembership: Membership;
    readonly roles: typeof BUILT_IN_ROLES;
    readonly grants: readonly Grant[];
    readonly epochs: readonly ScopeEpoch[];
}

export function createTenantControlBootstrapPlan(
    anchor: TenantControlBootstrapAnchor,
    expectedRevision: Revision
): TenantControlBootstrapPlan {
    if (expectedRevision.value !== Revision.initial().value) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Tenant bootstrap requires the initial authorization revision"
        );
    }
    if (
        !(anchor.actorId instanceof ActorId) ||
        !(anchor.trustAnchor instanceof Uint8Array) ||
        anchor.trustAnchor.byteLength === 0
    ) {
        throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap anchor is malformed");
    }
    const tenantScope = ScopeRef.tenant(anchor.tenantId);
    const owner = new Principal(anchor.principalId, "user", "active");
    const tenant = new Tenant(
        anchor.tenantId,
        anchor.tenantKind ?? "personal",
        "active",
        expectedRevision
    );
    const ownerMembership = new Membership(
        deterministicOwnerMembershipId(anchor),
        tenantScope,
        SubjectRef.principal(anchor.principalId),
        OWNER_ROLE.name,
        "active",
        Revision.initial()
    );
    const materialization = new RoleGrantMaterializer().materialize({
        membership: ownerMembership,
        role: OWNER_ROLE,
        existing: []
    });
    const epochPlan = new EpochPlanner().plan(
        [],
        [
            {
                kind: "membership",
                affectedScopes: [tenantScope]
            }
        ]
    );
    return Object.freeze({
        tenant,
        owner,
        ownerMembership,
        roles: BUILT_IN_ROLES,
        grants: materialization.desiredRecords,
        epochs: epochPlan.bumped
    });
}

export interface AuthorityMutationStore {
    readonly tenantId: TenantId;
    transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result;

    principal(id: PrincipalId): Principal | undefined;
    putPrincipal(principal: Principal): void;
    team(id: TeamId): Team | undefined;
    teams(): readonly Team[];
    putTeam(team: Team): void;
    project(id: ProjectId): Project | undefined;
    putProject(project: Project): void;
    workspace(id: WorkspaceId): Workspace | undefined;
    putWorkspace(workspace: Workspace): void;
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    guestTrusts(): readonly GuestTrust[];
    putGuestTrust(trust: GuestTrust): void;
    role(name: RoleName): Role | undefined;
    putRole(role: Role): void;
    membership(id: MembershipId): Membership | undefined;
    memberships(): readonly Membership[];
    putMembership(membership: Membership): void;

    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    putGrant(grant: Grant): void;
    epochs(): readonly ScopeEpoch[];
    epoch(scope: ScopeEpoch["scope"]): ScopeEpoch;
    putEpoch(epoch: ScopeEpoch): void;
}

export interface MembershipChangeIntent {
    readonly role: RoleName;
    readonly state: Exclude<MembershipState, "revoked">;
}

/** @internal Couples all post-bootstrap resolver-input writes in one Tenant transaction. */
export class AuthorityMutationService {
    readonly #materializer = new RoleGrantMaterializer();
    readonly #planner = new EpochPlanner();

    public constructor(private readonly store: AuthorityMutationStore) {}

    public createPrincipal(principal: Principal): Principal {
        return this.store.transaction((store) => {
            requireAbsent(store.principal(principal.id), "Principal");
            store.putPrincipal(principal);
            return principal;
        });
    }

    public disablePrincipal(id: PrincipalId): Principal {
        return this.store.transaction((store) => {
            const principal = requireRecord(store.principal(id), "Principal");
            const disabled = principal.disable();
            if (disabled === principal) return principal;
            store.putPrincipal(disabled);
            this.bump(store, closureMutation("principalClosure", principalScopes(store, id)));
            return disabled;
        });
    }

    public createTeam(team: Team): Team {
        return this.store.transaction((store) => {
            requireAbsent(store.team(team.id), "Team");
            if (!team.tenantId.equals(store.tenantId)) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Team belongs to another Tenant"
                );
            }
            if (team.revision.value !== Revision.initial().value) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Teams require revision zero"
                );
            }
            requirePrincipals(store, team.principals);
            store.putTeam(team);
            return team;
        });
    }

    public changeTeam(id: TeamId, name: string, principals: readonly PrincipalId[]): Team {
        return this.store.transaction((store) => {
            const current = requireRecord(store.team(id), "Team");
            requirePrincipals(store, principals);
            const changed = current.revise(name, principals);
            store.putTeam(changed);
            this.bump(store, closureMutation("teamClosure", teamScopes(store, id)));
            return changed;
        });
    }

    public createWorkspace(workspace: Workspace): Workspace {
        return this.store.transaction((store) => {
            requireAbsent(store.workspace(workspace.id), "Workspace");
            if (!workspace.tenantId.equals(store.tenantId) || workspace.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Workspaces require the local Tenant and revision zero"
                );
            }
            if (workspace.projectId !== undefined) {
                requireRecord(store.project(workspace.projectId), "Workspace Project");
            }
            store.putWorkspace(workspace);
            this.bump(store, [{ kind: "topology", affectedScopes: [workspace.scope] }]);
            return workspace;
        });
    }

    public createProject(project: Project): Project {
        return this.store.transaction((store) => {
            requireAbsent(store.project(project.id), "Project");
            if (!project.tenantId.equals(store.tenantId) || project.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Projects require the local Tenant and revision zero"
                );
            }
            store.putProject(project);
            return project;
        });
    }

    public renameProject(id: ProjectId, name: string): Project {
        return this.store.transaction((store) => {
            const project = requireRecord(store.project(id), "Project").rename(name);
            store.putProject(project);
            return project;
        });
    }

    public createGuestTrust(trust: GuestTrust): GuestTrust {
        return this.store.transaction((store) => {
            requireAbsent(store.guestTrust(trust.id), "Guest trust");
            if (
                !trust.hostTenant.equals(store.tenantId) ||
                !trust.isActive ||
                trust.revision.value !== 0
            ) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New guest trust requires the local host Tenant, active state, and revision zero"
                );
            }
            store.putGuestTrust(trust);
            return trust;
        });
    }

    public rotateGuestTrust(id: GuestTrustId, verifier: GuestTrustVerifier): GuestTrust {
        return this.store.transaction((store) => {
            const trust = requireRecord(store.guestTrust(id), "Guest trust");
            const rotated = trust.rotate(verifier);
            store.putGuestTrust(rotated);
            this.revokeGuestMemberships(store, trust);
            return rotated;
        });
    }

    public revokeGuestTrust(id: GuestTrustId): GuestTrust {
        return this.store.transaction((store) => {
            const trust = requireRecord(store.guestTrust(id), "Guest trust");
            const revoked = trust.revoke();
            if (revoked === trust) return trust;
            store.putGuestTrust(revoked);
            this.revokeGuestMemberships(store, trust);
            return revoked;
        });
    }

    public createRole(role: Role): Role {
        return this.store.transaction((store) => {
            requireAbsent(store.role(role.name), "Role");
            store.putRole(role);
            return role;
        });
    }

    public changeRole(role: Role): Role {
        return this.store.transaction((store) => {
            const current = requireRecord(store.role(role.name), "Role");
            if (equalBytes(Role.encode(current), Role.encode(role))) return current;
            store.putRole(role);
            const affected = new Map<string, ScopeEpoch["scope"]>();
            for (const membership of store
                .memberships()
                .filter((entry) => entry.role.equals(role.name))) {
                for (const scope of this.reconcile(store, membership, role)) {
                    affected.set(scopeKey(scope), scope);
                }
            }
            this.bump(store, closureMutation("role", [...affected.values()]));
            return role;
        });
    }

    public assignMembership(membership: Membership): Membership {
        return this.store.transaction((store) => {
            requireAbsent(store.membership(membership.id), "Membership");
            if (membership.revision.value !== 0 || membership.state !== "active") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New Memberships must be active at revision zero"
                );
            }
            const role = requireRecord(store.role(membership.role), "Role");
            requireCanonicalScope(store, membership.scope);
            requireMembershipSubject(store, membership);
            if (membership.subject.kind === "foreign") {
                throw new AgentCoreError(
                    "authority.denied",
                    "Guest Memberships require verified provenance"
                );
            }
            const affected = this.reconcile(store, membership, role);
            store.putMembership(membership);
            this.bump(store, [
                { kind: "membership", affectedScopes: nonEmpty([membership.scope, ...affected]) }
            ]);
            return membership;
        });
    }

    public assignGuestMembership(
        membership: Membership,
        verification: GuestVerification,
        now: Date
    ): Membership {
        if (!verification.isHostMinted) {
            throw new AgentCoreError("authority.denied", "Guest verification was not host minted");
        }
        return this.store.transaction((store) => {
            requireAbsent(store.membership(membership.id), "Membership");
            if (
                membership.subject.kind !== "foreign" ||
                membership.revision.value !== 0 ||
                membership.state !== "active"
            ) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New guest Memberships require a foreign active subject at revision zero"
                );
            }
            const trust = requireRecord(store.guestTrust(verification.trustId), "Guest trust");
            if (
                !trust.isActive ||
                !trust.hostTenant.equals(store.tenantId) ||
                !trust.homeTenant.equals(membership.subject.homeTenant) ||
                trust.revision.value !== verification.trustRevision.value ||
                trust.verifier.kind !== verification.method ||
                !verification.admits(membership.subject, now)
            ) {
                throw new AgentCoreError(
                    "authority.denied",
                    "Guest verification is not currently valid"
                );
            }
            const role = requireRecord(store.role(membership.role), "Role");
            requireCanonicalScope(store, membership.scope);
            const verifiedMembership = membership.withGuestVerification(verification);
            const affected = this.reconcile(store, verifiedMembership, role);
            store.putMembership(verifiedMembership);
            this.bump(store, [
                { kind: "membership", affectedScopes: nonEmpty([membership.scope, ...affected]) }
            ]);
            return verifiedMembership;
        });
    }

    public changeMembership(id: MembershipId, intent: MembershipChangeIntent): Membership {
        return this.store.transaction((store) => {
            const current = requireRecord(store.membership(id), "Membership");
            const role = requireRecord(store.role(intent.role), "Role");
            const changed = current.revise(intent.role, intent.state);
            const affected = this.reconcile(store, changed, role);
            store.putMembership(changed);
            this.bump(store, [
                { kind: "membership", affectedScopes: nonEmpty([current.scope, ...affected]) }
            ]);
            return changed;
        });
    }

    public revokeMembership(id: MembershipId): Membership {
        return this.store.transaction((store) => {
            const current = requireRecord(store.membership(id), "Membership");
            if (current.state === "revoked") return current;
            const role = requireRecord(store.role(current.role), "Role");
            const revoked = current.revoke();
            const affected = this.reconcile(store, revoked, role);
            store.putMembership(revoked);
            this.bump(store, [
                { kind: "membership", affectedScopes: nonEmpty([current.scope, ...affected]) }
            ]);
            return revoked;
        });
    }

    public createGrant(grant: Grant): Grant {
        return this.store.transaction((store) => {
            requireAbsent(store.grant(grant.id), "Grant");
            if (grant.origin.kind !== "direct" || !grant.isLive) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Direct Grant creation requires a live direct-origin record"
                );
            }
            requireCanonicalScope(store, grant.scope);
            requireGrantSubject(store, grant);
            validateDelegation(store, grant);
            store.putGrant(grant);
            this.bump(store, [{ kind: "grant", scope: grant.scope }]);
            return grant;
        });
    }

    public revokeGrant(id: GrantId): Grant {
        return this.store.transaction((store) => {
            const current = requireRecord(store.grant(id), "Grant");
            if (!current.isLive) return current;
            const revoked = revokeGrantClosure(store, [current.id]);
            this.bump(
                store,
                revoked.map((grant) => ({ kind: "grant", scope: grant.scope }))
            );
            return requireRecord(store.grant(id), "Grant");
        });
    }

    private reconcile(
        store: AuthorityMutationStore,
        membership: Membership,
        role: Role
    ): readonly ScopeEpoch["scope"][] {
        const previous = new Map(store.grants().map((grant) => [grant.id.value, grant]));
        const materialization = this.#materializer.materialize({
            membership,
            role,
            existing: store.grants()
        });
        for (const grant of materialization.changedRecords) store.putGrant(grant);
        const replaced = materialization.changedRecords
            .filter((grant) => previous.has(grant.id.value))
            .map((grant) => grant.id);
        const descendants = revokeGrantClosure(
            store,
            replaced,
            new Set(replaced.map((id) => id.value))
        );
        return distinctScopes([
            ...materialization.affectedScopes,
            ...descendants.map((grant) => grant.scope)
        ]);
    }

    private revokeGuestMemberships(store: AuthorityMutationStore, trust: GuestTrust): void {
        const affected = new Map<string, ScopeRef>();
        for (const membership of store.memberships()) {
            if (
                membership.subject.kind !== "foreign" ||
                membership.guestVerification === undefined ||
                !membership.guestVerification.trustId.equals(trust.id) ||
                membership.state === "revoked"
            )
                continue;
            const role = requireRecord(store.role(membership.role), "Role");
            const revoked = membership.revoke();
            for (const scope of this.reconcile(store, revoked, role)) {
                affected.set(scopeKey(scope), scope);
            }
            store.putMembership(revoked);
            affected.set(scopeKey(membership.scope), membership.scope);
        }
        this.bump(store, closureMutation("guestVerification", [...affected.values()]));
    }

    private bump(
        store: AuthorityMutationStore,
        mutations: readonly ResolverInputMutation[]
    ): readonly ScopeEpoch[] {
        if (mutations.length === 0) return [];
        const plan = this.#planner.plan(store.epochs(), mutations);
        for (const epoch of plan.bumped) store.putEpoch(epoch);
        return plan.bumped;
    }
}

function validateDelegation(store: AuthorityMutationStore, grant: Grant): void {
    if (grant.attenuationOf === undefined) return;
    const parent = requireRecord(store.grant(grant.attenuationOf), "Parent Grant");
    if (!parent.canAttenuate(grant)) {
        throw new AgentCoreError("authority.denied", "Delegated Grant is not a live attenuation");
    }
}

function principalScopes(
    store: AuthorityMutationStore,
    principalId: PrincipalId
): readonly ScopeEpoch["scope"][] {
    const teamIds = new Set(
        store
            .teams()
            .filter((team) => team.has(principalId))
            .map((team) => team.id.value)
    );
    return distinctScopes(
        store
            .grants()
            .filter((grant) =>
                grant.subject.kind === "principal"
                    ? grant.subject.principalId.equals(principalId)
                    : grant.subject.kind === "team" && teamIds.has(grant.subject.teamId.value)
            )
            .map((grant) => grant.scope)
    );
}

function teamScopes(store: AuthorityMutationStore, teamId: TeamId): readonly ScopeEpoch["scope"][] {
    const key = subjectKey({ kind: "team", teamId });
    return distinctScopes([
        ...store
            .grants()
            .filter((grant) => subjectKey(grant.subject) === key)
            .map((grant) => grant.scope),
        ...store
            .memberships()
            .filter((membership) => subjectKey(membership.subject) === key)
            .map((membership) => membership.scope)
    ]);
}

function closureMutation(
    kind: "guestVerification" | "principalClosure" | "role" | "teamClosure",
    scopes: readonly ScopeEpoch["scope"][]
): readonly ResolverInputMutation[] {
    return scopes.length === 0 ? [] : [{ kind, affectedScopes: nonEmpty(scopes) }];
}

function distinctScopes(scopes: readonly ScopeEpoch["scope"][]): readonly ScopeEpoch["scope"][] {
    return [...new Map(scopes.map((scope) => [scopeKey(scope), scope])).values()];
}

function nonEmpty<Scopes extends ScopeEpoch["scope"]>(
    scopes: readonly Scopes[]
): readonly [Scopes, ...Scopes[]] {
    const distinct = distinctScopes(scopes) as readonly Scopes[];
    if (distinct.length === 0) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority mutations require an affected Scope"
        );
    }
    return distinct as readonly [Scopes, ...Scopes[]];
}

function requireRecord<Record>(record: Record | undefined, name: string): Record {
    if (record === undefined) {
        throw new AgentCoreError("protocol.invalid-state", `${name} does not exist`);
    }
    return record;
}

function requireAbsent(record: unknown | undefined, name: string): void {
    if (record !== undefined) {
        throw new AgentCoreError("protocol.invalid-state", `${name} already exists`);
    }
}

function requirePrincipals(
    store: AuthorityMutationStore,
    principals: readonly PrincipalId[]
): void {
    for (const principal of principals) requireRecord(store.principal(principal), "Principal");
}

function requireCanonicalScope(store: AuthorityMutationStore, scope: ScopeEpoch["scope"]): void {
    if (!scope.tenantId.equals(store.tenantId)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority Scope belongs to another Tenant"
        );
    }
    if (
        scope.kind === "project" &&
        (scope.projectId === undefined || store.project(scope.projectId) === undefined)
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority Project Scope is not canonical"
        );
    }
    if (scope.kind === "workspace") {
        const workspace =
            scope.workspaceId === undefined ? undefined : store.workspace(scope.workspaceId);
        if (workspace === undefined || !workspace.scope.equals(scope)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Authority Workspace Scope is not canonical"
            );
        }
    }
}

function requireMembershipSubject(store: AuthorityMutationStore, membership: Membership): void {
    if (membership.subject.kind === "principal") {
        requireRecord(store.principal(membership.subject.principalId), "Principal");
    } else if (membership.subject.kind === "team") {
        requireRecord(store.team(membership.subject.teamId), "Team");
    }
}

function requireGrantSubject(store: AuthorityMutationStore, grant: Grant): void {
    if (grant.subject.kind === "principal") {
        requireRecord(store.principal(grant.subject.principalId), "Principal");
    } else if (grant.subject.kind === "team") {
        requireRecord(store.team(grant.subject.teamId), "Team");
    } else {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Guest Grant verification is not implemented"
        );
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function deterministicOwnerMembershipId(anchor: TenantControlBootstrapAnchor): MembershipId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            actorId: anchor.actorId.value,
            principalId: anchor.principalId.value,
            tenantId: anchor.tenantId.value,
            trustAnchor: encodeBase64(anchor.trustAnchor)
        })
    );
    return new MembershipId(`bootstrap:${digest.value}`);
}

function revokeGrantClosure(
    store: AuthorityMutationStore,
    roots: readonly GrantId[],
    skip = new Set<string>()
): readonly Grant[] {
    const revoked: Grant[] = [];
    const pending = roots.map((id) => id.value);
    const visited = new Set<string>();
    while (pending.length > 0) {
        const parent = pending.pop()!;
        if (visited.has(parent)) continue;
        visited.add(parent);
        for (const grant of store
            .grants()
            .filter((candidate) => candidate.attenuationOf?.value === parent)) {
            pending.push(grant.id.value);
            if (!grant.isLive || skip.has(grant.id.value)) continue;
            const next = grant.revoke();
            store.putGrant(next);
            revoked.push(next);
        }
    }
    for (const id of roots) {
        if (skip.has(id.value)) continue;
        const grant = store.grant(id);
        if (grant?.isLive !== true) continue;
        const next = grant.revoke();
        store.putGrant(next);
        revoked.push(next);
    }
    return Object.freeze(revoked);
}
