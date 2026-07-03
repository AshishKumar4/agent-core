import type { ActorId, TransactionalStore } from "./types";

export interface ActorContext<TTransaction> {
    readonly id: ActorId;
    readonly store: TransactionalStore<TTransaction>;
}
