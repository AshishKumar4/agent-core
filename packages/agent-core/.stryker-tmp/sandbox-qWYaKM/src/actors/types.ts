// @ts-nocheck
import { isExactActorId, type ActorId } from "./id";

export type ActorKind = "tenant" | "workspace" | "run" | "environment" | "slate";

export class ActorRef {
    public readonly kind: ActorKind;
    public readonly id: ActorId;

    public constructor(kind: ActorKind, id: ActorId) {
        if (!isActorKind(kind) || !isExactActorId(id)) {
            throw new TypeError("Actor reference requires a valid kind and exact Actor ID");
        }
        this.kind = kind;
        this.id = id;
        Object.freeze(this);
    }

    public equals(other: ActorRef): boolean {
        return this.kind === other.kind && this.id.equals(other.id);
    }
}

function isActorKind(value: unknown): value is ActorKind {
    return (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    );
}

export class ActorFence {
    public constructor(
        public readonly actor: ActorRef,
        public readonly epoch: number
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Actor fence epoch must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    public matches(actor: ActorRef, epoch: number): boolean {
        return this.actor.equals(actor) && this.epoch === epoch;
    }
}

export type TransactionOperation<TTransaction, TResult> = (transaction: TTransaction) => TResult;

export type ActorCommand<TTransaction, TResult> = TransactionOperation<TTransaction, TResult>;

export type SynchronousResultGuard<TResult> = [Extract<TResult, PromiseLike<unknown>>] extends [
    never
]
    ? []
    : [error: "Actor transaction callbacks must be synchronous"];

export interface TransactionalStore<TTransaction> {
    transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult;
}
