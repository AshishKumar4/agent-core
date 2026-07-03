import { TextId } from "../core";

export class ActorId extends TextId {
    public constructor(value: string) {
        super(value, "Actor ID");
    }
}

export class ActorFence {
    public constructor(
        public readonly actorId: ActorId,
        public readonly epoch: number
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Actor fence epoch must be a non-negative safe integer");
        }
    }

    public matches(actorId: ActorId, epoch: number): boolean {
        return this.actorId.equals(actorId) && this.epoch === epoch;
    }
}

export type TransactionOperation<TTransaction, TResult> = (
    transaction: TTransaction
) => TResult | Promise<TResult>;

export type ActorCommand<TTransaction, TResult> = TransactionOperation<TTransaction, TResult>;

export interface TransactionalStore<TTransaction> {
    transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>
    ): Promise<TResult>;
}
