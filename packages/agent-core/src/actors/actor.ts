import { AgentCoreError } from "../errors";
import type { ActorContext } from "./context";
import { ActorFence } from "./types";
import type { ActorCommand, ActorId, TransactionOperation } from "./types";

export abstract class Actor<TTransaction> {
    readonly #context: ActorContext<TTransaction>;
    #initialization: Promise<void> | undefined;
    #mailbox: Promise<void> = Promise.resolve();
    #closed = false;
    #closing = false;
    #epoch = 0;

    protected constructor(context: ActorContext<TTransaction>) {
        this.#context = context;
    }

    public get id(): ActorId {
        return this.#context.id;
    }

    private initialize(): Promise<void> {
        this.ensureOpen();
        if (this.#initialization === undefined) {
            const initialization = this.transaction(transaction =>
                this.onInitialize(transaction)
            );

            this.#initialization = initialization.catch(error => {
                this.#initialization = undefined;
                throw error;
            });
        }

        return this.#initialization;
    }

    public async execute<TResult>(command: ActorCommand<TTransaction, TResult>): Promise<TResult> {
        const execution = this.#mailbox.then(async () => {
            this.ensureOpen();
            await this.initialize();
            this.ensureOpen();
            return await this.transaction(command);
        });

        this.#mailbox = execution.then(noop, noop);
        return await execution;
    }

    public executeFenced<TResult>(fence: ActorFence, command: ActorCommand<TTransaction, TResult>): Promise<TResult> {
        if (!fence.matches(this.id, this.#epoch)) {
            return Promise.reject(new AgentCoreError("actor.stale-callback", "Actor command fence is stale"));
        }

        return this.execute(command);
    }

    public currentFence(): ActorFence {
        return new ActorFence(this.id, this.#epoch);
    }

    public async close(): Promise<void> {
        this.#closing = true;
        await this.#mailbox;
        this.#epoch += 1;
        this.#closed = true;
    }

    protected transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>
    ): Promise<TResult> {
        return this.#context.store.transaction(operation);
    }

    protected abstract onInitialize(transaction: TTransaction): Promise<void>;

    protected advanceFence(): ActorFence {
        this.#epoch += 1;
        return this.currentFence();
    }

    private ensureOpen(): void {
        if (this.#closed || this.#closing) {
            throw new AgentCoreError("actor.closed", "Actor is closed");
        }
    }
}

function noop(): void {
}
