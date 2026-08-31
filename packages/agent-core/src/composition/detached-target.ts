import { Digest, encodeCanonicalJson } from "../core";
import type { ContentStore } from "../content";
import { AgentCoreError } from "../errors";
import { FacetRef, Operation, type FacetData, type OperationContext } from "../facets";
import type { EffectAttemptId } from "../invocation-references";
import {
    AttemptCancellationObservation,
    DetachedEffectTarget,
    type AdmittedInvocationItem,
    type CanonicalBatchItemExecution,
    type InvocationTransactionPort,
    type OperationPin
} from "../invocations";
import { FacetRuntimeHost } from "../operations/internal";
import type { MediationPersistence } from "./mediation-preparation";

/**
 * The mediation composition's live target for work a Turn detached (SPEC §5.6,
 * C13-TURN-HANDLE-DETACHMENT).
 *
 * A detached item outlives the Turn that issued it, so nothing here may hold a per-Turn
 * closure. `execution` rebuilds the live half of one admitted item from durable records
 * alone: the PreparedInvocation's pinned Operation resolved back against the Facet runtime
 * the composition activated, and the prepared arguments as stored. The Turn's authorization
 * is deliberately not rebuilt — §7.3 froze the whole intent at preparation and §7.4 admits
 * the attempt once, so a rebuilt authorization would be a second authority decision where
 * the rules require none, and a fabricated one at that.
 *
 * The controllers are the whole live resource this class owns, one per in-flight attempt and
 * keyed by `EffectAttemptId` because that is the one identity a Run's cancellation message
 * names. A restart empties the map by construction, which is why `cancel` answers `absent`
 * rather than pretending a controller nobody observed was aborted.
 */
export class DetachedMediationTarget<Transaction, Admission> extends DetachedEffectTarget {
    readonly #controllers = new Map<string, AbortController>();

    public constructor(
        private readonly facets: FacetRuntimeHost,
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: MediationPersistence<Transaction, Admission>,
        private readonly content: ContentStore
    ) {
        super();
    }

    /**
     * Rebuilds the execution of one admitted item, refusing rather than approximating.
     *
     * The pin is verified against the live runtime before anything runs: the pinned facet
     * target must still be the Facet this composition activated, the pinned operation name
     * must still be declared, and the live descriptor must still hash to the pinned digest.
     * The descriptor is the authority for §7.4's `outputInvalid`, so a live Facet whose
     * declaration has drifted from the pin is a refusal — the item's reconciliation owns what
     * happens next, not a descriptor the Invocation never admitted under.
     */
    public async execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution> {
        const prepared = this.transactions.transact((transaction) =>
            this.persistence.prepared(transaction, item.invocation)
        );
        if (prepared === undefined) {
            throw new AgentCoreError(
                "invocation.invalid",
                "A detached item names no stored PreparedInvocation"
            );
        }
        const stored = prepared.item(item.itemIndex);
        if (stored.idempotencyKey !== item.itemKey) {
            throw new AgentCoreError(
                "invocation.invalid",
                "A detached item does not bind its PreparedInvocation item"
            );
        }
        const pin = prepared.header.operation;
        const operation = this.resolveOperation(pin);
        const inputs = Array.from(
            { length: prepared.itemCount },
            (_unused, index) => prepared.item(index).arguments
        );
        const controller = this.controller(item.attempt);
        return Object.freeze({
            descriptor: operation.descriptor,
            execute: (itemIndex: number, context: OperationContext): Promise<FacetData> => {
                const input = inputs[itemIndex];
                if (input === undefined) {
                    throw new AgentCoreError(
                        "invocation.invalid",
                        "A detached execution requested an item its Invocation does not hold"
                    );
                }
                // A declared Operation may answer synchronously, and this seam promises a
                // Promise, so the one call site normalizes rather than every caller.
                return Promise.resolve(operation.execute(context, input));
            },
            resources: Object.freeze({
                // The signal is the controller `cancel` fires, so a reached cancellation is
                // one the running attempt observes rather than an advisory one (§4.3).
                signal: controller.signal,
                content: this.content,
                deadline: undefined,
                target: Object.freeze({
                    answering: (): boolean =>
                        this.facets.facet(new FacetRef(pin.target)) !== undefined
                })
            }),
            targetAdmission: undefined
        });
    }

    /**
     * Aborts the one live controller this attempt runs under, or reports it absent.
     *
     * `absent` is the answer after a restart: no controller survived one, so no cancellation
     * reached an effect, and §7.4 leaves the outcome for reconciliation. Nothing here derives
     * `aborted` from the request — the running attempt a `reached` answer returns writes its
     * own Receipt through the ordinary classification path, because the signal it runs under
     * is the one just fired.
     */
    public cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation> {
        const controller = this.#controllers.get(attempt.value);
        if (controller === undefined) return Promise.resolve(AttemptCancellationObservation.absent);
        controller.abort();
        return Promise.resolve(AttemptCancellationObservation.reached);
    }

    /** The controller one attempt runs under, created on first use and keyed by its attempt. */
    public controller(attempt: EffectAttemptId): AbortController {
        const existing = this.#controllers.get(attempt.value);
        if (existing !== undefined) return existing;
        const created = new AbortController();
        this.#controllers.set(attempt.value, created);
        return created;
    }

    /** Drops every live controller the way a process restart does, leaving the records. */
    public restart(): void {
        this.#controllers.clear();
    }

    private resolveOperation(pin: OperationPin): Operation {
        const runtime = this.facets.facet(new FacetRef(pin.target));
        if (runtime === undefined) {
            throw new AgentCoreError(
                "facet.inactive",
                `A detached item's pinned Facet ${pin.target} is no longer active`
            );
        }
        const operation = runtime.operation(pin.operation.operation);
        if (operation === undefined) {
            throw new AgentCoreError(
                "operation.missing",
                `A detached item's pinned Operation ${pin.operation.value} is not declared`
            );
        }
        if (
            !Digest.sha256(encodeCanonicalJson(operation.descriptor.toData())).equals(
                pin.descriptorDigest
            )
        ) {
            throw new AgentCoreError(
                "invocation.invalid",
                "A detached item's live Operation descriptor differs from its pin"
            );
        }
        return operation;
    }
}
