import type { AgentId } from "../id";
import { AgentCoreError } from "../../errors";
import type { PrincipalId, TenantId } from "../../identity";
import type { ContentRef, Digest, Revision } from "../../record";
import type { SubscriptionId, TaskId, WorkspaceId } from "../../workspaces";
import type { EnvironmentPin } from "./pin";
import type { TurnLease, TurnLeaseCommit } from "./lease";
import type { RunBranchId, RunCommitId, RunId, TurnId } from "./id";

export abstract class RunStatus {
    public static get active(): RunStatus {
        return activeRunStatus;
    }

    public static get completed(): RunStatus {
        return completedRunStatus;
    }

    public static get cancelled(): RunStatus {
        return cancelledRunStatus;
    }

    protected constructor(public readonly name: string) {
    }

    public get allowsWork(): boolean {
        return false;
    }

    public complete(): RunStatus {
        throw new AgentCoreError("run.invalid-state", "Only active Runs can complete");
    }

    public cancel(): RunStatus {
        throw new AgentCoreError("run.invalid-state", "Only active Runs can be cancelled");
    }

    public equals(other: RunStatus): boolean {
        return this === other;
    }
}

class ActiveRunStatus extends RunStatus {
    public constructor() {
        super("active");
    }

    public override get allowsWork(): boolean {
        return true;
    }

    public override complete(): RunStatus {
        return completedRunStatus;
    }

    public override cancel(): RunStatus {
        return cancelledRunStatus;
    }
}

class TerminalRunStatus extends RunStatus {
    public constructor(name: string) {
        super(name);
    }
}

const activeRunStatus = new ActiveRunStatus();
const completedRunStatus = new TerminalRunStatus("completed");
const cancelledRunStatus = new TerminalRunStatus("cancelled");

export abstract class TurnStatus {
    public static get queued(): TurnStatus {
        return queuedTurnStatus;
    }

    public static get running(): TurnStatus {
        return runningTurnStatus;
    }

    public static get suspended(): TurnStatus {
        return suspendedTurnStatus;
    }

    public static get succeeded(): TurnStatus {
        return succeededTurnStatus;
    }

    public static get failed(): TurnStatus {
        return failedTurnStatus;
    }

    public static get cancelled(): TurnStatus {
        return cancelledTurnStatus;
    }

    public static get interrupted(): TurnStatus {
        return interruptedTurnStatus;
    }

    protected constructor(public readonly name: string) {
    }

    public get terminal(): boolean {
        return false;
    }

    public claimable(): boolean {
        return false;
    }

    public claim(): TurnStatus {
        throw new AgentCoreError("turn.invalid-state", "Turn claim requires a queued or suspended Turn");
    }

    public requireRunning(message: string): void {
        throw new AgentCoreError("turn.invalid-state", message);
    }

    public equals(other: TurnStatus): boolean {
        return this === other;
    }
}

class QueuedTurnStatus extends TurnStatus {
    public constructor() {
        super("queued");
    }

    public override claimable(): boolean {
        return true;
    }

    public override claim(): TurnStatus {
        return runningTurnStatus;
    }
}

class RunningTurnStatus extends TurnStatus {
    public constructor() {
        super("running");
    }

    public override requireRunning(_message: string): void {
    }
}

class SuspendedTurnStatus extends TurnStatus {
    public constructor() {
        super("suspended");
    }

    public override claimable(): boolean {
        return true;
    }

    public override claim(): TurnStatus {
        return runningTurnStatus;
    }
}

class TerminalTurnStatus extends TurnStatus {
    public constructor(name: string) {
        super(name);
    }

    public override get terminal(): boolean {
        return true;
    }
}

const queuedTurnStatus = new QueuedTurnStatus();
const runningTurnStatus = new RunningTurnStatus();
const suspendedTurnStatus = new SuspendedTurnStatus();
const succeededTurnStatus = new TerminalTurnStatus("succeeded");
const failedTurnStatus = new TerminalTurnStatus("failed");
const cancelledTurnStatus = new TerminalTurnStatus("cancelled");
const interruptedTurnStatus = new TerminalTurnStatus("interrupted");

export abstract class TurnRole {
    public static get executor(): TurnRole {
        return executorTurnRole;
    }

    public static get proposer(): TurnRole {
        return proposerTurnRole;
    }

    public static get aggregator(): TurnRole {
        return aggregatorTurnRole;
    }

    public static get judge(): TurnRole {
        return judgeTurnRole;
    }

    protected constructor(public readonly name: string) {
    }

    public equals(other: TurnRole): boolean {
        return this === other;
    }
}

class Role extends TurnRole {
    public constructor(name: string) {
        super(name);
    }
}

const executorTurnRole = new Role("executor");
const proposerTurnRole = new Role("proposer");
const aggregatorTurnRole = new Role("aggregator");
const judgeTurnRole = new Role("judge");

export abstract class RunCommitKind {
    public static get input(): RunCommitKind {
        return inputCommitKind;
    }

    public static get message(): RunCommitKind {
        return messageCommitKind;
    }

    public static get checkpoint(): RunCommitKind {
        return checkpointCommitKind;
    }

    public static get invocation(): RunCommitKind {
        return invocationCommitKind;
    }

    public static get event(): RunCommitKind {
        return eventCommitKind;
    }

    public static get result(): RunCommitKind {
        return resultCommitKind;
    }

    public static get merge(): RunCommitKind {
        return mergeCommitKind;
    }

    public static get verdict(): RunCommitKind {
        return verdictCommitKind;
    }

    public static get undo(): RunCommitKind {
        return undoCommitKind;
    }

    protected constructor(
        public readonly name: string,
        public readonly minimumParents: number
    ) {
    }

    public validateParents(parents: readonly RunCommitId[]): void {
        if (parents.length < this.minimumParents) {
            throw new TypeError(`${this.name} RunCommits require at least ${this.minimumParents} parent(s)`);
        }
    }

    public equals(other: RunCommitKind): boolean {
        return this === other;
    }
}

class CommitKind extends RunCommitKind {
    public constructor(name: string, minimumParents: number) {
        super(name, minimumParents);
    }
}

const inputCommitKind = new CommitKind("input", 0);
const messageCommitKind = new CommitKind("message", 1);
const checkpointCommitKind = new CommitKind("checkpoint", 1);
const invocationCommitKind = new CommitKind("invocation", 1);
const eventCommitKind = new CommitKind("event", 1);
const resultCommitKind = new CommitKind("result", 1);
const mergeCommitKind = new CommitKind("merge", 2);
const verdictCommitKind = new CommitKind("verdict", 1);
const undoCommitKind = new CommitKind("undo", 1);

export class TurnOutcome {
    public constructor(
        public readonly status: TurnStatus,
        public readonly resultRef: ContentRef | undefined
    ) {
        if (!status.terminal) {
            throw new TypeError("Turn outcomes require a terminal status");
        }
    }

    public static succeeded(resultRef: ContentRef | undefined): TurnOutcome {
        return new TurnOutcome(TurnStatus.succeeded, resultRef);
    }

    public static failed(resultRef: ContentRef | undefined): TurnOutcome {
        return new TurnOutcome(TurnStatus.failed, resultRef);
    }

    public static cancelled(resultRef: ContentRef | undefined = undefined): TurnOutcome {
        return new TurnOutcome(TurnStatus.cancelled, resultRef);
    }

    public static interrupted(resultRef: ContentRef | undefined = undefined): TurnOutcome {
        return new TurnOutcome(TurnStatus.interrupted, resultRef);
    }
}

export class TurnSuspension {
    public constructor(
        public readonly checkpointRef: ContentRef,
        public readonly leaseEpoch: number
    ) {
        if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 0) {
            throw new TypeError("Turn suspension lease epoch must be a non-negative safe integer");
        }
    }
}

export class RunCommit {
    public readonly parents: readonly RunCommitId[];

    public constructor(
        public readonly id: RunCommitId,
        public readonly runId: RunId,
        public readonly branchId: RunBranchId,
        public readonly kind: RunCommitKind,
        parents: readonly RunCommitId[],
        public readonly contentRef: ContentRef | undefined,
        public readonly contentDigest: Digest | undefined,
        public readonly turnId: TurnId | undefined,
        public readonly revision: Revision
    ) {
        kind.validateParents(parents);
        this.parents = Object.freeze([...parents]);
    }
}

export class RunBranch {
    public constructor(
        public readonly id: RunBranchId,
        public readonly runId: RunId,
        public readonly name: string,
        public readonly head: RunCommitId,
        public readonly revision: Revision
    ) {
        if (name.length === 0 || name.length > 256) {
            throw new TypeError("Run branch name must contain between 1 and 256 characters");
        }
    }

    public move(head: RunCommitId): RunBranch {
        return new RunBranch(this.id, this.runId, this.name, head, this.revision.next());
    }
}

export class Run {
    public constructor(
        public readonly id: RunId,
        public readonly workspaceId: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly agentId: AgentId,
        public readonly taskId: TaskId | undefined,
        public readonly subscriptionId: SubscriptionId | undefined,
        public readonly parentId: RunId | undefined,
        public readonly predecessorId: RunId | undefined,
        public readonly status: RunStatus,
        public readonly environmentPin: EnvironmentPin | undefined,
        public readonly inputRef: ContentRef,
        public readonly rootBranchId: RunBranchId,
        public readonly rootCommitId: RunCommitId,
        public readonly activeBranchId: RunBranchId,
        public readonly resultRef: ContentRef | undefined,
        public readonly revision: Revision
    ) {
    }

    public get active(): boolean {
        return this.status.allowsWork;
    }

    public complete(resultRef: ContentRef | undefined): Run {
        return this.transition(this.status.complete(), resultRef);
    }

    public cancel(): Run {
        return this.transition(this.status.cancel(), this.resultRef);
    }

    public moveActiveBranch(branchId: RunBranchId): Run {
        return this.revise(this.status, branchId, this.resultRef);
    }

    private transition(status: RunStatus, resultRef: ContentRef | undefined): Run {
        return this.revise(status, this.activeBranchId, resultRef);
    }

    private revise(status: RunStatus, activeBranchId: RunBranchId, resultRef: ContentRef | undefined): Run {
        return new Run(
            this.id,
            this.workspaceId,
            this.tenantId,
            this.agentId,
            this.taskId,
            this.subscriptionId,
            this.parentId,
            this.predecessorId,
            status,
            this.environmentPin,
            this.inputRef,
            this.rootBranchId,
            this.rootCommitId,
            activeBranchId,
            resultRef,
            this.revision.next()
        );
    }
}

export class Turn {
    public constructor(
        public readonly id: TurnId,
        public readonly runId: RunId,
        public readonly branchId: RunBranchId,
        public readonly role: TurnRole,
        public readonly layer: number,
        public readonly status: TurnStatus,
        public readonly lease: TurnLease,
        public readonly inputRef: ContentRef,
        public readonly suspension: TurnSuspension | undefined,
        public readonly outcome: TurnOutcome | undefined
    ) {
        if (!Number.isSafeInteger(layer) || layer < 0) {
            throw new TypeError("Turn layer must be a non-negative safe integer");
        }
    }

    public get terminal(): boolean {
        return this.status.terminal;
    }

    public claim(holderId: PrincipalId, expiresAt: Date, now: Date): Turn {
        const nextStatus = this.status.claim();
        return this.transition(nextStatus, this.lease.claim(holderId, expiresAt, now), undefined, this.outcome);
    }

    public renewLease(commit: TurnLeaseCommit, expiresAt: Date, now: Date): Turn {
        this.status.requireRunning("Turn lease renewal requires a running Turn");
        return this.transition(TurnStatus.running, this.lease.renew(commit.holderId, commit.epoch, expiresAt, now), undefined, this.outcome);
    }

    public suspend(commit: TurnLeaseCommit, checkpointRef: ContentRef, now: Date): Turn {
        this.status.requireRunning("Turn suspension requires a running Turn");
        this.ensureHeldBy(commit, now, "Turn suspension requires the current lease");
        return this.transition(TurnStatus.suspended, this.lease.fence(), new TurnSuspension(checkpointRef, commit.epoch), this.outcome);
    }

    public complete(commit: TurnLeaseCommit, outcome: TurnOutcome, now: Date): Turn {
        this.status.requireRunning("Turn completion requires a running Turn");
        this.ensureHeldBy(commit, now, "Turn completion requires the current lease");
        return this.transition(outcome.status, this.lease.fence(), undefined, outcome);
    }

    public commitLease(commit: TurnLeaseCommit, now: Date): void {
        this.ensureHeldBy(commit, now, "Turn commit requires the current lease");
    }

    private ensureHeldBy(commit: TurnLeaseCommit, now: Date, message: string): void {
        if (!commit.isHeldBy(this.lease, now)) {
            throw new AgentCoreError("lease.invalid", message);
        }
    }

    private transition(
        status: TurnStatus,
        lease: TurnLease,
        suspension: TurnSuspension | undefined,
        outcome: TurnOutcome | undefined
    ): Turn {
        return new Turn(
            this.id,
            this.runId,
            this.branchId,
            this.role,
            this.layer,
            status,
            lease,
            this.inputRef,
            suspension,
            outcome
        );
    }
}
