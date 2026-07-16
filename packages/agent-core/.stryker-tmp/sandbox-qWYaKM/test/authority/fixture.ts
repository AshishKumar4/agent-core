// @ts-nocheck
import type { Impact } from "../../src/facets";
import {
    PrincipalId,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId,
    type SubjectRef as SubjectReference
} from "../../src/identity";
import { Grant, GrantId } from "../../src/authority";
import { CapabilitySpec } from "../../src/facets";

export const tenantId = new TenantId("tenant-authority");
export const projectId = new ProjectId("project-authority");
export const workspaceId = new WorkspaceId("workspace-authority");
export const tenantScope = ScopeRef.tenant(tenantId);
export const projectScope = ScopeRef.project(tenantId, projectId);
export const workspaceScope = ScopeRef.workspace(tenantId, projectId, workspaceId);
export const principalId = new PrincipalId("principal-authority");
export const otherPrincipalId = new PrincipalId("principal-other");
export const principal = SubjectRef.principal(principalId);

export function capability(
    impacts: readonly [Impact, ...Impact[]] = ["observe"],
    facetPattern = "workspace:mail.*",
    operations: readonly string[] = []
): CapabilitySpec {
    return new CapabilitySpec({ facetPattern, impacts, operations });
}

export function allowGrant(
    id: string,
    subject: SubjectReference = principal,
    scope = workspaceScope,
    spec = capability(),
    attenuationOf?: GrantId
): Grant {
    return new Grant(
        new GrantId(id),
        scope,
        subject,
        "allow",
        spec,
        { kind: "direct" },
        attenuationOf
    );
}
