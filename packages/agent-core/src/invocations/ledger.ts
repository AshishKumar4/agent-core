import { requireSynchronousResult } from "../actors";
import { AgentCoreError } from "../errors";
import type { Approval } from "./approval";
import type { EffectAttempt } from "./attempt";
import { AuditRecord, validateAuditRelation, type AuditEvidenceResolver } from "./audit";
import type { ItemClaim, ItemClaimOwner } from "./claim";
import { InvocationContinuation } from "./continuation";
import type { ItemClaimId } from "./id";
import type { InvocationId } from "../interaction-references";
import { deriveBatchOutcome, type BatchOutcome } from "./outcome";
import type { InvocationPersistence } from "./persistence";
import type {
    AuthorityAdmissionPort,
    InvocationAuditPersistence,
    InvocationClaimOwnerPort,
    InvocationEvidencePersistence,
    InvocationPreparationPort,
    InvocationTimePort
} from "./ports";
import type { PreparedInvocation } from "./prepared";
import type { InvocationPublicationOutbox } from "./publication";
import { AttemptReceipt, PreEffectReceipt, type Receipt } from "./receipt";

export interface ReceiptSupersessionEvidence {
    readonly finalReceiptAudit: AuditRecord;
    readonly supersessionAudit: AuditRecord;
    readonly publication: InvocationPublicationOutbox;
}
import { sameJson, validDate, type StructuralCodec } from "./codec";

export class InvocationLedger<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Authentication = undefined
> {
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
            Admission,
            Authentication
        >
    ) {}

    protected prepareUnchecked(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): void {
        this.validatePreparation(transaction, record);
        this.persistence.insertPrepared(transaction, record);
    }

    public prepareWithAudit(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        audit: AuditRecord,
        evidence: InvocationAuditPersistence<Transaction>
    ): void {
        this.validatePreparation(transaction, record);
        this.requirePreparationAuditBinding(record, audit);
        if (audit.kind.kind === "invocation") {
            evidence.appendAudit(transaction, audit);
        } else {
            this.requirePersistedAudit(transaction, audit, evidence);
        }
        this.persistence.insertPrepared(transaction, record);
    }

    public requirePreparedAudit(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        audit: AuditRecord,
        evidence: InvocationAuditPersistence<Transaction>
    ): void {
        this.requirePreparationAuditBinding(record, audit);
        this.requirePersistedAudit(transaction, audit, evidence);
    }

    public requirePersistedAuditRelation(
        transaction: Transaction,
        audit: AuditRecord,
        evidence: InvocationAuditPersistence<Transaction>
    ): void {
        validateAuditRelation(
            audit,
            { get: (id) => evidence.audit(transaction, id) },
            undefined,
            this.auditEvidence(transaction, {})
        );
    }

    private validatePreparation(
        transaction: Transaction,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): void {
        if (this.persistence.prepared(transaction, record.header.id) !== undefined) {
            throw invalid("PreparedInvocation already exists");
        }
        if (!requireSynchronousResult(this.preparation.admits(transaction, record))) {
            throw invalid("PreparedInvocation owner, audit, route, or schema evidence is invalid");
        }
    }

    private requirePreparationAuditBinding(
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        audit: AuditRecord
    ): void {
        const route = record.header.route;
        const local =
            route === undefined &&
            record.header.projectionDigest === undefined &&
            audit.kind.kind === "invocation" &&
            audit.kind.id.equals(record.header.id);
        const routed =
            route !== undefined &&
            record.header.projectionDigest !== undefined &&
            audit.kind.kind === "routeProjected" &&
            audit.kind.reservation.equals(route);
        if (
            !audit.id.equals(record.header.auditCause) ||
            !audit.actor.equals(record.header.actor) ||
            audit.cause !== undefined ||
            (!local && !routed)
        ) {
            throw invalid("Preparation AuditRecord does not bind the PreparedInvocation");
        }
    }

    private requirePersistedAudit(
        transaction: Transaction,
        audit: AuditRecord,
        evidence: InvocationAuditPersistence<Transaction>
    ): void {
        const persisted = evidence.audit(transaction, audit.id);
        if (persisted === undefined || !sameAudit(persisted, audit)) {
            throw invalid("PreparedInvocation does not have its exact preparation AuditRecord");
        }
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
        now: Date,
        authentication?: Authentication
    ): Approval | undefined {
        const admitted = this.admitAttemptInternal(
            transaction,
            attempt,
            now,
            false,
            authentication
        );
        if (admitted === false) {
            throw invalid("AuthorityAdmission does not authorize this exact EffectAttempt");
        }
        return admitted;
    }

    private admitAttemptInternal(
        transaction: Transaction,
        attempt: EffectAttempt<Lease, Admission>,
        now: Date,
        returnAuthorityDenial: boolean,
        authentication: Authentication | undefined
    ): Approval | undefined | false {
        const nowTime = this.requireTime(transaction, now);
        const prepared = this.requireItem(transaction, attempt.invocation, attempt.itemIndex);
        const currentReceipt = this.currentReceipt(
            transaction,
            attempt.invocation,
            attempt.itemIndex
        );
        if (
            currentReceipt !== undefined &&
            this.retryOrdinal(transaction, currentReceipt) !== attempt.ordinal
        ) {
            throw invalid("EffectAttempt does not follow the final failed attempt ordinal");
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
                this.authorityAdmission.admits(
                    transaction,
                    attempt.admission,
                    {
                        invocation: attempt.invocation,
                        itemIndex: attempt.itemIndex,
                        ordinal: attempt.ordinal,
                        lease: attempt.token,
                        authority: prepared.header.authority,
                        domain: prepared.header.domain,
                        pathEpochs: prepared.header.pathEpochs,
                        intentDigest: prepared.intentDigest,
                        itemKey: attempt.idempotencyKey
                    },
                    authentication
                )
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
        evidence: InvocationEvidencePersistence<Transaction>,
        authentication?: Authentication
    ): Approval | undefined {
        const consumed = this.admitAttempt(transaction, attempt, now, authentication);
        evidence.appendAudit(transaction, audit, {
            evidence: this.auditEvidence(transaction, { attempt })
        });
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
        evidence: InvocationEvidencePersistence<Transaction>,
        authentication?: Authentication
    ): boolean {
        const admitted = this.admitAttemptInternal(transaction, attempt, now, true, authentication);
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
        evidence.appendAudit(transaction, attemptAudit, {
            evidence: this.auditEvidence(transaction, { attempt })
        });
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
        this.requireItem(transaction, claim.invocation, claim.itemIndex);
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
            publication.state.kind !== "pending" ||
            !publication.observation.invocation.equals(claim.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(audit.id)
        ) {
            throw invalid("Authority denial evidence does not bind the current claimed item");
        }
        this.persistence.appendReceipt(transaction, receipt);
        evidence.appendAudit(transaction, audit, {
            evidence: this.auditEvidence(transaction, { receipt })
        });
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
            publication.state.kind !== "pending" ||
            !publication.observation.invocation.equals(attempt.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(audit.id)
        ) {
            throw invalid("Receipt AuditRecord or publication does not bind the attempted effect");
        }
        this.recordAttemptReceipt(transaction, receipt);
        evidence.appendAudit(transaction, audit, {
            evidence: this.auditEvidence(transaction, { receipt })
        });
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

    protected supersedeReceiptUnchecked(transaction: Transaction, receipt: AttemptReceipt): void {
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

    public supersedeReceiptWithAudit(
        transaction: Transaction,
        receipt: AttemptReceipt,
        supersession: ReceiptSupersessionEvidence,
        evidence: InvocationEvidencePersistence<Transaction>
    ): void {
        const { finalReceiptAudit, supersessionAudit, publication } = supersession;
        this.requireTime(transaction, receipt.recordedAt);
        const attempt = this.persistence.attempt(transaction, receipt.attempt);
        if (
            attempt === undefined ||
            publication.state.kind !== "pending" ||
            !publication.observation.invocation.equals(attempt.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(supersessionAudit.id)
        ) {
            throw invalid("Receipt supersession evidence does not bind the attempted effect");
        }
        const context = { evidence: this.auditEvidence(transaction, { receipt }) };
        evidence.appendAudit(transaction, supersessionAudit, context);
        this.supersedeReceiptUnchecked(transaction, receipt);
        evidence.appendAudit(transaction, finalReceiptAudit, context);
        evidence.appendPublication(transaction, publication);
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

    private auditEvidence(
        transaction: Transaction,
        candidate: {
            readonly attempt?: EffectAttempt<Lease, Admission>;
            readonly receipt?: Receipt;
        }
    ): AuditEvidenceResolver {
        return {
            approval: (id, phase) => {
                const approval = this.persistence.approval(transaction, id);
                return approval?.state.kind === phase
                    ? { invocation: approval.invocation, phase }
                    : undefined;
            },
            attempt: (id) => {
                const attempt =
                    candidate.attempt !== undefined && id.equals(candidate.attempt.id)
                        ? candidate.attempt
                        : this.persistence.attempt(transaction, id);
                return attempt === undefined
                    ? undefined
                    : { invocation: attempt.invocation, auditCause: attempt.auditCause };
            },
            receipt: (id) => {
                const receipt =
                    candidate.receipt !== undefined && id.equals(candidate.receipt.id)
                        ? candidate.receipt
                        : this.persistence.receipt(transaction, id);
                if (receipt === undefined) return undefined;
                if (receipt instanceof PreEffectReceipt) {
                    return { invocation: receipt.invocation, outcome: receipt.outcome };
                }
                if (!(receipt instanceof AttemptReceipt)) return undefined;
                const attempt = this.persistence.attempt(transaction, receipt.attempt);
                return attempt === undefined
                    ? undefined
                    : {
                          invocation: attempt.invocation,
                          attempt: receipt.attempt,
                          outcome: receipt.outcome,
                          ...(receipt.previous === undefined ? {} : { previous: receipt.previous })
                      };
            },
            event: () => undefined,
            route: () => undefined,
            projection: () => undefined,
            delivery: () => undefined,
            commit: () => undefined,
            write: () => undefined
        };
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
