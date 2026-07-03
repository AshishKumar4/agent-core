import type { OperationId } from "../../operations/id";
import type { Durability } from "./durability";

export class MutationReceipt {
    public constructor(
        public readonly operation: OperationId,
        public readonly completion: Durability
    ) {
    }
}
