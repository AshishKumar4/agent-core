import { Revision } from "../../core";
import { requireSynchronousResult } from "../../actors";
import { AgentCoreError } from "../../errors";
import type { PrincipalId } from "../../identity";
import type { RunCommitId, TurnId } from "../../execution-references";
import type { ReceiptId } from "../../invocation-references";
import type { AuditRecordId, EventId } from "../../interaction-references";
import type { RunSourceRevisionPort } from "../source";
import { bytesEqual } from "../record-data";
import { RunCommit, validateCommitWriter } from "./commit";
import {
    RunAdmissionRegistry,
    type RunAdmissionReservation,
    type RunObligation
} from "./admission";
import type { RunEvidencePort, RunMergePort } from "./evidence";
import { ForcedTurnCancellation } from "./forced-cancellation";
import type { RunBranchId, RunId } from "./id";
import type { LeaseToken } from "./lease";
import { RunConfigurationSnapshot, RunPins } from "./pins";
import { TurnPlacementSnapshot } from "./placement";
import { Run, RunBranch, RunLifecycle } from "./run";
import { RunSpawnPort, SpawnReservation, SpawnReservationCodec } from "./spawn";
import {
    SettlementEvidencePort,
    SettlementObligation,
    TerminalSnapshot,
    isSettled,
    type RunOutcome,
    type SettlementAuditObligation
} from "./settlement";
import { RunRepository } from "./store";
import { RunCheckpoint, Turn, TurnInboxEntry, type TurnTerminalStatus } from "./turn";

export interface RunGenesis {
    readonly run: Run;
    readonly configuration: RunConfigurationSnapshot;
    readonly branch: RunBranch;
    readonly root: RunCommit;
}

export interface TurnGenesis {
    readonly turn: Turn;
    readonly placement: TurnPlacementSnapshot;
}

export interface SuspendTurnRequest {
    readonly turn: TurnId;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly checkpoint: RunCheckpoint;
    readonly commit: RunCommit;
    readonly now: Date;
}

export interface CompleteTurnRequest {
    readonly turn: TurnId;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly outcome: TurnTerminalStatus;
    readonly commit: RunCommit;
    readonly now: Date;
}

export interface TerminalizeRunRequest {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly expectedRunRevision: Revision;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly outcome: RunOutcome;
    readonly commit: RunCommit;
    readonly forcedCancellationControl?: ForcedCancellationControl;
    readonly siblingCancellations: ReadonlyMap<string, SiblingCancellationEvidence>;
    readonly requiredAudits?: readonly SettlementAuditObligation[];
    readonly now: Date;
}

export interface ForcedCancellationControl {
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
}

export interface SiblingCancellationEvidence {
    readonly event: EventId;
    readonly audit: AuditRecordId;
}

export class RunRuntime<Transaction> {
    public constructor(
        public readonly repository: RunRepository<Transaction>,
        private readonly sources: RunSourceRevisionPort<Transaction, RunConfigurationSnapshot>,
        private readonly evidence: RunEvidencePort<Transaction>,
        private readonly settlement: SettlementEvidencePort<Transaction>,
        private readonly spawn: RunSpawnPort<Transaction>,
        private readonly merge: RunMergePort<Transaction>
    ) {}

    public createRun(genesis: RunGenesis): void {
        this.repository.transaction((tx) => this.createRunInTransaction(tx, genesis));
    }

    public spawnRun(reservation: SpawnReservation, genesis: RunGenesis, now: Date): void {
        this.repository.transaction((tx) =>
            this.spawnRunInTransaction(tx, reservation, genesis, now)
        );
    }

    public spawnRunInTransaction(
        tx: Transaction,
        reservation: SpawnReservation,
        genesis: RunGenesis,
        now: Date
    ): void {
        const existing = this.repository.loadSpawn(tx, reservation.id);
        if (existing !== undefined) {
            const child = this.repository.loadRun(tx, reservation.childRun);
            if (
                bytesEqual(
                    SpawnReservationCodec.encode(existing),
                    SpawnReservationCodec.encode(reservation)
                ) &&
                child !== undefined &&
                child.configuration.equals(reservation.configuration)
            )
                return;
            throw new AgentCoreError("run.invalid-state", "Spawn reservation identity conflicts");
        }
        const parent = this.requireActiveRun(tx, reservation.parentRun);
        const turn = requireValue(
            this.repository.loadTurn(tx, reservation.parentTurn),
            "Spawning Turn does not exist"
        );
        turn.requireToken(reservation.token, now);
        if (
            !turn.run.equals(parent.id) ||
            !genesis.run.id.equals(reservation.childRun) ||
            !genesis.run.parent?.equals(parent.id) ||
            !genesis.configuration.id.equals(reservation.configuration) ||
            !genesis.root.content?.equals(reservation.rootContent) ||
            requireSynchronousResult(this.spawn.verify(tx, reservation)) !== true
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Spawn reservation is not an exact attenuated child genesis"
            );
        }
        this.repository.insertSpawn(tx, reservation);
        this.createRunInTransaction(tx, genesis);
    }

    public createRunInTransaction(tx: Transaction, genesis: RunGenesis): void {
        if (
            !genesis.run.configuration.equals(genesis.configuration.id) ||
            !genesis.run.root.equals(genesis.root.id) ||
            !genesis.run.initialBranch.equals(genesis.branch.id) ||
            !genesis.root.run.equals(genesis.run.id) ||
            !genesis.root.branch.equals(genesis.branch.id) ||
            !genesis.branch.run.equals(genesis.run.id) ||
            !genesis.branch.head.equals(genesis.root.id) ||
            genesis.run.lifecycle.kind !== "active" ||
            genesis.run.revision.value !== 0 ||
            genesis.branch.revision.value !== 0 ||
            genesis.root.kind !== "root" ||
            genesis.root.writer.kind !== "root" ||
            !genesis.root.pins.equals(genesis.configuration.pins)
        ) {
            throw invalidRun("Run genesis records do not form one canonical root");
        }
        if (!genesis.run.agent.equals(genesis.configuration.pins.agent.id)) {
            throw invalidRun("Run Agent does not match its configuration snapshot");
        }
        if (
            requireSynchronousResult(this.sources.verify(tx, genesis.configuration)) !== true ||
            requireSynchronousResult(
                this.sources.verifyPackageClosure(tx, genesis.configuration)
            ) !== true
        ) {
            throw invalidRun(
                "Run configuration does not resolve exact authoritative source revisions"
            );
        }
        if (
            this.repository.loadRun(tx, genesis.run.id) !== undefined ||
            this.repository.loadCommit(tx, genesis.root.id) !== undefined ||
            this.repository.loadBranch(tx, genesis.branch.id) !== undefined ||
            this.repository.loadAdmission(tx, genesis.run.id) !== undefined
        ) {
            throw new AgentCoreError("run.invalid-state", "Run genesis identifiers already exist");
        }
        this.repository.insertConfiguration(tx, genesis.configuration);
        this.repository.insertRun(tx, genesis.run);
        this.repository.insertCommit(tx, genesis.root);
        this.repository.insertBranch(tx, genesis.branch);
        this.repository.insertAdmission(tx, RunAdmissionRegistry.initial(genesis.run.id));
    }

    public reserveRunObligation(run: RunId, obligation: RunObligation): RunAdmissionReservation {
        return this.repository.transaction((tx) =>
            this.reserveRunObligationInTransaction(tx, run, obligation)
        );
    }

    public reserveRunObligationInTransaction(
        tx: Transaction,
        run: RunId,
        obligation: RunObligation
    ): RunAdmissionReservation {
        this.requireActiveRun(tx, run);
        const registry = this.requireAdmission(tx, run);
        const reserved = registry.reserve(obligation);
        if (reserved.registry !== registry) {
            this.repository.replaceAdmission(tx, registry, reserved.registry);
        }
        return reserved.reservation;
    }

    public completeRunObligation(reservation: RunAdmissionReservation): void {
        this.repository.transaction((tx) =>
            this.completeRunObligationInTransaction(tx, reservation)
        );
    }

    public completeRunObligationInTransaction(
        tx: Transaction,
        reservation: RunAdmissionReservation
    ): void {
        const registry = this.requireAdmission(tx, reservation.run);
        const completed = registry.complete(reservation);
        if (completed !== registry) this.repository.replaceAdmission(tx, registry, completed);
    }

    public acceptsRunAdmission(reservation: RunAdmissionReservation): boolean {
        return this.repository.transaction((tx) =>
            this.acceptsRunAdmissionInTransaction(tx, reservation)
        );
    }

    public acceptsRunAdmissionInTransaction(
        tx: Transaction,
        reservation: RunAdmissionReservation
    ): boolean {
        return this.repository.loadAdmission(tx, reservation.run)?.accepts(reservation) === true;
    }

    public createBranch(runId: RunId, branch: RunBranch, expectedRunRevision: Revision): void {
        this.repository.transaction((tx) =>
            this.createBranchInTransaction(tx, runId, branch, expectedRunRevision)
        );
    }

    public createBranchInTransaction(
        tx: Transaction,
        runId: RunId,
        branch: RunBranch,
        expectedRunRevision: Revision
    ): void {
        const run = this.requireActiveRun(tx, runId);
        requireRevision(run.revision, expectedRunRevision);
        const head = this.repository.loadCommit(tx, branch.head);
        if (
            !branch.run.equals(runId) ||
            branch.revision.value !== 0 ||
            head === undefined ||
            !head.run.equals(runId) ||
            this.repository
                .listBranches(tx)
                .some((existing) => existing.run.equals(runId) && existing.name === branch.name) ||
            this.repository.loadBranch(tx, branch.id) !== undefined
        ) {
            throw invalidRun("Run branch creation is invalid");
        }
        this.repository.insertBranch(tx, branch);
        this.repository.replaceRun(tx, run.revision, run.revise());
    }

    public appendCommit(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void {
        this.repository.transaction((tx) =>
            this.appendCommitInTransaction(tx, commit, expectedBranchRevision, now)
        );
    }

    public appendCommitInTransaction(
        tx: Transaction,
        commit: RunCommit,
        expectedBranchRevision: Revision,
        now: Date
    ): void {
        if (commit.kind === "migration") {
            throw invalidRun("Migration requires an exact verified target configuration snapshot");
        }
        this.appendInTransaction(tx, commit, expectedBranchRevision, now);
    }

    public migrateRun(
        commit: RunCommit,
        target: RunConfigurationSnapshot,
        expectedBranchRevision: Revision,
        now: Date
    ): void {
        this.repository.transaction((tx) =>
            this.migrateRunInTransaction(tx, commit, target, expectedBranchRevision, now)
        );
    }

    public migrateRunInTransaction(
        tx: Transaction,
        commit: RunCommit,
        target: RunConfigurationSnapshot,
        expectedBranchRevision: Revision,
        now: Date
    ): void {
        const run = this.requireActiveRun(tx, commit.run);
        if (
            commit.kind !== "migration" ||
            !commit.migration?.to.equals(target.pins) ||
            !target.pins.agent.id.equals(run.agent) ||
            requireSynchronousResult(this.sources.verify(tx, target)) !== true ||
            requireSynchronousResult(this.sources.verifyPackageClosure(tx, target)) !== true
        ) {
            throw invalidRun(
                "Migration target does not resolve an exact authoritative configuration"
            );
        }
        this.repository.insertConfiguration(tx, target);
        this.appendInTransaction(tx, commit, expectedBranchRevision, now);
        const migrated = requireValue(
            this.repository.loadRun(tx, run.id),
            "Migrated Run does not exist"
        );
        const withConfiguration = migrated.recordConfiguration(target.id);
        if (withConfiguration !== migrated) {
            this.repository.replaceRun(tx, migrated.revision, withConfiguration);
        }
    }

    public appendCapturedEvidence(
        commit: RunCommit,
        expectedBranchRevision: Revision,
        now: Date
    ): void {
        this.repository.transaction((tx) =>
            this.appendCapturedEvidenceInTransaction(tx, commit, expectedBranchRevision, now)
        );
    }

    public appendCapturedEvidenceInTransaction(
        tx: Transaction,
        commit: RunCommit,
        expectedBranchRevision: Revision,
        now: Date
    ): void {
        const run = requireValue(this.repository.loadRun(tx, commit.run), "Run does not exist");
        if (
            run.lifecycle.kind !== "terminal" ||
            run.terminal === undefined ||
            !run.terminal.obligation.obligations.some(
                (obligation) =>
                    obligation.kind === "systemCommit" && obligation.commit.equals(commit.id)
            ) ||
            commit.writer.kind !== "system" ||
            (commit.kind !== "invocation" && commit.kind !== "eventDelivery")
        ) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Post-terminal commit is not a captured obligation"
            );
        }
        this.appendInTransaction(tx, commit, expectedBranchRevision, now, true);
    }

    public createTurn(genesis: TurnGenesis, expectedBranchRevision: Revision): void {
        this.repository.transaction((tx) =>
            this.createTurnInTransaction(tx, genesis, expectedBranchRevision)
        );
    }

    public createTurnInTransaction(
        tx: Transaction,
        genesis: TurnGenesis,
        expectedBranchRevision: Revision
    ): void {
        const run = this.requireActiveRun(tx, genesis.turn.run);
        const branch = requireValue(
            this.repository.loadBranch(tx, genesis.turn.branch),
            "Turn branch does not exist"
        );
        requireRevision(branch.revision, expectedBranchRevision);
        const head = requireValue(
            this.repository.loadCommit(tx, branch.head),
            "Turn branch head is missing"
        );
        this.requireConfigurationForPins(tx, run, head.pins);
        if (
            !branch.run.equals(run.id) ||
            genesis.turn.status.kind !== "queued" ||
            genesis.turn.revision.value !== 0 ||
            genesis.turn.lease.holder !== undefined ||
            genesis.turn.lease.epoch !== 0 ||
            genesis.turn.lease.expiresAt !== undefined ||
            genesis.turn.checkpoint !== undefined ||
            genesis.turn.result !== undefined ||
            !genesis.turn.startHead.equals(branch.head) ||
            !genesis.turn.pins.equals(head.pins) ||
            !genesis.placement.turn.equals(genesis.turn.id) ||
            !genesis.placement.pins.equals(genesis.turn.pins) ||
            !genesis.placement.digest.equals(genesis.turn.placement) ||
            !this.effectiveCommitInTransaction(tx, branch.head).equals(
                genesis.turn.effectiveInput
            ) ||
            this.repository.loadTurn(tx, genesis.turn.id) !== undefined
        ) {
            throw invalidTurn("Turn genesis does not match its branch and placement snapshot");
        }
        this.repository.insertPlacement(tx, genesis.placement);
        this.repository.insertTurn(tx, genesis.turn);
        this.repository.replaceRun(tx, run.revision, run.revise());
    }

    public claimTurn(
        turnId: TurnId,
        expected: Revision,
        holder: PrincipalId,
        now: Date,
        expiresAt: Date
    ): Turn {
        return this.repository.transaction((tx) =>
            this.claimTurnInTransaction(tx, turnId, expected, holder, now, expiresAt)
        );
    }

    public claimTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        holder: PrincipalId,
        now: Date,
        expiresAt: Date
    ): Turn {
        return this.updateTurnInTransaction(tx, turnId, expected, (turn) =>
            turn.claim(holder, now, expiresAt)
        );
    }

    public renewTurn(
        turnId: TurnId,
        expected: Revision,
        token: LeaseToken,
        now: Date,
        expiresAt: Date
    ): Turn {
        return this.repository.transaction((tx) =>
            this.renewTurnInTransaction(tx, turnId, expected, token, now, expiresAt)
        );
    }

    public renewTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        token: LeaseToken,
        now: Date,
        expiresAt: Date
    ): Turn {
        return this.updateTurnInTransaction(tx, turnId, expected, (turn) =>
            turn.renew(token, now, expiresAt)
        );
    }

    public reclaimTurn(
        turnId: TurnId,
        expected: Revision,
        holder: PrincipalId,
        now: Date,
        expiresAt: Date,
        cancellation: TurnInboxEntry
    ): Turn {
        return this.repository.transaction((tx) =>
            this.reclaimTurnInTransaction(
                tx,
                turnId,
                expected,
                holder,
                now,
                expiresAt,
                cancellation
            )
        );
    }

    public reclaimTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        holder: PrincipalId,
        now: Date,
        expiresAt: Date,
        cancellation: TurnInboxEntry
    ): Turn {
        return this.updateTurnInTransaction(tx, turnId, expected, (turn) => {
            const displaced = currentToken(turn);
            this.appendCancellation(tx, turn, cancellation, displaced);
            return turn.reclaim(holder, now, expiresAt);
        });
    }

    public cancelUnheldTurn(turnId: TurnId, expected: Revision): Turn {
        return this.repository.transaction((tx) =>
            this.cancelUnheldTurnInTransaction(tx, turnId, expected)
        );
    }

    public cancelUnheldTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision
    ): Turn {
        return this.updateTurnInTransaction(tx, turnId, expected, (turn) => turn.cancelUnheld());
    }

    public deliverEvent(
        turnId: TurnId,
        expected: Revision,
        token: LeaseToken,
        entry: TurnInboxEntry,
        now: Date
    ): void {
        this.repository.transaction((tx) =>
            this.deliverEventInTransaction(tx, turnId, expected, token, entry, now)
        );
    }

    public deliverEventInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        token: LeaseToken,
        entry: TurnInboxEntry,
        now: Date
    ): void {
        const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
        requireRevision(turn.revision, expected);
        turn.requireToken(token, now);
        const inbox = this.repository.listInbox(tx, turnId);
        if (
            entry.event === "turn.cancel" ||
            !entry.turn.equals(turnId) ||
            entry.sequence !== inbox.length ||
            inbox.some((existing) => existing.idempotencyKey === entry.idempotencyKey)
        ) {
            throw invalidTurn("Inbox entry does not have the next Turn sequence");
        }
        this.repository.insertInbox(tx, entry);
        this.repository.replaceTurn(tx, turn.revision, turn.revise());
    }

    public suspendTurn(request: SuspendTurnRequest): void {
        this.repository.transaction((tx) => this.suspendTurnInTransaction(tx, request));
    }

    public suspendTurnInTransaction(tx: Transaction, request: SuspendTurnRequest): void {
        const turn = this.requireTurnAndBranch(
            tx,
            request.turn,
            request.expectedTurnRevision,
            request.expectedBranchRevision
        );
        if (
            !request.checkpoint.turn.equals(turn.id) ||
            !request.checkpoint.commit.equals(request.commit.id) ||
            request.commit.kind !== "checkpoint" ||
            !request.commit.subjectTurn?.equals(turn.id) ||
            request.commit.writer.kind !== "turn" ||
            !tokensEqual(request.commit.writer.token, request.token) ||
            !request.commit.content?.equals(request.checkpoint.state) ||
            !optionalRefsEqual(request.commit.treeCheckpoint, request.checkpoint.tree) ||
            request.checkpoint.inboxCursor > this.repository.listInbox(tx, turn.id).length
        ) {
            throw invalidTurn("Suspend checkpoint and commit do not match the Turn");
        }
        this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
        this.repository.insertCheckpoint(tx, request.checkpoint);
        this.repository.replaceTurn(
            tx,
            turn.revision,
            turn.suspend(request.token, request.checkpoint.id, request.now)
        );
    }

    public completeTurn(request: CompleteTurnRequest): void {
        this.repository.transaction((tx) => this.completeTurnInTransaction(tx, request));
    }

    public completeTurnInTransaction(tx: Transaction, request: CompleteTurnRequest): void {
        const turn = this.requireTurnAndBranch(
            tx,
            request.turn,
            request.expectedTurnRevision,
            request.expectedBranchRevision
        );
        if (
            request.commit.kind !== "result" ||
            request.commit.content === undefined ||
            !request.commit.subjectTurn?.equals(turn.id) ||
            request.commit.writer.kind !== "turn" ||
            !tokensEqual(request.commit.writer.token, request.token)
        ) {
            throw invalidTurn("Turn completion requires a result commit");
        }
        this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
        this.repository.replaceTurn(
            tx,
            turn.revision,
            turn.complete(request.token, request.outcome, request.commit.content, request.now)
        );
    }

    public cancelHeldTurn(request: CompleteTurnRequest, cancellation: TurnInboxEntry): void {
        this.repository.transaction((tx) =>
            this.cancelHeldTurnInTransaction(tx, request, cancellation)
        );
    }

    public cancelHeldTurnInTransaction(
        tx: Transaction,
        request: CompleteTurnRequest,
        cancellation: TurnInboxEntry
    ): void {
        if (request.outcome !== "cancelled") {
            throw invalidTurn("Held cancellation requires a cancelled result");
        }
        const turn = this.requireTurnAndBranch(
            tx,
            request.turn,
            request.expectedTurnRevision,
            request.expectedBranchRevision
        );
        this.appendCancellation(tx, turn, cancellation, request.token);
        this.completeTurnInTransaction(tx, request);
    }

    public timeoutTurn(
        turnId: TurnId,
        expected: Revision,
        cancellation: TurnInboxEntry,
        now: Date
    ): Turn {
        return this.repository.transaction((tx) =>
            this.timeoutTurnInTransaction(tx, turnId, expected, cancellation, now)
        );
    }

    public timeoutTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        cancellation: TurnInboxEntry,
        now: Date
    ): Turn {
        return this.updateTurnInTransaction(tx, turnId, expected, (turn) => {
            const expiresAt = turn.lease.expiresAt?.getTime();
            if (
                turn.status.kind !== "running" ||
                expiresAt === undefined ||
                expiresAt > now.getTime()
            ) {
                throw new AgentCoreError(
                    "turn.invalid-state",
                    "Turn timeout requires an expired running lease"
                );
            }
            const displaced = currentToken(turn);
            this.appendCancellation(tx, turn, cancellation, displaced);
            return turn.forceCancel();
        });
    }

    public terminalizeRun(request: TerminalizeRunRequest): TerminalSnapshot {
        return this.repository.transaction((tx) => this.terminalizeRunInTransaction(tx, request));
    }

    public terminalizeRunInTransaction(
        tx: Transaction,
        request: TerminalizeRunRequest
    ): TerminalSnapshot {
        const run = this.requireActiveRun(tx, request.run);
        requireRevision(run.revision, request.expectedRunRevision);
        const turn = this.requireTurnAndBranch(
            tx,
            request.turn,
            request.expectedTurnRevision,
            request.expectedBranchRevision
        );
        turn.requireToken(request.token, request.now);
        if (
            !turn.run.equals(run.id) ||
            request.commit.kind !== "result" ||
            !request.commit.subjectTurn?.equals(turn.id)
        ) {
            throw invalidRun("Terminal result does not match the finishing Turn");
        }
        const forcedSiblings = this.forceCancelSiblings(tx, request, run, turn);
        const branch = requireValue(
            this.repository.loadBranch(tx, turn.branch),
            "Terminal branch is missing"
        );
        const preterminal = branch.head;
        const registry = this.requireAdmission(tx, run.id);
        this.validateTerminalSiblings(tx, run.id, turn.id, forcedSiblings);
        const closedRegistry = registry.close();
        if (closedRegistry === registry) {
            throw invalidRun("Run admission registry is already closed");
        }
        this.repository.replaceAdmission(tx, registry, closedRegistry);
        const obligation = new SettlementObligation({
            registryEpoch: closedRegistry.epoch,
            obligations: closedRegistry.frontier(),
            requiredAudits: request.requiredAudits ?? []
        });
        this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
        const completed = turn.complete(
            request.token,
            request.outcome,
            request.commit.content!,
            request.now
        );
        this.repository.replaceTurn(tx, turn.revision, completed);
        const snapshot = new TerminalSnapshot(
            run.id,
            turn.id,
            preterminal,
            request.commit.id,
            request.outcome,
            obligation,
            request.now
        );
        const currentRun = requireValue(
            this.repository.loadRun(tx, run.id),
            "Run disappeared during terminalization"
        );
        this.repository.replaceRun(tx, currentRun.revision, currentRun.terminalize(snapshot));
        return snapshot;
    }

    public settled(runId: RunId): boolean {
        return this.repository.transaction((tx) => this.settledInTransaction(tx, runId));
    }

    public settledInTransaction(tx: Transaction, runId: RunId): boolean {
        const run = requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
        return (
            run.terminal !== undefined && isSettled(tx, run.terminal.obligation, this.settlement)
        );
    }

    public effectiveCommit(runId: RunId, branchId: RunBranchId): RunCommitId {
        return this.repository.transaction((tx) =>
            this.effectiveBranchCommitInTransaction(tx, runId, branchId)
        );
    }

    public effectiveBranchCommitInTransaction(
        tx: Transaction,
        runId: RunId,
        branchId: RunBranchId
    ): RunCommitId {
        const branch = requireValue(
            this.repository.loadBranch(tx, branchId),
            "Run branch does not exist"
        );
        if (!branch.run.equals(runId)) throw invalidRun("Run branch belongs to another Run");
        return this.effectiveCommitInTransaction(tx, branch.head);
    }

    private appendInTransaction(
        tx: Transaction,
        commit: RunCommit,
        expectedBranchRevision: Revision,
        now: Date,
        allowTerminal = false
    ): void {
        const run = requireValue(this.repository.loadRun(tx, commit.run), "Run does not exist");
        if (!allowTerminal && run.lifecycle.kind !== "active") {
            throw new AgentCoreError("run.invalid-state", "Terminal Runs reject ordinary commits");
        }
        const branch = requireValue(
            this.repository.loadBranch(tx, commit.branch),
            "Run branch does not exist"
        );
        requireRevision(branch.revision, expectedBranchRevision);
        if (!branch.run.equals(run.id) || this.repository.loadCommit(tx, commit.id) !== undefined) {
            throw invalidRun("Run commit target is invalid");
        }
        if (commit.kind === "merge") this.validateMerge(tx, commit, branch);
        else if (commit.parents.length !== 1 || !commit.parents[0]!.equals(branch.head)) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Run commit parent is not the current branch head"
            );
        }
        const parent = requireValue(
            this.repository.loadCommit(tx, commit.parents[0]!),
            "Run commit parent does not exist"
        );
        if (!parent.run.equals(run.id))
            throw invalidRun("Run commit parent belongs to another Run");
        if (commit.kind === "migration") {
            if (!commit.migration?.from.equals(parent.pins)) {
                throw invalidRun("Migration from pins do not match the parent");
            }
            const admitted = this.repository
                .listTurns(tx)
                .some(
                    (turn) =>
                        turn.run.equals(run.id) &&
                        turn.branch.equals(branch.id) &&
                        !isTerminalTurn(turn)
                );
            if (admitted)
                throw new AgentCoreError(
                    "run.invalid-state",
                    "Migration rejects an admitted Turn on its branch"
                );
        } else if (!commit.pins.equals(parent.pins)) {
            throw invalidRun("Non-migration Run commit must inherit parent pins");
        }
        if (commit.writer.kind === "turn") {
            const turn = requireValue(
                this.repository.loadTurn(tx, commit.writer.token.turn),
                "Commit Turn does not exist"
            );
            if (
                !turn.run.equals(run.id) ||
                !turn.branch.equals(branch.id) ||
                !turn.pins.equals(commit.pins)
            ) {
                throw invalidRun("Turn writer does not belong to the commit lineage");
            }
            turn.requireToken(commit.writer.token, now);
        }
        if (
            commit.kind === "undo" &&
            !this.repository.isAncestor(tx, commit.selects!, branch.head)
        ) {
            throw invalidRun("Undo selection must be an ancestor of the current head");
        }
        if (
            commit.kind === "undo" &&
            this.repository.listTurns(tx).some((turn) => {
                return (
                    turn.run.equals(run.id) &&
                    turn.branch.equals(branch.id) &&
                    turn.status.kind === "running" &&
                    turn.lease.holder !== undefined
                );
            })
        ) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Undo requires the in-flight Turn to be fenced first"
            );
        }
        validateCommitWriter(tx, commit, this.evidence);
        this.repository.insertCommit(tx, commit);
        this.repository.replaceBranch(tx, branch.revision, branch.advance(commit.id));
        this.repository.replaceRun(
            tx,
            run.revision,
            allowTerminal ? run.recordEvidence() : run.revise()
        );
    }

    private validateMerge(tx: Transaction, commit: RunCommit, target: RunBranch): void {
        if (
            !commit.parents[0]?.equals(target.head) ||
            commit.parents[1] === undefined ||
            commit.parents[0].equals(commit.parents[1])
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Merge parents are not distinct ordered current heads"
            );
        }
        const source = this.repository
            .listBranches(tx)
            .find(
                (branch) =>
                    !branch.id.equals(target.id) &&
                    branch.run.equals(target.run) &&
                    branch.head.equals(commit.parents[1]!)
            );
        const targetCommit = this.repository.loadCommit(tx, target.head);
        const sourceCommit = this.repository.loadCommit(tx, commit.parents[1]);
        if (
            source === undefined ||
            targetCommit === undefined ||
            sourceCommit === undefined ||
            !targetCommit.pins.equals(sourceCommit.pins) ||
            !commit.pins.equals(targetCommit.pins)
        ) {
            throw invalidRun("Merge requires equal-pinned current heads from distinct branches");
        }
        const parentIds = commit.parents.map((parent) => parent.value);
        if (commit.resolution?.kind === "pick") {
            const pickedIndex = parentIds.indexOf(commit.resolution.parent.value);
            const picked = pickedIndex < 0 ? undefined : [targetCommit, sourceCommit][pickedIndex];
            if (
                picked?.content === undefined ||
                commit.content === undefined ||
                !picked.content.equals(commit.content)
            ) {
                throw invalidRun("Pick resolution must copy one exact parent content");
            }
        }
        if (
            commit.resolution?.kind === "concat" &&
            requireSynchronousResult(
                this.merge.verifyConcat(tx, commit, targetCommit, sourceCommit)
            ) !== true
        ) {
            throw invalidRun("Concat resolution does not match canonical parent-order content");
        }
        const tree = commit.treeResolution;
        if (tree !== undefined) {
            if (
                (tree.policy === "ours" && !tree.side.equals(commit.parents[0]!)) ||
                (tree.policy === "theirs" && !tree.side.equals(commit.parents[1]!)) ||
                (tree.policy === "perPath" &&
                    tree.resolutions.some((path) => !parentIds.includes(path.side.value)))
            ) {
                throw invalidRun("Tree resolution sides must name the ordered merge parents");
            }
            if (tree.policy === "ours" || tree.policy === "theirs") {
                const selected = tree.policy === "ours" ? targetCommit : sourceCommit;
                if (
                    selected.treeCheckpoint === undefined ||
                    commit.treeCheckpoint === undefined ||
                    !selected.treeCheckpoint.equals(commit.treeCheckpoint)
                ) {
                    throw invalidRun("Tree side resolution must copy the selected parent tree");
                }
            }
            if (
                requireSynchronousResult(
                    this.merge.verifyTree(tx, commit, targetCommit, sourceCommit)
                ) !== true
            ) {
                throw invalidRun(
                    "Tree resolution lacks exact base, Environment, or conflict evidence"
                );
            }
        }
    }

    private updateTurnInTransaction(
        tx: Transaction,
        turnId: TurnId,
        expected: Revision,
        update: (turn: Turn) => Turn
    ): Turn {
        const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
        requireRevision(turn.revision, expected);
        const run = this.requireActiveRun(tx, turn.run);
        const next = update(turn);
        this.repository.replaceTurn(tx, turn.revision, next);
        this.repository.replaceRun(tx, run.revision, run.revise());
        return next;
    }

    private appendCancellation(
        tx: Transaction,
        turn: Turn,
        entry: TurnInboxEntry,
        displaced: LeaseToken
    ): void {
        const inbox = this.repository.listInbox(tx, turn.id);
        if (
            entry.event !== "turn.cancel" ||
            !entry.turn.equals(turn.id) ||
            entry.sequence !== inbox.length ||
            entry.cancellationToken === undefined ||
            !tokensEqual(entry.cancellationToken, displaced) ||
            inbox.some((existing) => existing.idempotencyKey === entry.idempotencyKey)
        ) {
            throw invalidTurn(
                "Turn cancellation must append the next entry for the displaced token"
            );
        }
        this.repository.insertInbox(tx, entry);
    }

    private forceCancelSiblings(
        tx: Transaction,
        request: TerminalizeRunRequest,
        run: Run,
        terminalTurn: Turn
    ): readonly TurnId[] {
        if (this.repository.listForcedCancellations(tx, run.id).length !== 0) {
            throw invalidRun("Active Run contains preexisting forced cancellation records");
        }
        const siblings = this.repository
            .listTurns(tx)
            .filter((value) => value.run.equals(run.id) && !value.id.equals(terminalTurn.id));
        const pending = siblings.filter(
            (sibling) => !isTerminalTurn(sibling) || sibling.lease.holder !== undefined
        );
        if (pending.length === 0) {
            if (
                request.forcedCancellationControl !== undefined ||
                request.siblingCancellations.size !== 0
            ) {
                throw invalidRun("Terminalization supplied unused forced cancellation evidence");
            }
            return [];
        }
        const control = request.forcedCancellationControl;
        if (control === undefined || request.siblingCancellations.size !== pending.length) {
            throw invalidRun(
                "Terminalization requires one control and exact evidence for every active sibling"
            );
        }
        this.requireAdministerControl(tx, run.id, terminalTurn.id, control);
        const cancellations = pending.map((sibling) => {
            const supplied = request.siblingCancellations.get(sibling.id.value);
            if (supplied === undefined) {
                throw invalidRun("Terminalization is missing sibling cancellation evidence");
            }
            const fenced = sibling.forceCancel();
            const cancellation = new ForcedTurnCancellation({
                run: run.id,
                terminalTurn: terminalTurn.id,
                turn: sibling.id,
                priorLeaseEpoch: sibling.lease.epoch,
                fencedLeaseEpoch: fenced.lease.epoch,
                controlReceipt: control.receipt,
                controlAudit: control.audit,
                cancellationEvent: supplied.event,
                cancellationAudit: supplied.audit
            });
            this.requireForcedCancellationEvidence(tx, cancellation);
            return { sibling, fenced, cancellation };
        });
        for (const value of cancellations) {
            this.repository.replaceTurn(tx, value.sibling.revision, value.fenced);
            this.repository.insertForcedCancellation(tx, value.cancellation);
        }
        return cancellations.map((value) => value.sibling.id);
    }

    private validateTerminalSiblings(
        tx: Transaction,
        run: RunId,
        terminalTurn: TurnId,
        forcedSiblings: readonly TurnId[]
    ): void {
        const siblings = this.repository
            .listTurns(tx)
            .filter((value) => value.run.equals(run) && !value.id.equals(terminalTurn));
        if (
            siblings.some(
                (sibling) => !isTerminalTurn(sibling) || sibling.lease.holder !== undefined
            )
        ) {
            throw invalidRun("Run admission cannot close while a sibling is active or held");
        }
        const records = this.repository.listForcedCancellations(tx, run);
        if (
            records.length !== forcedSiblings.length ||
            forcedSiblings.some((turn) => !records.some((record) => record.turn.equals(turn)))
        ) {
            throw invalidRun("Every forcibly fenced sibling requires one cancellation record");
        }
        for (const record of records) {
            const sibling = siblings.find((value) => value.id.equals(record.turn));
            if (
                !record.run.equals(run) ||
                !record.terminalTurn.equals(terminalTurn) ||
                sibling === undefined ||
                sibling.status.kind !== "cancelled" ||
                sibling.lease.holder !== undefined ||
                sibling.lease.epoch !== record.fencedLeaseEpoch
            ) {
                throw invalidRun("Forced cancellation record does not match its fenced sibling");
            }
            this.requireAdministerControl(tx, run, terminalTurn, {
                receipt: record.controlReceipt,
                audit: record.controlAudit
            });
            this.requireForcedCancellationEvidence(tx, record);
        }
    }

    private requireAdministerControl(
        tx: Transaction,
        run: RunId,
        terminalTurn: TurnId,
        control: ForcedCancellationControl
    ): void {
        const evidence = requireSynchronousResult(
            this.evidence.administer(tx, control.receipt, control.audit)
        );
        if (
            evidence === undefined ||
            evidence.kind !== "administer" ||
            evidence.outcome !== "succeeded" ||
            !evidence.run.equals(run) ||
            !evidence.terminalTurn.equals(terminalTurn) ||
            !evidence.receipt.equals(control.receipt) ||
            !evidence.audit.equals(control.audit)
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Forced cancellation requires the exact successful administer Receipt and Audit"
            );
        }
    }

    private requireForcedCancellationEvidence(
        tx: Transaction,
        cancellation: ForcedTurnCancellation
    ): void {
        const evidence = requireSynchronousResult(
            this.evidence.forcedCancellation(
                tx,
                cancellation.cancellationEvent,
                cancellation.cancellationAudit
            )
        );
        if (
            evidence === undefined ||
            evidence.kind !== "turnCancellation" ||
            evidence.eventKind !== "turn.cancel" ||
            !evidence.run.equals(cancellation.run) ||
            !evidence.terminalTurn.equals(cancellation.terminalTurn) ||
            !evidence.turn.equals(cancellation.turn) ||
            evidence.priorLeaseEpoch !== cancellation.priorLeaseEpoch ||
            evidence.fencedLeaseEpoch !== cancellation.fencedLeaseEpoch ||
            evidence.inboxLeaseEpoch !== cancellation.priorLeaseEpoch ||
            !evidence.controlReceipt.equals(cancellation.controlReceipt) ||
            !evidence.controlAudit.equals(cancellation.controlAudit) ||
            !evidence.event.equals(cancellation.cancellationEvent) ||
            !evidence.audit.equals(cancellation.cancellationAudit)
        ) {
            throw invalidRun("Forced cancellation inbox and Audit evidence do not match the fence");
        }
    }

    private requireTurnAndBranch(
        tx: Transaction,
        turnId: TurnId,
        turnRevision: Revision,
        branchRevision: Revision
    ): Turn {
        const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
        requireRevision(turn.revision, turnRevision);
        const branch = requireValue(
            this.repository.loadBranch(tx, turn.branch),
            "Turn branch does not exist"
        );
        requireRevision(branch.revision, branchRevision);
        return turn;
    }

    private effectiveCommitInTransaction(tx: Transaction, head: RunCommitId): RunCommitId {
        const commit = requireValue(
            this.repository.loadCommit(tx, head),
            "Run head commit does not exist"
        );
        return commit.kind === "undo" ? commit.selects! : commit.id;
    }

    private requireActiveRun(tx: Transaction, id: RunId): Run {
        const run = requireValue(this.repository.loadRun(tx, id), "Run does not exist");
        if (run.lifecycle.kind !== RunLifecycle.active.kind) {
            throw new AgentCoreError("run.invalid-state", "Run is terminal");
        }
        return run;
    }

    private requireAdmission(tx: Transaction, run: RunId): RunAdmissionRegistry {
        const registry = this.repository.loadAdmission(tx, run);
        if (registry === undefined) {
            throw new AgentCoreError("codec.invalid", "Run admission registry is missing");
        }
        return registry;
    }

    private requireConfigurationForPins(
        tx: Transaction,
        run: Run,
        pins: RunPins
    ): RunConfigurationSnapshot {
        const matching = run.configurations
            .map((id) => this.repository.loadConfiguration(tx, id.value))
            .filter(
                (value): value is RunConfigurationSnapshot =>
                    value !== undefined && value.pins.equals(pins)
            );
        if (matching.length !== 1) {
            throw invalidRun("Run pins do not resolve one exact configuration snapshot");
        }
        return matching[0]!;
    }
}

function requireRevision(actual: Revision, expected: Revision): void {
    if (!actual.equals(expected)) {
        throw new AgentCoreError("protocol.revision-conflict", "Expected revision is stale");
    }
}

function requireValue<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw new AgentCoreError("run.invalid-state", message);
    return value;
}

function isTerminalTurn(turn: Turn): boolean {
    return (
        turn.status.kind === "succeeded" ||
        turn.status.kind === "failed" ||
        turn.status.kind === "cancelled"
    );
}

function tokensEqual(left: LeaseToken, right: LeaseToken): boolean {
    return (
        left.turn.equals(right.turn) &&
        left.holder.equals(right.holder) &&
        left.epoch === right.epoch
    );
}

function currentToken(turn: Turn): LeaseToken {
    if (turn.lease.holder === undefined) {
        throw new AgentCoreError("lease.invalid", "Turn has no held lease to displace");
    }
    return Object.freeze({
        turn: turn.id,
        holder: turn.lease.holder,
        epoch: turn.lease.epoch
    });
}

function optionalRefsEqual<Value extends { equals(other: Value): boolean }>(
    left: Value | undefined,
    right: Value | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function invalidRun(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function invalidTurn(message: string): AgentCoreError {
    return new AgentCoreError("turn.invalid-state", message);
}
