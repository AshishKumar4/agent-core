import { AgentCoreError, type AgentCoreErrorCode } from "../errors";
import { createActorContext, type ActorContext } from "./context";
import { ActorRecoveryState } from "./fence";
import type { ActorId } from "./id";
import { requireSynchronousResult, type ActorStartOperation } from "./store";
import { ActorFence } from "./types";
import type { ActorCommand, ActorRef, SynchronousResultGuard, TransactionOperation } from "./types";

interface ActorCommitUnknownErrorCodeDependency {
    readonly requested: "actor.commit-unknown";
    readonly fallback: Extract<AgentCoreErrorCode, "actor.closed">;
}

const ACTOR_COMMIT_UNKNOWN_ERROR_CODE: ActorCommitUnknownErrorCodeDependency = Object.freeze({
    requested: "actor.commit-unknown",
    fallback: "actor.closed"
});
const actorCommitUnknownErrors = new WeakSet<object>();

export class ActorCommitUnknownError extends AgentCoreError {
    public static readonly codeDependency = ACTOR_COMMIT_UNKNOWN_ERROR_CODE;

    public constructor(message = "The Actor transaction commit result is unknown") {
        super(ACTOR_COMMIT_UNKNOWN_ERROR_CODE.fallback, message);
        this.name = "ActorCommitUnknownError";
        actorCommitUnknownErrors.add(this);
    }
}

export abstract class Actor<TTransaction> {
    readonly #context: ActorContext<TTransaction>;
    #mailbox: Promise<void> = Promise.resolve();
    #closed = false;
    #closing = false;
    #closePromise: Promise<void> | undefined;
    #fence: ActorFence;

    protected constructor(
        context: ActorContext<TTransaction>,
        start: ActorStartOperation<TTransaction>
    ) {
        this.#context = createActorContext(context.actor, context.store);
        this.#fence = this.#context.store.activateActor(context.actor, start).fence;
    }

    public get id(): ActorId {
        return this.#context.actor.id;
    }

    public get ref(): ActorRef {
        return this.#context.actor;
    }

    protected execute<TResult>(
        command: ActorCommand<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): Promise<TResult> {
        return this.enqueueCommand(undefined, command, ...guard);
    }

    protected executeFenced<TResult>(
        fence: ActorFence,
        command: ActorCommand<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): Promise<TResult> {
        return this.enqueueCommand(fence, command, ...guard);
    }

    public currentFence(): Promise<ActorFence> {
        return this.enqueue(() => {
            this.ensureActive();
            return this.mutate(undefined, () => this.#fence);
        });
    }

    public close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        if (this.#closed) {
            this.#closePromise = Promise.resolve();
            return this.#closePromise;
        }
        this.#closing = true;
        this.#closePromise = this.enqueue(() => {
            if (this.#closed) return;
            try {
                this.advanceCurrentFence();
            } catch (error) {
                if (!isStaleFence(error)) throw error;
            } finally {
                this.#closed = true;
            }
        });
        return this.#closePromise;
    }

    protected advanceFence(): Promise<ActorFence> {
        try {
            this.ensureAccepting();
        } catch (error) {
            return Promise.reject(error);
        }
        return this.enqueue(() => {
            this.ensureActive();
            this.advanceCurrentFence();
            return this.#fence;
        });
    }

    private advanceCurrentFence(): void {
        const advanced = this.transact((transaction) => {
            const state = this.requireCurrentState(transaction).advance();
            this.#context.store.saveRecoveryState(transaction, state);
            return state.fence;
        });
        this.#fence = advanced;
    }

    private mutate<TResult>(
        expectedFence: ActorFence | undefined,
        operation: TransactionOperation<TTransaction, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const completed = this.transact((transaction) => {
            const state = this.requireCurrentState(transaction);
            if (expectedFence !== undefined && !expectedFence.matches(this.ref, state.epoch)) {
                throw staleFence();
            }

            const result = requireSynchronousResult(operation(transaction));
            return { fence: state.fence, result };
        });

        this.#fence = completed.fence;
        return completed.result;
    }

    private requireCurrentState(transaction: TTransaction): ActorRecoveryState {
        const state = this.#context.store.loadRecoveryState(transaction, this.ref);
        if (state === undefined || !this.#fence.matches(this.ref, state.epoch)) {
            throw staleFence();
        }
        return state;
    }

    private enqueueCommand<TResult>(
        fence: ActorFence | undefined,
        command: ActorCommand<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): Promise<TResult> {
        try {
            this.ensureAccepting();
        } catch (error) {
            return Promise.reject(error);
        }
        return this.enqueue(() => {
            this.ensureActive();
            return this.mutate(fence, command, ...guard);
        });
    }

    private enqueue<TResult>(operation: () => TResult): Promise<TResult> {
        const execution = this.#mailbox.then(operation);
        this.#mailbox = execution.then(noop, noop);
        return execution;
    }

    private transact<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        let operationCompleted = false;
        try {
            return this.#context.store.transaction(
                (transaction) => {
                    try {
                        const result = operation(transaction);
                        operationCompleted = true;
                        return result;
                    } catch (error) {
                        throw rejectCallbackCommitUnknown(error);
                    }
                },
                ...guard
            );
        } catch (error) {
            if (operationCompleted && isActorCommitUnknown(error)) {
                this.#closed = true;
            }
            throw error;
        }
    }

    private ensureAccepting(): void {
        if (this.#closed || this.#closing) {
            throw new AgentCoreError("actor.closed", "Actor is closed");
        }
    }

    private ensureActive(): void {
        if (this.#closed) {
            throw new AgentCoreError("actor.closed", "Actor is closed");
        }
    }
}

function staleFence(): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", "Actor command fence is stale");
}

function noop(): void {}

function isStaleFence(error: unknown): boolean {
    return error instanceof AgentCoreError && error.code === "actor.stale-callback";
}

function isActorCommitUnknown(error: unknown): boolean {
    return (
        error !== null &&
        (typeof error === "object" || typeof error === "function") &&
        actorCommitUnknownErrors.has(error)
    );
}

function rejectCallbackCommitUnknown(error: unknown): unknown {
    return isActorCommitUnknown(error)
        ? new AgentCoreError(
              "protocol.invalid-state",
              "Commit uncertainty cannot originate inside an Actor transaction"
          )
        : error;
}
