import { CodecCompatibility, CodecDeclaration, isObjectRecord } from "../core";
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
    #compatibility: CodecCompatibility = CodecCompatibility.compatible;
    #bootstrapFailure: AgentCoreError | undefined;

    /**
     * Subclasses declare only the record codecs they own. Actor unions the stable recovery
     * carrier itself, so no subclass can omit it or choose its version. The stored
     * declaration sits in a separate raw carrier that the store returns before `start`
     * decodes domain records; an incompatible or malformed future carrier therefore leaves
     * construction possible and refuses every operation instead.
     */
    protected constructor(
        context: ActorContext<TTransaction>,
        declaration: CodecDeclaration,
        start: ActorStartOperation<TTransaction>
    ) {
        this.#context = createActorContext(context.actor, context.store);
        const store = this.#context.store;
        const completeDeclaration = declarationForActor(declaration);
        this.#fence = store.activateActor(context.actor, (transaction, activation) => {
            const carrier = store.loadRecordSetDeclaration(transaction, context.actor);
            let stored = CodecDeclaration.empty;
            if (carrier !== undefined) {
                try {
                    stored = CodecDeclaration.decode(carrier);
                } catch (error) {
                    if (!(error instanceof AgentCoreError)) throw error;
                    this.#bootstrapFailure = error;
                    return;
                }
            }
            this.#compatibility = stored.compatibilityWith(completeDeclaration);
            this.#compatibility.admit(() => {
                if (!stored.equals(completeDeclaration)) {
                    store.saveRecordSetDeclaration(
                        transaction,
                        context.actor,
                        CodecDeclaration.encode(completeDeclaration)
                    );
                }
                requireSynchronousResult(start(transaction, activation));
            });
        }).fence;
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
                        if (isActorCommitUnknown(error)) {
                            throw new AgentCoreError(
                                "protocol.invalid-state",
                                "Commit uncertainty cannot originate inside an Actor transaction"
                            );
                        }
                        throw error;
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
        if (this.#bootstrapFailure !== undefined) throw this.#bootstrapFailure;
        this.#compatibility.requireCompatible();
    }
}

function staleFence(): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", "Actor command fence is stale");
}

function noop(): void {}

function isStaleFence(error: unknown): error is AgentCoreError {
    return error instanceof AgentCoreError && error.code === "actor.stale-callback";
}

function isActorCommitUnknown(error: unknown): error is ActorCommitUnknownError {
    return isObjectRecord(error) && actorCommitUnknownErrors.has(error);
}

function declarationForActor(declaration: CodecDeclaration): CodecDeclaration {
    if (declaration.versionOf(ActorRecoveryState.codec.kind) !== undefined) {
        throw new TypeError("Actor subclasses must not declare the stable recovery carrier");
    }
    return CodecDeclaration.of([ActorRecoveryState.codec, ...declaration.declared]);
}
