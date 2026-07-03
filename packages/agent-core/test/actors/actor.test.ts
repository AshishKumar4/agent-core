import { describe, expect, test } from "vitest";
import { Actor, ActorId, type ActorContext, type TransactionOperation, type TransactionalStore } from "../../src/actors";
import { AgentCoreError } from "../../src/errors";

interface CounterTransaction {
    readonly log: string[];
}

class SerialStore implements TransactionalStore<CounterTransaction> {
    public readonly log: string[] = [];
    public active = 0;
    public maxActive = 0;

    public async transaction<TResult>(operation: TransactionOperation<CounterTransaction, TResult>): Promise<TResult> {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);

        try {
            return await operation({ log: this.log });
        } finally {
            this.active -= 1;
        }
    }
}

class CounterActor extends Actor<CounterTransaction> {
    public constructor(context: ActorContext<CounterTransaction>) {
        super(context);
    }

    protected onInitialize(transaction: CounterTransaction): Promise<void> {
        transaction.log.push("initialize");
        return Promise.resolve();
    }

    public rotateFence() {
        return this.advanceFence();
    }
}

function actor(store: SerialStore): CounterActor {
    return new CounterActor({
        id: new ActorId("actor-counter"),
        store
    });
}

describe("Actor", () => {
    test("initializes once and serializes commands through the mailbox", async () => {
        const store = new SerialStore();
        const counter = actor(store);

        await Promise.all([
            counter.execute(async transaction => {
                transaction.log.push("first:start");
                await Promise.resolve();
                transaction.log.push("first:end");
                return "first";
            }),
            counter.execute(transaction => {
                transaction.log.push("second");
                return "second";
            })
        ]);

        expect(store.log).toEqual([
            "initialize",
            "first:start",
            "first:end",
            "second"
        ]);
        expect(store.maxActive).toBe(1);
    });

    test("rejects commands after close", async () => {
        const store = new SerialStore();
        const counter = actor(store);

        await counter.close();

        await expect(counter.execute(transaction => {
            transaction.log.push("after-close");
        })).rejects.toMatchObject(new AgentCoreError("actor.closed", "Actor is closed"));
        expect(store.log).toEqual([]);
    });

    test("rejects stale fenced callbacks", async () => {
        const store = new SerialStore();
        const counter = actor(store);
        const stale = counter.currentFence();
        const current = counter.rotateFence();

        await expect(counter.executeFenced(stale, transaction => {
            transaction.log.push("stale");
        })).rejects.toMatchObject(new AgentCoreError("actor.stale-callback", "Actor command fence is stale"));
        await counter.executeFenced(current, transaction => {
            transaction.log.push("current");
        });

        expect(store.log).toEqual(["initialize", "current"]);
    });
});
