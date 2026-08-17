import type { ContentStore } from "../content";
import { Digest, decodeCanonicalJson, encodeCanonicalJson, type ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import { canonicalFacetData, type FacetData, type OperationContext } from "../facets";
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
    AttemptCompletion,
    AttemptFailureKind,
    AttemptReceipt,
    PreEffectReceipt,
    type AttemptTargetDomain,
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
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Denial = never
> {
    issue(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>
    ): Promise<CanonicalBatchAuthorityPermitResult<Admission, Denial>>;
    deny(
        transaction: Transaction,
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        denial: Denial
    ): void;
}

export type CanonicalBatchAuthorityPermitResult<Admission, Denial = never> =
    | { readonly kind: "issued"; readonly admission: AuthorityAdmissionReference<Admission> }
    | { readonly kind: "denied"; readonly denial: Denial; readonly reason: string }
    | { readonly kind: "invalid"; readonly reason: string }
    | { readonly kind: "expired" };

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
        completion: AttemptCompletion,
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

/**
 * The live resources one attempt runs against. The bound and the hosting domain are here
 * rather than on the PreparedInvocation because §7.4 asks the host to derive a failure kind
 * from a seam it controls, and §8.3 forbids a durable record from owning live substrate
 * resources. A host that sets no bound on an attempt says so with `undefined`.
 */
export interface CanonicalBatchAttemptResources {
    readonly signal: AbortSignal;
    readonly content: ContentStore;
    readonly deadline: Date | undefined;
    readonly target: AttemptTargetDomain;
}

export interface CanonicalBatchResourcesPort<Authorization> {
    resources(
        request: CanonicalBatchInvocationRequest<Authorization>,
        itemIndex: number
    ): CanonicalBatchAttemptResources;
}

/**
 * The facts a host holds when an attempt ended without a usable result. §7.4 lets the host
 * derive four kinds from boundaries it owns and lets the invoked handler originate only
 * `raised`, so the callee's contribution arrives as a verdict the seam already narrowed to
 * rather than as anything the callee said about itself: labelling a rejection `domainLost`
 * cannot reach `domainLost`, because that kind is read off the domain and not off the error.
 *
 * `target` is required and has no default. It carries the entire content of `domainLost`, so
 * an observation without one is not classifiable rather than classifiable as answering — a
 * default would let that kind be ruled out by nothing having been asked.
 */
export interface AttemptFailureObservation {
    /** True exactly when the handler signalled failure itself (§4.1 `execute`). */
    readonly confirmed: boolean;
    /** The host's own bound on this attempt, present only when it is what ended the wait. */
    readonly elapsedBound: Date | undefined;
    /** Cancellation of the Turn or Run that owns the item. */
    readonly cancellation: AbortSignal;
    /** The protection domain hosting the target. */
    readonly target: AttemptTargetDomain;
    readonly observedAt: Date;
}

/**
 * §7.4's derivation, or `undefined` when the host holds no determination and the outcome is
 * therefore `indeterminate`.
 *
 * The order is causal, not arbitrary. A confirmed verdict is the handler's own answer, so the
 * host is not guessing and asks nothing further. Otherwise a lost domain explains any
 * boundary of the host's that also closed; a cancelled Turn or Run explains an elapsed bound
 * but not a lost domain; and the host's own bound is named only when nothing else accounts
 * for the end of the wait. Falling through to `undefined` is the point rather than a gap: an
 * unexplained end is not a kind, because naming one would convert "I cannot tell" into "I
 * know why".
 */
export function classifyAttemptFailure(
    observation: AttemptFailureObservation
): AttemptFailureKind | undefined {
    if (observation.confirmed) return AttemptFailureKind.raised;
    if (!observation.target.answering()) {
        return AttemptFailureKind.domainLost(observation.target);
    }
    if (observation.cancellation.aborted) {
        return AttemptFailureKind.aborted(observation.cancellation);
    }
    if (observation.elapsedBound !== undefined) {
        return AttemptFailureKind.deadline(observation.elapsedBound, observation.observedAt);
    }
    return undefined;
}

/**
 * The host's own bound closing on an attempt. It is module-private so the invoked handler
 * cannot construct one: §7.4 lets the callee originate `raised` and nothing else, and a
 * marker a callee could throw would hand it `deadline`.
 */
class AttemptBoundElapsed {
    public constructor(public readonly bound: Date) {
        Object.freeze(this);
    }
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
    Authentication = undefined,
    Denial = never
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
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission,
            Denial
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
        requireRequestCardinality(request.request);
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
            const receipt = this.finish(
                prepared,
                state.attempt,
                AttemptCompletion.indeterminate,
                undefined
            );
            return terminal(itemIndex, receipt);
        }

        const permitResult = await this.permits.issue(prepared, state.claim);
        if (permitResult.kind === "expired") {
            return this.invokeItemOnce(request, prepared, itemIndex);
        }
        if (permitResult.kind === "invalid") {
            return terminal(itemIndex, this.denyClaim(prepared, state.claim, permitResult.reason));
        }
        if (permitResult.kind === "denied") {
            return terminal(
                itemIndex,
                this.denyClaim(prepared, state.claim, permitResult.reason, permitResult.denial)
            );
        }
        const { admission } = permitResult;

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
            output = canonicalData(
                await withinBound(
                    request.request.execute(itemIndex, context),
                    execution.deadline,
                    this.now
                )
            );
        } catch (error) {
            const confirmed = error instanceof ConfirmedOperationFailure ? error : undefined;
            const failure = classifyAttemptFailure({
                confirmed: confirmed !== undefined,
                elapsedBound: error instanceof AttemptBoundElapsed ? error.bound : undefined,
                cancellation: execution.signal,
                target: execution.target,
                observedAt: this.now()
            });
            return terminal(
                itemIndex,
                this.finish(
                    prepared,
                    attempt,
                    failure === undefined
                        ? AttemptCompletion.indeterminate
                        : AttemptCompletion.failed(failure),
                    confirmed?.evidence
                )
            );
        }
        const declared = request.request.descriptor.output;
        if (!declared.accepts(output)) {
            return terminal(
                itemIndex,
                this.finish(
                    prepared,
                    attempt,
                    AttemptCompletion.failed(AttemptFailureKind.outputInvalid(declared, output)),
                    undefined
                )
            );
        }

        let result: ContentRef;
        try {
            result = (await execution.content.put(encodeCanonicalJson(output))).ref;
        } catch {
            return terminal(
                itemIndex,
                this.finish(prepared, attempt, AttemptCompletion.indeterminate, undefined)
            );
        }
        const receipt = this.finish(prepared, attempt, AttemptCompletion.succeeded, result);
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
        reason: string,
        denial?: Denial
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
            const currentClaim = this.persistence
                .claimsForItem(transaction, prepared.header.id, claim.itemIndex)
                .at(-1);
            if (
                currentClaim === undefined ||
                !currentClaim.id.equals(claim.id) ||
                this.persistence.attemptForClaim(transaction, claim.id) !== undefined
            ) {
                throw invalid("Authority denial does not bind the exact current claim");
            }
            if (denial !== undefined) {
                this.permits.deny(transaction, prepared, claim, denial);
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
        completion: AttemptCompletion,
        result: ContentRef | undefined
    ): AttemptReceipt {
        const receipt = this.records.attemptReceipt(attempt, completion, this.now(), result);
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
            output: canonicalFacetData(decodeCanonicalJson(await content.get(receipt.result)))
        });
    }
}

function requireRequestCardinality<Authorization>(
    request: MediatedInvocationRequest<Authorization>
): void {
    const expected = request.cardinality.kind === "single" ? 1 : request.cardinality.itemCount;
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
    const expectedKind = request.request.cardinality.kind;
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

/**
 * Awaits the handler under the host's own bound on this attempt, if the host set one.
 *
 * The bound is raced separately from the owning Turn or Run's cancellation on purpose. A
 * single combined signal would tell the host that *something* closed and never which,
 * collapsing §7.4's `deadline` and `aborted` into one indistinguishable fact. Racing the two
 * separately is what lets the host name the boundary it actually observed.
 */
function withinBound<Value>(
    work: Promise<Value>,
    bound: Date | undefined,
    now: () => Date
): Promise<Value> {
    if (bound === undefined) return work;
    const elapsed = new Promise<never>((_resolve, reject) => {
        const remaining = Math.max(0, bound.getTime() - now().getTime());
        const timer = setTimeout(() => reject(new AttemptBoundElapsed(bound)), remaining);
        const settle = (): void => clearTimeout(timer);
        work.then(settle, settle);
    });
    return Promise.race([work, elapsed]);
}

function canonicalData(value: FacetData): FacetData {
    return canonicalFacetData(value);
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
