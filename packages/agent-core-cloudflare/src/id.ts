import { TextId } from "@agent-core/core";

export class ReconciliationOutboxId extends TextId {
    public constructor(value: string) {
        super(value, "Reconciliation outbox ID");
    }
}

/** The queue platform's own message identity, narrowed where it enters the adapter. */
export class QueueMessageId extends TextId {
    public constructor(value: string) {
        super(value, "Queue message ID");
    }
}
