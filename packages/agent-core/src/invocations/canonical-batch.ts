import type { ContentStore } from "../content";
import { Digest, decodeCanonicalJson, encodeCanonicalJson, type ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import {
    canonicalFacetData,
    type FacetData,
    type OperationContext,
    type OperationDescriptor
} from "../facets";
import { ConfirmedOperationFailure, type MediatedInvocationRequest } from "../operations";
import type { InvocationId } from "../interaction-references";
import { AdmittedInvocationItem } from "./admitted-item";
import type { EffectAttempt } from "./attempt";
import type { AuditRecord } from "./audit";
import type { ItemClaim } from "./claim";
import { sameJson } from "./codec";
import {
    DetachedEffectExecution,
    type DetachedEffectExecutionPersistence
} from "./detached-execution";
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
    type PreEffectReceiptOutcome,
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
    /**
     * The outcome is an argument because §7.4 gives the pre-effect variant two of them and
     * they are different facts: a denial before the effect and a cancellation before the
     * effect derive different batch outcomes (§7.5) and carry different ids (§7.4's one
     * owning-Actor namespace). A port that chose the outcome itself would answer a question
     * only the admission point can answer.
     */
    preEffectReceipt(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        outcome: PreEffectReceiptOutcome,
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

/**
 * `cancelled` is the §5.6 boundary rather than a second flavour of denial. Admission is the
 * commit point a handle names, so an expiry, cancellation, or loss of the required Turn or Run
 * observed here is a `cancelledPreEffect` Receipt over an item with no EffectAttempt, and
 * nothing is detached; after admission the same fact reaches the attempt instead and §7.4
 * names it `aborted`. Collapsing the two into `denied` would report a cancelled Run's batch as
 * `denied` and would claim an authority decision that was never made.
 */
export type CanonicalBatchFinalAdmissionResult =
    | { readonly kind: "admitted"; readonly evidence?: unknown }
    | { readonly kind: "denied"; readonly reason: string }
    | { readonly kind: "cancelled"; readonly reason: string };

/**
 * The target's own admission evidence, carried to the handler as `OperationContext`'s
 * `targetAdmission`. It is named off the result that produces it so the two cannot drift and
 * so no second declaration widens the type.
 */
export type CanonicalBatchTargetAdmission = Extract<
    CanonicalBatchFinalAdmissionResult,
    { readonly kind: "admitted" }
>["evidence"];

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
 * Everything live one admitted item's execution runs against: the handler the pinned Operation
 * exposes, the resources that handler observes, and the target's own admission evidence.
 *
 * Admission and execution are separate steps, so the live half is a value rather than a closure
 * the admitting call happened to hold. An in-Turn invocation passes its own live request; a
 * detached item's target rebuilds one from durable records after the issuing Turn is gone. Both
 * reach the same execution step, which is what keeps one §7.4 classification path for both.
 *
 * It carries exactly what the execution reads — the declared output shape and the handler call —
 * and deliberately not a whole `MediatedInvocationRequest`. The rest of that shape is inert on
 * the execution path, and three of its fields (the request key, the full authority intent, the
 * interceptor traces) are not reconstructible from durable records: a rebuilt target would have
 * to fabricate them to satisfy the type, and a seam that demands fabricated authority evidence
 * is not a seam. The admitting Turn still supplies the full request where those fields genuinely
 * exist.
 */
export interface CanonicalBatchItemExecution {
    /** The pinned Operation's declared shape, read for the output the handler must satisfy. */
    readonly descriptor: OperationDescriptor;
    /** The Operation's handler, exactly as an in-Turn invocation would call it. */
    execute(itemIndex: number, context: OperationContext): Promise<FacetData>;
    readonly resources: CanonicalBatchAttemptResources;
    readonly targetAdmission: CanonicalBatchTargetAdmission;
}

/**
 * What the admission step reached for one item: a durable EffectAttempt that no Receipt names
 * yet, or a Receipt that ends the item before any effect.
 *
 * The admitted case carries the item and never a Receipt, because that is the entire point of
 * separating the steps: §5.6's handle is built over an item whose work has been admitted and
 * has not happened, and a value that could carry an outcome would let a Run publish a handle
 * for an item that already finished.
 */
export type CanonicalBatchItemAdmission =
    | {
          readonly kind: "admitted";
          readonly item: AdmittedInvocationItem;
          readonly targetAdmission: CanonicalBatchTargetAdmission;
      }
    | { readonly kind: "terminal"; readonly itemIndex: number; readonly receipt: Receipt };

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

/**
 * The admission step's own answer. It is the public `CanonicalBatchItemAdmission` plus the
 * EffectAttempt record, which the execution step needs and no caller outside this file does:
 * a Receipt is written against the attempt, and re-reading it to hand it back would be a
 * second read of a record this transaction already holds.
 */
type ItemAdmission<Lease, Admission> =
    | {
          readonly kind: "admitted";
          readonly item: AdmittedInvocationItem;
          readonly attempt: EffectAttempt<Lease, Admission>;
          readonly targetAdmission: CanonicalBatchTargetAdmission;
      }
    | { readonly kind: "terminal"; readonly itemIndex: number; readonly receipt: Receipt };

/** The stored records one admitted item names, read in one transaction. */
interface AdmittedItemState<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly attempt: EffectAttempt<Lease, Admission>;
    readonly receipt: Receipt | undefined;
}

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
        private readonly detachedExecutions: DetachedEffectExecutionPersistence<Transaction>,
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
        const prepared = this.prepare(request);
        const items: CanonicalBatchItemResult[] = [];
        for (let itemIndex = 0; itemIndex < prepared.itemCount; itemIndex += 1) {
            items.push(await this.invokeItem(request, prepared, itemIndex));
        }
        return Object.freeze({ invocation: request.invocation, items: Object.freeze(items) });
    }

    /**
     * Admits one item's effect and records that its execution has left the issuing Turn, in one
     * transaction (§5.6, C13-TURN-HANDLE-DETACHMENT).
     *
     * The EffectAttempt and the detachment record commit together because either alone is a
     * lie: an attempt with no detachment record is an item nothing will ever execute after a
     * restart, and a detachment record with no attempt names work that was never admitted.
     * Nothing runs here, so the caller can publish an admission identity over an item that has
     * an attempt and no Receipt — which is the fact §5.6's handle needs and the one a truthful
     * settlement view cannot obtain from a Receipt.
     */
    public async admitDetachedItem(
        request: CanonicalBatchInvocationRequest<Authorization>,
        itemIndex: number
    ): Promise<CanonicalBatchItemAdmission> {
        const prepared = this.prepare(request);
        // Refuses an index this PreparedInvocation does not have before anything is claimed.
        prepared.item(itemIndex);
        return this.admitItem(request, prepared, itemIndex, true);
    }

    /**
     * Runs one admitted item against the live resources it was given, and records its Receipt.
     *
     * It re-reads its own state first and takes the item as durable facts rather than as a
     * closure, so the same step serves the Turn that admitted the item and a driver that
     * rebuilt it from records after a restart. A Receipt that already exists replays instead of
     * running the effect again (§7.3's idempotency), which is what makes a duplicated delivery
     * a no-op rather than a second external effect.
     */
    public async executeAdmittedItem(
        item: AdmittedInvocationItem,
        execution: CanonicalBatchItemExecution
    ): Promise<CanonicalBatchItemResult> {
        return this.once(item.invocation, item.itemIndex, async () => {
            const admitted = this.transactions.transact((transaction) =>
                this.admittedItemState(transaction, item)
            );
            if (admitted.receipt !== undefined) {
                return this.resultForReceipt(
                    item.itemIndex,
                    admitted.receipt,
                    () => execution.resources.content
                );
            }
            return this.executeAttempt(
                item.itemIndex,
                admitted.prepared,
                admitted.attempt,
                execution
            );
        });
    }

    /** Records the PreparedInvocation once, or requires the stored one to be the same intent. */
    private prepare(
        request: CanonicalBatchInvocationRequest<Authorization>
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
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
        return prepared;
    }

    private async invokeItem(
        request: CanonicalBatchInvocationRequest<Authorization>,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number
    ): Promise<CanonicalBatchItemResult> {
        return this.once(prepared.header.id, itemIndex, () =>
            this.invokeItemOnce(request, prepared, itemIndex)
        );
    }

    /**
     * Runs one item's work at most once per process at a time. Two callers naming the same item
     * share the first one's promise, so a redelivery that arrives while the item is running
     * joins the run in flight instead of starting a second effect.
     */
    private async once(
        invocation: InvocationId,
        itemIndex: number,
        work: () => Promise<CanonicalBatchItemResult>
    ): Promise<CanonicalBatchItemResult> {
        let invocationItems = this.#activeItems.get(invocation.value);
        if (invocationItems === undefined) {
            invocationItems = new Map();
            this.#activeItems.set(invocation.value, invocationItems);
        }
        const existing = invocationItems.get(itemIndex);
        if (existing !== undefined) return existing;
        const started = work();
        invocationItems.set(itemIndex, started);
        try {
            return await started;
        } finally {
            if (invocationItems.get(itemIndex) === started) {
                invocationItems.delete(itemIndex);
                if (invocationItems.size === 0) {
                    this.#activeItems.delete(invocation.value);
                }
            }
        }
    }

    private async invokeItemOnce(
        request: CanonicalBatchInvocationRequest<Authorization>,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number
    ): Promise<CanonicalBatchItemResult> {
        const admission = await this.admitItem(request, prepared, itemIndex, false);
        if (admission.kind === "terminal") {
            return this.resultForReceipt(
                itemIndex,
                admission.receipt,
                () => this.resources.resources(request, itemIndex).content
            );
        }
        return this.executeAttempt(itemIndex, prepared, admission.attempt, {
            descriptor: request.request.descriptor,
            execute: (item, context) => request.request.execute(item, context),
            resources: this.resources.resources(request, itemIndex),
            targetAdmission: admission.targetAdmission
        });
    }

    /**
     * Everything up to and including the durable EffectAttempt append: claim, authority permit,
     * permit authentication, and the target's own final admission. `detached` decides only
     * whether the same transaction also records that the item's execution left the Turn.
     */
    private async admitItem(
        request: CanonicalBatchInvocationRequest<Authorization>,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        itemIndex: number,
        detached: boolean
    ): Promise<ItemAdmission<Lease, Admission>> {
        const state = this.claim(prepared, itemIndex);
        if (state.kind === "receipt") return terminal(itemIndex, state.receipt);
        if (state.kind === "attempt") {
            const readmitted = detached ? this.readmitDetached(prepared, state.attempt) : undefined;
            if (readmitted !== undefined) return readmitted;
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
            return this.admitItem(request, prepared, itemIndex, detached);
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
            if (final.kind === "denied" || final.kind === "cancelled") {
                const outcome: PreEffectReceiptOutcome =
                    final.kind === "cancelled" ? "cancelledPreEffect" : "deniedPreEffect";
                const receipt = this.records.preEffectReceipt(
                    prepared,
                    state.claim,
                    outcome,
                    admittedAt,
                    final.reason
                );
                const audit = this.records.receiptAudit(prepared, undefined, receipt);
                const outbox = publication(prepared.header.id, receipt, audit);
                if (final.kind === "cancelled") {
                    this.ledger.recordClaimedCancellationWithAudit(
                        transaction,
                        state.claim,
                        receipt,
                        audit,
                        outbox,
                        this.evidence
                    );
                } else {
                    this.ledger.recordClaimedAuthorityDenialWithAudit(
                        transaction,
                        state.claim,
                        receipt,
                        audit,
                        outbox,
                        this.evidence
                    );
                }
                return { kind: "refused" as const, receipt };
            }
            if (final.kind !== "admitted") {
                throw invalid("Final admission result kind is invalid");
            }
            const attempt = this.records.attempt(prepared, state.claim, admission, admittedAt);
            const attemptAudit = this.records.attemptAudit(prepared, attempt);
            const denialReceipt = this.records.preEffectReceipt(
                prepared,
                state.claim,
                "deniedPreEffect",
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
            if (!admitted) return { kind: "refused" as const, receipt: denialReceipt };
            const item = AdmittedInvocationItem.derive(prepared, attempt);
            if (detached) {
                this.detachedExecutions.appendDetachedExecution(
                    transaction,
                    DetachedEffectExecution.awaiting(item)
                );
            }
            return { kind: "admitted" as const, attempt, item, evidence: final.evidence };
        });
        if (admissionResult.kind === "refused") {
            return terminal(itemIndex, admissionResult.receipt);
        }
        if (admissionResult.kind === "receipt") {
            return terminal(itemIndex, admissionResult.receipt);
        }
        if (admissionResult.kind === "attempt") {
            throw invalid("A concurrent EffectAttempt won target admission");
        }
        if (admissionResult.kind === "retry") {
            return this.admitItem(request, prepared, itemIndex, detached);
        }
        return Object.freeze({
            kind: "admitted" as const,
            item: admissionResult.item,
            attempt: admissionResult.attempt,
            targetAdmission: admissionResult.evidence
        });
    }

    /**
     * The already-admitted answer for a detached replay: an attempt this host detached earlier
     * and never receipted is the same admitted item, so re-admission returns it instead of
     * declaring the outcome unknown. Without a detachment record the attempt belongs to the
     * in-Turn path, and only that path's own rule applies.
     */
    private readmitDetached(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>
    ): ItemAdmission<Lease, Admission> | undefined {
        const detachment = this.transactions.transact((transaction) =>
            this.detachedExecutions.detachedExecution(transaction, attempt.id)
        );
        if (detachment === undefined) return undefined;
        return Object.freeze({
            kind: "admitted",
            item: AdmittedInvocationItem.derive(prepared, attempt),
            attempt,
            targetAdmission: undefined
        });
    }

    /** The stored PreparedInvocation, EffectAttempt, and current Receipt one item names. */
    private admittedItemState(
        transaction: Transaction,
        item: AdmittedInvocationItem
    ): AdmittedItemState<Lease, Authority, Domain, PathEpochs, Admission> {
        const prepared = this.persistence.prepared(transaction, item.invocation);
        if (prepared === undefined) {
            throw invalid("Admitted item names no stored PreparedInvocation");
        }
        const attempt = this.persistence.attempt(transaction, item.attempt);
        if (
            attempt === undefined ||
            !AdmittedInvocationItem.derive(prepared, attempt).equals(item)
        ) {
            throw invalid("Admitted item does not name the exact stored EffectAttempt");
        }
        const receipt = this.ledger.currentReceipt(transaction, item.invocation, item.itemIndex);
        const receipted =
            this.persistence.receiptsForAttempt(transaction, item.attempt).length !== 0;
        if (receipt === undefined && receipted) {
            throw invalid("Admitted item has a Receipt its item does not carry");
        }
        return { prepared, attempt, receipt };
    }

    private async executeAttempt(
        itemIndex: number,
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>,
        execution: CanonicalBatchItemExecution
    ): Promise<CanonicalBatchItemResult> {
        const resources = execution.resources;
        const context: OperationContext = Object.freeze({
            invocation: prepared.header.id,
            itemIndex,
            idempotencyKey: prepared.item(itemIndex).idempotencyKey,
            attempt: Object.freeze({
                id: attempt.id,
                ordinal: attempt.ordinal,
                intentDigest: prepared.intentDigest
            }),
            targetAdmission: execution.targetAdmission,
            signal: resources.signal,
            content: resources.content
        });
        let output: FacetData;
        try {
            output = canonicalData(
                await withinBound(
                    execution.execute(itemIndex, context),
                    resources.deadline,
                    this.now
                )
            );
        } catch (error) {
            const confirmed = error instanceof ConfirmedOperationFailure ? error : undefined;
            const failure = AttemptFailureKind.classify({
                confirmed: confirmed !== undefined,
                elapsedBound: error instanceof AttemptBoundElapsed ? error.bound : undefined,
                cancellation: resources.signal,
                target: resources.target,
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
        const declared = execution.descriptor.output;
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
            result = (await resources.content.put(encodeCanonicalJson(output))).ref;
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
            // A final Receipt ends the item's scheduling life. Its original pre-effect claim
            // remains append-only history, but it is never a live claim that may re-enter
            // permit issuance or recovery on a replay. The failed case alone opens the next
            // ordinal; every other Receipt is terminal for this item.
            if (receipt !== undefined) {
                if (
                    !(receipt instanceof AttemptReceipt) ||
                    receipt.outcome !== "failed" ||
                    attempt === undefined ||
                    !receipt.attempt.equals(attempt.id)
                ) {
                    return { kind: "receipt", receipt };
                }
                if (
                    current !== undefined &&
                    this.persistence.attemptForClaim(transaction, current.id) === undefined
                ) {
                    if (current.attemptOrdinal !== attempt.ordinal + 1) {
                        throw invalid("Failed Receipt has an inconsistent live retry claim");
                    }
                    if (current.expiresAt.getTime() > at.getTime()) {
                        return { kind: "claim", claim: current };
                    }
                    const replacement = this.records.claim(prepared, itemIndex, current, at);
                    this.ledger.recoverClaim(transaction, current.id, replacement, at);
                    return { kind: "claim", claim: replacement };
                }
                const retry = this.records.retryClaim(prepared, attempt, at);
                this.ledger.claimItem(transaction, retry, at);
                return { kind: "claim", claim: retry };
            }
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
        const receipt = this.records.preEffectReceipt(
            prepared,
            claim,
            "deniedPreEffect",
            recordedAt,
            reason
        );
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

    /**
     * The result a stored Receipt already decides. The ContentStore arrives as a closure
     * because only a succeeded Receipt reads content: an in-Turn replay must not build attempt
     * resources for an item whose Receipt needs none, and a detached replay reads through the
     * store its target handed it.
     */
    private async resultForReceipt(
        itemIndex: number,
        receipt: Receipt,
        content: () => ContentStore
    ): Promise<CanonicalBatchItemResult> {
        if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "succeeded") {
            return terminal(itemIndex, receipt);
        }
        if (receipt.result === undefined) {
            throw invalid("Successful Operation Receipt has no canonical result content");
        }
        const store = content();
        return Object.freeze({
            kind: "succeeded",
            itemIndex,
            receipt,
            output: canonicalFacetData(decodeCanonicalJson(await store.get(receipt.result)))
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

/**
 * The one terminal shape both the item result and the item admission carry, so an admission
 * that ended before any effect and a result that ended the same way are the same value.
 */
function terminal(
    itemIndex: number,
    receipt: Receipt
): Extract<CanonicalBatchItemResult, { readonly kind: "terminal" }> {
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
