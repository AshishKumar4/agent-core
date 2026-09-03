import { describe, expect, test } from "vitest";
import {
    Actor,
    ActorFence,
    ActorId,
    ActorRef,
    MemoryActorStore,
    type ActorContext
} from "../../src/actors";
import { CodecDeclaration } from "../../src/core";
import { SqliteActorStore, type TransactionalSqlite } from "../../src/substrates";
import { sqliteInteger, TestSqlite } from "../helpers/sqlite";
import { sourceProject } from "../../scripts/quality/evidence.mjs";
import {
    AUTHORITY_RECORD_CLASSES,
    DERIVED_CACHE_INVENTORY,
    SUBSCRIPTION_ENTRY_POINTS,
    SUBSCRIPTION_NAMESPACE,
    discoverDerivedCaches,
    discoverPersistenceSurfaces,
    discoverSubscriptionWriters,
    validateAuthorityPlaneExclusivity,
    validateDerivedCacheInventory,
    validateSubscriptionWriteMediation,
    type SubscriptionEntryPoint,
    type SubscriptionWriter
} from "../../scripts/quality/record-ownership.mjs";

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
        super(context, CodecDeclaration.empty, (transaction) => operations.start(transaction));
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

describe("one durable owner per record kind", () => {
    test(
        "[C13-OWNERSHIP-AUTHORITY-RECORDS] [C13-OWNERSHIP-SINGLE-OWNER] no durable surface outside the Tenant authority plane can hold a Binding, Grant or ScopeEpoch",
        { tags: "p0", timeout: 60_000 },
        () => {
            const surfaces = discoverPersistenceSurfaces(sourceProject());
            expect(surfaces.length).toBeGreaterThan(50);
            expect(() => validateAuthorityPlaneExclusivity(surfaces)).not.toThrow();

            // The Run and Workspace Actors are the two the rule names, and what they hold
            // of the authority plane is nothing at all — not the record and not an index
            // of it. A dedicated Run Actor therefore has no local Binding projection to
            // authorize from, which is why §7.2 leaves it on the mediated path.
            const runAndWorkspace = surfaces.filter(
                (surface) =>
                    surface.context.startsWith("src/agents/") ||
                    surface.context.startsWith("src/workspaces/")
            );
            expect(runAndWorkspace.length).toBeGreaterThan(0);
            expect(runAndWorkspace.flatMap((surface) => surface.records)).toEqual([]);

            // A unique registry declaration cannot see this: the adversary registers
            // nothing and simply adds the member. Each of the three records must be
            // refused on its own, so a check that noticed only Bindings would fail here.
            for (const record of AUTHORITY_RECORD_CLASSES) {
                const dualWriter = {
                    selector: `src/workspaces/persistence.ts#WorkspacePersistence`,
                    context: "src/workspaces/persistence.ts",
                    records: [{ record, member: `put${record}` }]
                };
                expect(() => validateAuthorityPlaneExclusivity([...surfaces, dualWriter])).toThrow(
                    `Durable surface outside the Tenant authority plane holds ${record}: src/workspaces/persistence.ts#WorkspacePersistence`
                );
            }
        }
    );

    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] the derived cache inventory is the whole set, and each entry states how the cache survives loss",
        { tags: "p0", timeout: 60_000 },
        () => {
            const caches = discoverDerivedCaches(sourceProject());
            expect(() => validateDerivedCacheInventory(caches)).not.toThrow();
            expect(caches.map((cache) => cache.source).sort()).toEqual(
                DERIVED_CACHE_INVENTORY.map((entry) => entry.source).sort()
            );

            // Every entry names a real cache and a test that shows it rebuilt, so the
            // inventory cannot record a property nothing demonstrates.
            for (const entry of DERIVED_CACHE_INVENTORY) {
                expect(entry.test).toMatch(/^test\/.+#.+$/);
                expect(entry.rebuiltBy.length).toBeGreaterThan(0);
            }

            // A cache the tree grows and the inventory does not know about is refused —
            // which is what turns "every cache is rebuildable" from a claim about the one
            // measured case into a claim about the set.
            expect(() =>
                validateDerivedCacheInventory([
                    ...caches,
                    { source: "src/workspaces/persistence.ts#WorkspacePersistence.#bindingCache" }
                ])
            ).toThrow(
                "Derived cache is not in the inventory: src/workspaces/persistence.ts#WorkspacePersistence.#bindingCache"
            );
            // And an inventory entry whose cache was deleted is refused too, so the list
            // cannot outlive what it describes.
            expect(() => validateDerivedCacheInventory([])).toThrow(
                /Derived cache inventory names no such cache/
            );
        }
    );

    test(
        "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] [C13-OWNERSHIP-SINGLE-OWNER] the Subscription namespace has one writer and exactly the declared entry points reach it",
        { tags: "p0", timeout: 60_000 },
        () => {
            const discovered = discoverSubscriptionWriters(sourceProject());
            expect(() => validateSubscriptionWriteMediation(discovered)).not.toThrow();
            // The funnel is one private member, discovered rather than declared, so the
            // negative claim this row rests on is a fact about the tree.
            expect(discovered.writers.map((writer: SubscriptionWriter) => writer.selector)).toEqual(
                [SUBSCRIPTION_NAMESPACE.writer]
            );
            expect(
                discovered.entries.map((entry: SubscriptionWriter) => entry.member).sort()
            ).toEqual(
                SUBSCRIPTION_ENTRY_POINTS.map(
                    (entry: SubscriptionEntryPoint) => entry.member
                ).sort()
            );

            // A second raw writer is refused wherever it lives: attribution fixity is
            // enforced on the way through the funnel, so a path around it is the defect
            // no amount of source reading can rule out for a writer added later.
            expect(() =>
                validateSubscriptionWriteMediation({
                    ...discovered,
                    writers: [
                        ...discovered.writers,
                        {
                            selector:
                                "src/substrates/sqlite/events/subscription.ts#SqliteSubscriptions.put",
                            member: "put"
                        }
                    ]
                })
            ).toThrow(
                "Subscription namespace is written outside src/workspaces/persistence.ts#WorkspacePersistence.writeSubscription: src/substrates/sqlite/events/subscription.ts#SqliteSubscriptions.put"
            );

            // And an entry point nothing declared is refused too, because what authorizes
            // the attribution each one writes is reviewed per path rather than counted.
            expect(() =>
                validateSubscriptionWriteMediation({
                    ...discovered,
                    entries: [
                        ...discovered.entries,
                        {
                            selector:
                                "src/workspaces/persistence.ts#WorkspacePersistence.importSubscription",
                            member: "importSubscription"
                        }
                    ]
                })
            ).toThrow("Subscription funnel is reached by an undeclared writer: importSubscription");

            // A declaration whose writer was deleted is stale rather than silently kept.
            expect(() =>
                validateSubscriptionWriteMediation(discovered, [
                    ...SUBSCRIPTION_ENTRY_POINTS,
                    { member: "adoptSubscription", attribution: "nothing this tree contains" }
                ])
            ).toThrow("Subscription entry point names no such writer: adoptSubscription");
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
