import { TextId } from "@agent-core/core";

export class ReconciliationOutboxId extends TextId {
    public constructor(value: string) {
        super(value, "Reconciliation outbox ID");
    }
}
