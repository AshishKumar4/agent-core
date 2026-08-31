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
    PrincipalRef,
    Project,
    ProjectId,
    Role,
    RoleName,
    ScopeRef,
    ShareOffer,
    ShareOfferId,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    WorkspaceId,
    Workspace,
    type ForeignPrincipalRef,
    type GuestTrustVerifier,
    type MembershipState,
    type RoleImpact,
    type ShareOfferRedemptionOutcome,
    type ShareOfferRedemptionRequest,
    type TenantKind
} from "../identity";
import { bytesEqual } from "./data";
import { ScopeEpoch } from "./epoch";
import { Binding } from "./binding";
import { Grant } from "./grant";
import { GrantId } from "./id";
import { RoleGrantMaterializer } from "./materializer";
import { EpochPlanner, type ResolverInputMutation } from "./planner";
import { scopeKey, subjectKey } from "./reference";

/** SPEC §3.3: issuing a share offer is an `administer`-impact act at the offer's Scope. */
const ISSUANCE_IMPACT: RoleImpact = "administer";

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
        SubjectRef.principal(new PrincipalRef(anchor.tenantId, anchor.principalId)),
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

/** Everything a Tenant's authority records can be read through, and nothing more. */
export interface AuthorityReadStore {
    readonly tenantId: TenantId;

    principal(id: PrincipalId): Principal | undefined;
    team(id: TeamId): Team | undefined;
    teams(): readonly Team[];
    project(id: ProjectId): Project | undefined;
    projects(): readonly Project[];
    workspace(id: WorkspaceId): Workspace | undefined;
    workspaces(): readonly Workspace[];
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    guestTrusts(): readonly GuestTrust[];
    role(name: RoleName): Role | undefined;
    membership(id: MembershipId): Membership | undefined;
    memberships(): readonly Membership[];
    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    binding(key: string): Binding | undefined;
    bindings(): readonly Binding[];
    shareOffer(id: ShareOfferId): ShareOffer | undefined;
    shareOffers(): readonly ShareOffer[];
    epoch(scope: ScopeEpoch["scope"]): ScopeEpoch;
    epochs(): readonly ScopeEpoch[];
}

export interface AuthorityMutationStore extends AuthorityReadStore {
    transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result;

    putPrincipal(principal: Principal): void;
    putTeam(team: Team): void;
    putProject(project: Project): void;
    putWorkspace(workspace: Workspace): void;
    putGuestTrust(trust: GuestTrust): void;
    putRole(role: Role): void;
    putMembership(membership: Membership): void;
    putGrant(grant: Grant): void;
    putBinding(binding: Binding): void;
    putShareOffer(offer: ShareOffer): void;
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

    public changeRole(role: Role, now: Date): Role {
        return this.store.transaction((store) => {
            const current = requireRecord(store.role(role.name), "Role");
            if (bytesEqual(Role.encode(current), Role.encode(role))) return current;
            const members = store.memberships().filter((entry) => entry.role.equals(role.name));
            for (const membership of members) requireCurrentGuestVerification(membership, now);
            store.putRole(role);
            const affected = new Map<string, ScopeEpoch["scope"]>();
            for (const membership of members) {
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
            requireGuestVerificationEvidence(store, membership.subject, verification, now);
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

    public changeMembership(
        id: MembershipId,
        intent: MembershipChangeIntent,
        now: Date
    ): Membership {
        return this.store.transaction((store) => {
            const current = requireRecord(store.membership(id), "Membership");
            const role = requireRecord(store.role(intent.role), "Role");
            const changed = current.revise(intent.role, intent.state);
            requireCurrentGuestVerification(changed, now);
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

    public createBinding(binding: Binding): Binding {
        return this.store.transaction((store) => {
            requireAbsent(store.binding(binding.key), "Binding");
            requireBindingAuthority(store, binding);
            store.putBinding(binding);
            this.bump(store, [{ kind: "bindingTransition", affectedScopes: [binding.scope] }]);
            return binding;
        });
    }

    public replaceBinding(
        key: string,
        grantId: GrantId,
        facet: Binding["facet"],
        credentialCustody?: Binding["credentialCustody"]
    ): Binding {
        return this.store.transaction((store) => {
            const current = requireRecord(store.binding(key), "Binding");
            const replacement =
                credentialCustody === undefined
                    ? current.replace(grantId, facet)
                    : current.replace(grantId, facet, credentialCustody);
            requireBindingAuthority(store, replacement);
            store.putBinding(replacement);
            this.bump(store, [{ kind: "bindingTransition", affectedScopes: [replacement.scope] }]);
            return replacement;
        });
    }

    public deactivateBinding(key: string): Binding {
        return this.store.transaction((store) => {
            const current = requireRecord(store.binding(key), "Binding");
            const inactive = current.deactivate();
            if (inactive === current) return current;
            store.putBinding(inactive);
            this.bump(store, [{ kind: "bindingTransition", affectedScopes: [inactive.scope] }]);
            return inactive;
        });
    }

    /**
     * Issuing an offer is an `administer`-impact act at the offer's Scope, and the
     * Membership a redemption mints is bounded by what the issuer could have assigned
     * directly (§3.3). Nothing is materialized: an offer confers no Grant and resolves no
     * Binding, so no Scope epoch moves.
     */
    public issueShareOffer(offer: ShareOffer, issuer: SubjectRef): ShareOffer {
        return this.store.transaction((store) => {
            requireAbsent(store.shareOffer(offer.id), "Share offer");
            if (
                !offer.isOpen ||
                offer.redemptions.length !== 0 ||
                offer.revision.value !== Revision.initial().value
            ) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "New share offers must be open and unredeemed at revision zero"
                );
            }
            requireCanonicalScope(store, offer.scope);
            const role = requireRecord(store.role(offer.role), "Role");
            if (!offer.roleDigest.equals(roleContentDigest(role))) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Share offer Role content does not match the Role issued"
                );
            }
            requireShareOfferIssuanceAuthority(store, offer, role, issuer);
            store.putShareOffer(offer);
            return offer;
        });
    }

    /**
     * Revocation stops every not-yet-recorded redemption and never retracts a Membership a
     * recorded redemption already minted: only the offer record is written. An offer is not
     * a resolver input, so nothing here advances a Scope epoch — the Memberships it already
     * minted are revoked as Memberships, which is what advances their path epochs.
     */
    public revokeShareOffer(id: ShareOfferId): ShareOffer {
        return this.store.transaction((store) => {
            const current = requireRecord(store.shareOffer(id), "Share offer");
            const revoked = current.revoke();
            if (revoked.state === current.state) return current;
            store.putShareOffer(revoked);
            return revoked;
        });
    }

    /**
     * One transaction linearizes a redemption against the Grant plane and the path epochs:
     * the minted Membership, the redemption recorded on the offer, the reconciled Role
     * Grants, and every affected Scope epoch commit together or not at all. A replay writes
     * nothing, because a duplicate delivery of an already-committed redemption mints no
     * second Membership and consumes no second unit of the bound.
     */
    public redeemShareOffer(
        id: ShareOfferId,
        request: ShareOfferRedemptionRequest
    ): ShareOfferRedemptionOutcome {
        return this.store.transaction((store) => {
            const offer = requireRecord(store.shareOffer(id), "Share offer");
            let outcome: ShareOfferRedemptionOutcome;
            try {
                outcome = offer.redeem(request);
            } catch (error) {
                if (
                    isCrossTenantPrincipal(request.subject, store.tenantId) &&
                    error instanceof TypeError
                ) {
                    throw new AgentCoreError(
                        "authority.denied",
                        "Share offer redemption holder belongs to another Tenant"
                    );
                }
                throw error;
            }
            const minted = outcome.membership;
            if (minted === undefined) return outcome;
            requireAbsent(store.membership(minted.id), "Membership");
            const role = requireRecord(store.role(minted.role), "Role");
            if (!outcome.offer.roleDigest.equals(roleContentDigest(role))) {
                throw new AgentCoreError(
                    "authority.denied",
                    "Share offer Role changed after issuance"
                );
            }
            requireCanonicalScope(store, minted.scope);
            requireMembershipSubject(store, minted);
            requireRedeemedProvenance(store, minted, request.now);
            const affected = this.reconcile(store, minted, role);
            store.putMembership(minted);
            store.putShareOffer(outcome.offer);
            this.bump(store, [
                { kind: "membership", affectedScopes: nonEmpty([minted.scope, ...affected]) }
            ]);
            return outcome;
        });
    }

    private reconcile(
        store: AuthorityMutationStore,
        membership: Membership,
        role: Role
    ): readonly ScopeEpoch["scope"][] {
        const existing = store.grants();
        const previous = new Map(existing.map((grant) => [grant.id.value, grant]));
        const materialization = this.#materializer.materialize({ membership, role, existing });
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

    private bump(store: AuthorityMutationStore, mutations: readonly ResolverInputMutation[]): void {
        if (mutations.length === 0) return;
        for (const epoch of this.#planner.plan(store.epochs(), mutations).bumped) {
            store.putEpoch(epoch);
        }
    }
}

function requireBindingAuthority(store: AuthorityMutationStore, binding: Binding): void {
    requireCanonicalScope(store, binding.scope);
    const grant = requireRecord(store.grant(binding.grantId), "Binding Grant");
    if (
        !grant.isLive ||
        grant.effect !== "allow" ||
        subjectKey(grant.subject) !== subjectKey(binding.subject) ||
        !binding.scope.path.some((scope) => scope.equals(grant.scope))
    ) {
        throw new AgentCoreError(
            "authority.denied",
            "Binding requires a live allow Grant for its subject and Workspace path"
        );
    }
}

function validateDelegation(store: AuthorityMutationStore, grant: Grant): void {
    if (grant.attenuationOf === undefined) return;
    const parent = requireRecord(store.grant(grant.attenuationOf), "Parent Grant");
    if (!parent.canAttenuate(grant)) {
        throw new AgentCoreError("authority.denied", "Delegated Grant is not a live attenuation");
    }
}

/**
 * The bound §3.3 fixes on a share offer: the issuer must hold, reaching the offer's Scope,
 * one live allow Grant that both carries `administer` and covers every capability the Role
 * would materialize as an allow. One Grant, not a union of them, because "what the issuer
 * could have assigned directly" is exactly the delegation bound `Grant.canAttenuate`
 * already decides, and that bound names a single parent authority.
 *
 * Only the Role's allow rules are bounded. A deny rule materializes a deny Grant, which
 * narrows the minted Membership rather than widening it, so requiring the issuer to cover
 * it would refuse a strictly smaller offer.
 *
 * There is no second authorization mechanism here: authority is read from the one durable
 * Grant plane, for the subjects the issuer acts under, over the Scope path a Binding is
 * resolved against. A guest therefore cannot issue at all — guest Grants never carry
 * elevation — without this naming guests as a case.
 */
function requireShareOfferIssuanceAuthority(
    store: AuthorityMutationStore,
    offer: ShareOffer,
    role: Role,
    issuer: SubjectRef
): void {
    const subjects = new Set(issuerSubjects(store, issuer).map(subjectKey));
    const path = new Set(offer.scope.path.map(scopeKey));
    const bounded = store
        .grants()
        .some(
            (grant) =>
                grant.isLive &&
                grant.effect === "allow" &&
                subjects.has(subjectKey(grant.subject)) &&
                path.has(scopeKey(grant.scope)) &&
                grant.capability.impacts.includes(ISSUANCE_IMPACT) &&
                role.rules.every(
                    (rule) => rule.effect !== "allow" || grant.capability.covers(rule.capability)
                )
        );
    if (!bounded) {
        throw new AgentCoreError(
            "authority.denied",
            "Issuing a share offer requires administer authority covering its Role at its Scope"
        );
    }
}

/** The durable bytes of the Role content an offer names at issuance, not its mutable name. */
function roleContentDigest(role: Role): Digest {
    return Digest.sha256(Role.encode(role));
}

function isCrossTenantPrincipal(subject: SubjectRef, tenant: TenantId): boolean {
    return subject.kind === "principal" && !subject.principal.tenantId.equals(tenant);
}

/**
 * A local Principal issues in its own name and through the Teams it belongs to. The
 * Principal must still be able to act before either subject is considered: durable Grants
 * survive disabling for audit history, but a disabled Principal cannot exercise them. A Team
 * is a grant subject, never a protocol caller, so presenting one directly is malformed
 * rather than an alternate way around the Principal lifecycle check. A foreign issuer acts
 * only as itself and then fails the normal authority bound because foreign Grants never
 * carry elevation.
 */
function issuerSubjects(store: AuthorityMutationStore, issuer: SubjectRef): readonly SubjectRef[] {
    if (issuer.kind === "team") {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "A share offer issuer must be a local Principal"
        );
    }
    if (issuer.kind !== "principal") return [issuer];
    if (!issuer.principal.tenantId.equals(store.tenantId)) {
        throw new AgentCoreError(
            "authority.denied",
            "Share offer issuer belongs to another Tenant"
        );
    }
    const principal = requireRecord(
        store.principal(issuer.principal.principalId),
        "Share offer issuer Principal"
    );
    if (!principal.canAct) {
        throw new AgentCoreError(
            "authority.denied",
            "Disabled Principal cannot issue share offers"
        );
    }
    return [
        issuer,
        ...store
            .teams()
            .filter((team) => team.has(principal.id))
            .map((team) => SubjectRef.team(team.id))
    ];
}

/**
 * A guest holder passes the same trust-evidence gate a directly assigned guest Membership
 * does. A local holder needs nothing here: the Membership record refuses to carry guest
 * verification at all, and refuses one without host provenance, so an offer defers who is
 * bound without opening a second provenance path (§3.3).
 */
function requireRedeemedProvenance(
    store: AuthorityMutationStore,
    minted: Membership,
    now: Date
): void {
    if (minted.subject.kind !== "foreign") return;
    const verification = minted.guestVerification;
    if (verification === undefined) {
        throw new AgentCoreError(
            "authority.denied",
            "Guest Memberships require verified provenance"
        );
    }
    requireGuestVerificationEvidence(store, minted.subject, verification, now);
}

/**
 * The one guest evidence gate: a live host trust for this Membership's home Tenant, at the
 * exact revision and verification scheme the evidence names, that still admits the subject
 * now. Both a directly assigned guest Membership and one a redemption mints pass it.
 */
function requireGuestVerificationEvidence(
    store: AuthorityMutationStore,
    subject: ForeignPrincipalRef,
    verification: GuestVerification,
    now: Date
): void {
    const trust = requireRecord(store.guestTrust(verification.trustId), "Guest trust");
    if (
        !trust.isActive ||
        !trust.hostTenant.equals(store.tenantId) ||
        !trust.homeTenant.equals(subject.homeTenant) ||
        trust.revision.value !== verification.trustRevision.value ||
        trust.verifier.kind !== verification.verifiedVia.value ||
        !verification.admits(subject, now)
    ) {
        throw new AgentCoreError("authority.denied", "Guest verification is not currently valid");
    }
}

/**
 * Materialization is the security event: it mints a durable, enumerable, delegable Grant that
 * survives whatever the authorization path later decides. A guest verification is a fact with an
 * expiry, so re-minting role Grants requires the fact to still hold at the write, not merely to
 * have held once. Nothing here extends a deadline: a stale guest is denied, and the Membership
 * must be suspended, revoked, or re-verified before its Role plane moves again.
 */
function requireCurrentGuestVerification(membership: Membership, now: Date): void {
    if (membership.subject.kind !== "foreign" || !membership.isActive) return;
    const verification = membership.guestVerification;
    if (verification === undefined || !verification.admits(membership.subject, now)) {
        throw new AgentCoreError("authority.denied", "Guest verification is not currently valid");
    }
}

function principalScopes(
    store: AuthorityMutationStore,
    principalId: PrincipalId
): readonly ScopeEpoch["scope"][] {
    const key = subjectKey(SubjectRef.principal(new PrincipalRef(store.tenantId, principalId)));
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
                    ? subjectKey(grant.subject) === key
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

function distinctScopes<Scope extends ScopeEpoch["scope"]>(
    scopes: readonly Scope[]
): readonly Scope[] {
    return [...new Map(scopes.map((scope) => [scopeKey(scope), scope])).values()];
}

function nonEmpty<Scopes extends ScopeEpoch["scope"]>(
    scopes: readonly Scopes[]
): readonly [Scopes, ...Scopes[]] {
    const [first, ...remaining] = distinctScopes(scopes);
    if (first === undefined) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Authority mutations require an affected Scope"
        );
    }
    return [first, ...remaining];
}

function requireRecord<Record>(record: Record | undefined, name: string): Record {
    if (record === undefined) {
        throw new AgentCoreError("protocol.invalid-state", `${name} does not exist`);
    }
    return record;
}

function requireAbsent<Record>(record: Record | undefined, name: string): void {
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
        requireRecord(store.principal(membership.subject.principal.principalId), "Principal");
    } else if (membership.subject.kind === "team") {
        requireRecord(store.team(membership.subject.teamId), "Team");
    }
}

function requireGrantSubject(store: AuthorityMutationStore, grant: Grant): void {
    if (grant.subject.kind === "principal") {
        requireRecord(store.principal(grant.subject.principal.principalId), "Principal");
    } else if (grant.subject.kind === "team") {
        requireRecord(store.team(grant.subject.teamId), "Team");
    } else {
        // SPEC §3.3: sharing is Membership issuance — there is no second mechanism.
        // A direct-origin Grant carries no guest provenance, so it denies; guest
        // Grants exist only as role materializations of a verified guest Membership.
        throw new AgentCoreError(
            "authority.denied",
            "Guest Grants materialize only through verified guest Memberships"
        );
    }
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
    if (roots.length === 0) return Object.freeze([]);
    // A Grant's attenuation parent is immutable across replacement, so revoking cannot
    // move an edge this walk has yet to follow. The lineage is read once rather than once
    // per node, which is what kept a revocation proportional to depth times store size.
    const children = new Map<string, Grant[]>();
    for (const grant of store.grants()) {
        const parent = grant.attenuationOf?.value;
        if (parent === undefined) continue;
        children.set(parent, [...(children.get(parent) ?? []), grant]);
    }
    const revoked: Grant[] = [];
    const pending = roots.map((id) => id.value);
    const visited = new Set<string>();
    while (pending.length > 0) {
        const parent = pending.pop()!;
        if (visited.has(parent)) continue;
        visited.add(parent);
        for (const grant of children.get(parent) ?? []) {
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
