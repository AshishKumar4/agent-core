import type { TenantId } from "../identity";
import type { Revision } from "../record";
import type { WorkspaceId } from "../workspaces";
import type { EnvironmentId } from "./id";
import type { ProviderDescriptor } from "./provider";

export type EnvironmentStatus = "active" | "rotating" | "disabled" | "deleted";

export class Environment {
    public constructor(
        public readonly id: EnvironmentId,
        public readonly workspaceId: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly status: EnvironmentStatus,
        public readonly provider: ProviderDescriptor,
        public readonly revision: Revision
    ) {
    }

    public get canOpenSession(): boolean {
        return this.status === "active";
    }

    public rotate(): Environment {
        return new Environment(
            this.id,
            this.workspaceId,
            this.tenantId,
            "active",
            this.provider,
            this.revision.next()
        );
    }
}
