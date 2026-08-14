import { describe, expect, test } from "vitest";
import {
    Actor,
    ActorFence,
    ActorId,
    ActorRef,
    MemoryActorStore,
    type ActorContext
} from "../../src/actors";
import { SqliteActorStore, type TransactionalSqlite } from "../../src/substrates";
import { sqliteInteger, TestSqlite } from "../helpers/sqlite";

interface ContractActor {
    currentFence(): Promise<ActorFence>;
    failAfterMutation(): Promise<void>;
    increment(): Promise<number>;
    incrementFenced(fence: ActorFence): Promise<number>;
}

interface ActorContractHarness {
    create(): ContractActor;
    starts(): number;
    value(): number;
}

interface CounterOperations<Transaction> {
    increment(transaction: Transaction): number;
    readStarts(): number;
    readValue(): number;
    start(transaction: Transaction): void;
}

class ContractCounterActor<Transaction> extends Actor<Transaction> implements ContractActor {
    public constructor(
        context: ActorContext<Transaction>,
        private readonly operations: CounterOperations<Transaction>
    ) {
        super(context, (transaction) => operations.start(transaction));
    }

    public increment(): Promise<number> {
        return this.execute((transaction) => this.operations.increment(transaction));
    }

    public incrementFenced(fence: ActorFence): Promise<number> {
        return this.executeFenced(fence, (transaction) => this.operations.increment(transaction));
    }

    public failAfterMutation(): Promise<void> {
        return this.execute((transaction) => {
            this.operations.increment(transaction);
            throw new TypeError("deliberate command failure");
        });
    }
}

interface MemoryCounter {
    starts: number;
    value: number;
}

const contractFactories: readonly [string, () => ActorContractHarness][] = [
    ["memory", createMemoryHarness],
    ["sqlite", createSqliteHarness]
];

describe("Actor ownership contract", () => {
    test.each(contractFactories)(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] %s serializes, recovers, linearizes, and fences one command stream",
        { tags: "p0" },
        async (_adapter, createHarness) => {
            const harness = createHarness();
            expect(harness.starts()).toBe(0);

            const first = harness.create();
            expect(harness.starts()).toBe(1);
            const firstFence = await first.currentFence();

            const firstIncrement = first.increment();
            const secondIncrement = first.increment();
            await expect(Promise.all([firstIncrement, secondIncrement])).resolves.toEqual([1, 2]);
            expect(harness.value()).toBe(2);

            await expect(first.failAfterMutation()).rejects.toThrow("deliberate command failure");
            expect(harness.value()).toBe(2);

            const recovered = harness.create();
            expect(harness.starts()).toBe(2);
            const recoveredFence = await recovered.currentFence();
            expect(recoveredFence.epoch).toBe(firstFence.epoch + 1);

            await expect(first.increment()).rejects.toMatchObject({
                code: "actor.stale-callback"
            });
            await expect(recovered.incrementFenced(firstFence)).rejects.toMatchObject({
                code: "actor.stale-callback"
            });
            expect(harness.value()).toBe(2);
            await expect(recovered.increment()).resolves.toBe(3);
        }
    );
});

function createMemoryHarness(): ActorContractHarness {
    const actor = new ActorRef("tenant", new ActorId("ownership-memory"));
    const store = new MemoryActorStore<MemoryCounter>({ starts: 0, value: 0 }, structuredClone);
    const operations: CounterOperations<MemoryCounter> = {
        increment(transaction) {
            transaction.value += 1;
            return transaction.value;
        },
        readStarts: () => store.snapshot().state.starts,
        readValue: () => store.snapshot().state.value,
        start(transaction) {
            transaction.starts += 1;
        }
    };
    return createHarness(actor, store, operations);
}

function createSqliteHarness(): ActorContractHarness {
    const actor = new ActorRef("tenant", new ActorId("ownership-sqlite"));
    const database = new TestSqlite();
    database.run(
        "CREATE TABLE ownership_counter (singleton INTEGER PRIMARY KEY, starts INTEGER NOT NULL, value INTEGER NOT NULL)",
        []
    );
    database.run("INSERT INTO ownership_counter VALUES (1, 0, 0)", []);
    const operations: CounterOperations<TransactionalSqlite> = {
        increment(transaction) {
            const next = readSqliteCounter(transaction, "value") + 1;
            transaction.run("UPDATE ownership_counter SET value = ? WHERE singleton = 1", [next]);
            return next;
        },
        readStarts: () => readSqliteCounter(database, "starts"),
        readValue: () => readSqliteCounter(database, "value"),
        start(transaction) {
            const next = readSqliteCounter(transaction, "starts") + 1;
            transaction.run("UPDATE ownership_counter SET starts = ? WHERE singleton = 1", [next]);
        }
    };
    return createHarness(actor, new SqliteActorStore(database), operations);
}

function createHarness<Transaction>(
    actor: ActorRef,
    store: ActorContext<Transaction>["store"],
    operations: CounterOperations<Transaction>
): ActorContractHarness {
    return {
        create: () => new ContractCounterActor({ actor, store }, operations),
        starts: operations.readStarts,
        value: operations.readValue
    };
}

function readSqliteCounter(database: TransactionalSqlite, column: "starts" | "value"): number {
    return sqliteInteger(
        database.all(`SELECT ${column} FROM ownership_counter WHERE singleton = 1`, [])[0],
        column,
        `Ownership counter ${column}`
    );
}
