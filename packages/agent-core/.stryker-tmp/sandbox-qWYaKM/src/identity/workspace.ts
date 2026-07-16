// @ts-nocheck
import { RecordCodec, Revision, type JsonValue } from "../core";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { ProjectId, TenantId, WorkspaceId } from "./id";
import { ScopeRef } from "./scope";

class WorkspaceRecordCodec extends RecordCodec<Workspace> {
    public constructor() {
        super("identity.workspace", { major: 1, minor: 0 });
    }

    protected encodePayload(workspace: Workspace): JsonValue {
        return {
            id: workspace.id.value,
            project: workspace.projectId?.value ?? null,
            revision: workspace.revision.value,
            tenant: workspace.tenantId.value
        };
    }

    protected decodePayload(payload: JsonValue): Workspace {
        const object = requireIdentityObject(payload, "Workspace payload");
        requireIdentityFields(object, ["id", "project", "revision", "tenant"], "Workspace payload");
        const project = object["project"];
        if (project !== null && typeof project !== "string") {
            throw new TypeError("Workspace Project must be a string or null");
        }
        return new Workspace(
            new WorkspaceId(requireIdentityString(object["id"], "Workspace ID")),
            new TenantId(requireIdentityString(object["tenant"], "Workspace Tenant")),
            project === null ? undefined : new ProjectId(project),
            requireIdentityRevision(object["revision"], "Workspace revision")
        );
    }
}

export class Workspace {
    public static readonly codec: RecordCodec<Workspace> = new WorkspaceRecordCodec();

    public constructor(
        public readonly id: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly projectId: ProjectId | undefined,
        public readonly revision: Revision
    ) {
        if (revision.value !== 0) {
            throw new TypeError("Workspace topology requires immutable revision zero");
        }
        Object.freeze(this);
    }

    public static encode(workspace: Workspace): Uint8Array {
        return Workspace.codec.encode(workspace);
    }

    public static decode(bytes: Uint8Array): Workspace {
        return Workspace.codec.decode(bytes);
    }

    public get scope(): ScopeRef {
        return this.projectId === undefined
            ? ScopeRef.workspace(this.tenantId, this.id)
            : ScopeRef.workspace(this.tenantId, this.projectId, this.id);
    }
}
