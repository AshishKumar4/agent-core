import type { PrincipalId } from "../identity";
import type { Digest, Revision } from "../record";
import type { RunId } from "../agents";
import type { WorkspaceId } from "../workspaces";
import type { ApprovalId, InvocationId } from "./id";

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";

export class ApprovalResolution {
    public constructor(
        public readonly status: "approved" | "denied" | "cancelled" | "expired",
        public readonly resolverId: PrincipalId
    ) {
    }
}

export class Approval {
    public constructor(
        public readonly id: ApprovalId,
        public readonly workspaceId: WorkspaceId,
        public readonly runId: RunId,
        public readonly invocationId: InvocationId,
        public readonly operationDigest: Digest,
        public readonly status: ApprovalStatus,
        public readonly resolverId: PrincipalId | undefined,
        public readonly revision: Revision
    ) {
    }

    public get isOpen(): boolean {
        return this.status === "pending";
    }

    public resolve(resolution: ApprovalResolution): Approval {
        if (!this.isOpen) {
            throw new TypeError("Only pending approvals can be resolved");
        }

        return new Approval(
            this.id,
            this.workspaceId,
            this.runId,
            this.invocationId,
            this.operationDigest,
            resolution.status,
            resolution.resolverId,
            this.revision.next()
        );
    }
}
