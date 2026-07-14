import { requireSynchronousResult } from "../actors";
import { AgentCoreError } from "../errors";
import type { Approval } from "./approval";
import type { EffectAttempt } from "./attempt";
import { AuditRecord } from "./audit";
import type { ItemClaim, ItemClaimOwner } from "./claim";
import { InvocationContinuation } from "./continuation";
import type { ItemClaimId, ReceiptId } from "./id";
import type { InvocationId } from "../interaction-references";
import { deriveBatchOutcome, type BatchOutcome } from "./outcome";
import type { InvocationPersistence } from "./persistence";
import type {
    AuthorityAdmissionPort,
    InvocationClaimOwnerPort,
    InvocationEvidencePersistence,
    InvocationPreparationPort,
    InvocationTimePort,
    ReconciliationResult
} from "./ports";
import type { PreparedInvocation } from "./prepared";
import type { InvocationPublicationOutbox } from "./publication";
import { AttemptReceipt, PreEffectReceipt, type Receipt } from "./receipt";
import { sameJson, validDate, type StructuralCodec } from "./codec";

export class InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission> {
    public constructor(
        private readonly persistence: InvocationPersistence<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly lease: StructuralCodec<Lease>,
        private readonly preparation: InvocationPreparationPort<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly time: InvocationTimePort<Transaction>,
        private readonly claimOwner: InvocationClaimOwnerPort<Transaction, Lease, Admission>,
        private readonly authorityAdmission: AuthorityAdmissionPort<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >
    ) {}

    public prepare(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): void {
        if (this.persistence.prepared(transaction, record.header.id) !== undefined) {
            throw invalid("PreparedInvocation already exists");
        }
        if (!requireSynchronousResult(this.preparation.admits(transaction, record))) {
            throw invalid("PreparedInvocation owner, audit, route, or schema evidence is invalid");
        }
        this.persistence.insertPrepared(transaction, record);
    }

    public requestApproval(transaction: Transaction, approval: Approval): void {
        const prepared = this.requirePrepared(transaction, approval.invocation);
        if (
            !prepared.intentDigest.equals(approval.intentDigest) ||
            approval.revision.value !== 0 ||
            approval.state.kind !== "pending" ||
            this.persistence.approvalForInvocation(transaction, approval.invocation) !== undefined
        ) {
            throw invalid("Approval does not bind a fresh exact PreparedInvocation");
        }
        this.persistence.appendApproval(transaction, approval);
    }

    public appendApprovalRevision(transaction: Transaction, next: Approval): void {
        const current = this.persistence.approval(transaction, next.id);
        if (
            current === undefined ||
            next.revision.value !== current.revision.value + 1 ||
            !next.invocation.equals(current.invocation) ||
            !next.intentDigest.equals(current.intentDigest) ||
            next.requestedAt.getTime() !== current.requestedAt.getTime() ||
            next.expiresAt?.getTime() !== current.expiresAt?.getTime() ||
            next.state.kind === "consumed" ||
            !isLegalApprovalTransition(current, next)
        ) {
            throw invalid("Approval revision is not the next legal transition");
        }
        this.persistence.appendApproval(transaction, next);
    }

    public claimItem(transaction: Transaction, claim: ItemClaim<Lease>, now: Date): void {
        this.requireTime(transaction, now);
        const prepared = this.requireItem(transaction, claim.invocation, claim.itemIndex);
        claim.requireFuture(now);
        const currentClaim = this.currentUnattemptedClaim(
            transaction,
            claim.invocation,
            claim.itemIndex
        );
        if (currentClaim !== undefined) throw invalid("Item already has an unattempted claim");
        const current = this.currentReceipt(transaction, claim.invocation, claim.itemIndex);
        if (
            current === undefined &&
            this.persistence.attemptsForItem(transaction, claim.invocation, claim.itemIndex)
                .length !== 0
        ) {
            throw invalid("Item has an unresolved EffectAttempt");
        }
        const ordinal = current === undefined ? 0 : this.retryOrdinal(transaction, current);
        if (claim.attemptOrdinal !== ordinal)
            throw invalid("Item claim has the wrong attempt ordinal");
        this.validateClaimOwner(prepared, claim);
        this.persistence.appendClaim(transaction, claim);
    }

    public recoverClaim(
        transaction: Transaction,
        previousId: ItemClaimId,
        replacement: ItemClaim<Lease>,
        now: Date
    ): void {
        this.requireTime(transaction, now);
        const previous = this.persistence.claim(transaction, previousId);
        const current =
            previous === undefined
                ? undefined
                : this.currentUnattemptedClaim(
                      transaction,
                      previous.invocation,
                      previous.itemIndex
                  );
        if (
            previous === undefined ||
            current === undefined ||
            !current.id.equals(previous.id) ||
            this.persistence.attemptForClaim(transaction, previous.id) !== undefined
        ) {
            throw invalid("Only the exact current no-attempt claim may be recovered");
        }
        const expected = previous.recover(
            replacement.id,
            replacement.owner,
            replacement.expiresAt,
            now
        );
        if (!sameClaim(expected, replacement, this.lease)) {
            throw invalid("Recovered claim changed immutable scheduling identity");
        }
        this.validateClaimOwner(
            this.requireItem(transaction, replacement.invocation, replacement.itemIndex),
            replacement
        );
        this.persistence.appendClaim(transaction, replacement);
    }

    public admitAttempt(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>,
        now: Date
    ): Approval | undefined {
        const admitted = this.admitAttemptInternal(transaction, attempt, now, false);
        if (admitted === false) {
            throw invalid("AuthorityAdmission does not authorize this exact EffectAttempt");
        }
        return admitted;
    }

    private admitAttemptInternal(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>,
        now: Date,
        returnAuthorityDenial: boolean
    ): Approval | undefined | false {
        const nowTime = this.requireTime(transaction, now);
        const prepared = this.requireItem(transaction, attempt.invocation, attempt.itemIndex);
        if (this.currentReceipt(transaction, attempt.invocation, attempt.itemIndex) !== undefined) {
            throw invalid("Terminal item cannot admit an EffectAttempt");
        }
        const claim = this.persistence.claim(transaction, attempt.claim);
        const currentClaim = this.currentUnattemptedClaim(
            transaction,
            attempt.invocation,
            attempt.itemIndex
        );
        if (
            claim === undefined ||
            currentClaim === undefined ||
            !claim.id.equals(currentClaim.id) ||
            claim.attemptOrdinal !== attempt.ordinal ||
            claim.expiresAt.getTime() <= nowTime ||
            attempt.startedAt.getTime() > nowTime ||
            this.persistence.attemptForClaim(transaction, claim.id) !== undefined ||
            attempt.idempotencyKey !== prepared.item(attempt.itemIndex).idempotencyKey
        ) {
            throw invalid("EffectAttempt does not match the live current claim");
        }
        if (claim.owner.kind === "executor") {
            if (
                attempt.token === undefined ||
                !structuralEquals(this.lease, claim.owner.token, attempt.token) ||
                prepared.header.lease === undefined ||
                !structuralEquals(this.lease, prepared.header.lease, attempt.token)
            ) {
                throw invalid("EffectAttempt token does not match its executor claim");
            }
        } else if (attempt.token !== undefined) {
            throw invalid("System EffectAttempt cannot carry an executor token");
        }
        if (!requireSynchronousResult(this.claimOwner.admits(transaction, claim, attempt))) {
            throw invalid("EffectAttempt caller does not own the current ItemClaim");
        }
        if (
            !requireSynchronousResult(
                this.authorityAdmission.admits(transaction, attempt.admission, {
                    invocation: attempt.invocation,
                    itemIndex: attempt.itemIndex,
                    ordinal: attempt.ordinal,
                    lease: attempt.token,
                    authority: prepared.header.authority,
                    domain: prepared.header.domain,
                    pathEpochs: prepared.header.pathEpochs,
                    intentDigest: prepared.intentDigest,
                    itemKey: attempt.idempotencyKey
                })
            )
        ) {
            if (returnAuthorityDenial) return false;
            throw invalid("AuthorityAdmission does not authorize this exact EffectAttempt");
        }
        let consumed: Approval | undefined;
        const approval = this.persistence.approvalForInvocation(transaction, prepared.header.id);
        const continuation = this.persistence.continuation(transaction, prepared.header.id);
        if (prepared.header.operation.approvalRequired && approval === undefined) {
            throw invalid("EffectAttempt requires Approval");
        }
        if (approval === undefined && continuation !== undefined) {
            throw invalid("InvocationContinuation requires its exact Approval");
        }
        if (approval !== undefined) {
            if (
                !approval.invocation.equals(prepared.header.id) ||
                !approval.intentDigest.equals(prepared.intentDigest)
            ) {
                throw invalid("EffectAttempt Approval does not bind the PreparedInvocation");
            }
            if (approval.state.kind === "approved") {
                if (continuation !== undefined) {
                    throw invalid("Approved Invocation cannot already have a continuation");
                }
                if (
                    approval.expiresAt !== undefined &&
                    now.getTime() >= approval.expiresAt.getTime()
                ) {
                    throw invalid("Approved continuation has expired");
                }
                consumed = approval.consume(attempt.id, now);
                this.persistence.appendApproval(transaction, consumed);
                this.persistence.insertContinuation(
                    transaction,
                    new InvocationContinuation(
                        prepared.header.id,
                        prepared.intentDigest,
                        approval.id,
                        attempt.id,
                        attempt.itemIndex,
                        attempt.ordinal,
                        claim.id,
                        claim.owner,
                        attempt.idempotencyKey,
                        now
                    )
                );
            } else if (approval.state.kind === "consumed") {
                this.requireContinuation(transaction, prepared, approval, continuation);
            } else {
                throw invalid("EffectAttempt requires an approved continuation");
            }
        }
        this.persistence.appendAttempt(transaction, attempt);
        return consumed;
    }

    public admitAttemptWithAudit(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>,
        now: Date,
        audit: AuditRecord,
        evidence: InvocationEvidencePersistence<Transaction>
    ): Approval | undefined {
        if (
            audit.kind.kind !== "attempt" ||
            !audit.kind.id.equals(attempt.id) ||
            audit.cause === undefined ||
            !audit.cause.equals(attempt.auditCause)
        ) {
            throw invalid("EffectAttempt AuditRecord does not bind the admitted attempt");
        }
        const consumed = this.admitAttempt(transaction, attempt, now);
        evidence.appendAudit(transaction, audit);
        return consumed;
    }

    public admitAttemptOrRecordAuthorityDenialWithAudit(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>,
        now: Date,
        attemptAudit: AuditRecord,
        denial: {
            readonly claim: ItemClaim<Lease>;
            readonly receipt: PreEffectReceipt;
            readonly audit: AuditRecord;
            readonly publication: InvocationPublicationOutbox;
        },
        evidence: InvocationEvidencePersistence<Transaction>
    ): boolean {
        if (
            attemptAudit.kind.kind !== "attempt" ||
            !attemptAudit.kind.id.equals(attempt.id) ||
            attemptAudit.cause === undefined ||
            !attemptAudit.cause.equals(attempt.auditCause)
        ) {
            throw invalid("EffectAttempt AuditRecord does not bind the admitted attempt");
        }
        const admitted = this.admitAttemptInternal(transaction, attempt, now, true);
        if (admitted === false) {
            this.recordClaimedAuthorityDenialWithAudit(
                transaction,
                denial.claim,
                denial.receipt,
                denial.audit,
                denial.publication,
                evidence
            );
            return false;
        }
        evidence.appendAudit(transaction, attemptAudit);
        return true;
    }

    public recordClaimedAuthorityDenialWithAudit(
        transaction: Transaction,
        claim: ItemClaim<Lease>,
        receipt: PreEffectReceipt,
        audit: AuditRecord,
        publication: InvocationPublicationOutbox,
        evidence: InvocationEvidencePersistence<Transaction>
    ): void {
        const prepared = this.requireItem(transaction, claim.invocation, claim.itemIndex);
        const currentClaim = this.currentUnattemptedClaim(
            transaction,
            claim.invocation,
            claim.itemIndex
        );
        if (
            currentClaim === undefined ||
            !currentClaim.id.equals(claim.id) ||
            this.persistence.attemptForClaim(transaction, claim.id) !== undefined ||
            this.currentReceipt(transaction, claim.invocation, claim.itemIndex) !== undefined ||
            receipt.outcome !== "deniedPreEffect" ||
            !receipt.invocation.equals(claim.invocation) ||
            receipt.itemIndex !== claim.itemIndex ||
            audit.kind.kind !== "receipt" ||
            !audit.kind.id.equals(receipt.id) ||
            audit.kind.outcome !== receipt.outcome ||
            audit.cause === undefined ||
            !audit.cause.equals(prepared.header.auditCause) ||
            publication.state.kind !== "pending" ||
            !publication.observation.invocation.equals(claim.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(audit.id)
        ) {
            throw invalid("Authority denial evidence does not bind the current claimed item");
        }
        this.persistence.appendReceipt(transaction, receipt);
        evidence.appendAudit(transaction, audit);
        evidence.appendPublication(transaction, publication);
    }

    public recordAttemptReceiptWithAudit(
        transaction: Transaction,
        receipt: AttemptReceipt,
        attemptAudit: AuditRecord,
        audit: AuditRecord,
        publication: InvocationPublicationOutbox,
        evidence: InvocationEvidencePersistence<Transaction>
    ): void {
        const attempt = this.persistence.attempt(transaction, receipt.attempt);
        const persistedAttemptAudit = evidence.audit(transaction, attemptAudit.id);
        if (
            attempt === undefined ||
            !receipt.attempt.equals(attempt.id) ||
            attemptAudit.kind.kind !== "attempt" ||
            !attemptAudit.kind.id.equals(attempt.id) ||
            attemptAudit.cause === undefined ||
            !attemptAudit.cause.equals(attempt.auditCause) ||
            persistedAttemptAudit === undefined ||
            !sameAudit(persistedAttemptAudit, attemptAudit) ||
            audit.kind.kind !== "receipt" ||
            !audit.kind.id.equals(receipt.id) ||
            audit.kind.outcome !== receipt.outcome ||
            audit.cause === undefined ||
            !audit.cause.equals(attemptAudit.id) ||
            !audit.actor.equals(attemptAudit.actor) ||
            !audit.tenant.equals(attemptAudit.tenant) ||
            !audit.correlation.equals(attemptAudit.correlation) ||
            publication.state.kind !== "pending" ||
            !publication.observation.invocation.equals(attempt.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(audit.id)
        ) {
            throw invalid("Receipt AuditRecord or publication does not bind the attempted effect");
        }
        this.recordAttemptReceipt(transaction, receipt);
        evidence.appendAudit(transaction, audit);
        evidence.appendPublication(transaction, publication);
    }

    private requireContinuation(
        transaction: Transaction,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        approval: Approval,
        continuation: InvocationContinuation<Lease> | undefined
    ): void {
        if (
            approval.state.kind !== "consumed" ||
            continuation === undefined ||
            !continuation.invocation.equals(prepared.header.id) ||
            !continuation.intentDigest.equals(prepared.intentDigest) ||
            !continuation.approval.equals(approval.id) ||
            !continuation.firstAttempt.equals(approval.state.firstAttempt)
        ) {
            throw invalid("Consumed Approval has no matching InvocationContinuation");
        }
        const first = this.persistence.attempt(transaction, continuation.firstAttempt);
        const claim = this.persistence.claim(transaction, continuation.firstClaim);
        if (
            first === undefined ||
            claim === undefined ||
            !first.invocation.equals(continuation.invocation) ||
            first.itemIndex !== continuation.firstItemIndex ||
            first.ordinal !== continuation.firstOrdinal ||
            !first.claim.equals(continuation.firstClaim) ||
            first.idempotencyKey !== continuation.firstItemKey ||
            claim.itemIndex !== continuation.firstItemIndex ||
            claim.attemptOrdinal !== continuation.firstOrdinal ||
            !sameOwner(this.lease, claim.owner, continuation.firstClaimOwner) ||
            prepared.item(continuation.firstItemIndex).idempotencyKey !== continuation.firstItemKey
        ) {
            throw invalid("InvocationContinuation first EffectAttempt identity is invalid");
        }
    }

    public recordPreEffect(transaction: Transaction, receipt: PreEffectReceipt): void {
        this.requireItem(transaction, receipt.invocation, receipt.itemIndex);
        if (
            this.persistence.attemptsForItem(transaction, receipt.invocation, receipt.itemIndex)
                .length !== 0 ||
            this.currentUnattemptedClaim(transaction, receipt.invocation, receipt.itemIndex) !==
                undefined ||
            this.currentReceipt(transaction, receipt.invocation, receipt.itemIndex) !== undefined
        ) {
            throw invalid("Pre-effect Receipt requires an untouched item");
        }
        this.persistence.appendReceipt(transaction, receipt);
    }

    public recordAttemptReceipt(transaction: Transaction, receipt: AttemptReceipt): void {
        if (receipt.previous !== undefined)
            throw invalid("Initial AttemptReceipt cannot name previous");
        const attempt = this.persistence.attempt(transaction, receipt.attempt);
        if (
            attempt === undefined ||
            this.persistence.receiptsForAttempt(transaction, receipt.attempt).length !== 0
        ) {
            throw invalid("AttemptReceipt requires one existing unreceipted EffectAttempt");
        }
        this.persistence.appendReceipt(transaction, receipt);
    }

    public supersedeReceipt(transaction: Transaction, receipt: AttemptReceipt): void {
        const previous =
            receipt.previous === undefined
                ? undefined
                : this.persistence.receipt(transaction, receipt.previous);
        if (
            !(previous instanceof AttemptReceipt) ||
            previous.outcome !== "indeterminate" ||
            receipt.outcome === "indeterminate" ||
            !receipt.attempt.equals(previous.attempt) ||
            !this.currentReceiptForAttempt(transaction, receipt.attempt)?.id.equals(previous.id)
        ) {
            throw invalid("Only a current indeterminate Receipt may be superseded once");
        }
        this.persistence.appendReceipt(transaction, receipt);
    }

    public reconcile(
        transaction: Transaction,
        previous: ReceiptId,
        next: ReceiptId,
        recordedAt: Date,
        result: ReconciliationResult
    ): AttemptReceipt | undefined {
        this.requireTime(transaction, recordedAt);
        const current = this.persistence.receipt(transaction, previous);
        if (
            !(current instanceof AttemptReceipt) ||
            current.outcome !== "indeterminate" ||
            !this.currentReceiptForAttempt(transaction, current.attempt)?.id.equals(current.id)
        ) {
            throw invalid("Reconciliation requires a current indeterminate Receipt");
        }
        if (result.kind === "unknown") return undefined;
        const receipt = new AttemptReceipt(
            next,
            current.attempt,
            result.kind,
            current.id,
            recordedAt,
            result.result
        );
        this.supersedeReceipt(transaction, receipt);
        return receipt;
    }

    public currentReceipt(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): Receipt | undefined {
        const receipts = this.persistence.receiptsForItem(transaction, invocation, itemIndex);
        const attempts = this.persistence.attemptsForItem(transaction, invocation, itemIndex);
        const preEffect = receipts.filter(
            (receipt): receipt is PreEffectReceipt => receipt instanceof PreEffectReceipt
        );
        if (preEffect.length > 1 || (preEffect.length === 1 && attempts.length !== 0)) {
            throw invalid("Item has contradictory pre-effect and attempted Receipt history");
        }
        if (preEffect.length === 1) return preEffect[0];
        const greatest = attempts.at(-1);
        return greatest === undefined
            ? undefined
            : this.currentReceiptForAttempt(transaction, greatest.id);
    }

    public batchOutcome(
        transaction: Transaction,
        invocation: InvocationId
    ): BatchOutcome | undefined {
        const prepared = this.requirePrepared(transaction, invocation);
        return deriveBatchOutcome(
            prepared.itemCount,
            Array.from({ length: prepared.itemCount }, (_, index) =>
                this.currentReceipt(transaction, invocation, index)
            )
        );
    }

    private requirePrepared(
        transaction: Transaction,
        invocation: InvocationId
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
        const prepared = this.persistence.prepared(transaction, invocation);
        if (prepared === undefined) throw invalid("PreparedInvocation does not exist");
        return prepared;
    }

    private requireItem(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
        const prepared = this.requirePrepared(transaction, invocation);
        prepared.item(itemIndex);
        return prepared;
    }

    private currentUnattemptedClaim(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number
    ): ItemClaim<Lease> | undefined {
        const latest = this.persistence.claimsForItem(transaction, invocation, itemIndex).at(-1);
        return latest === undefined ||
            this.persistence.attemptForClaim(transaction, latest.id) !== undefined
            ? undefined
            : latest;
    }

    private currentReceiptForAttempt(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>["id"]
    ): AttemptReceipt | undefined {
        const receipts = this.persistence
            .receiptsForAttempt(transaction, attempt)
            .filter((receipt): receipt is AttemptReceipt => receipt instanceof AttemptReceipt);
        if (receipts.length === 0) return undefined;
        const ids = new Set(receipts.map((receipt) => receipt.id.value));
        if (
            receipts.some(
                (receipt) => receipt.previous !== undefined && !ids.has(receipt.previous.value)
            )
        ) {
            throw invalid("Attempt Receipt history has a missing predecessor");
        }
        const previousIds = new Set(
            receipts.flatMap((receipt) =>
                receipt.previous === undefined ? [] : [receipt.previous.value]
            )
        );
        const heads = receipts.filter((receipt) => !previousIds.has(receipt.id.value));
        if (heads.length !== 1)
            throw invalid("Attempt Receipt history does not have one current head");
        const byId = new Map(receipts.map((receipt) => [receipt.id.value, receipt]));
        const visited = new Set<string>();
        let cursor: AttemptReceipt | undefined = heads[0];
        while (cursor !== undefined) {
            if (visited.has(cursor.id.value)) {
                throw invalid("Attempt Receipt history contains a cycle");
            }
            visited.add(cursor.id.value);
            cursor = cursor.previous === undefined ? undefined : byId.get(cursor.previous.value);
        }
        if (visited.size !== receipts.length) {
            throw invalid("Attempt Receipt history contains a disconnected lineage");
        }
        return heads[0];
    }

    private retryOrdinal(transaction: Transaction, receipt: Receipt): number {
        if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "failed") {
            throw invalid("Only a final failed Receipt permits another attempt ordinal");
        }
        const attempt = this.persistence.attempt(transaction, receipt.attempt);
        if (attempt === undefined || attempt.ordinal === Number.MAX_SAFE_INTEGER) {
            throw invalid("Prior EffectAttempt is unavailable or ordinal is exhausted");
        }
        return attempt.ordinal + 1;
    }

    private validateClaimOwner(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>
    ): void {
        if (prepared.header.lease === undefined) {
            if (claim.owner.kind !== "system" || !claim.owner.actor.equals(prepared.header.actor)) {
                throw invalid("Lease-free invocation requires its exact owning Actor claim");
            }
            return;
        }
        if (
            claim.owner.kind !== "executor" ||
            !structuralEquals(this.lease, prepared.header.lease, claim.owner.token)
        ) {
            throw invalid("Executor claim must carry the exact PreparedInvocation lease");
        }
    }

    private requireTime(transaction: Transaction, time: Date): number {
        const value = validDate(time, "Invocation transition time");
        if (!requireSynchronousResult(this.time.admits(transaction, time))) {
            throw invalid("Invocation transition time is not trusted");
        }
        return value;
    }
}

function isLegalApprovalTransition(current: Approval, next: Approval): boolean {
    if (current.state.kind === "pending") {
        return (
            next.state.kind === "approved" ||
            next.state.kind === "denied" ||
            next.state.kind === "expired"
        );
    }
    return false;
}

function sameClaim<Lease>(
    left: ItemClaim<Lease>,
    right: ItemClaim<Lease>,
    lease: StructuralCodec<Lease>
): boolean {
    if (
        !left.id.equals(right.id) ||
        !left.invocation.equals(right.invocation) ||
        left.itemIndex !== right.itemIndex ||
        left.attemptOrdinal !== right.attemptOrdinal ||
        left.expiresAt.getTime() !== right.expiresAt.getTime() ||
        left.owner.kind !== right.owner.kind ||
        !left.owner.worker.equals(right.owner.worker)
    )
        return false;
    if (left.owner.kind === "executor" && right.owner.kind === "executor") {
        return structuralEquals(lease, left.owner.token, right.owner.token);
    }
    return (
        left.owner.kind === "system" &&
        right.owner.kind === "system" &&
        left.owner.actor.equals(right.owner.actor)
    );
}

function structuralEquals<Value>(
    codec: StructuralCodec<Value>,
    left: Value,
    right: Value
): boolean {
    return sameJson(codec.encode(left), codec.encode(right));
}

function sameOwner<Lease>(
    lease: StructuralCodec<Lease>,
    left: ItemClaimOwner<Lease>,
    right: ItemClaimOwner<Lease>
): boolean {
    if (left.kind !== right.kind || !left.worker.equals(right.worker)) return false;
    return left.kind === "executor" && right.kind === "executor"
        ? structuralEquals(lease, left.token, right.token)
        : left.kind === "system" && right.kind === "system" && left.actor.equals(right.actor);
}

function sameAudit(left: AuditRecord, right: AuditRecord): boolean {
    const leftBytes = AuditRecord.encode(left);
    const rightBytes = AuditRecord.encode(right);
    return (
        leftBytes.length === rightBytes.length &&
        leftBytes.every((value, index) => value === rightBytes[index])
    );
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
