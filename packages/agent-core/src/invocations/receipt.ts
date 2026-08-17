import {
    ContentRef,
    JsonSchema,
    RecordCodec,
    isMember,
    type JsonValue,
    type RecordVersion
} from "../core";
import {
    requireDate,
    requireExactObject,
    requireNullableString,
    requireObject,
    requireSafeInteger,
    requireString,
    validDate
} from "./codec";
import { EffectAttemptId, ReceiptId } from "./id";
import { InvocationId } from "../interaction-references";

export type PreEffectReceiptOutcome = "deniedPreEffect" | "cancelledPreEffect";
const ATTEMPT_RECEIPT_OUTCOMES = Object.freeze(["succeeded", "failed", "indeterminate"] as const);
export type AttemptReceiptOutcome = (typeof ATTEMPT_RECEIPT_OUTCOMES)[number];

const ATTEMPT_FAILURE_KINDS = Object.freeze([
    "raised",
    "deadline",
    "aborted",
    "domainLost",
    "outputInvalid"
] as const);
export type AttemptFailureKindName = (typeof ATTEMPT_FAILURE_KINDS)[number];

type ReceiptProperties = PreEffectReceiptProperties | AttemptReceiptProperties;

/**
 * The protection domain (§1.5) hosting an attempt's target, asked whether it still answers.
 * Liveness is a live substrate fact, so it reaches the seam through a port rather than
 * through the durable Domain reference on the PreparedInvocation header, which §8.3 forbids
 * from owning live resources.
 */
export interface AttemptTargetDomain {
    answering(): boolean;
}

/**
 * §7.4's closed failure taxonomy for an attempted `failed` Receipt.
 *
 * Each case is reachable only through the fact that distinguishes it, so a host cannot
 * record a kind it has not observed, and no call accepts two facts. `raised` is the one kind
 * the invoked handler may author and it must present the handler's own confirmation; the
 * host derives `deadline` from the bound it set, `aborted` from the cancellation it owns,
 * `domainLost` from the domain hosting the target, and `outputInvalid` from the output shape
 * the Operation declared — never from anything the target reports about itself, for the
 * reason §7.1 gives.
 *
 * Only construction is guarded. `kind` is the wire label, but reading one proves nothing the
 * caller did not already establish to obtain the value.
 */
export abstract class AttemptFailureKind {
    public abstract readonly kind: AttemptFailureKindName;

    /** §7.4: the sole kind the invoked code is permitted to originate. */
    public get authoredByHandler(): boolean {
        return this.kind === "raised";
    }

    /**
     * The invoked handler signalled failure itself.
     *
     * This is the one case with no host-side precondition to check, and the asymmetry is
     * §7.4's own: the other four are facts about boundaries the host owns and can therefore
     * be interrogated, while this one is the callee's answer and the host either holds it or
     * does not. Requiring evidence content here would be a witness for the adjacent question
     * — whether the handler produced content, not whether it signalled failure — and the two
     * come apart, since a reconciled external verdict is the callee's own report and carries
     * no §4.1 rejection. Naming this kind is therefore the seam's obligation: a caller must
     * have narrowed to a confirmed callee verdict, never to an unrecognized rejection.
     */
    public static get raised(): AttemptFailureKind {
        return raisedFailure;
    }

    /** A host-set bound on this attempt elapsed. */
    public static deadline(bound: Date, observedAt: Date): AttemptFailureKind {
        const elapsed = validDate(bound, "Attempt bound");
        if (validDate(observedAt, "Attempt bound observation") < elapsed) {
            throw new TypeError("A deadline failure requires a bound that has elapsed");
        }
        return deadlineFailure;
    }

    /** Cancellation of the Turn or Run that owns the item reached the attempt. */
    public static aborted(cancellation: AbortSignal): AttemptFailureKind {
        if (!(cancellation instanceof AbortSignal) || !cancellation.aborted) {
            throw new TypeError(
                "An aborted failure requires cancellation that reached the attempt"
            );
        }
        return abortedFailure;
    }

    /** The protection domain hosting the target stopped answering. */
    public static domainLost(target: AttemptTargetDomain): AttemptFailureKind {
        if (target.answering()) {
            throw new TypeError("A domainLost failure requires a domain that stopped answering");
        }
        return domainLostFailure;
    }

    /** The handler resolved with a value the Operation's declared output shape rejects. */
    public static outputInvalid(output: JsonSchema, value: JsonValue): AttemptFailureKind {
        if (output.constructor !== JsonSchema) {
            throw new TypeError("An outputInvalid failure requires the declared output shape");
        }
        if (output.accepts(value)) {
            throw new TypeError("An outputInvalid failure requires a rejected resolved value");
        }
        return outputInvalidFailure;
    }

    public equals(other: AttemptFailureKind): boolean {
        return other instanceof AttemptFailureKind && other.kind === this.kind;
    }
}

class RaisedFailure extends AttemptFailureKind {
    public readonly kind = "raised" as const;
}

class DeadlineFailure extends AttemptFailureKind {
    public readonly kind = "deadline" as const;
}

class AbortedFailure extends AttemptFailureKind {
    public readonly kind = "aborted" as const;
}

class DomainLostFailure extends AttemptFailureKind {
    public readonly kind = "domainLost" as const;
}

class OutputInvalidFailure extends AttemptFailureKind {
    public readonly kind = "outputInvalid" as const;
}

const raisedFailure: AttemptFailureKind = Object.freeze(new RaisedFailure());
const deadlineFailure: AttemptFailureKind = Object.freeze(new DeadlineFailure());
const abortedFailure: AttemptFailureKind = Object.freeze(new AbortedFailure());
const domainLostFailure: AttemptFailureKind = Object.freeze(new DomainLostFailure());
const outputInvalidFailure: AttemptFailureKind = Object.freeze(new OutputInvalidFailure());

/**
 * An attempted outcome carrying its failure kind inseparably.
 *
 * §7.4 requires a kind on exactly the `failed` outcome, so `succeeded` and `indeterminate`
 * are values that accept no argument and `failed` is the only call that accepts one. A kind
 * on a non-failed outcome, a `failed` outcome without one, and two kinds on one outcome are
 * therefore not calls that exist rather than calls that are rejected. `indeterminate` in
 * particular cannot carry one: naming a kind is a determination, and a host that has one has
 * stopped not knowing.
 */
export abstract class AttemptCompletion {
    public static get succeeded(): AttemptCompletion {
        return succeededCompletion;
    }
    public static get indeterminate(): AttemptCompletion {
        return indeterminateCompletion;
    }
    public static failed(failure: AttemptFailureKind): AttemptCompletion {
        if (!(failure instanceof AttemptFailureKind)) {
            throw new TypeError("A failed attempt outcome requires one closed §7.4 failure kind");
        }
        return new FailedCompletion(failure);
    }

    public abstract readonly outcome: AttemptReceiptOutcome;
    public abstract readonly failure: AttemptFailureKind | undefined;
}

class SucceededCompletion extends AttemptCompletion {
    public readonly outcome = "succeeded" as const;
    public readonly failure = undefined;
}

class IndeterminateCompletion extends AttemptCompletion {
    public readonly outcome = "indeterminate" as const;
    public readonly failure = undefined;
}

class FailedCompletion extends AttemptCompletion {
    public readonly outcome = "failed" as const;

    public constructor(public readonly failure: AttemptFailureKind) {
        super();
        Object.freeze(this);
    }
}

const succeededCompletion: AttemptCompletion = Object.freeze(new SucceededCompletion());
const indeterminateCompletion: AttemptCompletion = Object.freeze(new IndeterminateCompletion());

export abstract class Receipt {
    readonly #recordedAt: number;

    protected constructor(recordedAt: Date, properties: ReceiptProperties) {
        this.#recordedAt = validDate(recordedAt, "Receipt time");
        Object.assign(this, properties);
        Object.freeze(this);
    }

    public static encode(record: Receipt): Uint8Array {
        return ReceiptCodec.encode(record);
    }

    public static decode(bytes: Uint8Array): Receipt {
        return ReceiptCodec.decode(bytes);
    }

    public abstract readonly variant: "preEffect" | "attempt";
    public abstract readonly id: ReceiptId;
    public abstract readonly outcome: PreEffectReceiptOutcome | AttemptReceiptOutcome;
    public get recordedAt(): Date {
        return new Date(this.#recordedAt);
    }
}

export class PreEffectReceipt extends Receipt {
    declare public readonly variant: "preEffect";
    declare public readonly id: ReceiptId;
    declare public readonly invocation: InvocationId;
    declare public readonly itemIndex: number;
    declare public readonly outcome: PreEffectReceiptOutcome;
    declare public readonly reason: string;

    public constructor(
        id: ReceiptId,
        invocation: InvocationId,
        itemIndex: number,
        outcome: PreEffectReceiptOutcome,
        recordedAt: Date,
        reason: string
    ) {
        super(recordedAt, requirePreEffectReceipt(id, invocation, itemIndex, outcome, reason));
    }
}

export class AttemptReceipt extends Receipt {
    declare public readonly variant: "attempt";
    declare public readonly id: ReceiptId;
    declare public readonly attempt: EffectAttemptId;
    declare public readonly outcome: AttemptReceiptOutcome;
    declare public readonly failure: AttemptFailureKind | undefined;
    declare public readonly previous: ReceiptId | undefined;
    declare public readonly result: ContentRef | undefined;

    public constructor(
        id: ReceiptId,
        attempt: EffectAttemptId,
        completion: AttemptCompletion,
        previous: ReceiptId | undefined,
        recordedAt: Date,
        result: ContentRef | undefined
    ) {
        super(recordedAt, requireAttemptReceipt(id, attempt, completion, previous, result));
    }
}

interface PreEffectReceiptProperties {
    readonly variant: "preEffect";
    readonly id: ReceiptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly outcome: PreEffectReceiptOutcome;
    readonly reason: string;
}

function requirePreEffectReceipt(
    id: ReceiptId,
    invocation: InvocationId,
    itemIndex: number,
    outcome: PreEffectReceiptOutcome,
    reason: string
): PreEffectReceiptProperties {
    if (id.constructor !== ReceiptId || invocation.constructor !== InvocationId) {
        throw new TypeError("Pre-effect Receipt identifiers must use exact context classes");
    }
    if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) {
        throw new TypeError("Receipt item index must be a non-negative safe integer");
    }
    if (outcome !== "deniedPreEffect" && outcome !== "cancelledPreEffect") {
        throw new TypeError("Pre-effect Receipt outcome is invalid");
    }
    if (reason.trim().length === 0) throw new TypeError("Pre-effect Receipt reason is required");
    return { variant: "preEffect", id, invocation, itemIndex, outcome, reason };
}

interface AttemptReceiptProperties {
    readonly variant: "attempt";
    readonly id: ReceiptId;
    readonly attempt: EffectAttemptId;
    readonly outcome: AttemptReceiptOutcome;
    readonly failure: AttemptFailureKind | undefined;
    readonly previous: ReceiptId | undefined;
    readonly result: ContentRef | undefined;
}

function requireAttemptReceipt(
    id: ReceiptId,
    attempt: EffectAttemptId,
    completion: AttemptCompletion,
    previous: ReceiptId | undefined,
    result: ContentRef | undefined
): AttemptReceiptProperties {
    if (
        id.constructor !== ReceiptId ||
        attempt.constructor !== EffectAttemptId ||
        (previous !== undefined && previous.constructor !== ReceiptId)
    ) {
        throw new TypeError("Attempt Receipt identifiers must use exact context classes");
    }
    if (!(completion instanceof AttemptCompletion)) {
        throw new TypeError("Attempt Receipt outcome is invalid");
    }
    const { failure, outcome } = completion;
    requireAttemptOutcome(outcome);
    if (failure !== undefined && !(failure instanceof AttemptFailureKind)) {
        throw new TypeError("Attempt Receipt failure kind is invalid");
    }
    if ((failure === undefined) === (outcome === "failed")) {
        throw new TypeError("An attempt failure kind is recorded on exactly a failed outcome");
    }
    if (outcome === "indeterminate" && result !== undefined) {
        throw new TypeError("Indeterminate Receipts cannot carry a result");
    }
    return { variant: "attempt", id, attempt, outcome, failure, previous, result };
}

/**
 * Version 2 of the serialized form. Version 1 had no failure field, so its `failed` payloads
 * cannot be upcast: the kind is not derivable from bytes that never carried it, and choosing
 * one would manufacture the determination §7.4 exists to withhold. Rejecting an unknown
 * major with a typed error is what §8.3 requires of exactly that case, and no persisted
 * version 1 bytes exist to reject — no declared migration names the Receipt record,
 * `artifacts/conformance/live-evidence` holds test results and a deployment manifest rather
 * than records, `artifacts/integration` references Receipts only as paths and selectors, and
 * every Receipt fixture in the suite is built in process.
 */
class ReceiptCodecV2 extends RecordCodec<Receipt> {
    public constructor() {
        super("invocation.receipt", { major: 2, minor: 0 });
    }

    protected encodePayload(record: Receipt): JsonValue {
        if (record instanceof PreEffectReceipt) {
            return {
                id: record.id.value,
                invocation: record.invocation.value,
                itemIndex: record.itemIndex,
                outcome: record.outcome,
                reason: record.reason,
                recordedAt: record.recordedAt.toISOString(),
                variant: record.variant
            };
        }
        if (record instanceof AttemptReceipt) {
            return {
                attempt: record.attempt.value,
                failure: record.failure?.kind ?? null,
                id: record.id.value,
                outcome: record.outcome,
                previous: record.previous?.value ?? null,
                recordedAt: record.recordedAt.toISOString(),
                result: record.result?.value ?? null,
                variant: record.variant
            };
        }
        throw new TypeError("Receipt implementation is invalid");
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Receipt {
        const variant = requireString(requireObject(payload, "Receipt payload"), "variant");
        if (variant === "preEffect") {
            const object = requireExactObject(
                payload,
                ["id", "invocation", "itemIndex", "outcome", "reason", "recordedAt", "variant"],
                "Pre-effect Receipt"
            );
            return new PreEffectReceipt(
                new ReceiptId(requireString(object, "id")),
                new InvocationId(requireString(object, "invocation")),
                requireSafeInteger(object, "itemIndex", "Receipt item index"),
                requirePreEffectOutcome(requireString(object, "outcome")),
                requireDate(object, "recordedAt"),
                requireString(object, "reason")
            );
        }
        if (variant === "attempt") {
            const object = requireExactObject(
                payload,
                [
                    "attempt",
                    "failure",
                    "id",
                    "outcome",
                    "previous",
                    "recordedAt",
                    "result",
                    "variant"
                ],
                "Attempt Receipt"
            );
            const previous = requireNullableString(
                object,
                "previous",
                "Attempt Receipt previous reference"
            );
            const result = requireNullableString(
                object,
                "result",
                "Attempt Receipt result reference"
            );
            return new AttemptReceipt(
                new ReceiptId(requireString(object, "id")),
                new EffectAttemptId(requireString(object, "attempt")),
                decodedCompletion(
                    requireAttemptOutcome(requireString(object, "outcome")),
                    requireNullableString(object, "failure", "Attempt Receipt failure kind")
                ),
                previous === undefined ? undefined : new ReceiptId(previous),
                requireDate(object, "recordedAt"),
                result === undefined ? undefined : new ContentRef(result)
            );
        }
        throw new TypeError("Receipt variant is invalid");
    }
}

/**
 * The only place a failure kind is reconstructed from its wire label. A decoder restores a
 * determination its writer already made and cannot re-observe the fact behind it, so this
 * door stays inside the codec and is never a public constructor.
 */
function decodedCompletion(
    outcome: AttemptReceiptOutcome,
    failure: string | undefined
): AttemptCompletion {
    if (outcome === "failed") {
        if (failure === undefined) {
            throw new TypeError("A failed Attempt Receipt must name one failure kind");
        }
        if (!isMember(ATTEMPT_FAILURE_KINDS, failure)) {
            throw new TypeError("Attempt Receipt failure kind is invalid");
        }
        return AttemptCompletion.failed(failureKindsByLabel[failure]);
    }
    if (failure !== undefined) {
        throw new TypeError("Only a failed Attempt Receipt may name a failure kind");
    }
    return outcome === "succeeded" ? AttemptCompletion.succeeded : AttemptCompletion.indeterminate;
}

const failureKindsByLabel: Readonly<Record<AttemptFailureKindName, AttemptFailureKind>> =
    Object.freeze({
        aborted: abortedFailure,
        deadline: deadlineFailure,
        domainLost: domainLostFailure,
        outputInvalid: outputInvalidFailure,
        raised: raisedFailure
    });

function requirePreEffectOutcome(value: string): PreEffectReceiptOutcome {
    if (value === "deniedPreEffect" || value === "cancelledPreEffect") return value;
    throw new TypeError("Pre-effect Receipt outcome is invalid");
}

function requireAttemptOutcome(value: string): AttemptReceiptOutcome {
    if (isMember(ATTEMPT_RECEIPT_OUTCOMES, value)) {
        return value;
    }
    throw new TypeError("Attempt Receipt outcome is invalid");
}

export const ReceiptCodec: RecordCodec<Receipt> = new ReceiptCodecV2();
