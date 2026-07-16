// @ts-nocheck
import { TextId } from "../core";

export class ApprovalId extends TextId {
    public constructor(value: string) {
        super(value, "Approval ID");
        Object.freeze(this);
    }
}

export class ReceiptId extends TextId {
    public constructor(value: string) {
        super(value, "Receipt ID");
        Object.freeze(this);
    }
}

export class EffectAttemptId extends TextId {
    public constructor(value: string) {
        super(value, "Effect attempt ID");
        Object.freeze(this);
    }
}

export class ItemClaimId extends TextId {
    public constructor(value: string) {
        super(value, "Item claim ID");
        Object.freeze(this);
    }
}

export class ClaimWorkerId extends TextId {
    public constructor(value: string) {
        super(value, "Claim worker ID");
        Object.freeze(this);
    }
}

export class WriteRecordId extends TextId {
    public constructor(value: string) {
        super(value, "Write record ID");
        Object.freeze(this);
    }
}
