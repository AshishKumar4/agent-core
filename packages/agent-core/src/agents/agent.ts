import type { TenantId } from "../identity";
import type { Revision } from "../record";
import type { WorkspaceId } from "../workspaces";
import type { AgentId } from "./id";
import type { AgentProfile } from "./profile";

export type AgentStatus = "active" | "paused" | "deleted";

export class AgentConfig {
    public constructor(public readonly profile: AgentProfile) {
    }

    public withProfile(profile: AgentProfile): AgentConfig {
        return new AgentConfig(profile);
    }
}

export class Agent {
    public constructor(
        public readonly id: AgentId,
        public readonly workspaceId: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly config: AgentConfig,
        public readonly status: AgentStatus,
        public readonly revision: Revision
    ) {
    }

    public get profile(): AgentProfile {
        return this.config.profile;
    }

    public get canStartRun(): boolean {
        return this.status === "active";
    }

    public revise(config: AgentConfig, status: AgentStatus): Agent {
        return new Agent(
            this.id,
            this.workspaceId,
            this.tenantId,
            config,
            status,
            this.revision.next()
        );
    }
}
