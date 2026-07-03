import type { AgentId } from "../agents";
import type { PrincipalId } from "../identity";
import type { Revision } from "../record";
import type { TaskId, WorkspaceId } from "./id";

export type TaskStatus = "open" | "running" | "blocked" | "done" | "cancelled";

export class TaskAssignee {
    public constructor(
        public readonly principalId: PrincipalId | undefined,
        public readonly agentId: AgentId | undefined
    ) {
        if (principalId === undefined && agentId === undefined) {
            throw new TypeError("Task assignee must include a principal or agent");
        }
    }
}

export class Task {
    public constructor(
        public readonly id: TaskId,
        public readonly workspaceId: WorkspaceId,
        public readonly parentId: TaskId | undefined,
        public readonly assignee: TaskAssignee | undefined,
        public readonly status: TaskStatus,
        public readonly revision: Revision
    ) {
    }

    public get isTerminal(): boolean {
        return this.status === "done" || this.status === "cancelled";
    }

    public revise(status: TaskStatus, assignee: TaskAssignee | undefined): Task {
        return new Task(
            this.id,
            this.workspaceId,
            this.parentId,
            assignee,
            status,
            this.revision.next()
        );
    }
}
