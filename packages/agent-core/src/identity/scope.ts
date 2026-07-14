import type { JsonValue } from "../core";
import {
    invalid,
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityString
} from "./codec";
import { ProjectId, TenantId, WorkspaceId } from "./id";

export type ScopeKind = "tenant" | "project" | "workspace";

export class ScopeRef {
    private constructor(
        public readonly kind: ScopeKind,
        public readonly tenantId: TenantId,
        public readonly projectId: ProjectId | undefined,
        public readonly workspaceId: WorkspaceId | undefined
    ) {
        Object.freeze(this);
    }

    public static tenant(tenantId: TenantId): ScopeRef {
        return new ScopeRef("tenant", tenantId, undefined, undefined);
    }

    public static project(tenantId: TenantId, projectId: ProjectId): ScopeRef {
        return new ScopeRef("project", tenantId, projectId, undefined);
    }

    public static workspace(tenantId: TenantId, workspaceId: WorkspaceId): ScopeRef;
    public static workspace(
        tenantId: TenantId,
        projectId: ProjectId,
        workspaceId: WorkspaceId
    ): ScopeRef;
    public static workspace(
        tenantId: TenantId,
        projectOrWorkspace: ProjectId | WorkspaceId,
        workspace?: WorkspaceId
    ): ScopeRef {
        return workspace === undefined
            ? new ScopeRef("workspace", tenantId, undefined, requireWorkspace(projectOrWorkspace))
            : new ScopeRef("workspace", tenantId, requireProject(projectOrWorkspace), workspace);
    }

    public get path(): readonly ScopeRef[] {
        return scopePath(this);
    }

    public equals(other: ScopeRef): boolean {
        return (
            this.kind === other.kind &&
            this.tenantId.equals(other.tenantId) &&
            optionalIdEquals(this.projectId, other.projectId) &&
            optionalIdEquals(this.workspaceId, other.workspaceId)
        );
    }
}

export function encodeScopeRef(scope: ScopeRef): JsonValue {
    if (scope.kind === "tenant") {
        return { kind: scope.kind, tenant: scope.tenantId.value };
    }
    if (scope.kind === "project") {
        if (scope.projectId === undefined) {
            throw new TypeError("Project scope requires a Project ID");
        }
        return {
            kind: scope.kind,
            project: scope.projectId.value,
            tenant: scope.tenantId.value
        };
    }
    if (scope.workspaceId === undefined) {
        throw new TypeError("Workspace scope requires a Workspace ID");
    }
    return {
        kind: scope.kind,
        project: scope.projectId?.value ?? null,
        tenant: scope.tenantId.value,
        workspace: scope.workspaceId.value
    };
}

export function decodeScopeRef(value: JsonValue): ScopeRef {
    const object = requireIdentityObject(value, "Scope reference");
    const kind = object["kind"];
    if (kind === "tenant") {
        requireIdentityFields(object, ["kind", "tenant"], "Tenant scope reference");
        return ScopeRef.tenant(
            new TenantId(requireIdentityString(object["tenant"], "Scope tenant"))
        );
    }
    if (kind === "project") {
        requireIdentityFields(object, ["kind", "project", "tenant"], "Project scope reference");
        return ScopeRef.project(
            new TenantId(requireIdentityString(object["tenant"], "Scope tenant")),
            new ProjectId(requireIdentityString(object["project"], "Scope project"))
        );
    }
    if (kind === "workspace") {
        requireIdentityFields(
            object,
            ["kind", "project", "tenant", "workspace"],
            "Workspace scope reference"
        );
        const tenant = new TenantId(requireIdentityString(object["tenant"], "Scope tenant"));
        const workspace = new WorkspaceId(
            requireIdentityString(object["workspace"], "Scope workspace")
        );
        const project = object["project"];
        if (project === null) {
            return ScopeRef.workspace(tenant, workspace);
        }
        return ScopeRef.workspace(
            tenant,
            new ProjectId(requireIdentityString(project, "Scope project")),
            workspace
        );
    }
    throw invalid("Scope reference kind is invalid");
}

export function scopePath(scope: ScopeRef): readonly ScopeRef[] {
    if (scope.kind === "tenant") {
        return Object.freeze([scope]);
    }
    const tenant = ScopeRef.tenant(scope.tenantId);
    if (scope.kind === "project") {
        return Object.freeze([tenant, scope]);
    }
    if (scope.projectId === undefined) {
        return Object.freeze([tenant, scope]);
    }
    return Object.freeze([tenant, ScopeRef.project(scope.tenantId, scope.projectId), scope]);
}

function requireProject(value: ProjectId | WorkspaceId): ProjectId {
    if (!(value instanceof ProjectId)) {
        throw new TypeError("Workspace project must be a Project ID");
    }
    return value;
}

function requireWorkspace(value: ProjectId | WorkspaceId): WorkspaceId {
    if (!(value instanceof WorkspaceId)) {
        throw new TypeError("Workspace scope requires a Workspace ID");
    }
    return value;
}

function optionalIdEquals(
    left: ProjectId | WorkspaceId | undefined,
    right: ProjectId | WorkspaceId | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}
