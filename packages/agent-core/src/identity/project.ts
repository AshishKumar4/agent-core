import { RecordCodec, Revision, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { ProjectId, TenantId } from "./id";

class ProjectRecordCodec extends RecordCodec<Project> {
    public constructor() {
        super("identity.project", { major: 1, minor: 0 });
    }

    protected encodePayload(project: Project): JsonValue {
        return {
            id: project.id.value,
            name: project.name,
            revision: project.revision.value,
            tenant: project.tenantId.value
        };
    }

    protected decodePayload(payload: JsonValue): Project {
        const object = requireIdentityObject(payload, "Project payload");
        requireIdentityFields(object, ["id", "name", "revision", "tenant"], "Project payload");
        return new Project(
            new ProjectId(requireIdentityString(object["id"], "Project ID")),
            new TenantId(requireIdentityString(object["tenant"], "Project tenant")),
            requireIdentityString(object["name"], "Project name"),
            requireIdentityRevision(object["revision"], "Project revision")
        );
    }
}

export class Project {
    public static readonly codec: RecordCodec<Project> = new ProjectRecordCodec();
    public readonly name: string;

    public constructor(
        public readonly id: ProjectId,
        public readonly tenantId: TenantId,
        name: string,
        public readonly revision: Revision
    ) {
        if (name.trim() !== name || name.length === 0 || name.length > 256) {
            throw new TypeError("Project name must contain between 1 and 256 canonical characters");
        }
        this.name = name;
        Object.freeze(this);
    }

    public static encode(project: Project): Uint8Array {
        return Project.codec.encode(project);
    }

    public static decode(bytes: Uint8Array): Project {
        return Project.codec.decode(bytes);
    }

    public rename(name: string): Project {
        if (name.trim() !== name || name.length === 0 || name.length > 256) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Project name must contain between 1 and 256 canonical characters"
            );
        }
        if (this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Project revision is exhausted");
        }
        return new Project(this.id, this.tenantId, name, this.revision.next());
    }
}
