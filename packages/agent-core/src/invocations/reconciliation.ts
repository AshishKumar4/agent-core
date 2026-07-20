import type { ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import type { EffectAttempt } from "./attempt";
import { AuditRecord } from "./audit";
import type { EffectAttemptId } from "./id";
import type { InvocationLedger } from "./ledger";
import type { InvocationPersistence } from "./persistence";
import type {
    EffectReconciliationPort,
    InvocationEvidencePersistence,
    InvocationTransactionPort,
    ReconciliationResult
} from "./ports";
import type { PreparedInvocation } from "./prepared";
import { InvocationPublicationOutbox } from "./publication";
import { AttemptReceipt } from "./receipt";

type FinalReconciliationResult = Exclude<ReconciliationResult, { readonly kind: "unknown" }>;

export interface InvocationReconciliationRecordPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    receiptAudit(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        cause: AuditRecord,
        receipt: AttemptReceipt
    ): AuditRecord;
    reconciledReceipt(
        attempt: EffectAttempt<Lease, Admission>,
        previous: AttemptReceipt,
        result: FinalReconciliationResult,
        recordedAt: Date
    ): AttemptReceipt;
    receiptSupersessionAudit(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        previousAudit: AuditRecord,
        previous: AttemptReceipt,
        next: AttemptReceipt
    ): AuditRecord;
}

export class InvocationReconciler<Transaction, Lease, Authority, Domain, PathEpochs, Admission> {
    public constructor(
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: InvocationPersistence<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly ledger: InvocationLedger<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly provider: EffectReconciliationPort<Lease, Admission>,
        private readonly records: InvocationReconciliationRecordPort<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly evidence: InvocationEvidencePersistence<Transaction>,
        private readonly now: () => Date
    ) {}

    public async reconcile(attemptId: EffectAttemptId): Promise<AttemptReceipt | undefined> {
        const current = this.transactions.transact((transaction) =>
            this.current(transaction, attemptId)
        );
        if (current.receipt.outcome !== "indeterminate") return current.receipt;

        const result = await this.provider.query(current.attempt, current.invocation.intentDigest);
        if (result.kind === "unknown") return undefined;

        return this.transactions.transact((transaction) => {
            const refreshed = this.current(transaction, attemptId);
            if (refreshed.receipt.outcome !== "indeterminate") {
                if (!matches(refreshed.receipt, result)) {
                    throw invalid(
                        "Reconciliation provider contradicted the persisted final Receipt"
                    );
                }
                return refreshed.receipt;
            }

            const receipt = this.records.reconciledReceipt(
                refreshed.attempt,
                refreshed.receipt,
                result,
                this.now()
            );
            if (!matches(receipt, result)) {
                throw invalid("Reconciliation Receipt does not match the authoritative result");
            }
            const supersession = this.supersession(
                refreshed.invocation,
                refreshed.attemptAudit,
                refreshed.receiptAudit,
                refreshed.receipt,
                receipt
            );
            this.ledger.supersedeReceiptWithAudit(
                transaction,
                receipt,
                supersession,
                this.evidence
            );
            return receipt;
        });
    }

    private current(transaction: Transaction, attemptId: EffectAttemptId) {
        const attempt = this.persistence.attempt(transaction, attemptId);
        if (attempt === undefined) throw invalid("Reconciliation EffectAttempt does not exist");
        const invocation = this.persistence.prepared(transaction, attempt.invocation);
        if (invocation === undefined) {
            throw invalid("Reconciliation EffectAttempt has no PreparedInvocation");
        }
        const receipt = this.ledger.currentReceipt(
            transaction,
            attempt.invocation,
            attempt.itemIndex
        );
        if (!(receipt instanceof AttemptReceipt) || !receipt.attempt.equals(attempt.id)) {
            throw invalid("Reconciliation requires the current attempted Receipt");
        }
        const attemptCause = this.evidence.audit(transaction, attempt.auditCause);
        if (attemptCause === undefined) {
            throw invalid("Reconciliation EffectAttempt has no persisted audit cause");
        }
        this.ledger.requirePersistedAuditRelation(transaction, attemptCause, this.evidence);
        const attemptAudit = requireCausedAudit(
            this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
                kind: "attempt",
                id: attempt.id
            }),
            attemptCause,
            "Reconciliation EffectAttempt has no exact audit evidence"
        );
        this.ledger.requirePersistedAuditRelation(transaction, attemptAudit, this.evidence);
        const receiptAudit = requireCausedAudit(
            this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
                kind: "receipt",
                id: receipt.id,
                outcome: receipt.outcome
            }),
            attemptAudit,
            "Reconciliation Receipt has no exact audit evidence"
        );
        this.ledger.requirePersistedAuditRelation(transaction, receiptAudit, this.evidence);
        if (receipt.outcome !== "indeterminate") {
            this.requireCompleteEvidence(
                transaction,
                invocation,
                attempt,
                attemptAudit,
                receipt,
                receiptAudit
            );
        }
        return { attempt, attemptAudit, invocation, receipt, receiptAudit };
    }

    private supersession(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attemptAudit: AuditRecord,
        previousAudit: AuditRecord,
        previous: AttemptReceipt,
        next: AttemptReceipt
    ) {
        const finalReceiptAudit = this.records.receiptAudit(invocation, attemptAudit, next);
        const supersessionAudit = this.records.receiptSupersessionAudit(
            invocation,
            previousAudit,
            previous,
            next
        );
        return {
            finalReceiptAudit,
            supersessionAudit,
            publication: InvocationPublicationOutbox.pending({
                invocation: invocation.header.id,
                receipt: next.id,
                audit: supersessionAudit.id
            })
        };
    }

    private requireCompleteEvidence(
        transaction: Transaction,
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>,
        attemptAudit: AuditRecord,
        receipt: AttemptReceipt,
        finalReceiptAudit: AuditRecord
    ): void {
        const previous =
            receipt.previous === undefined
                ? undefined
                : this.persistence.receipt(transaction, receipt.previous);
        if (!(previous instanceof AttemptReceipt) || previous.outcome !== "indeterminate") {
            throw invalid("Final reconciliation Receipt has no indeterminate predecessor");
        }
        const previousAudit = requireCausedAudit(
            this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
                kind: "receipt",
                id: previous.id,
                outcome: previous.outcome
            }),
            attemptAudit,
            "Final reconciliation Receipt has no exact predecessor audit"
        );
        this.ledger.requirePersistedAuditRelation(transaction, previousAudit, this.evidence);
        const supersessionAudit = requireCausedAudit(
            this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
                kind: "receiptSuperseded",
                previous: previous.id,
                next: receipt.id
            }),
            previousAudit,
            "Final reconciliation Receipt has no exact supersession audit"
        );
        this.ledger.requirePersistedAuditRelation(transaction, supersessionAudit, this.evidence);
        const publicationIdentity = InvocationPublicationOutbox.pending({
            invocation: attempt.invocation,
            receipt: receipt.id,
            audit: supersessionAudit.id
        });
        const publication = this.evidence.publication(transaction, publicationIdentity.id);
        if (
            publication === undefined ||
            !publication.observation.invocation.equals(attempt.invocation) ||
            !publication.observation.receipt.equals(receipt.id) ||
            !publication.observation.audit.equals(supersessionAudit.id) ||
            !finalReceiptAudit.actor.equals(attemptAudit.actor) ||
            !finalReceiptAudit.tenant.equals(attemptAudit.tenant) ||
            !finalReceiptAudit.correlation.equals(attemptAudit.correlation)
        ) {
            throw invalid("Final reconciliation Receipt has no exact publication evidence");
        }
    }
}

function matches(receipt: AttemptReceipt, result: FinalReconciliationResult): boolean {
    return receipt.outcome === result.kind && sameContent(receipt.result, result.result);
}

function sameContent(left: ContentRef | undefined, right: ContentRef | undefined): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function requireCausedAudit(
    actual: AuditRecord | undefined,
    cause: AuditRecord,
    message: string
): AuditRecord {
    if (
        actual === undefined ||
        actual.cause?.equals(cause.id) !== true ||
        !actual.actor.equals(cause.actor) ||
        !actual.tenant.equals(cause.tenant) ||
        !actual.correlation.equals(cause.correlation)
    ) {
        throw invalid(message);
    }
    return actual;
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
