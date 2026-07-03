import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import type { Revision } from "../../record";
import type { WorkspaceId } from "../../workspaces";
import type { AgentId } from "../id";
import type { RunCommitId } from "./id";
import type { TurnLeaseCommit } from "./lease";
import {
    RunBranchRecord,
    RunCommitRecord,
    RunSpawnRecord,
    RunStartRecord
} from "./records";
import type {
    RunBranchRequest,
    RunCommitRequest,
    RunCreationRequest,
    RunSpawnRequest,
    TurnClaimRequest,
    TurnCompleteRequest,
    TurnRenewLeaseRequest,
    TurnSuspendRequest
} from "./request";
import { RunCommitKind, TurnStatus } from "./run";
import type { Run, RunBranch, Turn } from "./run";

export class RunController {
    public start(
        request: RunCreationRequest,
        workspace: WorkspaceId,
        tenant: TenantId,
        agent: AgentId,
        revision: Revision,
        parentId: Run["parentId"] = undefined,
        predecessorId: Run["predecessorId"] = undefined
    ): RunStartRecord {
        return new RunStartRecord(
            request.create(workspace, tenant, agent, parentId, predecessorId, revision),
            request.rootBranch(revision),
            request.rootCommit(revision)
        );
    }

    public branch(run: Run, request: RunBranchRequest, revision: Revision): RunBranchRecord {
        this.ensureActive(run);
        return new RunBranchRecord(run.id, request.create(run.id, revision));
    }

    public commit(turn: Turn, branch: RunBranch, request: RunCommitRequest, revision: Revision): RunCommitRecord {
        this.ensureRunningLease(turn, request.lease, request.now, "Run commit requires a running Turn lease");
        if (!turn.runId.equals(branch.runId) || !turn.branchId.equals(branch.id)) {
            throw new AgentCoreError("run.invalid-state", "Turn can only commit to its own Run branch");
        }

        const commit = request.create(turn, branch, revision);
        return new RunCommitRecord(turn.id, request.lease.epoch, commit, branch.move(commit.id));
    }

    public undo(turn: Turn, branch: RunBranch, target: RunCommitId, request: RunCommitRequest, revision: Revision): RunCommitRecord {
        const record = this.commit(turn, branch, request, revision);
        if (!record.commit.kind.equals(RunCommitKind.undo) || record.commit.contentRef !== undefined || record.commit.contentDigest !== undefined) {
            throw new AgentCoreError("run.invalid-state", "Undo commits must only move the branch head");
        }

        return new RunCommitRecord(record.turnId, record.leaseEpoch, record.commit, branch.move(target));
    }

    public claim(turn: Turn, request: TurnClaimRequest): Turn {
        return turn.claim(request.holderId, request.expiresAt, request.now);
    }

    public renewLease(turn: Turn, request: TurnRenewLeaseRequest): Turn {
        return turn.renewLease(request.lease, request.expiresAt, request.now);
    }

    public suspend(turn: Turn, request: TurnSuspendRequest): Turn {
        return turn.suspend(request.lease, request.checkpointRef, request.now);
    }

    public complete(turn: Turn, request: TurnCompleteRequest): Turn {
        return turn.complete(request.lease, request.outcome, request.now);
    }

    public spawn(parentRun: Run, parentTurn: Turn, request: RunSpawnRequest, revision: Revision): RunSpawnRecord {
        this.ensureRunningLease(parentTurn, request.parentLease, request.now, "Run spawn requires the running parent Turn lease");
        const run = request.run.create(
            parentRun.workspaceId,
            parentRun.tenantId,
            parentRun.agentId,
            parentRun.id,
            undefined,
            revision
        );
        return new RunSpawnRecord(parentTurn.id, request.parentLease.epoch, run, request.facets);
    }

    private ensureActive(run: Run): void {
        if (!run.active) {
            throw new AgentCoreError("run.invalid-state", "Run operation requires an active Run");
        }
    }

    private ensureRunningLease(turn: Turn, lease: TurnLeaseCommit, now: Date, message: string): void {
        if (!turn.status.equals(TurnStatus.running) || !lease.isHeldBy(turn.lease, now)) {
            throw new AgentCoreError("lease.invalid", message);
        }
    }
}
