// @ts-nocheck
import { RecordCodec, type JsonValue } from "../../core";
import { ReceiptId } from "../../invocation-references";
import { AuditRecordId, EventId } from "../../interaction-references";
import {
    CodecRecord,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString
} from "../record-data";
import { RunId, TurnId } from "./id";

export interface ForcedTurnCancellationInit {
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly cancellationEvent: EventId;
    readonly cancellationAudit: AuditRecordId;
}

class ForcedCancellationCodec extends RecordCodec<ForcedTurnCancellation> {
    public constructor() {
        super("run.forced-turn-cancellation", { major: 1, minor: 0 });
    }

    protected encodePayload(value: ForcedTurnCancellation): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): ForcedTurnCancellation {
        return ForcedTurnCancellation.fromData(value);
    }
}

export class ForcedTurnCancellation extends CodecRecord {
    public static readonly codec: RecordCodec<ForcedTurnCancellation> =
        new ForcedCancellationCodec();
    public static encode<Value>(
        this: { readonly codec: RecordCodec<Value> },
        value: Value
    ): Uint8Array {
        return this.codec.encode(value);
    }
    public static decode<Value>(
        this: { readonly codec: RecordCodec<Value> },
        bytes: Uint8Array
    ): Value {
        return this.codec.decode(bytes);
    }

    public readonly run: RunId;
    public readonly terminalTurn: TurnId;
    public readonly turn: TurnId;
    public readonly priorLeaseEpoch: number;
    public readonly fencedLeaseEpoch: number;
    public readonly controlReceipt: ReceiptId;
    public readonly controlAudit: AuditRecordId;
    public readonly cancellationEvent: EventId;
    public readonly cancellationAudit: AuditRecordId;

    public constructor(init: ForcedTurnCancellationInit) {
        super();
        if (
            init.run.constructor !== RunId ||
            init.terminalTurn.constructor !== TurnId ||
            init.turn.constructor !== TurnId ||
            init.controlReceipt.constructor !== ReceiptId ||
            init.controlAudit.constructor !== AuditRecordId ||
            init.cancellationEvent.constructor !== EventId ||
            init.cancellationAudit.constructor !== AuditRecordId
        ) {
            throw new TypeError("Forced cancellation identifiers must use exact context classes");
        }
        if (init.terminalTurn.equals(init.turn)) {
            throw new TypeError("Forced cancellation requires a distinct sibling Turn");
        }
        if (
            !Number.isSafeInteger(init.priorLeaseEpoch) ||
            init.priorLeaseEpoch < 0 ||
            !Number.isSafeInteger(init.fencedLeaseEpoch) ||
            init.fencedLeaseEpoch !== init.priorLeaseEpoch + 1
        ) {
            throw new TypeError("Forced cancellation requires one exact lease fence increment");
        }
        this.run = init.run;
        this.terminalTurn = init.terminalTurn;
        this.turn = init.turn;
        this.priorLeaseEpoch = init.priorLeaseEpoch;
        this.fencedLeaseEpoch = init.fencedLeaseEpoch;
        this.controlReceipt = init.controlReceipt;
        this.controlAudit = init.controlAudit;
        this.cancellationEvent = init.cancellationEvent;
        this.cancellationAudit = init.cancellationAudit;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            cancellationAudit: this.cancellationAudit.value,
            cancellationEvent: this.cancellationEvent.value,
            controlAudit: this.controlAudit.value,
            controlReceipt: this.controlReceipt.value,
            fencedLeaseEpoch: this.fencedLeaseEpoch,
            priorLeaseEpoch: this.priorLeaseEpoch,
            run: this.run.value,
            terminalTurn: this.terminalTurn.value,
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): ForcedTurnCancellation {
        const object = requireObject(value, "Forced Turn cancellation");
        requireExactFields(
            object,
            [
                "cancellationAudit",
                "cancellationEvent",
                "controlAudit",
                "controlReceipt",
                "fencedLeaseEpoch",
                "priorLeaseEpoch",
                "run",
                "terminalTurn",
                "turn"
            ],
            [],
            "Forced Turn cancellation"
        );
        return new ForcedTurnCancellation({
            run: new RunId(requireString(object["run"], "Forced cancellation Run")),
            terminalTurn: new TurnId(
                requireString(object["terminalTurn"], "Forced cancellation terminal Turn")
            ),
            turn: new TurnId(requireString(object["turn"], "Forced cancellation sibling Turn")),
            priorLeaseEpoch: requireInteger(
                object["priorLeaseEpoch"],
                "Forced cancellation prior lease epoch"
            ),
            fencedLeaseEpoch: requireInteger(
                object["fencedLeaseEpoch"],
                "Forced cancellation fenced lease epoch"
            ),
            controlReceipt: new ReceiptId(
                requireString(object["controlReceipt"], "Forced cancellation control Receipt")
            ),
            controlAudit: new AuditRecordId(
                requireString(object["controlAudit"], "Forced cancellation control Audit")
            ),
            cancellationEvent: new EventId(
                requireString(object["cancellationEvent"], "Forced cancellation Event")
            ),
            cancellationAudit: new AuditRecordId(
                requireString(object["cancellationAudit"], "Forced cancellation Audit")
            )
        });
    }
}

export const ForcedTurnCancellationCodec: RecordCodec<ForcedTurnCancellation> =
    ForcedTurnCancellation.codec;
