import {
    RunEvidencePort,
    RunMergePort,
    RunSourceRevisionPort,
    RunSpawnPort,
    SettlementEvidencePort,
    type ControlCommitEvidence,
    type AdministerControlEvidence,
    type DeliveryCommitEvidence,
    type ForcedCancellationEvidence,
    type ReceiptCommitEvidence,
    type RunCommit,
    type RunConfigurationSnapshot,
    type SettlementAuditObligation,
    type SpawnReservation,
    type SynthesisCommitEvidence
} from "../agents";
import type {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../interaction-references";
import type { ApprovalId, EffectAttemptId, ReceiptId } from "../invocation-references";
import type { RunCommitId } from "../execution-references";

export interface CanonicalRunEvidenceSource<Transaction> {
    receipt(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ReceiptCommitEvidence | undefined;
    delivery(
        transaction: Transaction,
        reservation: RouteReservationId,
        audit: AuditRecordId
    ): DeliveryCommitEvidence | undefined;
    control(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ControlCommitEvidence | undefined;
    synthesis(transaction: Transaction, receipt: ReceiptId): SynthesisCommitEvidence | undefined;
    administer?(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): AdministerControlEvidence | undefined;
    forcedCancellation?(
        transaction: Transaction,
        event: EventId,
        audit: AuditRecordId
    ): ForcedCancellationEvidence | undefined;
}

export class CanonicalRunEvidencePort<Transaction> extends RunEvidencePort<Transaction> {
    public constructor(private readonly source: CanonicalRunEvidenceSource<Transaction>) {
        super();
    }
    public receipt(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.source.receipt(transaction, receipt, audit);
    }
    public delivery(
        transaction: Transaction,
        reservation: RouteReservationId,
        audit: AuditRecordId
    ) {
        return this.source.delivery(transaction, reservation, audit);
    }
    public control(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.source.control(transaction, receipt, audit);
    }
    public synthesis(transaction: Transaction, receipt: ReceiptId) {
        return this.source.synthesis(transaction, receipt);
    }
    public administer(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.source.administer?.(transaction, receipt, audit);
    }
    public forcedCancellation(transaction: Transaction, event: EventId, audit: AuditRecordId) {
        return this.source.forcedCancellation?.(transaction, event, audit);
    }
}

export interface CanonicalSettlementSource<Transaction> {
    approvalResolved(transaction: Transaction, approval: ApprovalId): boolean;
    invocationItemTerminal(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string
    ): boolean;
    routeTerminal(transaction: Transaction, route: RouteReservationId): boolean;
    reconciliationSuperseded(transaction: Transaction, attempt: EffectAttemptId): boolean;
    commitExists(transaction: Transaction, commit: RunCommitId): boolean;
    auditSatisfied(transaction: Transaction, obligation: SettlementAuditObligation): boolean;
}

export class CanonicalSettlementEvidencePort<
    Transaction
> extends SettlementEvidencePort<Transaction> {
    public constructor(private readonly source: CanonicalSettlementSource<Transaction>) {
        super();
    }
    public approvalResolved(transaction: Transaction, approval: ApprovalId): boolean {
        return this.source.approvalResolved(transaction, approval);
    }
    public invocationItemTerminal(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string
    ): boolean {
        return this.source.invocationItemTerminal(transaction, invocation, itemIndex, itemKey);
    }
    public routeTerminal(transaction: Transaction, route: RouteReservationId): boolean {
        return this.source.routeTerminal(transaction, route);
    }
    public reconciliationSuperseded(transaction: Transaction, attempt: EffectAttemptId): boolean {
        return this.source.reconciliationSuperseded(transaction, attempt);
    }
    public commitExists(transaction: Transaction, commit: RunCommitId): boolean {
        return this.source.commitExists(transaction, commit);
    }
    public auditSatisfied(
        transaction: Transaction,
        obligation: SettlementAuditObligation
    ): boolean {
        return this.source.auditSatisfied(transaction, obligation);
    }
}

export interface CanonicalSpawnEvidenceSource<Transaction> {
    successfulDelegateReceipt(transaction: Transaction, reservation: SpawnReservation): boolean;
    durableAttenuation(transaction: Transaction, reservation: SpawnReservation): boolean;
}

export class CanonicalRunSpawnPort<Transaction> extends RunSpawnPort<Transaction> {
    public constructor(private readonly source: CanonicalSpawnEvidenceSource<Transaction>) {
        super();
    }
    public verify(transaction: Transaction, reservation: SpawnReservation): boolean {
        return (
            this.source.successfulDelegateReceipt(transaction, reservation) &&
            this.source.durableAttenuation(transaction, reservation)
        );
    }
}

export interface CanonicalMergeSource<Transaction> {
    concat(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;
    tree(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;
}

export class CanonicalRunMergePort<Transaction> extends RunMergePort<Transaction> {
    public constructor(private readonly source: CanonicalMergeSource<Transaction>) {
        super();
    }
    public verifyConcat(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean {
        return this.source.concat(transaction, commit, target, source);
    }
    public verifyTree(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean {
        return this.source.tree(transaction, commit, target, source);
    }
}

export interface CanonicalRunSource<Transaction> {
    verify(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
    verifyPackageClosure(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
}

export class CanonicalRunSourceRevisionPort<Transaction> extends RunSourceRevisionPort<
    Transaction,
    RunConfigurationSnapshot
> {
    public constructor(private readonly source: CanonicalRunSource<Transaction>) {
        super();
    }
    public verify(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean {
        return this.source.verify(transaction, snapshot);
    }
    public verifyPackageClosure(
        transaction: Transaction,
        snapshot: RunConfigurationSnapshot
    ): boolean {
        return this.source.verifyPackageClosure(transaction, snapshot);
    }
}
