import { ActorId } from "../../src/actors";
import { MemoryBindingStore, MemoryTenantControlStore } from "../../src/authority";
import { assembleSingleTenantPolicy } from "../../src/composition";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, TenantId, WorkspaceId } from "../../src/identity";
import { describe, expect, test } from "vitest";

const anchor = {
    actorId: new ActorId("single-tenant-control"),
    tenantId: new TenantId("personal"),
    principalId: new PrincipalId("owner"),
    trustAnchor: Uint8Array.of(1),
    tenantKind: "personal" as const
};
const workspaceId = new WorkspaceId("assistant");
const workspaceScope = ScopeRef.workspace(anchor.tenantId, workspaceId);
const policyInit = {
    anchor,
    workspaceId,
    binding: {
        name: new BindingName("assistant"),
        domain: new ProtectionDomain("backend", "assistant", "may-hold-secrets"),
        facet: new FacetRef("profile:self")
    }
};

describe("Single-tenant policy assembly", () => {
    test("[P11-SINGLE-TENANT-POLICY] admits the initial Tenant and denies creating a second Tenant", () => {
        const { assembly, bindings, control } = createAssembly();
        expect(assembly.policy.mode).toBe("single-tenant");
        expect(assembly.policy.canCreateTenant(0)).toBe(true);
        expect(assembly.policy.canCreateTenant(1)).toBe(false);
        expect(() => assembly.policy.canCreateTenant(-1)).toThrow(/non-negative safe integer/);
        expect(() => assembleSingleTenantPolicy(control, bindings, policyInit)).toThrow(
            /already has its Tenant/
        );
    });

    test("[P11-SINGLE-TENANT-PRINCIPAL] persists exactly the one anchored Principal", () => {
        const { control } = createAssembly();
        const principals = control
            .identitySnapshot()
            .records.filter((record) => record.kind === "principal");
        expect(principals.map((record) => record.id)).toEqual([anchor.principalId.value]);
    });

    test("[P11-SINGLE-TENANT-TENANT] persists exactly the one personal Tenant", () => {
        const { control } = createAssembly();
        const tenants = control
            .identitySnapshot()
            .records.filter((record) => record.kind === "tenant");
        expect(tenants.map((record) => record.id)).toEqual([anchor.tenantId.value]);
        expect(control.tenant(anchor.tenantId)?.kind).toBe("personal");
    });

    test("[P11-SINGLE-TENANT-OWNER] materializes an active owner Membership for the Principal", () => {
        const { assembly, control } = createAssembly();
        const membership = control.membership(assembly.ownerMembership.id);
        expect(membership).toMatchObject({ state: "active" });
        expect(membership?.role.value).toBe("owner");
        expect(membership?.subject).toEqual(assembly.ownerMembership.subject);
    });

    test("[P11-SINGLE-TENANT-RECORDS] restores ordinary Grant and Binding records from durable snapshots", () => {
        const { assembly, control, bindings } = createAssembly();
        const restartedControl = MemoryTenantControlStore.restore(control.snapshot());
        const restartedBindings = new MemoryBindingStore(workspaceScope, bindings.snapshot());

        expect(
            assembly.grants.every((grant) => restartedControl.grant(grant.id) !== undefined)
        ).toBe(true);
        expect(
            restartedBindings.load(assembly.binding.key)?.grantId.equals(assembly.binding.grantId)
        ).toBe(true);
    });

    test("[P11-SINGLE-TENANT-PROMOTION] changes only Tenant multiplicity policy", () => {
        const { assembly, control, bindings } = createAssembly();
        const authorityBefore = control.snapshot();
        const bindingsBefore = bindings.snapshot();

        const promoted = assembly.policy.promote();

        expect(promoted.mode).toBe("multi-tenant");
        expect(promoted.canCreateTenant(1)).toBe(true);
        expect(control.snapshot()).toEqual(authorityBefore);
        expect(bindings.snapshot()).toEqual(bindingsBefore);
    });

    test("[P11-SINGLE-TENANT-ASSEMBLY] assembles a personal assistant from ordinary policy records", () => {
        const { assembly } = createAssembly();
        expect(assembly.workspace.tenantId.equals(assembly.tenant.id)).toBe(true);
        expect(assembly.binding.scope.equals(assembly.workspace.scope)).toBe(true);
        expect(assembly.binding.subject).toEqual(assembly.ownerMembership.subject);
        expect(assembly.grants.some((grant) => grant.id.equals(assembly.binding.grantId))).toBe(
            true
        );
    });
});

function createAssembly() {
    const control = MemoryTenantControlStore.create(anchor);
    const bindings = new MemoryBindingStore(workspaceScope);
    const assembly = assembleSingleTenantPolicy(control, bindings, policyInit);
    return { assembly, control, bindings };
}
