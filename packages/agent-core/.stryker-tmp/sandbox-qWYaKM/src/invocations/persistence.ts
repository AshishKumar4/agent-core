// @ts-nocheck
import type { Approval } from "./approval";
import type { EffectAttempt } from "./attempt";
import type { ItemClaim } from "./claim";
import type { InvocationContinuation } from "./continuation";
import type { ApprovalId, EffectAttemptId, ItemClaimId, ReceiptId } from "./id";
import type { InvocationId } from "../interaction-references";
import type { PreparedInvocation } from "./prepared";
import type { Receipt } from "./receipt";

export interface InvocationPersistence<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    prepared(
        transaction: Transaction,
        id: InvocationId
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> | undefined;
    insertPrepared(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): void;

    approval(transaction: Transaction, id: ApprovalId): Approval | undefined;
    approvalForInvocation(transaction: Transaction, invocation: InvocationId): Approval | undefined;
    approvalRevision(
        transaction: Transaction,
        id: ApprovalId,
        revision: number
    ): Approval | undefined;
    appendApproval(transaction: Transaction, record: Approval): void;

    continuation(
        transaction: Transaction,
        invocation: InvocationId
    ): InvocationContinuation<Lease> | undefined;
    insertContinuation(transaction: Transaction, record: InvocationContinuation<Lease>): void;

    claim(transaction: Transaction, id: ItemClaimId): ItemClaim<Lease> | undefined;
    claimsForItem(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): readonly ItemClaim<Lease>[];
    appendClaim(transaction: Transaction, record: ItemClaim<Lease>): void;

    attempt(
        transaction: Transaction,
        id: EffectAttemptId
    ): EffectAttempt<Lease, Admission> | undefined;
    attemptForClaim(
        transaction: Transaction,
        claim: ItemClaimId
    ): EffectAttempt<Lease, Admission> | undefined;
    attemptsForItem(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): readonly EffectAttempt<Lease, Admission>[];
    appendAttempt(transaction: Transaction, record: EffectAttempt<Lease, Admission>): void;

    receipt(transaction: Transaction, id: ReceiptId): Receipt | undefined;
    receiptsForItem(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): readonly Receipt[];
    receiptsForAttempt(transaction: Transaction, attempt: EffectAttemptId): readonly Receipt[];
    appendReceipt(transaction: Transaction, record: Receipt): void;
}
