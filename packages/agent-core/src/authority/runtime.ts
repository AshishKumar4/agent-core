import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import type { CapabilityIntent } from "../facets";
import type {
    Principal,
    PrincipalId,
    GuestTrust,
    GuestTrustId,
    Membership,
    MembershipId,
    ScopeRef,
    Team,
    TenantId,
    WorkspaceId,
    Workspace
} from "../identity";
import { SubjectRef as Subjects } from "../identity";
import type { BindingValidationRequest } from "./binding-evidence";
import { BindingValidationEvidence } from "./binding-evidence";
import {
    AuthorityCheckEvidence,
    type AuthorityCheckRequest,
    type AuthorityDecisionReason
} from "./evidence";
import { PathEpochEvidence, type ScopeEpoch } from "./epoch";
import type { Grant } from "./grant";
import type { GrantId } from "./id";
import { scopeKey, subjectKey } from "./reference";

export interface TenantAuthorityReadStore {
    readonly tenantId: TenantId;
    principal(id: PrincipalId): Principal | undefined;
    teams(): readonly Team[];
    workspace(id: WorkspaceId): Workspace | undefined;
    membership(id: MembershipId): Membership | undefined;
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    epoch(scope: ScopeRef): ScopeEpoch;
}

export class TenantAuthorityRuntime {
    public constructor(
        private readonly store: TenantAuthorityReadStore,
        private readonly issuer: ActorRef
    ) {
        if (issuer.kind !== "tenant") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant authority runtime requires a Tenant Actor"
            );
        }
    }

    public validateBinding(
        request: BindingValidationRequest,
        now: Date
    ): BindingValidationEvidence {
        this.requireTenant(request.ownerTenant);
        const workspace = this.requireWorkspace(request.scope);
        const grant = this.store.grant(request.grantId);
        if (
            grant === undefined ||
            !grant.isLive ||
            grant.effect !== "allow" ||
            !scopeReaches(grant.scope, workspace.scope) ||
            validateLineage(grant, this.store.grants(), workspace.scope.path) !== undefined ||
            !this.guestGrantIsCurrent(grant, now)
        ) {
            throw authorityDenied("Binding requires a live allow Grant reaching its Workspace");
        }
        return new BindingValidationEvidence(
            this.store.tenantId,
            this.issuer,
            request.digest(),
            workspace.scope,
            grant.subject,
            grant.id,
            this.currentPath(workspace),
            now
        );
    }

    public check(request: AuthorityCheckRequest, now: Date): AuthorityCheckEvidence {
        this.requireTenant(request.ownerTenant);
        const workspace = this.requireWorkspace(request.binding.scope);
        const currentPath = this.currentPath(workspace);
        const stale = !request.expectedPath.equals(currentPath);
        const result = stale
            ? { reason: "stalePath" as const, allow: [] as Grant[], deny: [] as Grant[] }
            : this.evaluate(request, workspace.scope.path, now);
        return new AuthorityCheckEvidence(
            this.store.tenantId,
            this.issuer,
            request.digest(),
            request.binding.key,
            request.binding.generation,
            result.reason === "allowed" ? "allow" : "deny",
            result.reason,
            result.allow.map((grant) => grant.id),
            result.deny.map((grant) => grant.id),
            currentPath,
            now
        );
    }

    private evaluate(
        request: AuthorityCheckRequest,
        exactPath: readonly ScopeRef[],
        now: Date
    ): {
        readonly reason: AuthorityDecisionReason;
        readonly allow: readonly Grant[];
        readonly deny: readonly Grant[];
    } {
        if (
            !request.binding.resolves ||
            !request.binding.scope.equals(exactPath[exactPath.length - 1]!)
        ) {
            return { reason: "invalidBinding", allow: [], deny: [] };
        }
        const subjects = this.effectiveSubjects(request);
        if (subjects === undefined) {
            return { reason: "missingPrincipal", allow: [], deny: [] };
        }
        if (request.principal.tenantId.equals(this.store.tenantId)) {
            const principal = this.store.principal(request.principal.principalId);
            if (principal === undefined) return { reason: "missingPrincipal", allow: [], deny: [] };
            if (!principal.canAct) return { reason: "inactivePrincipal", allow: [], deny: [] };
        }
        const intent: CapabilityIntent = {
            facet: request.intent.facet.value,
            operation: request.intent.operation,
            impact: request.intent.impact,
            arguments: request.intent.arguments
        };
        const path = new Set(exactPath.map(scopeKey));
        const all = this.store.grants();
        const relevant = all.filter(
            (grant) =>
                subjects.has(subjectKey(grant.subject)) &&
                path.has(scopeKey(grant.scope)) &&
                grant.capability.matches(intent)
        );
        const deny = relevant.filter((grant) => grant.isLive && grant.effect === "deny");
        if (deny.length > 0) return { reason: "matchingDeny", allow: [], deny };

        const guest = !request.principal.tenantId.equals(this.store.tenantId);
        if (
            guest &&
            (request.intent.impact === "delegate" || request.intent.impact === "administer")
        ) {
            return { reason: "guestElevation", allow: [], deny: [] };
        }

        const backing = this.store.grant(request.binding.grantId);
        if (backing === undefined || backing.effect !== "allow") {
            return { reason: "missingGrant", allow: [], deny: [] };
        }
        if (!backing.isLive) return { reason: "revokedGrant", allow: [], deny: [] };
        if (
            guest &&
            (backing.origin.kind !== "role" ||
                !backing.origin.guest ||
                backing.capability.grantsElevation())
        ) {
            return { reason: "guestElevation", allow: [], deny: [] };
        }
        if (guest && !this.guestGrantIsCurrent(backing, now)) {
            return { reason: "guestVerificationExpired", allow: [], deny: [] };
        }
        if (
            !subjects.has(subjectKey(backing.subject)) ||
            subjectKey(backing.subject) !== subjectKey(request.binding.subject) ||
            !path.has(scopeKey(backing.scope)) ||
            request.binding.facet.value !== request.intent.facet.value ||
            !backing.capability.matches(intent)
        ) {
            return { reason: "noMatchingAllow", allow: [], deny: [] };
        }
        const lineage = validateLineage(backing, all, exactPath);
        if (lineage !== undefined) return { reason: lineage, allow: [], deny: [] };
        const allow = relevant.filter(
            (grant) =>
                grant.effect === "allow" &&
                validateLineage(grant, all, exactPath) === undefined &&
                (grant.subject.kind !== "foreign" || this.guestGrantIsCurrent(grant, now))
        );
        return allow.some((grant) => grant.id.equals(backing.id))
            ? { reason: "allowed", allow, deny: [] }
            : { reason: "noMatchingAllow", allow: [], deny: [] };
    }

    private effectiveSubjects(request: AuthorityCheckRequest): ReadonlySet<string> | undefined {
        if (request.principal.tenantId.equals(this.store.tenantId)) {
            const principal = Subjects.principal(request.principal.principalId);
            const subjects = new Set([subjectKey(principal)]);
            for (const team of this.store.teams()) {
                if (team.has(request.principal.principalId)) {
                    subjects.add(subjectKey(Subjects.team(team.id)));
                }
            }
            return subjects;
        }
        const subject = request.binding.subject;
        return subject.kind === "foreign" &&
            subject.homeTenant.equals(request.principal.tenantId) &&
            subject.principalId.equals(request.principal.principalId)
            ? new Set([subjectKey(subject)])
            : undefined;
    }

    private currentPath(workspace: Workspace): PathEpochEvidence {
        const epochs = workspace.scope.path.map((scope) => this.store.epoch(scope));
        return new PathEpochEvidence(epochs as [ScopeEpoch, ...ScopeEpoch[]]);
    }

    private guestGrantIsCurrent(grant: Grant, now: Date): boolean {
        if (grant.subject.kind !== "foreign") return true;
        if (grant.origin.kind !== "role" || !grant.origin.guest) return false;
        const membership = this.store.membership(grant.origin.membershipId);
        const verification = membership?.guestVerification;
        if (
            membership === undefined ||
            membership.state !== "active" ||
            membership.subject.kind !== "foreign" ||
            verification === undefined ||
            !verification.admits(membership.subject, now)
        )
            return false;
        const trust = this.store.guestTrust(verification.trustId);
        return (
            trust?.isActive === true &&
            trust.revision.value === verification.trustRevision.value &&
            trust.homeTenant.equals(membership.subject.homeTenant) &&
            trust.verifier.kind === verification.method
        );
    }

    private requireWorkspace(scope: ScopeRef): Workspace {
        if (scope.kind !== "workspace" || scope.workspaceId === undefined) {
            throw authorityDenied("Authority target must be a Workspace Scope");
        }
        const workspace = this.store.workspace(scope.workspaceId);
        if (workspace === undefined || !workspace.scope.equals(scope)) {
            throw authorityDenied("Authority target does not match canonical Tenant topology");
        }
        return workspace;
    }

    private requireTenant(tenantId: TenantId): void {
        if (!tenantId.equals(this.store.tenantId)) {
            throw authorityDenied("Authority request targets another Tenant");
        }
    }
}

function validateLineage(
    grant: Grant,
    grants: readonly Grant[],
    exactPath: readonly ScopeRef[]
): "revokedGrant" | "invalidDelegation" | undefined {
    const byId = new Map(grants.map((candidate) => [candidate.id.value, candidate]));
    const path = new Map(exactPath.map((scope, index) => [scopeKey(scope), index]));
    const seen = new Set<string>();
    let child = grant;
    while (true) {
        if (!child.isLive) return "revokedGrant";
        if (seen.has(child.id.value)) return "invalidDelegation";
        seen.add(child.id.value);
        if (child.attenuationOf === undefined) return undefined;
        const parent = byId.get(child.attenuationOf.value);
        if (parent === undefined || !parent.isLive) return "revokedGrant";
        const parentIndex = path.get(scopeKey(parent.scope));
        const childIndex = path.get(scopeKey(child.scope));
        if (
            parent.effect !== "allow" ||
            parentIndex === undefined ||
            childIndex === undefined ||
            parentIndex > childIndex ||
            !parent.capability.covers(child.capability)
        ) {
            return "invalidDelegation";
        }
        child = parent;
    }
}

function scopeReaches(grantScope: ScopeRef, target: ScopeRef): boolean {
    return target.path.some((scope) => scope.equals(grantScope));
}

function authorityDenied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}
