// @ts-nocheck
import { ContentRef } from "../../core";
import type { ReceiptId } from "../../invocation-references";
import type {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../../interaction-references";
import type { LeaseToken } from "./lease";
import type { RunId } from "./id";
import type { RunCommit } from "./commit";
import type { TurnId } from "../../execution-references";

export interface ReceiptCommitEvidence {
    readonly kind: "receipt";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly invocation: InvocationId;
    readonly subjectTurn?: LeaseToken["turn"];
}

export interface DeliveryCommitEvidence {
    readonly kind: "delivery";
    readonly run: RunId;
    readonly reservation: RouteReservationId;
    readonly audit: AuditRecordId;
    readonly subjectTurn?: LeaseToken["turn"];
}

export interface ControlCommitEvidence {
    readonly kind: "control";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly proposalDigest: string;
}

export interface SynthesisCommitEvidence {
    readonly kind: "synthesis";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly token: LeaseToken;
    readonly content: ContentRef;
}

export interface AdministerControlEvidence {
    readonly kind: "administer";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly outcome: "succeeded";
}

export interface ForcedCancellationEvidence {
    readonly kind: "turnCancellation";
    readonly eventKind: "turn.cancel";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly inboxLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly event: EventId;
    readonly audit: AuditRecordId;
}

export abstract class RunEvidencePort<Transaction> {
    public abstract receipt(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ReceiptCommitEvidence | undefined;

    public abstract delivery(
        transaction: Transaction,
        reservation: RouteReservationId,
        audit: AuditRecordId
    ): DeliveryCommitEvidence | undefined;

    public abstract control(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ControlCommitEvidence | undefined;

    public abstract synthesis(
        transaction: Transaction,
        receipt: ReceiptId
    ): SynthesisCommitEvidence | undefined;

    public abstract administer(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): AdministerControlEvidence | undefined;

    public abstract forcedCancellation(
        transaction: Transaction,
        event: EventId,
        audit: AuditRecordId
    ): ForcedCancellationEvidence | undefined;
}

export abstract class RunMergePort<Transaction> {
    public abstract verifyConcat(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;

    public abstract verifyTree(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;
}
