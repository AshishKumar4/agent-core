import { AgentCoreError } from "../errors";
import type {
    GuestTrust,
    Membership,
    Project,
    Role,
    ScopeRef,
    ShareOffer,
    Team,
    TenantId,
    Workspace
} from "../identity";
import { bytesEqual } from "./data";
import type { Binding } from "./binding";
import type { ScopeEpoch } from "./epoch";
import { Grant } from "./grant";
import { RoleGrantMaterializer } from "./materializer";
import { subjectKey } from "./reference";
import type { AuthorityReadStore } from "./service";

/** Whether a record already existed when the transaction that wrote it opened. */
export type AuthorityRecordPresence = "created" | "replaced";

/** The records of one kind a transaction wrote, keyed by the store's own record key. */
export class AuthorityRecordChanges<Record> {
    readonly #written = new Map<string, Record>();
    readonly #replaced = new Set<string>();

    public record(key: string, value: Record, presence: AuthorityRecordPresence): void {
        if (!this.#written.has(key) && presence === "replaced") this.#replaced.add(key);
        this.#written.set(key, value);
    }

    public written(): readonly Record[] {
        return [...this.#written.values()];
    }

    public replaced(): readonly Record[] {
        return [...this.#written]
            .filter(([key]) => this.#replaced.has(key))
            .map(([, value]) => value);
    }

    public isCreated(key: string): boolean {
        return this.#written.has(key) && !this.#replaced.has(key);
    }
}

/**
 * What one transaction wrote. Principals and the Tenant record are absent because no
 * cross-record invariant reads their content — only that they exist, which a write can
 * only make more true.
 */
export class AuthorityChangeSet {
    public readonly teams = new AuthorityRecordChanges<Team>();
    public readonly projects = new AuthorityRecordChanges<Project>();
    public readonly workspaces = new AuthorityRecordChanges<Workspace>();
    public readonly guestTrusts = new AuthorityRecordChanges<GuestTrust>();
    public readonly roles = new AuthorityRecordChanges<Role>();
    public readonly memberships = new AuthorityRecordChanges<Membership>();
    public readonly grants = new AuthorityRecordChanges<Grant>();
    public readonly bindings = new AuthorityRecordChanges<Binding>();
    public readonly shareOffers = new AuthorityRecordChanges<ShareOffer>();
    /** Nothing points at a Scope epoch, so stores record every epoch write as replaced. */
    public readonly epochs = new AuthorityRecordChanges<ScopeEpoch>();
}

/**
 * Re-derives every invariant that spans more than one Tenant authority record: Scope
 * canonicality, subject and Role existence, guest trust evidence, Binding-to-Grant
 * closure, attenuation acyclicity, share offer redemption evidence, and Role Grant
 * materialization equality. Both the Memory store and the SQLite ledger call it, so one
 * implementation decides what a consistent Tenant is on either backing.
 *
 * Passing the transaction's `changed` records audits those records and the ones whose
 * validity their change can break; passing nothing sweeps the whole store, which is what
 * opening or restoring a store does.
 */
export function assertAuthorityClosure(
    store: AuthorityReadStore,
    changed?: AuthorityChangeSet
): void {
    new AuthorityClosure(store, changed).assert();
}

/**
 * The audit, plus the store lists it had to read to run. Each list is fetched at most
 * once and only when an incremental audit needs to search for records that point at a
 * changed one — which is why a transaction that only creates records reads no lists.
 */
class AuthorityClosure {
    readonly #materializer = new RoleGrantMaterializer();
    #allGrants: readonly Grant[] | undefined;
    #allBindings: readonly Binding[] | undefined;
    #allMemberships: readonly Membership[] | undefined;

    public constructor(
        private readonly store: AuthorityReadStore,
        private readonly changed: AuthorityChangeSet | undefined
    ) {}

    public assert(): void {
        for (const team of this.#auditedTeams()) this.#assertTeam(team);
        for (const project of this.#auditedProjects()) {
            this.#requireLocalTenant(project.tenantId, "Project");
        }
        for (const workspace of this.#auditedWorkspaces()) this.#assertWorkspace(workspace);
        for (const trust of this.#auditedGuestTrusts()) {
            this.#requireLocalTenant(trust.hostTenant, "Guest trust");
        }
        for (const membership of this.#auditedMemberships()) this.#assertMembership(membership);
        for (const grant of this.#auditedGrants()) this.#assertGrant(grant);
        for (const binding of this.#auditedBindings()) this.#assertBinding(binding);
        for (const offer of this.#auditedShareOffers()) this.#assertShareOffer(offer);
        for (const epoch of this.#auditedEpochs()) this.#requireCanonicalScope(epoch.scope);
        for (const membership of this.#materializedMemberships()) {
            this.#assertMaterialization(membership);
        }
    }

    #assertTeam(team: Team): void {
        this.#requireLocalTenant(team.tenantId, "Team");
        for (const principal of team.principals) {
            if (this.store.principal(principal) === undefined) {
                throw corruptAuthorityClosure("Team references a missing Principal");
            }
        }
    }

    #assertWorkspace(workspace: Workspace): void {
        this.#requireLocalTenant(workspace.tenantId, "Workspace");
        if (
            workspace.projectId !== undefined &&
            this.store.project(workspace.projectId) === undefined
        ) {
            throw corruptAuthorityClosure("Workspace references a missing Project");
        }
    }

    #assertMembership(membership: Membership): void {
        this.#requireCanonicalScope(membership.scope);
        if (this.store.role(membership.role) === undefined) {
            throw corruptAuthorityClosure("Membership references a missing Role");
        }
        if (
            membership.subject.kind === "principal" &&
            this.store.principal(membership.subject.principal.principalId) === undefined
        ) {
            throw corruptAuthorityClosure("Membership references a missing Principal");
        }
        if (
            membership.subject.kind === "team" &&
            this.store.team(membership.subject.teamId) === undefined
        ) {
            throw corruptAuthorityClosure("Membership references a missing Team");
        }
        if (membership.subject.kind !== "foreign") return;
        const verification = membership.guestVerification;
        const trust =
            verification === undefined ? undefined : this.store.guestTrust(verification.trustId);
        if (
            verification === undefined ||
            trust === undefined ||
            !trust.hostTenant.equals(this.store.tenantId) ||
            !trust.homeTenant.equals(membership.subject.homeTenant) ||
            (membership.state === "active" &&
                (trust.revision.value !== verification.trustRevision.value ||
                    trust.verifier.kind !== verification.verifiedVia.value ||
                    !trust.isActive))
        ) {
            throw corruptAuthorityClosure("Guest Membership references invalid trust evidence");
        }
    }

    #assertGrant(grant: Grant): void {
        this.#requireCanonicalScope(grant.scope);
        if (
            grant.subject.kind === "principal" &&
            this.store.principal(grant.subject.principal.principalId) === undefined
        ) {
            throw corruptAuthorityClosure("Grant references a missing Principal");
        }
        if (grant.subject.kind === "team" && this.store.team(grant.subject.teamId) === undefined) {
            throw corruptAuthorityClosure("Grant references a missing Team");
        }
        if (grant.origin.kind === "role") {
            const membership = this.store.membership(grant.origin.membershipId);
            if (
                membership === undefined ||
                membership.role.value !== grant.origin.roleName ||
                subjectKey(membership.subject) !== subjectKey(grant.subject)
            ) {
                throw corruptAuthorityClosure("Role Grant references invalid Membership evidence");
            }
        }
        const seen = new Set([grant.id.value]);
        let child = grant;
        while (child.attenuationOf !== undefined) {
            if (seen.has(child.attenuationOf.value)) {
                throw corruptAuthorityClosure("Delegated Grant attenuation contains a cycle");
            }
            seen.add(child.attenuationOf.value);
            const parent = this.store.grant(child.attenuationOf);
            if (parent === undefined || !parent.canAttenuate(child)) {
                throw corruptAuthorityClosure(
                    "Delegated Grant references invalid parent authority"
                );
            }
            child = parent;
        }
    }

    #assertBinding(binding: Binding): void {
        this.#requireCanonicalScope(binding.scope);
        const grant = this.store.grant(binding.grantId);
        if (
            grant === undefined ||
            grant.effect !== "allow" ||
            subjectKey(grant.subject) !== subjectKey(binding.subject) ||
            !binding.scope.path.some((scope) => scope.equals(grant.scope))
        ) {
            throw corruptAuthorityClosure("Binding references invalid Tenant authority");
        }
    }

    /**
     * An offer names a canonical Scope and an existing Role, and every redemption it
     * records names the Membership that redemption minted at that exact Scope for exactly
     * the holder it records. A Membership may later revise its Role or lifecycle, so the
     * offer never constrains either; its subject and Scope are the immutable evidence an
     * offer retains. A Membership is never deleted, so only writing the offer can break
     * these — which is why no other written kind pulls offers into an incremental audit.
     */
    #assertShareOffer(offer: ShareOffer): void {
        this.#requireCanonicalScope(offer.scope);
        if (this.store.role(offer.role) === undefined) {
            throw corruptAuthorityClosure("Share offer references a missing Role");
        }
        for (const redemption of offer.redemptions) {
            const membership = this.store.membership(redemption.membership);
            if (
                membership === undefined ||
                !membership.scope.equals(offer.scope) ||
                subjectKey(membership.subject) !== subjectKey(redemption.subject)
            ) {
                throw corruptAuthorityClosure(
                    "Share offer redemption references invalid Membership evidence"
                );
            }
        }
    }

    #assertMaterialization(membership: Membership): void {
        const role = this.store.role(membership.role);
        if (role === undefined) {
            throw corruptAuthorityClosure("Membership references a missing Role");
        }
        const owned = this.#ownedRoleGrants(membership);
        const expected = this.#materializer.materialize({
            membership,
            role,
            existing: owned
        }).desiredRecords;
        if (
            expected.length !== owned.length ||
            expected.some((record) => {
                const actual = owned.find((candidate) => candidate.id.equals(record.id));
                return (
                    actual === undefined || !bytesEqual(Grant.encode(actual), Grant.encode(record))
                );
            })
        ) {
            throw corruptAuthorityClosure(
                "Role Grant materialization does not match Membership evidence"
            );
        }
    }

    /**
     * Every Grant the Membership owns. A Membership created inside the transaction can
     * only be named by Grants the same transaction wrote: the closure held before it
     * opened, and a Role Grant is only valid while its Membership exists.
     */
    #ownedRoleGrants(membership: Membership): readonly Grant[] {
        const source =
            this.changed?.memberships.isCreated(membership.id.value) === true
                ? this.changed.grants.written()
                : this.#grants();
        return source.filter(
            (grant) =>
                grant.origin.kind === "role" && grant.origin.membershipId.equals(membership.id)
        );
    }

    #auditedTeams(): readonly Team[] {
        return this.changed === undefined ? this.store.teams() : this.changed.teams.written();
    }

    #auditedProjects(): readonly Project[] {
        return this.changed === undefined ? this.store.projects() : this.changed.projects.written();
    }

    #auditedWorkspaces(): readonly Workspace[] {
        return this.changed === undefined
            ? this.store.workspaces()
            : this.changed.workspaces.written();
    }

    #auditedGuestTrusts(): readonly GuestTrust[] {
        return this.changed === undefined
            ? this.store.guestTrusts()
            : this.changed.guestTrusts.written();
    }

    #auditedShareOffers(): readonly ShareOffer[] {
        return this.changed === undefined
            ? this.store.shareOffers()
            : this.changed.shareOffers.written();
    }

    #auditedEpochs(): readonly ScopeEpoch[] {
        return this.changed === undefined ? this.store.epochs() : this.changed.epochs.written();
    }

    /** Written Memberships, plus the guest Memberships a replaced trust can invalidate. */
    #auditedMemberships(): readonly Membership[] {
        if (this.changed === undefined) return this.#memberships();
        const rotated = new Set(this.changed.guestTrusts.replaced().map((trust) => trust.id.value));
        return distinct(
            [
                ...this.changed.memberships.written(),
                ...(rotated.size === 0
                    ? []
                    : this.#memberships().filter(
                          (membership) =>
                              membership.guestVerification !== undefined &&
                              rotated.has(membership.guestVerification.trustId.value)
                      ))
            ],
            (membership) => membership.id.value
        );
    }

    /** Written Grants, plus every Grant attenuating from a replaced one. */
    #auditedGrants(): readonly Grant[] {
        if (this.changed === undefined) return this.#grants();
        const written = this.changed.grants.written();
        const replaced = this.changed.grants.replaced();
        if (replaced.length === 0) return written;
        const children = new Map<string, Grant[]>();
        for (const grant of this.#grants()) {
            if (grant.attenuationOf === undefined) continue;
            const siblings = children.get(grant.attenuationOf.value) ?? [];
            siblings.push(grant);
            children.set(grant.attenuationOf.value, siblings);
        }
        const descendants: Grant[] = [];
        const visited = new Set(replaced.map((grant) => grant.id.value));
        let frontier = replaced;
        while (frontier.length > 0) {
            const next: Grant[] = [];
            for (const parent of frontier) {
                for (const child of children.get(parent.id.value) ?? []) {
                    if (visited.has(child.id.value)) continue;
                    visited.add(child.id.value);
                    descendants.push(child);
                    next.push(child);
                }
            }
            frontier = next;
        }
        return distinct([...written, ...descendants], (grant) => grant.id.value);
    }

    /** Written Bindings, plus every Binding naming a replaced Grant. */
    #auditedBindings(): readonly Binding[] {
        if (this.changed === undefined) return this.#bindings();
        const replaced = new Set(this.changed.grants.replaced().map((grant) => grant.id.value));
        return distinct(
            [
                ...this.changed.bindings.written(),
                ...(replaced.size === 0
                    ? []
                    : this.#bindings().filter((binding) => replaced.has(binding.grantId.value)))
            ],
            (binding) => binding.key
        );
    }

    /**
     * Written Memberships, the Memberships that own a written Role Grant, and every
     * Membership a replaced Role re-materializes.
     */
    #materializedMemberships(): readonly Membership[] {
        if (this.changed === undefined) return this.#memberships();
        const owners: Membership[] = [];
        for (const grant of this.changed.grants.written()) {
            if (grant.origin.kind !== "role") continue;
            const membership = this.store.membership(grant.origin.membershipId);
            if (membership !== undefined) owners.push(membership);
        }
        const roles = new Set(this.changed.roles.replaced().map((role) => role.name.value));
        return distinct(
            [
                ...this.changed.memberships.written(),
                ...owners,
                ...(roles.size === 0
                    ? []
                    : this.#memberships().filter((membership) => roles.has(membership.role.value)))
            ],
            (membership) => membership.id.value
        );
    }

    #grants(): readonly Grant[] {
        this.#allGrants ??= this.store.grants();
        return this.#allGrants;
    }

    #bindings(): readonly Binding[] {
        this.#allBindings ??= this.store.bindings();
        return this.#allBindings;
    }

    #memberships(): readonly Membership[] {
        this.#allMemberships ??= this.store.memberships();
        return this.#allMemberships;
    }

    /** A record owned by another Tenant is a boundary fault, not a decoding one. */
    #requireLocalTenant(tenantId: TenantId, subject: string): void {
        if (!tenantId.equals(this.store.tenantId)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `${subject} belongs to another Tenant`
            );
        }
    }

    #requireCanonicalScope(scope: ScopeRef): void {
        this.#requireLocalTenant(scope.tenantId, "Authority Scope");
        if (
            scope.kind === "project" &&
            (scope.projectId === undefined || this.store.project(scope.projectId) === undefined)
        ) {
            throw corruptAuthorityClosure("Authority Project Scope is not canonical");
        }
        if (scope.kind !== "workspace") return;
        const workspace =
            scope.workspaceId === undefined ? undefined : this.store.workspace(scope.workspaceId);
        if (workspace === undefined || !workspace.scope.equals(scope)) {
            throw corruptAuthorityClosure("Authority Workspace Scope is not canonical");
        }
    }
}

function distinct<Record>(records: readonly Record[], key: (record: Record) => string): Record[] {
    return [...new Map(records.map((record) => [key(record), record])).values()];
}

function corruptAuthorityClosure(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
