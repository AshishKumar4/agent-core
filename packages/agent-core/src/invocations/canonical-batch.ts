import type { ContentStore } from "../content";
import { Digest, decodeCanonicalJson, encodeCanonicalJson, type ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import type { FacetData, OperationContext } from "../facets";
import { ConfirmedOperationFailure, type MediatedInvocationRequest } from "../operations";
import type { InvocationId } from "../interaction-references";
import type { EffectAttempt } from "./attempt";
import type { AuditRecord } from "./audit";
import type { ItemClaim } from "./claim";
import { sameJson } from "./codec";
import type { InvocationLedger } from "./ledger";
import type { InvocationPersistence } from "./persistence";
import {
    type AuthorityAdmissionReference,
    type InvocationEvidencePersistence,
    type InvocationTransactionPort
} from "./ports";
import type { PreparedInvocation } from "./prepared";
import type { InvocationReconciliationRecordPort } from "./reconciliation";
import { InvocationPublicationOutbox } from "./publication";
import {
    AttemptReceipt,
    PreEffectReceipt,
    type AttemptReceiptOutcome,
    type Receipt
} from "./receipt";

export interface CanonicalBatchInvocationRequest<Authorization> {
    readonly invocation: InvocationId;
    readonly request: MediatedInvocationRequest<Authorization>;
}

export type CanonicalBatchItemResult =
    | {
          readonly kind: "succeeded";
          readonly itemIndex: number;
          readonly receipt: AttemptReceipt;
          readonly output: FacetData;
      }
    | {
          readonly kind: "terminal";
          readonly itemIndex: number;
          readonly receipt: Receipt;
      };

export interface CanonicalBatchInvocationResult {
    readonly invocation: InvocationId;
    readonly items: readonly CanonicalBatchItemResult[];
}

export interface CanonicalBatchInvoker<Authorization> {
    invoke(
        request: CanonicalBatchInvocationRequest<Authorization>
    ): Promise<CanonicalBatchInvocationResult>;
}

export interface CanonicalBatchPreparationPort<
    Authorization,
    Lease,
    Authority,
    Domain,
    PathEpochs
> {
    prepare(
        request: CanonicalBatchInvocationRequest<Authorization>
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
}

export interface CanonicalBatchAuthorityPermitPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    issue(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>
    ): Promise<AuthorityAdmissionReference<Admission>>;
}

export interface CanonicalBatchAuthorityAuthenticationPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Authentication
> {
    authenticate(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        admission: AuthorityAdmissionReference<Admission>
    ): Promise<Authentication>;
}

export interface CanonicalBatchRecordPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> extends InvocationReconciliationRecordPort<Lease, Authority, Domain, PathEpochs, Admission> {
    invocationAudit(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): AuditRecord;
    claim(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number,
        previous: ItemClaim<Lease> | undefined,
        now: Date
    ): ItemClaim<Lease>;
    retryClaim(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        previous: EffectAttempt<Lease, Admission>,
        now: Date
    ): ItemClaim<Lease>;
    attempt(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        admission: AuthorityAdmissionReference<Admission>,
        now: Date
    ): EffectAttempt<Lease, Admission>;
    attemptAudit(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>
    ): AuditRecord;
    preEffectReceipt(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        recordedAt: Date,
        reason: string
    ): PreEffectReceipt;
    attemptReceipt(
        attempt: EffectAttempt<Lease, Admission>,
        outcome: AttemptReceiptOutcome,
        recordedAt: Date,
        result: ContentRef | undefined
    ): AttemptReceipt;
    receiptAudit(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        cause: AuditRecord | undefined,
        receipt: Receipt
    ): AuditRecord;
}

export interface CanonicalBatchFinalAdmissionContext<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    readonly invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly claim: ItemClaim<Lease>;
    readonly authorityAdmission: AuthorityAdmissionReference<Admission>;
    readonly admittedAt: Date;
}

export type CanonicalBatchFinalAdmissionResult =
    | { readonly kind: "admitted"; readonly evidence?: unknown }
    | { readonly kind: "denied"; readonly reason: string };

export interface CanonicalBatchFinalAdmissionPort<
    Transaction,
    Authorization,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    admit(
        transaction: Transaction,
        request: CanonicalBatchInvocationRequest<Authorization>,
        context: CanonicalBatchFinalAdmissionContext<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >
    ): CanonicalBatchFinalAdmissionResult;
}

export interface CanonicalBatchResourcesPort<Authorization> {
    resources(
        request: CanonicalBatchInvocationRequest<Authorization>,
        itemIndex: number
    ): {
        readonly signal: AbortSignal;
        readonly content: ContentStore;
    };
}

type ItemState<Lease, Admission> =
    | { readonly kind: "receipt"; readonly receipt: Receipt }
    | { readonly kind: "attempt"; readonly attempt: EffectAttempt<Lease, Admission> }
    | { readonly kind: "claim"; readonly claim: ItemClaim<Lease> };

export class CanonicalBatchInvocationPort<
    Authorization,
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Authentication = undefined
> implements CanonicalBatchInvoker<Authorization> {
    readonly #activeItems = new Map<string, Map<number, Promise<CanonicalBatchItemResult>>>();

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
            Admission,
            Authentication
        >,
        private readonly preparation: CanonicalBatchPreparationPort<
            Authorization,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly permits: CanonicalBatchAuthorityPermitPort<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly authentication: CanonicalBatchAuthorityAuthenticationPort<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission,
            Authentication
        >,
        private readonly records: CanonicalBatchRecordPort<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly finalAdmission: CanonicalBatchFinalAdmissionPort<
            Transaction,
            Authorization,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly evidence: InvocationEvidencePersistence<Transaction>,
        private readonly resources: CanonicalBatchResourcesPort<Authorization>,
        private readonly now: () => Date
    ) {}

    public async invoke(
        request: CanonicalBatchInvocationRequest<Authorization>
    ): Promise<CanonicalBatchInvocationResult> {
        requireRequestShape(request.request);
        const prepared = this.preparation.prepare(request);
        requirePreparedRequest(prepared, request);
        this.transactions.transact((transaction) => {
            const existing = this.persistence.prepared(transaction, request.invocation);
            if (existing === undefined) {
                this.ledger.prepareWithAudit(
                    transaction,
                    prepared,
                    this.records.invocationAudit(prepared),
                    this.evidence
                );
            } else if (!existing.intentDigest.equals(prepared.intentDigest)) {
                throw invalid("Prepared Invocation changed under its canonical identity");
            } else {
                this.ledger.requirePreparedAudit(
                    transaction,
                    prepared,
                    this.records.invocationAudit(prepared),
                    this.evidence
                );
            }
        });

        const items: CanonicalBatchItemResult[] = [];
        for (let itemIndex = 0; itemIndex < prepared.itemCount; itemIndex += 1) {
            items.push(await this.invokeItem(request, prepared, itemIndex));
        }
        return Object.freeze({ invocation: request.invocation, items: Object.freeze(items) });
    }

    private async invokeItem(
        request: CanonicalBatchInvocationRequest<Authorization>,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number
    ): Promise<CanonicalBatchItemResult> {
        let invocationItems = this.#activeItems.get(prepared.header.id.value);
        if (invocationItems === undefined) {
            invocationItems = new Map();
            this.#activeItems.set(prepared.header.id.value, invocationItems);
        }
        const existing = invocationItems.get(itemIndex);
        if (existing !== undefined) return existing;
        const invocation = this.invokeItemOnce(request, prepared, itemIndex);
        invocationItems.set(itemIndex, invocation);
        try {
            return await invocation;
        } finally {
            if (invocationItems.get(itemIndex) === invocation) {
                invocationItems.delete(itemIndex);
                if (invocationItems.size === 0) {
                    this.#activeItems.delete(prepared.header.id.value);
                }
            }
        }
    }

    private async invokeItemOnce(
        request: CanonicalBatchInvocationRequest<Authorization>,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number
    ): Promise<CanonicalBatchItemResult> {
        const state = this.claim(prepared, itemIndex);
        if (state.kind === "receipt")
            return this.resultForReceipt(request, itemIndex, state.receipt);
        if (state.kind === "attempt") {
            const receipt = this.finish(prepared, state.attempt, "indeterminate", undefined);
            return terminal(itemIndex, receipt);
        }

        let admission: AuthorityAdmissionReference<Admission>;
        try {
            admission = await this.permits.issue(prepared, state.claim);
        } catch (error) {
            if (!(error instanceof AgentCoreError) || error.code !== "authority.denied")
                throw error;
            return terminal(
                itemIndex,
                this.denyClaim(prepared, state.claim, error.message || "Authority permit denied")
            );
        }

        let authentication: Authentication;
        try {
            authentication = await this.authentication.authenticate(
                prepared,
                state.claim,
                admission
            );
        } catch (error) {
            if (!(error instanceof AgentCoreError) || error.code !== "authority.denied")
                throw error;
            return terminal(
                itemIndex,
                this.denyClaim(
                    prepared,
                    state.claim,
                    error.message || "Authority permit authentication denied"
                )
            );
        }

        const admittedAt = this.now();
        const admissionResult = this.transactions.transact((transaction) => {
            const currentClaim = this.persistence
                .claimsForItem(transaction, prepared.header.id, itemIndex)
                .at(-1);
            if (currentClaim === undefined || !currentClaim.id.equals(state.claim.id)) {
                return { kind: "retry" as const };
            }
            const receipt = this.ledger.currentReceipt(transaction, prepared.header.id, itemIndex);
            if (receipt !== undefined) {
                const failedAttempt =
                    receipt instanceof AttemptReceipt && receipt.outcome === "failed"
                        ? this.persistence.attempt(transaction, receipt.attempt)
                        : undefined;
                if (
                    failedAttempt === undefined ||
                    failedAttempt.ordinal + 1 !== state.claim.attemptOrdinal
                ) {
                    return { kind: "receipt" as const, receipt };
                }
            }
            const winner = this.persistence
                .attemptsForItem(transaction, prepared.header.id, itemIndex)
                .at(-1);
            if (winner !== undefined && winner.ordinal >= state.claim.attemptOrdinal) {
                return { kind: "attempt" as const, attempt: winner };
            }
            const final = this.finalAdmission.admit(transaction, request, {
                invocation: prepared,
                claim: state.claim,
                authorityAdmission: admission,
                admittedAt
            });
            if (final.kind === "denied") {
                const receipt = this.records.preEffectReceipt(
                    prepared,
                    state.claim,
                    admittedAt,
                    final.reason
                );
                const audit = this.records.receiptAudit(prepared, undefined, receipt);
                this.ledger.recordClaimedAuthorityDenialWithAudit(
                    transaction,
                    state.claim,
                    receipt,
                    audit,
                    publication(prepared.header.id, receipt, audit),
                    this.evidence
                );
                return { kind: "denied" as const, receipt };
            }
            const attempt = this.records.attempt(prepared, state.claim, admission, admittedAt);
            const attemptAudit = this.records.attemptAudit(prepared, attempt);
            const denialReceipt = this.records.preEffectReceipt(
                prepared,
                state.claim,
                admittedAt,
                "Authority permit is invalid at target admission"
            );
            const denialAudit = this.records.receiptAudit(prepared, undefined, denialReceipt);
            const admitted = this.ledger.admitAttemptOrRecordAuthorityDenialWithAudit(
                transaction,
                attempt,
                admittedAt,
                attemptAudit,
                {
                    claim: state.claim,
                    receipt: denialReceipt,
                    audit: denialAudit,
                    publication: publication(prepared.header.id, denialReceipt, denialAudit)
                },
                this.evidence,
                authentication
            );
            return admitted
                ? { kind: "admitted" as const, attempt, evidence: final.evidence }
                : { kind: "denied" as const, receipt: denialReceipt };
        });
        if (admissionResult.kind === "denied") {
            return terminal(itemIndex, admissionResult.receipt);
        }
        if (admissionResult.kind === "receipt") {
            return this.resultForReceipt(request, itemIndex, admissionResult.receipt);
        }
        if (admissionResult.kind === "attempt") {
            throw invalid("A concurrent EffectAttempt won target admission");
        }
        if (admissionResult.kind === "retry") {
            return this.invokeItemOnce(request, prepared, itemIndex);
        }
        const { attempt } = admissionResult;

        const execution = this.resources.resources(request, itemIndex);
        const context: OperationContext = Object.freeze({
            invocation: prepared.header.id,
            itemIndex,
            idempotencyKey: prepared.item(itemIndex).idempotencyKey,
            attempt: Object.freeze({
                id: attempt.id,
                ordinal: attempt.ordinal,
                intentDigest: prepared.intentDigest
            }),
            targetAdmission: admissionResult.evidence,
            signal: execution.signal,
            content: execution.content
        });
        let output: FacetData;
        try {
            output = canonicalData(await request.request.execute(itemIndex, context));
        } catch (error) {
            const confirmed = error instanceof ConfirmedOperationFailure ? error : undefined;
            return terminal(
                itemIndex,
                this.finish(
                    prepared,
                    attempt,
                    confirmed === undefined ? "indeterminate" : "failed",
                    confirmed?.evidence
                )
            );
        }

        let result: ContentRef;
        try {
            result = (await execution.content.put(encodeCanonicalJson(output))).ref;
        } catch {
            return terminal(itemIndex, this.finish(prepared, attempt, "indeterminate", undefined));
        }
        const receipt = this.finish(prepared, attempt, "succeeded", result);
        return Object.freeze({ kind: "succeeded", itemIndex, receipt, output });
    }

    private claim(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number
    ): ItemState<Lease, Admission> {
        const at = this.now();
        return this.transactions.transact((transaction) => {
            const receipt = this.ledger.currentReceipt(transaction, prepared.header.id, itemIndex);
            const attempt = this.persistence
                .attemptsForItem(transaction, prepared.header.id, itemIndex)
                .at(-1);
            const current = this.persistence
                .claimsForItem(transaction, prepared.header.id, itemIndex)
                .at(-1);
            if (
                current !== undefined &&
                this.persistence.attemptForClaim(transaction, current.id) === undefined
            ) {
                if (current.expiresAt.getTime() > at.getTime()) {
                    return { kind: "claim", claim: current };
                }
                const replacement = this.records.claim(prepared, itemIndex, current, at);
                this.ledger.recoverClaim(transaction, current.id, replacement, at);
                return { kind: "claim", claim: replacement };
            }
            if (receipt !== undefined) {
                if (
                    !(receipt instanceof AttemptReceipt) ||
                    receipt.outcome !== "failed" ||
                    attempt === undefined ||
                    !receipt.attempt.equals(attempt.id)
                ) {
                    return { kind: "receipt", receipt };
                }
                const retry = this.records.retryClaim(prepared, attempt, at);
                this.ledger.claimItem(transaction, retry, at);
                return { kind: "claim", claim: retry };
            }
            if (attempt !== undefined) return { kind: "attempt", attempt };
            const claim = this.records.claim(prepared, itemIndex, undefined, at);
            this.ledger.claimItem(transaction, claim, at);
            return { kind: "claim", claim };
        });
    }

    private denyClaim(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        reason: string
    ): PreEffectReceipt {
        const recordedAt = this.now();
        const receipt = this.records.preEffectReceipt(prepared, claim, recordedAt, reason);
        const audit = this.records.receiptAudit(prepared, undefined, receipt);
        return this.transactions.transact((transaction) => {
            const current = this.ledger.currentReceipt(
                transaction,
                prepared.header.id,
                claim.itemIndex
            );
            if (current !== undefined) {
                if (current instanceof PreEffectReceipt) return current;
                throw invalid("Authority denial raced an attempted item Receipt");
            }
            this.ledger.recordClaimedAuthorityDenialWithAudit(
                transaction,
                claim,
                receipt,
                audit,
                publication(prepared.header.id, receipt, audit),
                this.evidence
            );
            return receipt;
        });
    }

    private finish(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>,
        outcome: AttemptReceiptOutcome,
        result: ContentRef | undefined
    ): AttemptReceipt {
        const receipt = this.records.attemptReceipt(attempt, outcome, this.now(), result);
        const attemptAudit = this.records.attemptAudit(prepared, attempt);
        const audit = this.records.receiptAudit(prepared, attemptAudit, receipt);
        this.transactions.transact((transaction) => {
            this.ledger.recordAttemptReceiptWithAudit(
                transaction,
                receipt,
                attemptAudit,
                audit,
                publication(prepared.header.id, receipt, audit),
                this.evidence
            );
        });
        return receipt;
    }

    private async resultForReceipt(
        request: CanonicalBatchInvocationRequest<Authorization>,
        itemIndex: number,
        receipt: Receipt
    ): Promise<CanonicalBatchItemResult> {
        if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "succeeded") {
            return terminal(itemIndex, receipt);
        }
        if (receipt.result === undefined) {
            throw invalid("Successful Operation Receipt has no canonical result content");
        }
        const content = this.resources.resources(request, itemIndex).content;
        return Object.freeze({
            kind: "succeeded",
            itemIndex,
            receipt,
            output: canonicalData(
                decodeCanonicalJson(await content.get(receipt.result)) as FacetData
            )
        });
    }
}

function requireRequestShape<Authorization>(
    request: MediatedInvocationRequest<Authorization>
): void {
    const expected = request.shape.kind === "single" ? 1 : request.shape.itemCount;
    if (
        !Number.isSafeInteger(expected) ||
        expected <= 0 ||
        request.inputs.length !== expected ||
        request.interceptions.length !== expected
    ) {
        throw invalid("Canonical batch request must be a nonempty exact payload shape");
    }
}

function requirePreparedRequest<Authorization, Lease, Authority, Domain, PathEpochs>(
    prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
    request: CanonicalBatchInvocationRequest<Authorization>
): void {
    const expectedKind = request.request.shape.kind;
    if (
        !prepared.header.id.equals(request.invocation) ||
        prepared.payload.kind !== expectedKind ||
        prepared.itemCount !== request.request.inputs.length ||
        prepared.header.operation.target !== request.request.facet.value ||
        prepared.header.operation.impact !== request.request.descriptor.impact ||
        !prepared.header.operation.descriptorDigest.equals(
            Digest.sha256(encodeCanonicalJson(request.request.descriptor.toData()))
        ) ||
        request.request.inputs.some(
            (input, itemIndex) => !sameJson(input, prepared.item(itemIndex).arguments)
        )
    ) {
        throw invalid("Prepared Invocation does not bind the exact canonical batch request");
    }
}

function publication(
    invocation: InvocationId,
    receipt: Receipt,
    audit: AuditRecord
): InvocationPublicationOutbox {
    return InvocationPublicationOutbox.pending(
        Object.freeze({ invocation, receipt: receipt.id, audit: audit.id })
    );
}

function terminal(itemIndex: number, receipt: Receipt): CanonicalBatchItemResult {
    return Object.freeze({ kind: "terminal", itemIndex, receipt });
}

function canonicalData(value: FacetData): FacetData {
    return decodeCanonicalJson(encodeCanonicalJson(value)) as FacetData;
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
