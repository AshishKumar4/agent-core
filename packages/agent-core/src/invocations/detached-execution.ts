import {
    Digest,
    RecordCodec,
    Revision,
    TextId,
    encodeCanonicalJson,
    type JsonValue,
    type RecordVersion
} from "../core";
import { InvocationId } from "../interaction-references";
import { AdmittedInvocationItem } from "./admitted-item";
import { requireExactObject, requireNonnegativeInteger, requireString } from "./codec";
import { EffectAttemptId } from "./id";

const DETACHED_EXECUTION_DOMAIN = "agent-core.invocation-detached-execution.v1";

const DETACHED_EXECUTION_STATES = Object.freeze([
    "awaitingPublication",
    "released",
    "cancellationRequested"
] as const);

export type DetachedEffectExecutionStateKind = (typeof DETACHED_EXECUTION_STATES)[number];

/**
 * Where one detached item's execution stands: waiting for the Run to publish its admission
 * identity, released to run, or asked to stop (§5.6).
 *
 * Each case is a class carrying its own transitions, so a caller asks the state what happens
 * next instead of reading a label and deciding. Delivery from the Run is at-least-once and
 * unordered (§6.1), which is why every transition is idempotent and why a release after a
 * cancellation request stays cancelled: the Run has already ended, and the admission message
 * it wrote earlier says nothing that revives it. A transition that returns the same state is
 * how a duplicate becomes a no-op rather than a second effect.
 *
 * There is no terminal case. §7.4 answers "did this item finish" from its current Receipt,
 * and a second durable place to ask would be a state this record could hold while the Receipt
 * disagreed (§8.4).
 */
export abstract class DetachedEffectExecutionState {
    /** The item is admitted; the Run has not yet taken it into its own obligation. */
    public static get awaitingPublication(): DetachedEffectExecutionState {
        return awaitingPublicationState;
    }

    /** The Run's admission message arrived; a driver may execute the item. */
    public static get released(): DetachedEffectExecutionState {
        return releasedState;
    }

    /** The Run asked for the item to stop; nothing releases it again. */
    public static get cancellationRequested(): DetachedEffectExecutionState {
        return cancellationRequestedState;
    }

    public abstract readonly kind: DetachedEffectExecutionStateKind;

    /** True for exactly the state whose item a driver may hand to the target. */
    public abstract readonly executable: boolean;

    public abstract release(): DetachedEffectExecutionState;

    public abstract requestCancellation(): DetachedEffectExecutionState;

    public equals(other: DetachedEffectExecutionState): boolean {
        return other instanceof DetachedEffectExecutionState && other.kind === this.kind;
    }
}

/**
 * The only door from a stored label back to a state. It is module-private and next to the
 * codec because a decoder restores a transition its writer already made; nothing else may
 * name a state it did not reach through the transitions above.
 */
function requireStateOfKind(kind: string): DetachedEffectExecutionState {
    const state = statesByKind[kind];
    if (state === undefined) {
        throw new TypeError("Detached effect execution state kind is invalid");
    }
    return state;
}

/** Proves the caller holds the admitted item this record is built over. */
function requireAdmittedItem(item: AdmittedInvocationItem): AdmittedInvocationItem {
    if (!(item instanceof AdmittedInvocationItem)) {
        throw new TypeError("Detached effect execution requires its admitted item");
    }
    return item;
}

class AwaitingPublicationState extends DetachedEffectExecutionState {
    public readonly kind = "awaitingPublication" as const;
    public readonly executable = false;

    public release(): DetachedEffectExecutionState {
        return releasedState;
    }

    public requestCancellation(): DetachedEffectExecutionState {
        return cancellationRequestedState;
    }
}

class ReleasedState extends DetachedEffectExecutionState {
    public readonly kind = "released" as const;
    public readonly executable = true;

    public release(): DetachedEffectExecutionState {
        return releasedState;
    }

    public requestCancellation(): DetachedEffectExecutionState {
        return cancellationRequestedState;
    }
}

class CancellationRequestedState extends DetachedEffectExecutionState {
    public readonly kind = "cancellationRequested" as const;
    public readonly executable = false;

    public release(): DetachedEffectExecutionState {
        return cancellationRequestedState;
    }

    public requestCancellation(): DetachedEffectExecutionState {
        return cancellationRequestedState;
    }
}

const awaitingPublicationState: DetachedEffectExecutionState = Object.freeze(
    new AwaitingPublicationState()
);
const releasedState: DetachedEffectExecutionState = Object.freeze(new ReleasedState());
const cancellationRequestedState: DetachedEffectExecutionState = Object.freeze(
    new CancellationRequestedState()
);

const statesByKind: Readonly<Record<string, DetachedEffectExecutionState | undefined>> =
    Object.freeze({
        awaitingPublication: awaitingPublicationState,
        released: releasedState,
        cancellationRequested: cancellationRequestedState
    });

export interface DetachedEffectExecutionInit {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly attempt: EffectAttemptId;
    readonly state: DetachedEffectExecutionState;
    readonly revision: Revision;
}

/**
 * The Invocation owner's durable record that one admitted item's execution left the Turn that
 * issued it (§5.6, C13-TURN-HANDLE-DETACHMENT).
 *
 * It exists because admission and execution are now separate: the EffectAttempt is durable
 * before the target runs, and nothing else on disk would say that the item is waiting for the
 * Run rather than running under a Turn. A per-Turn closure cannot carry that fact — the Turn
 * ends, the host restarts, and the closure is gone — so the fact is a record and the driver
 * rebuilds its work from it.
 *
 * It names the item and nothing more. The item key lives on the PreparedInvocation and the
 * ordinal on the EffectAttempt, so this record keeps neither: §8.4 forbids the second copy,
 * and every acceptance re-reads those owners anyway to decide whether a message is exact.
 */
export class DetachedEffectExecution {
    public static get codec(): RecordCodec<DetachedEffectExecution> {
        return DetachedEffectExecutionCodec;
    }

    public readonly id: Digest;
    public readonly invocation: InvocationId;
    public readonly itemIndex: number;
    public readonly attempt: EffectAttemptId;
    public readonly state: DetachedEffectExecutionState;
    public readonly revision: Revision;

    /** The first state of a freshly admitted detached item. */
    public static awaiting(candidate: AdmittedInvocationItem): DetachedEffectExecution {
        const item = requireAdmittedItem(candidate);
        return new DetachedEffectExecution({
            invocation: item.invocation,
            itemIndex: item.itemIndex,
            attempt: item.attempt,
            state: DetachedEffectExecutionState.awaitingPublication,
            revision: Revision.initial()
        });
    }

    public static encode(record: DetachedEffectExecution): Uint8Array {
        return DetachedEffectExecutionCodec.encode(record);
    }

    public static decode(bytes: Uint8Array): DetachedEffectExecution {
        return DetachedEffectExecutionCodec.decode(bytes);
    }

    public constructor(init: DetachedEffectExecutionInit) {
        if (
            init.invocation.constructor !== InvocationId ||
            init.attempt.constructor !== EffectAttemptId
        ) {
            throw new TypeError("Detached effect execution uses exact context identifiers");
        }
        if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) {
            throw new TypeError("Detached effect execution item index is invalid");
        }
        if (!(init.state instanceof DetachedEffectExecutionState)) {
            throw new TypeError("Detached effect execution requires one closed state");
        }
        if (init.revision.constructor !== Revision) {
            throw new TypeError("Detached effect execution requires its exact revision");
        }
        this.invocation = init.invocation;
        this.itemIndex = init.itemIndex;
        this.attempt = init.attempt;
        this.state = init.state;
        this.revision = init.revision;
        this.id = Digest.sha256(
            encodeCanonicalJson({
                attempt: this.attempt.value,
                domain: DETACHED_EXECUTION_DOMAIN,
                invocation: this.invocation.value,
                itemIndex: this.itemIndex
            })
        );
        Object.freeze(this.id);
        Object.freeze(this);
    }

    public released(): DetachedEffectExecution {
        return this.transition(this.state.release());
    }

    public cancellationRequested(): DetachedEffectExecution {
        return this.transition(this.state.requestCancellation());
    }

    /** True when `this` is exactly the next stored revision after `current`. */
    public follows(current: DetachedEffectExecution): boolean {
        return (
            this.id.equals(current.id) &&
            this.revision.value === current.revision.value + 1 &&
            !this.state.equals(current.state)
        );
    }

    private transition(state: DetachedEffectExecutionState): DetachedEffectExecution {
        if (state.equals(this.state)) return this;
        return new DetachedEffectExecution({
            invocation: this.invocation,
            itemIndex: this.itemIndex,
            attempt: this.attempt,
            state,
            revision: this.revision.next()
        });
    }
}

class DetachedEffectExecutionCodecV1 extends RecordCodec<DetachedEffectExecution> {
    public constructor() {
        super(
            [
                DetachedEffectExecution,
                DetachedEffectExecutionState,
                AwaitingPublicationState,
                ReleasedState,
                CancellationRequestedState,
                Digest,
                Revision,
                TextId,
                InvocationId,
                EffectAttemptId
            ],
            "invocation.detached-effect-execution",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(record: DetachedEffectExecution): JsonValue {
        return {
            attempt: record.attempt.value,
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            revision: record.revision.value,
            state: record.state.kind
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): DetachedEffectExecution {
        const object = requireExactObject(
            payload,
            ["attempt", "id", "invocation", "itemIndex", "revision", "state"],
            "Detached effect execution"
        );
        const record = new DetachedEffectExecution({
            invocation: new InvocationId(requireString(object, "invocation")),
            itemIndex: requireNonnegativeInteger(object, "itemIndex"),
            attempt: new EffectAttemptId(requireString(object, "attempt")),
            state: requireStateOfKind(requireString(object, "state")),
            revision: new Revision(requireNonnegativeInteger(object, "revision"))
        });
        if (record.id.value !== requireString(object, "id")) {
            throw new TypeError("Detached effect execution ID does not match its own item");
        }
        return record;
    }
}

export const DetachedEffectExecutionCodec: RecordCodec<DetachedEffectExecution> =
    new DetachedEffectExecutionCodecV1();

/**
 * The Invocation-owned store of detached execution records. It is its own seam rather than
 * more methods on `InvocationPersistence` because a host that never detaches an item needs no
 * table for one, and the record has no Lease or Admission parameter to carry.
 */
export interface DetachedEffectExecutionPersistence<Transaction> {
    detachedExecution(
        transaction: Transaction,
        attempt: EffectAttemptId
    ): DetachedEffectExecution | undefined;
    /** Every released record in one canonical order, newest last, bounded by `limit`. */
    releasedDetachedExecutions(
        transaction: Transaction,
        limit: number
    ): readonly DetachedEffectExecution[];
    appendDetachedExecution(transaction: Transaction, record: DetachedEffectExecution): void;
}
