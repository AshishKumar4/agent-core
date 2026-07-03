import type { AgentId } from "../id";
import type { FacetSet } from "../../facets";
import type { PrincipalId, TenantId } from "../../identity";
import type { ContentRef, Digest, Revision } from "../../record";
import type { SubscriptionId, TaskId, WorkspaceId } from "../../workspaces";
import { RunBranchId, RunCommitId, RunId, TurnId } from "./id";
import { TurnLease } from "./lease";
import type { TurnLeaseCommit } from "./lease";
import type { EnvironmentPin } from "./pin";
import { Run, RunBranch, RunCommit, RunCommitKind, RunStatus, Turn, TurnRole, TurnStatus } from "./run";
import type { TurnOutcome } from "./run";

export interface RunCreationRequestInit {
    readonly id: RunId;
    readonly inputRef: ContentRef;
    readonly rootBranchId?: RunBranchId;
    readonly rootCommitId?: RunCommitId;
    readonly taskId?: TaskId;
    readonly subscriptionId?: SubscriptionId;
    readonly environmentPin?: EnvironmentPin;
}

export class RunCreationRequest {
    public readonly id: RunId;

    public readonly inputRef: ContentRef;

    public readonly rootBranchId: RunBranchId;

    public readonly rootCommitId: RunCommitId;

    public readonly taskId: TaskId | undefined;

    public readonly subscriptionId: SubscriptionId | undefined;

    public readonly environmentPin: EnvironmentPin | undefined;

    public constructor(
        init: RunCreationRequestInit
    ) {
        this.id = init.id;
        this.inputRef = init.inputRef;
        this.rootBranchId = init.rootBranchId ?? new RunBranchId(`${init.id.value}:main`);
        this.rootCommitId = init.rootCommitId ?? new RunCommitId(`${init.id.value}:root`);
        this.taskId = init.taskId;
        this.subscriptionId = init.subscriptionId;
        this.environmentPin = init.environmentPin;
    }

    public create(
        workspaceId: WorkspaceId,
        tenantId: TenantId,
        agentId: AgentId,
        parentId: RunId | undefined,
        predecessorId: RunId | undefined,
        revision: Revision
    ): Run {
        return new Run(
            this.id,
            workspaceId,
            tenantId,
            agentId,
            this.taskId,
            this.subscriptionId,
            parentId,
            predecessorId,
            RunStatus.active,
            this.environmentPin,
            this.inputRef,
            this.rootBranchId,
            this.rootCommitId,
            this.rootBranchId,
            undefined,
            revision
        );
    }

    public rootBranch(revision: Revision): RunBranch {
        return new RunBranch(this.rootBranchId, this.id, "main", this.rootCommitId, revision);
    }

    public rootCommit(revision: Revision): RunCommit {
        return new RunCommit(this.rootCommitId, this.id, this.rootBranchId, RunCommitKind.input, [], this.inputRef, undefined, undefined, revision);
    }
}

export interface TurnCreationRequestInit {
    readonly id: TurnId;
    readonly runId: RunId;
    readonly branchId: RunBranchId;
    readonly inputRef: ContentRef;
    readonly role?: TurnRole;
    readonly layer?: number;
}

export class TurnCreationRequest {
    public readonly id: TurnId;

    public readonly runId: RunId;

    public readonly branchId: RunBranchId;

    public readonly inputRef: ContentRef;

    public readonly role: TurnRole;

    public readonly layer: number;

    public constructor(
        init: TurnCreationRequestInit
    ) {
        this.id = init.id;
        this.runId = init.runId;
        this.branchId = init.branchId;
        this.inputRef = init.inputRef;
        this.role = init.role ?? TurnRole.executor;
        this.layer = init.layer ?? 0;
    }

    public create(): Turn {
        return new Turn(
            this.id,
            this.runId,
            this.branchId,
            this.role,
            this.layer,
            TurnStatus.queued,
            TurnLease.unclaimed(),
            this.inputRef,
            undefined,
            undefined
        );
    }
}

export class RunBranchRequest {
    public constructor(
        public readonly id: RunBranchId,
        public readonly name: string,
        public readonly head: RunCommitId
    ) {
    }

    public create(runId: RunId, revision: Revision): RunBranch {
        return new RunBranch(this.id, runId, this.name, this.head, revision);
    }
}

export class RunCommitRequest {
    public constructor(
        public readonly id: RunCommitId,
        public readonly kind: RunCommitKind,
        public readonly parents: readonly RunCommitId[],
        public readonly contentRef: ContentRef | undefined,
        public readonly contentDigest: Digest | undefined,
        public readonly lease: TurnLeaseCommit,
        public readonly now: Date
    ) {
    }

    public create(turn: Turn, branch: RunBranch, revision: Revision): RunCommit {
        return new RunCommit(
            this.id,
            turn.runId,
            branch.id,
            this.kind,
            this.parents,
            this.contentRef,
            this.contentDigest,
            turn.id,
            revision
        );
    }
}

export class TurnClaimRequest {
    public constructor(
        public readonly holderId: PrincipalId,
        public readonly expiresAt: Date,
        public readonly now: Date
    ) {
    }
}

export class TurnRenewLeaseRequest {
    public constructor(
        public readonly lease: TurnLeaseCommit,
        public readonly expiresAt: Date,
        public readonly now: Date
    ) {
    }
}

export class TurnSuspendRequest {
    public constructor(
        public readonly lease: TurnLeaseCommit,
        public readonly checkpointRef: ContentRef,
        public readonly now: Date
    ) {
    }
}

export class TurnCompleteRequest {
    public constructor(
        public readonly lease: TurnLeaseCommit,
        public readonly outcome: TurnOutcome,
        public readonly now: Date
    ) {
    }
}

export class RunSpawnRequest {
    public constructor(
        public readonly run: RunCreationRequest,
        public readonly facets: FacetSet,
        public readonly parentLease: TurnLeaseCommit,
        public readonly now: Date
    ) {
    }
}
