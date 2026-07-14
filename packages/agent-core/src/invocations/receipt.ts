import { ContentRef, RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { requireDate, requireExactObject, requireString, validDate } from "./codec";
import { EffectAttemptId, ReceiptId } from "./id";
import { InvocationId } from "../interaction-references";

export type PreEffectReceiptOutcome = "deniedPreEffect" | "cancelledPreEffect";
const ATTEMPT_RECEIPT_OUTCOMES = Object.freeze(["succeeded", "failed", "indeterminate"] as const);
export type AttemptReceiptOutcome = (typeof ATTEMPT_RECEIPT_OUTCOMES)[number];

export abstract class Receipt {
    readonly #recordedAt: number;

    protected constructor(recordedAt: Date, properties: object) {
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
    declare public readonly previous: ReceiptId | undefined;
    declare public readonly result: ContentRef | undefined;

    public constructor(
        id: ReceiptId,
        attempt: EffectAttemptId,
        outcome: AttemptReceiptOutcome,
        previous: ReceiptId | undefined,
        recordedAt: Date,
        result: ContentRef | undefined
    ) {
        super(recordedAt, requireAttemptReceipt(id, attempt, outcome, previous, result));
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
    readonly previous: ReceiptId | undefined;
    readonly result: ContentRef | undefined;
}

function requireAttemptReceipt(
    id: ReceiptId,
    attempt: EffectAttemptId,
    outcome: AttemptReceiptOutcome,
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
    requireAttemptOutcome(outcome);
    if (outcome === "indeterminate" && result !== undefined) {
        throw new TypeError("Indeterminate Receipts cannot carry a result");
    }
    return { variant: "attempt", id, attempt, outcome, previous, result };
}

class ReceiptCodecV1 extends RecordCodec<Receipt> {
    public constructor() {
        super("invocation.receipt", { major: 1, minor: 0 });
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
        if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
            throw new TypeError("Receipt payload must be an object");
        }
        const variant = requireString(payload as { readonly [key: string]: JsonValue }, "variant");
        if (variant === "preEffect") {
            const object = requireExactObject(
                payload,
                ["id", "invocation", "itemIndex", "outcome", "reason", "recordedAt", "variant"],
                "Pre-effect Receipt"
            );
            const itemIndex = object["itemIndex"];
            if (typeof itemIndex !== "number" || !Number.isSafeInteger(itemIndex)) {
                throw new TypeError("Receipt item index must be a safe integer");
            }
            return new PreEffectReceipt(
                new ReceiptId(requireString(object, "id")),
                new InvocationId(requireString(object, "invocation")),
                itemIndex,
                requirePreEffectOutcome(requireString(object, "outcome")),
                requireDate(object, "recordedAt"),
                requireString(object, "reason")
            );
        }
        if (variant === "attempt") {
            const object = requireExactObject(
                payload,
                ["attempt", "id", "outcome", "previous", "recordedAt", "result", "variant"],
                "Attempt Receipt"
            );
            const previous = object["previous"];
            const result = object["result"];
            if (
                (previous !== null && typeof previous !== "string") ||
                (result !== null && typeof result !== "string")
            ) {
                throw new TypeError("Attempt Receipt references are malformed");
            }
            return new AttemptReceipt(
                new ReceiptId(requireString(object, "id")),
                new EffectAttemptId(requireString(object, "attempt")),
                requireAttemptOutcome(requireString(object, "outcome")),
                previous === null ? undefined : new ReceiptId(previous as string),
                requireDate(object, "recordedAt"),
                result === null ? undefined : new ContentRef(result as string)
            );
        }
        throw new TypeError("Receipt variant is invalid");
    }
}

function requirePreEffectOutcome(value: string): PreEffectReceiptOutcome {
    if (value === "deniedPreEffect" || value === "cancelledPreEffect") return value;
    throw new TypeError("Pre-effect Receipt outcome is invalid");
}

function requireAttemptOutcome(value: string): AttemptReceiptOutcome {
    if (ATTEMPT_RECEIPT_OUTCOMES.includes(value as AttemptReceiptOutcome)) {
        return value as AttemptReceiptOutcome;
    }
    throw new TypeError("Attempt Receipt outcome is invalid");
}

export const ReceiptCodec: RecordCodec<Receipt> = new ReceiptCodecV1();
