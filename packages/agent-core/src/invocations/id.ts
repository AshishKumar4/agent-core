import { TextId } from "../core";

export class InvocationId extends TextId {
    public constructor(value: string) {
        super(value, "Invocation ID");
    }
}

export class ApprovalId extends TextId {
    public constructor(value: string) {
        super(value, "Approval ID");
    }
}

export class ReceiptId extends TextId {
    public constructor(value: string) {
        super(value, "Receipt ID");
    }
}

export class AuditRecordId extends TextId {
    public constructor(value: string) {
        super(value, "Audit record ID");
    }
}
