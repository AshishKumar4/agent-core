import { AgentCoreError } from "../errors";
import type { InvocationId } from "../interaction-references";
import { AdmittedInvocationItem } from "./admitted-item";
import type { EffectAttempt } from "./attempt";
import type {
    CanonicalBatchItemExecution,
    CanonicalBatchItemResult,
    CanonicalBatchRecordPort
} from "./canonical-batch";
import type {
    DetachedEffectExecution,
    DetachedEffectExecutionPersistence
} from "./detached-execution";
import type { AttemptCancellationObservation, DetachedEffectTarget } from "./detached-target";
import type { EffectAttemptId } from "./id";
import type { InvocationLedger } from "./ledger";
import type { InvocationPersistence } from "./persistence";
import type { InvocationEvidencePersistence, InvocationTransactionPort } from "./ports";
import type { PreparedInvocation } from "./prepared";
import { InvocationPublicationOutbox } from "./publication";
import type { AttemptCompletion, AttemptReceipt, Receipt } from "./receipt";

/**
 * What one Run admission message left behind.
 *
 * Every case means the message is discharged and may be acknowledged; a message that does not
 * name this host's exact state is refused by throwing instead, because acknowledging it would
 * discard the Run's only copy of a command nobody executed. `executable` is the one bit a
 * caller acts on: it says a driver now has work that did not exist before.
 */
export abstract class DetachedEffectAdmissionOutcome {
    /** This message released the item; a driver must be armed. */
    public static get released(): DetachedEffectAdmissionOutcome {
        return releasedOutcome;
    }

    /** A duplicate of a message already applied; nothing changed. */
    public static get alreadyReleased(): DetachedEffectAdmissionOutcome {
        return alreadyReleasedOutcome;
    }

    /** The Run's cancellation reached this item first, so nothing releases it. */
    public static get cancellationRequested(): DetachedEffectAdmissionOutcome {
        return cancellationRequestedOutcome;
    }

    /** The item already has a current Receipt; there is nothing left to release. */
    public static settled(receipt: Receipt): DetachedEffectAdmissionOutcome {
        return new SettledAdmission(receipt);
    }

    public abstract readonly kind:
        "released" | "alreadyReleased" | "cancellationRequested" | "settled";

    /** True exactly when this message left work for a driver to execute. */
    public abstract readonly executable: boolean;

    /** The Receipt that already ended the item, when one did. */
    public abstract readonly receipt: Receipt | undefined;
}

class ReleasedAdmission extends DetachedEffectAdmissionOutcome {
    public readonly kind = "released" as const;
    public readonly executable = true;
    public readonly receipt = undefined;
}

class AlreadyReleasedAdmission extends DetachedEffectAdmissionOutcome {
    public readonly kind = "alreadyReleased" as const;
    public readonly executable = false;
    public readonly receipt = undefined;
}

class CancellationRequestedAdmission extends DetachedEffectAdmissionOutcome {
    public readonly kind = "cancellationRequested" as const;
    public readonly executable = false;
    public readonly receipt = undefined;
}

class SettledAdmission extends DetachedEffectAdmissionOutcome {
    public readonly kind = "settled" as const;
    public readonly executable = false;

    public constructor(public readonly receipt: Receipt) {
        super();
        Object.freeze(this);
    }
}

const releasedOutcome: DetachedEffectAdmissionOutcome = Object.freeze(new ReleasedAdmission());
const alreadyReleasedOutcome: DetachedEffectAdmissionOutcome = Object.freeze(
    new AlreadyReleasedAdmission()
);
const cancellationRequestedOutcome: DetachedEffectAdmissionOutcome = Object.freeze(
    new CancellationRequestedAdmission()
);

/**
 * What one Run cancellation message reached.
 *
 * `reached` records nothing: the live effect ends through the ordinary path and its own
 * classification names §7.4's `aborted`. `recorded` carries the `indeterminate` Receipt this
 * host wrote because no live effect remained to abort, which is the honest outcome for an
 * admitted attempt nobody observed and the one reconciliation resolves. `settled` is a
 * redelivery for an item that already finished.
 */
export abstract class DetachedEffectCancellationOutcome {
    public static get reached(): DetachedEffectCancellationOutcome {
        return reachedCancellation;
    }

    public static recorded(receipt: AttemptReceipt): DetachedEffectCancellationOutcome {
        return new RecordedCancellation(receipt);
    }

    public static settled(receipt: Receipt): DetachedEffectCancellationOutcome {
        return new SettledCancellation(receipt);
    }

    public abstract readonly kind: "reached" | "recorded" | "settled";

    public abstract readonly receipt: Receipt | undefined;
}

class ReachedCancellation extends DetachedEffectCancellationOutcome {
    public readonly kind = "reached" as const;
    public readonly receipt = undefined;
}

class RecordedCancellation extends DetachedEffectCancellationOutcome {
    public readonly kind = "recorded" as const;

    public constructor(public readonly receipt: AttemptReceipt) {
        super();
        Object.freeze(this);
    }
}

class SettledCancellation extends DetachedEffectCancellationOutcome {
    public readonly kind = "settled" as const;

    public constructor(public readonly receipt: Receipt) {
        super();
        Object.freeze(this);
    }
}

const reachedCancellation: DetachedEffectCancellationOutcome = Object.freeze(
    new ReachedCancellation()
);

/** The one execution step this port drives; the batch port satisfies it. */
interface AdmittedItemExecutor {
    executeAdmittedItem(
        item: AdmittedInvocationItem,
        execution: CanonicalBatchItemExecution
    ): Promise<CanonicalBatchItemResult>;
}

/** The exact local state a delivery is judged against, read in one span. */
interface DetachedItemState<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly attempt: EffectAttempt<Lease, Admission>;
    readonly item: AdmittedInvocationItem;
    readonly detachment: DetachedEffectExecution;
    readonly receipt: Receipt | undefined;
}

/**
 * The Invocation owner's inbound seam for the Run's messages about one detached item
 * (SPEC §5.6, §6.1), and the execution step a driver drives.
 *
 * It takes scalar facts rather than the Run's record: delivery is at-least-once across an
 * Actor boundary with no shared transaction, so the Invocation owner accepts nothing on the
 * sender's word. Every entry point re-reads its own state — the PreparedInvocation, that
 * item's key, the latest EffectAttempt, and the current Receipt — and a message that does not
 * name exactly that state is refused with a typed error rather than acknowledged.
 *
 * A cancellation is a request, never a verdict. This port asks the target to abort the exact
 * attempt and records only what the target observed, so §7.4's `aborted` still comes from the
 * cancellation that reached the effect and never from the fact that a Run asked.
 */
export class DetachedEffectDeliveryPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Authentication = undefined
> {
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
        private readonly records: CanonicalBatchRecordPort<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly evidence: InvocationEvidencePersistence<Transaction>,
        private readonly target: DetachedEffectTarget,
        private readonly executor: AdmittedItemExecutor,
        private readonly now: () => Date
    ) {}

    /**
     * Accepts the Run's admission message: the Run took the published item into its own
     * obligation, so the item may run. Releasing is idempotent, and a duplicate changes nothing
     * rather than starting a second effect.
     */
    public release(
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string,
        attempt: EffectAttemptId
    ): DetachedEffectAdmissionOutcome {
        return this.transactions.transact((transaction) => {
            const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
            if (state.receipt !== undefined) {
                return DetachedEffectAdmissionOutcome.settled(state.receipt);
            }
            const next = state.detachment.state.release();
            if (next.equals(state.detachment.state)) {
                return next.executable
                    ? DetachedEffectAdmissionOutcome.alreadyReleased
                    : DetachedEffectAdmissionOutcome.cancellationRequested;
            }
            this.detachedExecutions.appendDetachedExecution(
                transaction,
                state.detachment.released()
            );
            return DetachedEffectAdmissionOutcome.released;
        });
    }

    /**
     * Accepts the Run's cancellation message: the Run ended while this item was still owed, so
     * the target is asked to stop the exact attempt.
     *
     * The durable request is recorded first and the target is asked after that transaction
     * commits. There is no cross-Actor transaction to join, and a request that survives only in
     * memory would be lost by exactly the restart that also loses the live effect.
     */
    public async cancel(
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string,
        attempt: EffectAttemptId
    ): Promise<DetachedEffectCancellationOutcome> {
        const requested = this.transactions.transact((transaction) => {
            const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
            if (state.receipt !== undefined) return state.receipt;
            const next = state.detachment.state.requestCancellation();
            if (!next.equals(state.detachment.state)) {
                this.detachedExecutions.appendDetachedExecution(
                    transaction,
                    state.detachment.cancellationRequested()
                );
            }
            return undefined;
        });
        if (requested !== undefined) {
            return DetachedEffectCancellationOutcome.settled(requested);
        }
        const observation = await this.target.cancel(attempt);
        return this.record(invocation, itemIndex, itemKey, attempt, observation);
    }

    /**
     * Runs one released item. The target rebuilds the live request from durable records, so the
     * same call serves the host that admitted the item and a host that restarted since.
     */
    public async execute(item: AdmittedInvocationItem): Promise<CanonicalBatchItemResult> {
        if (!(item instanceof AdmittedInvocationItem)) {
            throw invalid("Detached execution requires its admitted item");
        }
        const execution = await this.target.execution(item);
        return this.executor.executeAdmittedItem(item, execution);
    }

    /**
     * Writes down what the target observed, once its answer is in hand. An `absent` observation
     * carries `indeterminate` and nothing else can be honestly recorded: no live effect was
     * reached, so no cancellation reached the attempt, and §7.4 leaves the outcome unknown for
     * reconciliation to resolve.
     */
    private record(
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string,
        attempt: EffectAttemptId,
        observation: AttemptCancellationObservation
    ): DetachedEffectCancellationOutcome {
        const completion = observation.completion;
        if (completion === undefined) return DetachedEffectCancellationOutcome.reached;
        return this.transactions.transact((transaction) => {
            const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
            if (state.receipt !== undefined) {
                return DetachedEffectCancellationOutcome.settled(state.receipt);
            }
            const receipt = this.receipt(transaction, state, completion);
            return DetachedEffectCancellationOutcome.recorded(receipt);
        });
    }

    private receipt(
        transaction: Transaction,
        state: DetachedItemState<Lease, Authority, Domain, PathEpochs, Admission>,
        completion: AttemptCompletion
    ): AttemptReceipt {
        const receipt = this.records.attemptReceipt(
            state.attempt,
            completion,
            this.now(),
            undefined
        );
        const attemptAudit = this.records.attemptAudit(state.prepared, state.attempt);
        const audit = this.records.receiptAudit(state.prepared, attemptAudit, receipt);
        this.ledger.recordAttemptReceiptWithAudit(
            transaction,
            receipt,
            attemptAudit,
            audit,
            InvocationPublicationOutbox.pending(
                Object.freeze({
                    invocation: state.item.invocation,
                    receipt: receipt.id,
                    audit: audit.id
                })
            ),
            this.evidence
        );
        return receipt;
    }

    /**
     * The exact-state read every message is judged against. It refuses rather than reporting,
     * because each condition it checks means the message names work this host does not have:
     * an Invocation it never prepared, an item whose key does not match, an attempt that is not
     * the item's latest, or an item that was never detached in the first place.
     */
    private state(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string,
        attempt: EffectAttemptId
    ): DetachedItemState<Lease, Authority, Domain, PathEpochs, Admission> {
        const prepared = this.persistence.prepared(transaction, invocation);
        if (prepared === undefined) {
            throw invalid("Detached effect delivery names no PreparedInvocation");
        }
        const latest = this.persistence.attemptsForItem(transaction, invocation, itemIndex).at(-1);
        if (latest === undefined || !latest.id.equals(attempt)) {
            throw invalid("Detached effect delivery does not name the item's latest EffectAttempt");
        }
        const item = AdmittedInvocationItem.derive(prepared, latest);
        if (!item.names(invocation, itemIndex, itemKey, attempt)) {
            throw invalid("Detached effect delivery does not name the exact admitted item");
        }
        const detachment = this.detachedExecutions.detachedExecution(transaction, attempt);
        if (
            detachment === undefined ||
            !detachment.invocation.equals(invocation) ||
            detachment.itemIndex !== itemIndex
        ) {
            throw invalid("Detached effect delivery names an item this host did not detach");
        }
        const receipt = this.ledger.currentReceipt(transaction, invocation, itemIndex);
        const receipted = this.persistence.receiptsForAttempt(transaction, attempt).length !== 0;
        if (receipt === undefined && receipted) {
            throw invalid("Detached item has a Receipt its item does not carry");
        }
        return { prepared, attempt: latest, item, detachment, receipt };
    }
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
