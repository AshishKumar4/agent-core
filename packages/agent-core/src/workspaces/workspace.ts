import type { TenantId } from "../identity";
import type { Revision } from "../record";
import type { WorkspaceId } from "./id";

export type WorkspaceStatus = "active" | "archived" | "deleted";

export class Workspace {
    public constructor(
        public readonly id: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly name: string,
        public readonly status: WorkspaceStatus,
        public readonly revision: Revision
    ) {
        if (name.length === 0 || name.length > 256) {
            throw new TypeError("Workspace name must contain between 1 and 256 characters");
        }
    }

    public get acceptsComposition(): boolean {
        return this.status === "active";
    }

    public rename(name: string): Workspace {
        return new Workspace(this.id, this.tenantId, name, this.status, this.revision.next());
    }
}
