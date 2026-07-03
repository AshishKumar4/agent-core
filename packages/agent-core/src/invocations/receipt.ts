import type { ContentRef } from "../record";
import type { InvocationId, ReceiptId } from "./id";

export type ReceiptStatus = "succeeded" | "failed" | "denied" | "cancelled" | "indeterminate";

export class InvocationReceipt {
    public constructor(
        public readonly id: ReceiptId,
        public readonly invocationId: InvocationId,
        public readonly status: ReceiptStatus,
        public readonly evidenceRef: ContentRef | undefined
    ) {
    }
}
