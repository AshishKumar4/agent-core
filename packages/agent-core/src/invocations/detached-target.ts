import type { ContentStore } from "../content";
import { AgentCoreError } from "../errors";
import type { FacetData, OperationContext, OperationDescriptor } from "../facets";
import type { AdmittedInvocationItem } from "./admitted-item";
import type {
    CanonicalBatchAttemptResources,
    CanonicalBatchItemExecution,
    CanonicalBatchTargetAdmission
} from "./canonical-batch";
import { EffectAttemptId } from "./id";
import { AttemptCompletion, type AttemptTargetDomain } from "./receipt";

/**
 * What the target observed when it was asked to stop one exact attempt.
 *
 * This is an observation and never a verdict. §7.4 lets a host record `aborted` only for
 * cancellation that reached the attempt, and the party that knows whether it reached one is
 * the target holding the live effect — not the Run that asked and not this value. So the two
 * cases carry the consequence for the Invocation owner rather than a failure kind, and there
 * is no member from which `AttemptFailureKind.aborted` can be built:
 *
 * - `reached`: the target aborted the exact live effect. The running attempt ends through the
 *   ordinary path, and its own classification names `aborted` because the signal it runs under
 *   is the one that fired. Nothing is recorded here.
 * - `absent`: the target holds no live effect for this attempt — the usual case after a
 *   restart. The attempt was admitted and its outcome is unknown, which §7.4 already fixes as
 *   `indeterminate`, so reconciliation resolves it. Manufacturing `aborted` here would claim a
 *   fact about a controller nobody observed.
 */
export abstract class AttemptCancellationObservation {
    /** The target aborted the exact live effect this attempt runs. */
    public static get reached(): AttemptCancellationObservation {
        return reachedObservation;
    }

    /** The target holds no live effect for this attempt. */
    public static get absent(): AttemptCancellationObservation {
        return absentObservation;
    }

    public abstract readonly kind: "reached" | "absent";

    /**
     * The completion the Invocation owner records itself, or `undefined` when the live effect
     * ends the attempt and writes its own Receipt.
     */
    public abstract readonly completion: AttemptCompletion | undefined;

    public equals(other: AttemptCancellationObservation): boolean {
        return other instanceof AttemptCancellationObservation && other.kind === this.kind;
    }
}

class ReachedCancellation extends AttemptCancellationObservation {
    public readonly kind = "reached" as const;
    public readonly completion = undefined;
}

class AbsentCancellation extends AttemptCancellationObservation {
    public readonly kind = "absent" as const;
    public readonly completion = AttemptCompletion.indeterminate;
}

const reachedObservation: AttemptCancellationObservation = Object.freeze(new ReachedCancellation());
const absentObservation: AttemptCancellationObservation = Object.freeze(new AbsentCancellation());

/**
 * The live target of a detached item: it starts the work and it can stop it.
 *
 * Both members are on one contract because they name one live resource from two directions.
 * The signal in the resources it returns is the same cancellation `cancel` fires, which is
 * what makes "cancellation reached the attempt" true rather than advisory (§4.3's reachability
 * requirement). An implementation that returned an unrelated signal would leave every reached
 * cancellation classified as `indeterminate`.
 *
 * `execution` carries only what the execution step reads — the pinned Operation's declared
 * shape and its handler — and never a whole `MediatedInvocationRequest`. A detached item
 * outlives the Turn that issued it, so a per-Turn closure is exactly what this contract
 * replaces: after a restart the durable records are all there is, and the parts of a live
 * request that are not reconstructible (its request key, its full authority intent, its
 * interceptor traces) must not be demanded here, because a target could satisfy that demand
 * only by fabricating authority evidence. An implementation that cannot rebuild the handler
 * refuses rather than returning one that runs a different effect.
 */
export abstract class DetachedEffectTarget {
    public abstract execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution>;

    public abstract cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation>;
}

export interface MemoryDetachedEffectTargetInit {
    /** The pinned Operation's declared shape, as the host resolves it from durable records. */
    readonly descriptor: OperationDescriptor;
    /**
     * The live handler for one admitted item, as a host would resolve it. It receives the item's
     * index and the same OperationContext every execution builds, so a target resolves the
     * per-item closure once rather than once per call site.
     */
    execute(
        item: AdmittedInvocationItem,
        itemIndex: number,
        context: OperationContext
    ): Promise<FacetData> | FacetData;
    readonly content: ContentStore;
    readonly deadline?: Date;
    readonly target?: AttemptTargetDomain;
    readonly targetAdmission?: CanonicalBatchTargetAdmission;
}

const answeringDomain: AttemptTargetDomain = Object.freeze({ answering: (): boolean => true });

/**
 * The in-memory reference target: one live controller per in-flight attempt, keyed by
 * EffectAttemptId, and a `restart` that drops every one of them the way a host restart does.
 */
export class MemoryDetachedEffectTarget extends DetachedEffectTarget {
    readonly #controllers = new Map<string, AbortController>();

    public constructor(private readonly init: MemoryDetachedEffectTargetInit) {
        super();
    }

    /** The controller this target hands to one attempt, created on first use. */
    public controller(attempt: EffectAttemptId): AbortController {
        const existing = this.#controllers.get(attempt.value);
        if (existing !== undefined) return existing;
        const created = new AbortController();
        this.#controllers.set(attempt.value, created);
        return created;
    }

    /** Drops every live controller, leaving only the durable records behind. */
    public restart(): void {
        this.#controllers.clear();
    }

    public execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution> {
        const resources: CanonicalBatchAttemptResources = Object.freeze({
            signal: this.controller(item.attempt).signal,
            content: this.init.content,
            deadline: this.init.deadline,
            target: this.init.target ?? answeringDomain
        });
        return Promise.resolve(
            Object.freeze({
                descriptor: this.init.descriptor,
                execute: (itemIndex: number, context: OperationContext): Promise<FacetData> =>
                    // A registered handler may answer synchronously, and this seam promises a
                    // Promise, so the one construction site normalizes it.
                    Promise.resolve(this.init.execute(item, itemIndex, context)),
                resources,
                targetAdmission: this.init.targetAdmission
            })
        );
    }

    public cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation> {
        if (attempt.constructor !== EffectAttemptId) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Detached effect cancellation names its exact EffectAttempt"
            );
        }
        const controller = this.#controllers.get(attempt.value);
        if (controller === undefined) {
            return Promise.resolve(AttemptCancellationObservation.absent);
        }
        controller.abort();
        return Promise.resolve(AttemptCancellationObservation.reached);
    }
}
