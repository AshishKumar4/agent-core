// @ts-nocheck
import {
    Binding,
    MemoryTenantControlStore,
    AuthorityMutationService,
    createTenantControlBootstrapPlan,
    subjectKey,
    type BindingStore,
    type TenantControlBootstrapAnchor
} from "../authority";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { BindingName, FacetRef, ProtectionDomain } from "../facets";
import { SubjectRef, Workspace, type WorkspaceId } from "../identity";

export interface SingleTenantPolicyBinding {
    readonly name: BindingName;
    readonly domain: ProtectionDomain;
    readonly facet: FacetRef;
}

export interface SingleTenantPolicyAssemblyInit {
    readonly anchor: TenantControlBootstrapAnchor;
    readonly workspaceId: WorkspaceId;
    readonly binding: SingleTenantPolicyBinding;
}

export class TenantMultiplicityPolicy {
    private constructor(public readonly mode: "single-tenant" | "multi-tenant") {
        Object.freeze(this);
    }

    public static singleTenant(): TenantMultiplicityPolicy {
        return new TenantMultiplicityPolicy("single-tenant");
    }

    public canCreateTenant(existingTenantCount: number): boolean {
        requireTenantCount(existingTenantCount);
        return this.mode === "multi-tenant" || existingTenantCount === 0;
    }

    public promote(): TenantMultiplicityPolicy {
        return new TenantMultiplicityPolicy("multi-tenant");
    }
}

export interface SingleTenantPolicyAssembly {
    readonly policy: TenantMultiplicityPolicy;
    readonly tenant: ReturnType<typeof createTenantControlBootstrapPlan>["tenant"];
    readonly owner: ReturnType<typeof createTenantControlBootstrapPlan>["owner"];
    readonly ownerMembership: ReturnType<
        typeof createTenantControlBootstrapPlan
    >["ownerMembership"];
    readonly grants: ReturnType<typeof createTenantControlBootstrapPlan>["grants"];
    readonly binding: Binding;
    readonly workspace: Workspace;
}

export function assembleSingleTenantPolicy(
    control: MemoryTenantControlStore,
    bindings: BindingStore,
    init: SingleTenantPolicyAssemblyInit
): SingleTenantPolicyAssembly {
    const policy = TenantMultiplicityPolicy.singleTenant();
    if (!policy.canCreateTenant(control.isBootstrapEligible() ? 0 : 1)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Single-tenant policy already has its Tenant"
        );
    }

    const plan = createTenantControlBootstrapPlan(init.anchor, Revision.initial());
    control.bootstrap(plan);
    const workspace = new Workspace(
        init.workspaceId,
        init.anchor.tenantId,
        undefined,
        Revision.initial()
    );
    new AuthorityMutationService(control).createWorkspace(workspace);

    const ownerGrant = plan.grants.find(
        (grant) =>
            grant.effect === "allow" &&
            subjectKey(grant.subject) === subjectKey(plan.ownerMembership.subject)
    );
    if (ownerGrant === undefined) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Single-tenant owner Membership did not materialize an allow Grant"
        );
    }
    const binding = Binding.active(
        workspace.scope,
        SubjectRef.principal(init.anchor.principalId),
        init.binding.domain,
        init.binding.name,
        ownerGrant.id,
        init.binding.facet
    );
    bindings.save(binding);

    return Object.freeze({
        policy,
        tenant: plan.tenant,
        owner: plan.owner,
        ownerMembership: plan.ownerMembership,
        grants: plan.grants,
        binding: bindings.load(binding.key)!,
        workspace
    });
}

function requireTenantCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Existing Tenant count must be a non-negative safe integer");
    }
}
