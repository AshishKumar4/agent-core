import { Digest, RecordCodec, type JsonValue } from "../../core";
import { OperationRef } from "../../facets";
import { ReceiptId } from "../../invocation-references";
import {
    CodecRecord,
    digestFromData,
    requireExactFields,
    requireObject,
    requireString
} from "../record-data";
import { AcceptanceId } from "./id";

export interface AcceptanceCriterionInit {
    readonly id: AcceptanceId;
    readonly operation: OperationRef;
}

export class AcceptanceCriterion extends CodecRecord {
    public static get codec(): RecordCodec<AcceptanceCriterion> {
        return AcceptanceCriterionCodec;
    }

    public readonly id: AcceptanceId;
    public readonly operation: OperationRef;

    public constructor(init: AcceptanceCriterionInit) {
        super();
        if (init.id.constructor !== AcceptanceId || init.operation.constructor !== OperationRef) {
            throw new TypeError("Acceptance criterion identifiers must use exact context classes");
        }
        this.id = init.id;
        this.operation = init.operation;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            id: this.id.value,
            operation: this.operation.value
        };
    }

    public static fromData(value: JsonValue): AcceptanceCriterion {
        const object = requireObject(value, "Acceptance criterion");
        requireExactFields(object, ["id", "operation"], [], "Acceptance criterion");
        return new AcceptanceCriterion({
            id: new AcceptanceId(requireString(object["id"], "Acceptance criterion ID")),
            operation: new OperationRef(
                requireString(object["operation"], "Acceptance criterion Operation")
            )
        });
    }
}

class AcceptanceCriterionRecordCodec extends RecordCodec<AcceptanceCriterion> {
    public constructor() {
        super("run.acceptance-criterion", { major: 1, minor: 0 });
    }
    protected encodePayload(value: AcceptanceCriterion): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): AcceptanceCriterion {
        return AcceptanceCriterion.fromData(value);
    }
}

export const AcceptanceCriterionCodec: RecordCodec<AcceptanceCriterion> =
    new AcceptanceCriterionRecordCodec();

export interface AcceptanceVerdictInit {
    readonly acceptance: AcceptanceId;
    readonly subject: Digest;
    readonly receipt: ReceiptId;
}

export class AcceptanceVerdict extends CodecRecord {
    public static get codec(): RecordCodec<AcceptanceVerdict> {
        return AcceptanceVerdictCodec;
    }

    public readonly acceptance: AcceptanceId;
    public readonly subject: Digest;
    public readonly receipt: ReceiptId;

    public constructor(init: AcceptanceVerdictInit) {
        super();
        if (
            init.acceptance.constructor !== AcceptanceId ||
            init.subject.constructor !== Digest ||
            init.receipt.constructor !== ReceiptId
        ) {
            throw new TypeError("Acceptance verdict identifiers must use exact context classes");
        }
        this.acceptance = init.acceptance;
        this.subject = init.subject;
        this.receipt = init.receipt;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            acceptance: this.acceptance.value,
            receipt: this.receipt.value,
            subject: this.subject.value
        };
    }

    public static fromData(value: JsonValue): AcceptanceVerdict {
        const object = requireObject(value, "Acceptance verdict");
        requireExactFields(object, ["acceptance", "receipt", "subject"], [], "Acceptance verdict");
        return new AcceptanceVerdict({
            acceptance: new AcceptanceId(
                requireString(object["acceptance"], "Acceptance verdict criterion")
            ),
            subject: digestFromData(object["subject"], "Acceptance verdict subject"),
            receipt: new ReceiptId(requireString(object["receipt"], "Acceptance verdict Receipt"))
        });
    }
}

class AcceptanceVerdictRecordCodec extends RecordCodec<AcceptanceVerdict> {
    public constructor() {
        super("run.acceptance-verdict", { major: 1, minor: 0 });
    }
    protected encodePayload(value: AcceptanceVerdict): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): AcceptanceVerdict {
        return AcceptanceVerdict.fromData(value);
    }
}

export const AcceptanceVerdictCodec: RecordCodec<AcceptanceVerdict> =
    new AcceptanceVerdictRecordCodec();
