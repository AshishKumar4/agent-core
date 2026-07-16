// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    ACTOR_STATE_SNAPSHOT,
    Actor,
    ActorActivation,
    ActorCommitUnknownError,
    ActorId,
    ActorRef,
    createActorContext,
    isActorActivationStore,
    type ActorActivationStore,
    type ActorCloneOwnedState,
    type ActorContext,
    type ActorStartOperation,
    type ActorStore,
    ActorFence,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { ActorRecoveryState } from "../../src/actors/fence";
import { MemoryActorStore } from "../../src/actors/store";
import { encodeCanonicalJson, Revision, TextId } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    SqliteActorStore,
    type ReadableSqlite,
    type TransactionalSqlite
} from "../../src/substrates";
import { TestSqlite as BaseTestSqlite } from "../helpers/sqlite";

class TestSqlite extends BaseTestSqlite {
    public constructor() {
        super();
    }
}

const ACTOR_ID = new ActorId("actor-counter");
const ACTOR_REF = new ActorRef("run", ACTOR_ID);

interface CounterOperations<TTransaction> {
    initialize(transaction: TTransaction): void;
    increment(transaction: TTransaction): number;
    value(): number;
    initializations(): number;
}

interface EscapedCommand {
    readonly execution: Promise<unknown>;
    lateResult(): Promise<void>;
}

class CounterActor<TTransaction> extends Actor<TTransaction> {
    public constructor(
        context: ActorContext<TTransaction>,
        private readonly operations: CounterOperations<TTransaction>
    ) {
        super(context, (transaction) => operations.initialize(transaction));
    }

    public increment(): Promise<number> {
        return this.execute((transaction) => this.operations.increment(transaction));
    }

    public incrementFenced(fence: ActorFence): Promise<number> {
        return this.executeFenced(fence, (transaction) => this.operations.increment(transaction));
    }

    public failAfterIncrement(): Promise<never> {
        return this.execute((transaction) => {
            this.operations.increment(transaction);
            throw new TypeError("Injected transaction fault");
        });
    }

    public forgeCommitUnknown(): Promise<never> {
        return this.execute(() => {
            throw new ActorCommitUnknownError("Forged by command callback");
        });
    }

    public returnThenable(): Promise<unknown> {
        const thenable = new Proxy(
            {},
            {
                get: (_target, property) => (property === "then" ? noop : undefined)
            }
        );
        return this.execute<unknown>(() => thenable);
    }

    public returnStatefulThenableAfterIncrement(): Promise<unknown> {
        let reads = 0;
        return this.execute<unknown>((transaction) => {
            this.operations.increment(transaction);
            return new Proxy(
                {},
                {
                    get: (_target, property) =>
                        property === "then" && ++reads > 1
                            ? () => {
                                  throw new TypeError("Assimilated after commit");
                              }
                            : undefined
                }
            );
        });
    }

    public escapePromise(): EscapedCommand {
        let late: Promise<void> | undefined;
        const execution = this.execute<unknown>((transaction) => {
            this.operations.increment(transaction);
            late = Promise.resolve().then(() => {
                this.operations.increment(transaction);
            });
            return late;
        });

        return {
            execution,
            async lateResult(): Promise<void> {
                try {
                    await execution;
                } catch {
                    // The transaction rejection is asserted separately.
                }
                if (late === undefined) {
                    throw new TypeError("Escaped command did not run");
                }
                return await late;
            }
        };
    }

    public rotateFence(): Promise<ActorFence> {
        return this.advanceFence();
    }
}

interface CounterActorClient {
    readonly id: ActorId;
    readonly ref: ActorRef;
    increment(): Promise<number>;
    incrementFenced(fence: ActorFence): Promise<number>;
    failAfterIncrement(): Promise<never>;
    forgeCommitUnknown(): Promise<never>;
    returnThenable(): Promise<unknown>;
    returnStatefulThenableAfterIncrement(): Promise<unknown>;
    escapePromise(): EscapedCommand;
    rotateFence(): Promise<ActorFence>;
    currentFence(): Promise<ActorFence>;
    close(): Promise<void>;
}

interface ActorHarness {
    readonly actor: CounterActorClient;
    restart(): CounterActorClient;
    value(): number;
    initializations(): number;
    recovery(): ActorRecoveryState | undefined;
    failNextCommitUnknown(): void;
    failCommitUnknownAfter(transactions: number): void;
    failNextCommitWith(error: unknown): void;
}

type HarnessFactory = () => ActorHarness;

function actorStoreContract(name: string, create: HarnessFactory): void {
    describe(`${name} ActorStore contract`, () => {
        test("runs an asynchronous mailbox outside synchronous transactions", async () => {
            const harness = create();

            expect(harness.actor.id).toBe(ACTOR_ID);
            expect(harness.actor.ref).toEqual(ACTOR_REF);
            expect(harness.initializations()).toBe(1);
            expect(harness.recovery()?.recoveries).toBe(1);

            const first = harness.actor.increment();
            const second = harness.actor.increment();

            expect(harness.value()).toBe(0);
            await expect(first).resolves.toBe(1);
            await expect(second).resolves.toBe(2);
            expect(harness.initializations()).toBe(1);
        });

        test("[actor.recovery-state] recovers durable fencing state before a restarted actor serves", async () => {
            const harness = create();
            const firstFence = await harness.actor.currentFence();

            const restarted = harness.restart();
            await expect(restarted.incrementFenced(firstFence)).rejects.toMatchObject(
                staleFenceError()
            );
            const recoveredFence = await restarted.currentFence();

            expect(recoveredFence.epoch).toBe(firstFence.epoch + 1);
            expect(harness.recovery()?.recoveries).toBe(2);
            await expect(harness.actor.incrementFenced(firstFence)).rejects.toMatchObject(
                staleFenceError()
            );
        });

        test("rejects a fence that becomes stale while queued", async () => {
            const harness = create();
            const stale = await harness.actor.currentFence();
            const rotating = harness.actor.rotateFence();
            const queued = harness.actor.incrementFenced(stale);
            const current = await rotating;

            expect(current.epoch).toBe(stale.epoch + 1);
            await expect(queued).rejects.toMatchObject(staleFenceError());
            expect(harness.value()).toBe(0);
        });

        test("commits recovery before rolling a failed mutation back", async () => {
            const harness = create();

            await expect(harness.actor.failAfterIncrement()).rejects.toThrow(
                "Injected transaction fault"
            );

            expect(harness.value()).toBe(0);
            expect(harness.initializations()).toBe(1);
            expect(harness.recovery()?.recoveries).toBe(1);
            await expect(harness.actor.increment()).resolves.toBe(1);
            expect(harness.initializations()).toBe(1);
            expect(harness.recovery()?.recoveries).toBe(1);
        });

        test("rejects runtime thenables and rolls their transaction back", async () => {
            const harness = create();

            await expect(harness.actor.returnThenable()).rejects.toThrow(
                "Actor transaction callbacks must be synchronous"
            );

            expect(harness.value()).toBe(0);
            expect(harness.recovery()?.recoveries).toBe(1);
        });

        test("rejects unstable thenable objects before committing state", async () => {
            const harness = create();

            await expect(harness.actor.returnStatefulThenableAfterIncrement()).rejects.toThrow(
                "Actor transaction callbacks must be synchronous"
            );

            expect(harness.value()).toBe(0);
            expect(harness.recovery()?.recoveries).toBe(1);
        });

        test("revokes an escaped Promise transaction before continuation", async () => {
            const harness = create();
            const escaped = harness.actor.escapePromise();

            await expect(escaped.execution).rejects.toThrow(
                "Actor transaction callbacks must be synchronous"
            );
            await expect(escaped.lateResult()).rejects.toSatisfy(
                isOperationalError("actor.closed")
            );
            expect(harness.value()).toBe(0);
            expect(harness.recovery()?.recoveries).toBe(1);
        });

        test("[C13-ADV-COMMAND-REJECTIONS] rejects commands after close and invalidates the durable fence", async () => {
            const harness = create();
            const fence = await harness.actor.currentFence();
            const accepted = harness.actor.increment();

            const closing = harness.actor.close();
            expect(harness.actor.close()).toBe(closing);

            await expect(accepted).resolves.toBe(1);
            await closing;
            await expect(harness.actor.increment()).rejects.toMatchObject(
                new AgentCoreError("actor.closed", "Actor is closed")
            );
            expect(harness.recovery()?.epoch).toBe(fence.epoch + 1);
        });

        test("orders commands, fence reads, rotation, and close in one mailbox", async () => {
            const harness = create();
            const initial = await harness.actor.currentFence();
            const increment = harness.actor.increment();
            const beforeRotation = harness.actor.currentFence();
            const rotation = harness.actor.rotateFence();
            const afterRotation = harness.actor.currentFence();
            const closing = harness.actor.close();

            await expect(increment).resolves.toBe(1);
            expect((await beforeRotation).epoch).toBe(initial.epoch);
            expect((await rotation).epoch).toBe(initial.epoch + 1);
            expect((await afterRotation).epoch).toBe(initial.epoch + 1);
            await closing;
            expect(harness.recovery()?.epoch).toBe(initial.epoch + 2);
        });

        test("fails closed after an unknown commit and recovers on a new incarnation", async () => {
            const harness = create();
            expect(ActorCommitUnknownError.codeDependency).toEqual({
                requested: "actor.commit-unknown",
                fallback: "actor.closed"
            });
            const previousFence = await harness.actor.currentFence();
            harness.failNextCommitUnknown();

            const uncertain = harness.actor.increment();
            const queued = harness.actor.increment();

            await expect(uncertain).rejects.toEqual(
                expect.objectContaining({
                    code: "actor.closed",
                    name: "ActorCommitUnknownError"
                })
            );
            await expect(queued).rejects.toMatchObject({ code: "actor.closed" });
            expect(harness.value()).toBe(1);
            await expect(harness.actor.currentFence()).rejects.toMatchObject({
                code: "actor.closed"
            });
            const closed = harness.actor.close();
            expect(harness.actor.close()).toBe(closed);
            await expect(closed).resolves.toBeUndefined();
            await expect(harness.actor.rotateFence()).rejects.toMatchObject({
                code: "actor.closed"
            });

            const restarted = harness.restart();
            expect((await restarted.currentFence()).epoch).toBe(previousFence.epoch + 1);
            await expect(restarted.increment()).resolves.toBe(2);
        });

        test("keeps an unknown close commit poisoned after FIFO prior work", async () => {
            const harness = create();
            const previousFence = await harness.actor.currentFence();
            harness.failCommitUnknownAfter(2);
            const accepted = harness.actor.increment();
            const closing = harness.actor.close();

            expect(harness.actor.close()).toBe(closing);
            await expect(accepted).resolves.toBe(1);
            await expect(closing).rejects.toBeInstanceOf(ActorCommitUnknownError);
            expect(harness.actor.close()).toBe(closing);
            await expect(harness.actor.currentFence()).rejects.toMatchObject({
                code: "actor.closed"
            });

            const restarted = harness.restart();
            expect((await restarted.currentFence()).epoch).toBe(previousFence.epoch + 2);
            await expect(restarted.increment()).resolves.toBe(2);
        });

        test("finishes a queued close after prior work poisons the incarnation", async () => {
            const harness = create();
            const previousFence = await harness.actor.currentFence();
            harness.failNextCommitUnknown();

            const uncertain = harness.actor.increment();
            const closing = harness.actor.close();

            await expect(uncertain).rejects.toBeInstanceOf(ActorCommitUnknownError);
            await expect(closing).resolves.toBeUndefined();
            expect(harness.recovery()?.epoch).toBe(previousFence.epoch);
        });

        test("poisons trusted commit-unknown subclasses before queued commands", async () => {
            const harness = create();
            class ProtocolCommitUnknownError extends ActorCommitUnknownError {}
            harness.failNextCommitWith(new ProtocolCommitUnknownError());
            const uncertain = harness.actor.increment();
            const queued = harness.actor.increment();

            await expect(uncertain).rejects.toBeInstanceOf(ProtocolCommitUnknownError);
            await expect(queued).rejects.toMatchObject({ code: "actor.closed" });
            expect(harness.value()).toBe(1);
        });

        test("does not let lookalike errors forge poisoning", async () => {
            const harness = create();

            const lookalike = new AgentCoreError("actor.closed", "Forged unknown commit");
            lookalike.name = "ActorCommitUnknownError";
            harness.failNextCommitWith(lookalike);
            await expect(harness.actor.increment()).rejects.toBe(lookalike);
            await expect(harness.actor.increment()).resolves.toBe(2);

            harness.failNextCommitWith(noop);
            await expect(harness.actor.increment()).rejects.toBe(noop);
            await expect(harness.actor.increment()).resolves.toBe(4);
        });

        test("does not trust commit uncertainty thrown by a command callback", async () => {
            const harness = create();

            await expect(harness.actor.forgeCommitUnknown()).rejects.toEqual(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Commit uncertainty cannot originate inside an Actor transaction"
                })
            );
            await expect(harness.actor.increment()).resolves.toBe(1);
        });

        test("closes a stale incarnation without advancing the current incarnation", async () => {
            const harness = create();
            const restarted = harness.restart();
            const current = await restarted.currentFence();

            await expect(harness.actor.close()).resolves.toBeUndefined();

            expect((await restarted.currentFence()).epoch).toBe(current.epoch);
            await expect(restarted.increment()).resolves.toBe(1);
        });
    });
}

actorStoreContract("Memory", createMemoryHarness);
actorStoreContract("SQLite", createSqliteHarness);

describe("MemoryActorStore isolation", () => {
    test("reports created and recovered activation without virtual construction", () => {
        const store = new MemoryActorStore<{ starts: number }>({ starts: 0 }, structuredClone);
        const activations: ActorActivation[] = [];
        const start: ActorStartOperation<{ starts: number }> = (transaction, activation) => {
            transaction.starts += 1;
            activations.push(activation);
        };

        new StartActor(createActorContext(ACTOR_REF, store), start);
        new StartActor(createActorContext(ACTOR_REF, store), start);

        expect(activations.map((value) => value.kind)).toEqual(["created", "recovered"]);
        expect(activations.map((value) => value.recovery.recoveries)).toEqual([1, 2]);
        expect(activations.every(Object.isFrozen)).toBe(true);
        expect(store.snapshot().state.starts).toBe(2);
        expect(() => ActorActivation.created(new ActorRecoveryState(ACTOR_REF, 1, 1))).toThrow(
            /requires initial recovery state/
        );
        expect(() => ActorActivation.recovered(ActorRecoveryState.initial(ACTOR_REF))).toThrow(
            /requires recovered state/
        );
    });

    test("validates and narrows generic Actor stores without casts", () => {
        const atomic = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
        const generic: ActorStore<{ value: number }> = atomic;
        const nonAtomic = new NonActivatingActorStore<{ value: number }>(
            new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone)
        );

        expect(isActorActivationStore(generic)).toBe(true);
        if (!isActorActivationStore(generic)) {
            throw new TypeError("Expected atomic activation storage");
        }
        expect(createActorContext(ACTOR_REF, generic)).toEqual({
            actor: ACTOR_REF,
            store: atomic
        });
        expect(isActorActivationStore(nonAtomic)).toBe(false);
        expect(() => createActorContext(ACTOR_REF, nonAtomic)).toThrow(
            /requires atomic activation storage/
        );
        expect(() => Reflect.apply(createActorContext, undefined, [{}, atomic])).toThrow(
            /requires an ActorRef/
        );
    });

    test("rolls back Actor identity, recovery, and state when eager start fails", () => {
        interface State {
            starts: number;
        }
        const store = new MemoryActorStore<State>({ starts: 0 }, structuredClone);
        const failing = new ActorRef("run", new ActorId("failing-start"));

        expect(
            () =>
                new StartActor({ actor: failing, store }, (transaction) => {
                    transaction.starts += 1;
                    throw new TypeError("Injected start failure");
                })
        ).toThrow("Injected start failure");
        expect(store.snapshot()).toMatchObject({
            actor: null,
            recoveryState: null,
            state: { starts: 0 }
        });

        const replacement = new ActorRef("run", new ActorId("replacement-start"));
        expect(
            () =>
                new StartActor({ actor: replacement, store }, (transaction) => {
                    transaction.starts += 1;
                })
        ).not.toThrow();
        expect(store.snapshot()).toMatchObject({
            actor: { kind: "run", id: "replacement-start" },
            state: { starts: 1 }
        });
    });

    test("rejects a runtime thenable from eager start and rolls activation back", () => {
        const store = new MemoryActorStore<{ starts: number }>({ starts: 0 }, structuredClone);
        const thenableStart = (transaction: { starts: number }) => {
            transaction.starts += 1;
            return new Proxy(
                {},
                {
                    get: (_target, property) => (property === "then" ? noop : undefined)
                }
            );
        };

        expect(() => new StartActor({ actor: ACTOR_REF, store }, thenableStart)).toThrow(
            "Actor transaction callbacks must be synchronous"
        );
        expect(store.snapshot()).toMatchObject({
            actor: null,
            recoveryState: null,
            state: { starts: 0 }
        });
    });

    test("fails closed when an existing Actor identity has no recovery state", () => {
        const store = MemoryActorStore.restore<{ starts: number }>(
            {
                version: 1,
                state: { starts: 0 },
                actor: { kind: ACTOR_REF.kind, id: ACTOR_REF.id.value },
                recoveryState: null
            },
            structuredClone
        );

        expect(
            () =>
                new StartActor({ actor: ACTOR_REF, store }, (transaction) => {
                    transaction.starts += 1;
                })
        ).toSatisfy(throwsOperationalError("codec.invalid"));
        expect(store.snapshot().state.starts).toBe(0);
    });

    test("rejects sharing one store across different Actor identities", () => {
        const store = new MemoryActorStore({ value: 0 }, structuredClone);
        store.bindActor(new ActorRef("run", new ActorId("actor-one")));

        expect(() => store.bindActor(new ActorRef("run", new ActorId("actor-two")))).toSatisfy(
            throwsOperationalError("protocol.invalid-state")
        );
    });

    test("treats Actor kind as part of storage identity", () => {
        const id = new ActorId("same-id");
        const store = new MemoryActorStore({ value: 0 }, structuredClone);
        store.bindActor(new ActorRef("run", id));

        expect(() => store.bindActor(new ActorRef("workspace", id))).toSatisfy(
            throwsOperationalError("protocol.invalid-state")
        );
    });

    test("rejects clone functions that retain mutable state aliases", () => {
        const initial = { nested: { value: 1 } };

        expect(() => new MemoryActorStore(initial, (value) => value)).toThrow(
            /detach all mutable state/
        );
        expect(() => new MemoryActorStore(initial, (value) => ({ ...value }))).toThrow(
            /detach all mutable state/
        );
    });

    test("rejects clone functions that do not return owned object state", () => {
        expect(() => new MemoryActorStore({ value: 1 }, () => null as never)).toThrow(
            /clones must return an object/
        );
    });

    test("rejects nested transactions and recovery access outside its Actor scope", () => {
        const store = new MemoryActorStore({ value: 0 }, structuredClone);
        const other = new ActorRef("run", new ActorId("other-memory-actor"));
        store.bindActor(ACTOR_REF);

        expect(() => store.loadRecoveryState({ value: 0 }, ACTOR_REF)).toSatisfy(
            throwsOperationalError("actor.stale-callback")
        );
        store.transaction((transaction) => {
            expect(() => store.transaction(() => undefined)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
            expect(() => store.loadRecoveryState(transaction, other)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
        });
    });

    test("commits a detached draft that cannot be changed through nested references", () => {
        interface State {
            readonly nested: { value: number };
        }

        const store = new MemoryActorStore<State>({ nested: { value: 0 } }, structuredClone);
        let captured: State["nested"] | undefined;
        const returned = store.transaction((transaction) => {
            transaction.nested.value = 1;
            captured = transaction.nested;
            return transaction.nested;
        });

        returned.value = 2;
        if (captured === undefined) {
            throw new TypeError("Transaction did not capture its nested draft");
        }
        captured.value = 3;

        expect(store.snapshot().state.nested.value).toBe(1);
    });

    test("expires an escaped write transaction with a typed capability error", () => {
        const store = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
        let escaped: { value: number } | undefined;

        store.transaction((transaction) => {
            escaped = transaction;
            transaction.value = 1;
        });

        expect(() => escaped!.value).toSatisfy(throwsOperationalError("actor.closed"));
        expect(() => {
            escaped!.value = 2;
        }).toSatisfy(throwsOperationalError("actor.closed"));
        expect(store.snapshot().state.value).toBe(1);
    });

    test.each(["commit", "rollback"] as const)(
        "expires every reflective transaction capability after %s",
        (outcome) => {
            const store = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
            let escaped: object | undefined;
            const transaction = () =>
                store.transaction((scope) => {
                    escaped = scope;
                    if (outcome === "rollback") throw new TypeError("Injected transaction fault");
                });

            if (outcome === "rollback") {
                expect(transaction).toThrow("Injected transaction fault");
            } else {
                transaction();
            }

            for (const reflection of expiredTransactionReflections) {
                expect(() => reflection(escaped!)).toSatisfy(
                    throwsOperationalError("actor.closed")
                );
            }
        }
    );

    test("discards captured nested draft references after rollback", () => {
        const store = new MemoryActorStore<{ nested: { value: number } }>(
            { nested: { value: 0 } },
            structuredClone
        );
        let captured: { value: number } | undefined;

        expect(() =>
            store.transaction<void>((transaction) => {
                transaction.nested.value = 1;
                captured = transaction.nested;
                throw new TypeError("Injected transaction fault");
            })
        ).toThrow("Injected transaction fault");

        if (captured === undefined) {
            throw new TypeError("Transaction did not capture its nested draft");
        }
        captured.value = 2;
        expect(store.snapshot().state.nested.value).toBe(0);
    });

    test("exposes detached immutable reads only inside the active transaction", () => {
        interface State {
            nested: { value: number };
        }
        const store = new MemoryActorStore<State>({ nested: { value: 1 } }, structuredClone);
        let escaped: { readonly nested: { readonly value: number } } | undefined;

        expect(() => store.read({ nested: { value: 1 } }, (value) => value)).toSatisfy(
            throwsOperationalError("actor.stale-callback")
        );
        store.transaction((transaction) => {
            store.read(transaction, (view) => {
                escaped = view;
                expect(Object.isFrozen(view)).toBe(true);
                expect(Object.isFrozen(view.nested)).toBe(true);
                expect(() => {
                    view.nested.value = 2;
                }).toSatisfy(throwsOperationalError("protocol.invalid-state"));
            });
        });

        expect(store.snapshot().state.nested.value).toBe(1);
        expect(escaped?.nested.value).toBe(1);
        expect(() => {
            (escaped!.nested as { value: number }).value = 3;
        }).toSatisfy(throwsOperationalError("protocol.invalid-state"));
    });

    test("snapshots and restores detached Actor identity and recovery bytes", () => {
        interface State {
            nested: { value: number };
        }
        const actorId = new ActorId("snapshot-actor");
        const store = new MemoryActorStore<State>({ nested: { value: 1 } }, structuredClone);
        const actor = new ActorRef("run", actorId);
        store.bindActor(actor);
        store.transaction((transaction) => {
            transaction.nested.value = 2;
            store.saveRecoveryState(transaction, ActorRecoveryState.initial(actor));
        });
        const snapshot = store.snapshot();
        const restored = MemoryActorStore.restore<State>(snapshot, structuredClone);
        snapshot.state.nested.value = 9;
        snapshot.recoveryState?.fill(0);

        expect(store.snapshot().state.nested.value).toBe(2);
        expect(restored.snapshot().state.nested.value).toBe(2);
        expect(restored.snapshot().actor).toEqual({ kind: actor.kind, id: actor.id.value });
        expect(
            restored.transaction(
                (transaction) => restored.loadRecoveryState(transaction, actor)?.epoch
            )
        ).toBe(0);
    });

    test("restores a valid unbound snapshot without inventing Actor recovery", () => {
        const restored = MemoryActorStore.restore(
            {
                version: 1,
                state: { value: 3 },
                actor: null,
                recoveryState: null
            },
            structuredClone
        );

        expect(restored.snapshot()).toEqual({
            version: 1,
            state: { value: 3 },
            actor: null,
            recoveryState: null
        });
    });

    test("fails closed on malformed, future-major, and mismatched recovery snapshots", () => {
        const actorId = new ActorId("snapshot-actor");
        const actor = new ActorRef("run", actorId);
        const snapshot = (recoveryState: Uint8Array) => ({
            version: 1 as const,
            state: { value: 0 },
            actor: { kind: actor.kind, id: actor.id.value },
            recoveryState
        });
        const malformed = new TextEncoder().encode("{");
        const future = encodeCanonicalJson({
            kind: "actor.recovery-state",
            payload: { actor: { kind: actor.kind, id: actor.id.value }, epoch: 0, recoveries: 1 },
            version: { major: 2, minor: 0 }
        });
        const mismatched = ActorRecoveryState.codec.encode(
            ActorRecoveryState.initial(new ActorRef("run", new ActorId("other-actor")))
        );

        expect(() => MemoryActorStore.restore(snapshot(malformed), structuredClone)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
        expect(() => MemoryActorStore.restore(snapshot(future), structuredClone)).toSatisfy(
            throwsOperationalError("codec.unknown-major")
        );
        expect(() => MemoryActorStore.restore(snapshot(mismatched), structuredClone)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
        expect(() =>
            MemoryActorStore.restore(
                {
                    version: 1,
                    state: { value: 0 },
                    actor: null,
                    recoveryState: mismatched
                },
                structuredClone
            )
        ).toSatisfy(throwsOperationalError("codec.invalid"));
        expect(() =>
            Reflect.apply(MemoryActorStore.restore, MemoryActorStore, [
                {
                    version: 1,
                    state: null,
                    actor: null,
                    recoveryState: null
                },
                structuredClone
            ])
        ).toSatisfy(throwsOperationalError("codec.invalid"));
    });

    test("rejects shared-memory state that cannot be detached", () => {
        if (typeof SharedArrayBuffer === "undefined") return;
        const bytes = new Uint8Array(new SharedArrayBuffer(1));

        expect(() => new MemoryActorStore({ bytes }, structuredClone)).toThrow(
            /cannot contain shared memory/
        );
        expect(() =>
            MemoryActorStore.restore(
                {
                    version: 1,
                    state: { bytes },
                    actor: null,
                    recoveryState: null
                },
                structuredClone
            )
        ).toThrow(/cannot contain shared memory/);
    });

    test("traverses symbol and non-enumerable owned properties", () => {
        if (typeof SharedArrayBuffer === "undefined") return;
        const symbol = Symbol("hidden-shared-memory");
        const state = { visible: 1 } as { visible: number; [symbol]?: Uint8Array };
        Object.defineProperty(state, "hidden", {
            value: new Uint8Array(new SharedArrayBuffer(1)),
            enumerable: false
        });

        expect(() => new MemoryActorStore(state, structuredClone)).toThrow(
            /cannot contain shared memory/
        );

        const symbolic = { visible: 1 } as typeof state;
        symbolic[symbol] = new Uint8Array(new SharedArrayBuffer(1));
        expect(() => new MemoryActorStore(symbolic, structuredClone)).toThrow(
            /cannot contain shared memory/
        );
    });

    test("rejects aliases retained through symbol and non-enumerable properties", () => {
        const symbol = Symbol("hidden-alias");
        const nested = { value: 1 };
        const state = { visible: 1 } as { visible: number; [symbol]?: typeof nested };
        Object.defineProperty(state, "hidden", { value: nested, enumerable: false });
        state[symbol] = nested;

        expect(
            () =>
                new MemoryActorStore(state, (source) => {
                    const copy = { visible: source.visible } as typeof state;
                    Object.defineProperty(copy, "hidden", { value: nested, enumerable: false });
                    copy[symbol] = nested;
                    return copy;
                })
        ).toThrow(/detach all mutable state/);
    });

    test("does not exempt extensible TextId subclass state from clone ownership", () => {
        class ExtensibleId extends TextId {
            public constructor(
                value: string,
                public readonly metadata: { value: number }
            ) {
                super(value, "Extensible ID");
            }
        }
        const metadata = { value: 1 };
        const state = { id: new ExtensibleId("id", metadata) };

        expect(
            () =>
                new MemoryActorStore(state, (source) => ({
                    id: new ExtensibleId(source.id.value, source.id.metadata)
                }))
        ).toThrow(/detach all mutable state/);
    });

    test("does not treat an extensible TextId itself as an immutable leaf", () => {
        class ExtensibleId extends TextId {
            public constructor(value: string) {
                super(value, "Extensible ID");
            }
        }
        const id = new ExtensibleId("id");

        expect(() => new MemoryActorStore({ id }, (source) => ({ id: source.id }))).toThrow(
            /detach all mutable state/
        );
    });

    test("certifies only exact Revision instances as immutable leaves", () => {
        class RevisionWithPrivateState extends Revision {
            readonly #metadata = { value: 1 };

            public mutate(value: number): void {
                this.#metadata.value = value;
            }
        }
        const revision = new RevisionWithPrivateState(0);

        expect(
            () => new MemoryActorStore({ revision }, (source) => ({ revision: source.revision }))
        ).toThrow(/detach all mutable state/);
        revision.mutate(2);

        const metadata = { value: 1 };
        const counterfeit = Object.create(Revision.prototype);
        Object.defineProperty(counterfeit, "metadata", { value: metadata });
        Object.freeze(counterfeit);
        expect(
            () =>
                new MemoryActorStore({ revision: counterfeit }, (source) => ({
                    revision: source.revision
                }))
        ).toThrow(/detach all mutable state/);
    });

    test("traverses attached string, symbol, and non-enumerable TextId metadata", () => {
        class ExtensibleId extends TextId {
            public constructor(value: string) {
                super(value, "Extensible ID");
            }
        }
        const symbol = Symbol("id-metadata");
        const properties: readonly [PropertyKey, boolean][] = [
            ["metadata", true],
            [symbol, true],
            ["hidden", false]
        ];

        for (const [property, enumerable] of properties) {
            const metadata = { value: 1 };
            const id = new ExtensibleId("id");
            Object.defineProperty(id, property, { value: metadata, enumerable });

            expect(
                () =>
                    new MemoryActorStore({ id }, (source) => {
                        const copy = new ExtensibleId(source.id.value);
                        Object.defineProperty(copy, property, { value: metadata, enumerable });
                        return { id: copy };
                    })
            ).toThrow(/detach all mutable state/);
        }
    });

    test("traverses mutable metadata held by a frozen TextId subclass", () => {
        class FrozenMetadataId extends TextId {
            public constructor(
                value: string,
                public readonly metadata: { value: number }
            ) {
                super(value, "Frozen metadata ID");
                Object.freeze(this);
            }
        }
        const metadata = { value: 1 };
        const id = new FrozenMetadataId("id", metadata);

        expect(
            () =>
                new MemoryActorStore({ id }, (source) => ({
                    id: new FrozenMetadataId(source.id.value, source.id.metadata)
                }))
        ).toThrow(/detach all mutable state/);
    });

    test("detaches frozen TextIds with private, symbol, and non-enumerable state", () => {
        const symbol = Symbol("private-id-symbol");
        class FrozenPrivateId extends TextId {
            readonly #privateMetadata: { value: number };
            readonly #symbolMetadata: { value: number };
            readonly #hiddenMetadata: { value: number };

            public constructor(
                value: string,
                privateMetadata: { value: number },
                symbolMetadata: { value: number },
                hiddenMetadata: { value: number }
            ) {
                super(value, "Frozen private ID");
                this.#privateMetadata = privateMetadata;
                this.#symbolMetadata = symbolMetadata;
                this.#hiddenMetadata = hiddenMetadata;
                Object.defineProperty(this, symbol, {
                    value: symbolMetadata,
                    enumerable: true
                });
                Object.defineProperty(this, "hidden", {
                    value: hiddenMetadata,
                    enumerable: false
                });
                Object.freeze(this);
            }

            public detached(): FrozenPrivateId {
                return new FrozenPrivateId(
                    this.value,
                    structuredClone(this.#privateMetadata),
                    structuredClone(this.#symbolMetadata),
                    structuredClone(this.#hiddenMetadata)
                );
            }

            public mutate(value: number): void {
                this.#privateMetadata.value = value;
                this.#symbolMetadata.value = value;
                this.#hiddenMetadata.value = value;
            }

            public values(): readonly number[] {
                return [
                    this.#privateMetadata.value,
                    this.#symbolMetadata.value,
                    this.#hiddenMetadata.value
                ];
            }
        }
        const id = new FrozenPrivateId("id", { value: 1 }, { value: 2 }, { value: 3 });

        expect(Object.getOwnPropertyDescriptor(id, symbol)?.enumerable).toBe(true);
        expect(Object.getOwnPropertyDescriptor(id, "hidden")?.enumerable).toBe(false);
        expect(() => new MemoryActorStore({ id }, (source) => ({ id: source.id }))).toThrow(
            /detach all mutable state/
        );

        const store = new MemoryActorStore({ id }, (source) => ({ id: source.id.detached() }));
        id.mutate(4);
        expect(store.snapshot().state.id.values()).toEqual([1, 2, 3]);

        const snapshot = store.snapshot();
        snapshot.state.id.mutate(5);
        expect(store.snapshot().state.id.values()).toEqual([1, 2, 3]);
        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.id.value).toBe("id");
                expect(() => view.id.mutate(6)).toThrow(/immutable/);
            })
        );
        expect(store.snapshot().state.id.values()).toEqual([1, 2, 3]);
    });

    test("accepts detached extensible TextIds and protects their read metadata", () => {
        class ExtensibleId extends TextId {
            public constructor(
                value: string,
                public readonly metadata: { value: number }
            ) {
                super(value, "Extensible ID");
            }
        }
        const metadata = { value: 1 };
        const clone = (state: { id: ExtensibleId }): { id: ExtensibleId } => ({
            id: new ExtensibleId(state.id.value, structuredClone(state.id.metadata))
        });
        const store = new MemoryActorStore({ id: new ExtensibleId("id", metadata) }, clone);
        metadata.value = 2;

        expect(store.snapshot().state.id.metadata.value).toBe(1);
        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.id.value).toBe("id");
                expect(view.id.toString()).toBe("id");
                expect(() => {
                    view.id.metadata.value = 3;
                }).toThrow(/immutable/);
            })
        );
        expect(store.snapshot().state.id.metadata.value).toBe(1);
    });

    test("freezes ActorId only after TextId initialization", () => {
        const id = new ActorId("frozen-actor-id");

        expect(Object.isFrozen(id)).toBe(true);
        expect(() => Object.defineProperty(id, "metadata", { value: {} })).toThrow(TypeError);
    });

    test("rejects accessor and function state that cannot prove ownership", () => {
        const accessor = { visible: 1 };
        Object.defineProperty(accessor, "hidden", { get: () => ({ value: 1 }) });

        expect(() => new MemoryActorStore(accessor, (source) => source)).toThrow(
            /accessor properties|detach all mutable state/
        );
        expect(() => new MemoryActorStore({ callback: noop }, (source) => ({ ...source }))).toThrow(
            /cannot contain functions/
        );
    });

    test("makes cyclic collections, dates, and typed views immutable during reads", () => {
        interface State {
            map: Map<string, { value: number }>;
            set: Set<string>;
            date: Date;
            bytes: Uint8Array;
            self?: State;
        }
        const initial: State = {
            map: new Map([["key", { value: 1 }]]),
            set: new Set(["one"]),
            date: new Date(1_000),
            bytes: Uint8Array.of(1)
        };
        initial.self = initial;
        const store = new MemoryActorStore<State>(initial, structuredClone);

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.self).toBe(view);
                expect(() => view.map.set("other", { value: 2 })).toThrow(/immutable/);
                expect(() => (view.map.get("key")!.value = 2)).toThrow(/immutable/);
                expect(() => view.set.add("two")).toThrow(/immutable/);
                expect(() => view.date.setTime(2_000)).toThrow(/immutable/);
                expect(() => (view.bytes[0] = 2)).toThrow(/immutable/);
                expect(() => view.bytes.fill(2)).toThrow(/immutable/);
            })
        );

        const state = store.snapshot().state;
        expect(state.map.get("key")?.value).toBe(1);
        expect(state.set.has("two")).toBe(false);
        expect(state.date.getTime()).toBe(1_000);
        expect(state.bytes[0]).toBe(1);
    });

    test("preserves sparse, symbolic, and non-enumerable read state", () => {
        const symbol = Symbol("state");
        const sparse: number[] = [];
        sparse.length = 5;
        sparse[1] = 7;
        const initial = { sparse, hidden: 3, [symbol]: 4 };
        Object.defineProperty(initial, "hidden", { value: 3, enumerable: false });
        const store = new MemoryActorStore(initial, (source) => {
            const copy = { sparse: source.sparse.slice() } as typeof initial;
            Object.defineProperty(copy, "hidden", {
                value: source.hidden,
                enumerable: false
            });
            copy[symbol] = source[symbol];
            return copy;
        });

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.sparse).toHaveLength(5);
                expect(0 in view.sparse).toBe(false);
                expect(view.sparse[1]).toBe(7);
                expect(view.hidden).toBe(3);
                expect(view[symbol]).toBe(4);
            })
        );
    });

    test("preserves typed view offsets and shared backing in immutable reads", () => {
        const buffer = new ArrayBuffer(8);
        const initial = {
            first: new Uint8Array(buffer, 1, 4),
            second: new DataView(buffer, 2, 3)
        };
        const store = new MemoryActorStore<typeof initial>(initial, structuredClone);

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.first.byteOffset).toBe(1);
                expect(view.first.byteLength).toBe(4);
                expect(view.second.byteOffset).toBe(2);
                expect(view.second.byteLength).toBe(3);
                expect(view.first.buffer).toBe(view.second.buffer);
                expect(() => (view.first[0] = 1)).toThrow(/immutable/);
                expect(() => view.second.setUint8(0, 1)).toThrow(/immutable/);
            })
        );
    });

    test("permits value reads across immutable built-in wrappers", () => {
        const buffer = Uint8Array.of(1, 2, 3).buffer;
        const initial = {
            id: new ActorId("read-id"),
            revision: Revision.initial(),
            date: new Date(1_000),
            buffer,
            bytes: new Uint8Array(buffer),
            data: new DataView(buffer)
        };
        const store = new MemoryActorStore<typeof initial>(initial, (state) => {
            const clonedBuffer = state.buffer.slice(0);
            return {
                id: new ActorId(state.id.value),
                revision: state.revision,
                date: new Date(state.date),
                buffer: clonedBuffer,
                bytes: new Uint8Array(clonedBuffer),
                data: new DataView(clonedBuffer)
            };
        });

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.id.value).toBe("read-id");
                expect(view.revision.value).toBe(0);
                expect(view.date.toISOString()).toBe("1970-01-01T00:00:01.000Z");
                expect(new Uint8Array(view.buffer.slice(0))).toEqual(Uint8Array.of(1, 2, 3));
                expect(view.bytes.slice(1)).toEqual(Uint8Array.of(2, 3));
                expect(view.data.getUint8(2)).toBe(3);
                expect(() => view.buffer.valueOf()).toThrow(/immutable/);
                expect(() => view.bytes.valueOf()).toThrow(/immutable/);
            })
        );
    });

    test("rejects mutable custom class instances without an ownership contract", () => {
        class MutableBox {
            public constructor(public value: number) {}
            public increment(): void {
                this.value += 1;
            }
            public clone(): MutableBox {
                return new MutableBox(this.value);
            }
        }
        const clone = (state: { box: MutableBox }): { box: MutableBox } => ({
            box: state.box.clone()
        });
        expect(() => new MemoryActorStore({ box: new MutableBox(1) }, clone)).toThrow(
            /custom state objects must be frozen/
        );
    });

    test("detaches clone-owned custom class data from immutable reads", () => {
        class CloneOwnedBox implements ActorCloneOwnedState {
            public constructor(public readonly nested: { value: number }) {
                Object.freeze(this);
            }

            public get value(): number {
                return this.nested.value;
            }

            public increment(): void {
                this.nested.value += 1;
            }

            public [ACTOR_STATE_SNAPSHOT](): unknown {
                return { nested: this.nested };
            }
        }
        interface State {
            box: CloneOwnedBox;
        }
        const clone = (state: State): State => ({
            box: new CloneOwnedBox(structuredClone(state.box.nested))
        });
        const store = new MemoryActorStore<State>({ box: new CloneOwnedBox({ value: 1 }) }, clone);

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.box).toBeInstanceOf(CloneOwnedBox);
                expect(() => {
                    view.box.nested.value = 2;
                }).toThrow(/immutable/);
                expect(() => view.box.increment()).toThrow(/immutable/);
                expect(() => view.box.value).toThrow(/immutable/);
            })
        );

        expect(store.snapshot().state.box.nested.value).toBe(1);
    });

    test("restored Actors advance recovery once and reject the prior fence", async () => {
        interface State {
            value: number;
            initializations: number;
        }
        const operations: CounterOperations<State> = {
            initialize: (transaction) => {
                transaction.initializations += 1;
            },
            increment: (transaction) => ++transaction.value,
            value: () => 0,
            initializations: () => 0
        };
        const firstStore = new MemoryActorStore<State>(
            { value: 0, initializations: 0 },
            structuredClone
        );
        const first = new CounterActor({ actor: ACTOR_REF, store: firstStore }, operations);
        await first.increment();
        const oldFence = await first.currentFence();
        const restoredStore = MemoryActorStore.restore(firstStore.snapshot(), structuredClone);
        const restarted = new CounterActor({ actor: ACTOR_REF, store: restoredStore }, operations);

        await expect(restarted.incrementFenced(oldFence)).rejects.toMatchObject({
            code: "actor.stale-callback"
        });
        expect((await restarted.currentFence()).epoch).toBe(oldFence.epoch + 1);
        expect(
            restoredStore.transaction(
                (transaction) => restoredStore.loadRecoveryState(transaction, ACTOR_REF)?.recoveries
            )
        ).toBe(2);
    });
});

describe("SqliteActorStore recovery storage", () => {
    test("fences two live incarnations using separate stores on one database", async () => {
        const database = new TestSqlite();
        const activations: ActorActivation[] = [];
        const first = new StartActor(
            { actor: ACTOR_REF, store: new SqliteActorStore(database) },
            (_transaction, activation) => {
                activations.push(activation);
            }
        );
        const firstFence = await first.currentFence();
        const second = new StartActor(
            { actor: ACTOR_REF, store: new SqliteActorStore(database) },
            (_transaction, activation) => {
                activations.push(activation);
            }
        );
        const secondFence = await second.currentFence();

        expect(secondFence.epoch).toBe(firstFence.epoch + 1);
        await expect(first.currentFence()).rejects.toMatchObject(staleFenceError());
        await expect(first.close()).resolves.toBeUndefined();
        expect((await second.currentFence()).epoch).toBe(secondFence.epoch);
        expect(activations.map((value) => value.kind)).toEqual(["created", "recovered"]);
        expect(activations.map((value) => value.recovery.epoch)).toEqual([0, 1]);
    });

    test("rolls back SQLite identity, recovery, and state when eager start fails", () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE start_counter (value INTEGER NOT NULL)", []);
        database.run("INSERT INTO start_counter (value) VALUES (0)", []);
        const store = new SqliteActorStore(database);

        expect(
            () =>
                new StartActor({ actor: ACTOR_REF, store }, (transaction) => {
                    transaction.run("UPDATE start_counter SET value = 1", []);
                    throw new TypeError("Injected start failure");
                })
        ).toThrow("Injected start failure");

        expect(database.all("SELECT * FROM actor_identity", [])).toEqual([]);
        expect(database.all("SELECT * FROM actor_recovery_state", [])).toEqual([]);
        expect(database.all("SELECT value FROM start_counter", [])[0]?.["value"]).toBe(0);
    });

    test("fails closed when a SQLite Actor identity has no recovery state", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);

        expect(() => new StartActor({ actor: ACTOR_REF, store }, noop)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
    });

    test("does not recreate a deleted recovery row under an existing identity", () => {
        const database = new TestSqlite();
        new StartActor({ actor: ACTOR_REF, store: new SqliteActorStore(database) }, noop);
        database.run("DELETE FROM actor_recovery_state WHERE actor_kind = ? AND actor_id = ?", [
            ACTOR_REF.kind,
            ACTOR_REF.id.value
        ]);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(
                () =>
                    new StartActor(
                        { actor: ACTOR_REF, store: new SqliteActorStore(database) },
                        noop
                    )
            ).toSatisfy(throwsOperationalError("codec.invalid"));
        }
        expect(database.all("SELECT * FROM actor_identity", [])).toHaveLength(1);
        expect(database.all("SELECT * FROM actor_recovery_state", [])).toEqual([]);
    });

    test("fails closed when SQLite recovery state has no Actor identity", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        database.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)`,
            [
                ACTOR_REF.kind,
                ACTOR_REF.id.value,
                ActorRecoveryState.codec.encode(ActorRecoveryState.initial(ACTOR_REF))
            ]
        );

        expect(() => new StartActor({ actor: ACTOR_REF, store }, noop)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
        expect(database.all("SELECT * FROM actor_identity", [])).toEqual([]);
    });

    test("binds reads and recovery operations to its exact active transaction", () => {
        const firstDatabase = new TestSqlite();
        const secondDatabase = new TestSqlite();
        const first = new SqliteActorStore(firstDatabase);
        const second = new SqliteActorStore(secondDatabase);
        first.bindActor(ACTOR_REF);
        second.bindActor(ACTOR_REF);

        first.transaction((transaction) => {
            expect(() => first.transaction(() => undefined)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
            expect(() => second.read(transaction, () => undefined)).toSatisfy(
                throwsOperationalError("actor.stale-callback")
            );
            expect(() => second.loadRecoveryState(transaction, ACTOR_REF)).toSatisfy(
                throwsOperationalError("actor.stale-callback")
            );
        });
        expect(() =>
            first.saveRecoveryState(firstDatabase, ActorRecoveryState.initial(ACTOR_REF))
        ).toSatisfy(throwsOperationalError("actor.stale-callback"));
    });

    test("rejects nested Actor transactions across stores sharing one database", () => {
        const database = new TestSqlite();
        const first = new SqliteActorStore(database);
        const second = new SqliteActorStore(database);
        first.bindActor(ACTOR_REF);
        second.bindActor(ACTOR_REF);

        first.transaction(() => {
            expect(() => second.transaction(() => undefined)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
        });
    });

    test("rejects nested SQLite scope transactions and expires escaped scopes", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);
        let escapedTransaction: TransactionalSqlite | undefined;
        let escapedRead: ReadableSqlite | undefined;

        store.transaction((transaction) => {
            escapedTransaction = transaction;
            expect(() => transaction.transaction(() => undefined)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
            store.read(transaction, (read) => {
                escapedRead = read;
            });
        });

        expect(() => escapedTransaction!.all("SELECT 1", [])).toSatisfy(
            throwsOperationalError("actor.closed")
        );
        expect(() => escapedTransaction!.run("CREATE TABLE escaped (value INTEGER)", [])).toSatisfy(
            throwsOperationalError("actor.closed")
        );
        expect(() => escapedRead!.all("SELECT 1", [])).toSatisfy(
            throwsOperationalError("actor.closed")
        );
    });

    test("rejects mutation statements from SQLite read scopes", () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE read_guard (value INTEGER NOT NULL)", []);
        database.run("INSERT INTO read_guard (value) VALUES (1)", []);
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);

        store.transaction((transaction) => {
            expect(
                store.read(
                    transaction,
                    (read) => read.all("SELECT value FROM read_guard", [])[0]?.["value"]
                )
            ).toBe(1);
            expect(() =>
                store.read(transaction, (read) =>
                    read.all("UPDATE read_guard SET value = 2 RETURNING value", [])
                )
            ).toSatisfy(throwsOperationalError("protocol.invalid-state"));
            expect(() =>
                store.read(transaction, (read) =>
                    read.all("SELECT value FROM read_guard; SELECT value FROM read_guard", [])
                )
            ).toSatisfy(throwsOperationalError("protocol.invalid-state"));
        });
        expect(database.all("SELECT value FROM read_guard", [])[0]?.["value"]).toBe(1);
    });

    test("rejects malformed codec bytes", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);
        database.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)`,
            [ACTOR_REF.kind, ACTOR_ID.value, new TextEncoder().encode("{")]
        );

        expect(() =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
        ).toSatisfy(throwsOperationalError("codec.invalid"));
        expect(() => new StartActor({ actor: ACTOR_REF, store }, noop)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
    });

    test("rejects unknown-major codec bytes", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);
        const encoded = encodeCanonicalJson({
            kind: "actor.recovery-state",
            payload: {
                actor: { kind: ACTOR_REF.kind, id: ACTOR_ID.value },
                epoch: 0,
                recoveries: 1
            },
            version: { major: 2, minor: 0 }
        });
        database.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)`,
            [ACTOR_REF.kind, ACTOR_ID.value, encoded]
        );

        expect(() =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
        ).toSatisfy(throwsOperationalError("codec.unknown-major"));
    });

    test("rejects recovery rows stored under a different Actor key", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        const other = new ActorRef("run", new ActorId("other-sqlite-actor"));
        store.bindActor(ACTOR_REF);
        database.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)`,
            [
                ACTOR_REF.kind,
                ACTOR_REF.id.value,
                ActorRecoveryState.codec.encode(ActorRecoveryState.initial(other))
            ]
        );

        expect(() =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
        ).toSatisfy(throwsOperationalError("codec.invalid"));
    });

    test("rejects non-byte recovery state storage", () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);
        database.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)`,
            [ACTOR_REF.kind, ACTOR_REF.id.value, "not recovery bytes"]
        );

        expect(() =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
        ).toSatisfy(throwsOperationalError("codec.invalid"));
    });

    test("rejects Actor identity changes inside and beside an active transaction", () => {
        const database = new TestSqlite();
        const first = new SqliteActorStore(database);
        const second = new SqliteActorStore(database);
        const other = new ActorRef("run", new ActorId("other-active-actor"));
        first.bindActor(ACTOR_REF);

        first.transaction((transaction) => {
            expect(() => first.bindActor(other)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
            expect(() => first.loadRecoveryState(transaction, other)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
            expect(() => second.bindActor(ACTOR_REF)).toSatisfy(
                throwsOperationalError("protocol.invalid-state")
            );
        });
    });

    test("does not repair an incompatible pre-existing Actor schema", () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE actor_identity (singleton INTEGER PRIMARY KEY)", []);
        const store = new SqliteActorStore(database);

        expect(() => store.bindActor(ACTOR_REF)).toThrow();
        expect(database.all("SELECT singleton FROM actor_identity", [])).toEqual([]);
    });

    test("binds a SQLite database to exactly one Actor identity", () => {
        const database = new TestSqlite();
        const first = new SqliteActorStore(database);
        const second = new SqliteActorStore(database);
        first.bindActor(new ActorRef("run", new ActorId("sqlite-actor-one")));

        expect(() =>
            second.bindActor(new ActorRef("run", new ActorId("sqlite-actor-two")))
        ).toSatisfy(throwsOperationalError("protocol.invalid-state"));
    });

    test("rejects a different Actor kind with the same SQLite Actor ID", () => {
        const database = new TestSqlite();
        const first = new SqliteActorStore(database);
        const second = new SqliteActorStore(database);
        const id = new ActorId("same-sqlite-id");
        first.bindActor(new ActorRef("run", id));

        expect(() => second.bindActor(new ActorRef("workspace", id))).toSatisfy(
            throwsOperationalError("protocol.invalid-state")
        );
    });
});

function createMemoryHarness(): ActorHarness {
    interface State {
        value: number;
        initializations: number;
    }

    const store = new MemoryActorStore<State>({ value: 0, initializations: 0 }, structuredClone);
    const operations: CounterOperations<State> = {
        initialize(transaction): void {
            transaction.initializations += 1;
        },
        increment(transaction): number {
            transaction.value += 1;
            return transaction.value;
        },
        value(): number {
            return store.snapshot().state.value;
        },
        initializations(): number {
            return store.snapshot().state.initializations;
        }
    };

    return harness(new FaultingActorStore(store), operations);
}

function createSqliteHarness(): ActorHarness {
    const database = new TestSqlite();
    database.transaction(() => {
        database.run(
            `CREATE TABLE actor_counter (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                value INTEGER NOT NULL,
                initializations INTEGER NOT NULL
            )`,
            []
        );
        database.run(
            "INSERT INTO actor_counter (singleton, value, initializations) VALUES (1, 0, 0)",
            []
        );
    });

    const store = new SqliteActorStore(database);
    const operations: CounterOperations<TransactionalSqlite> = {
        initialize(transaction): void {
            transaction.run(
                "UPDATE actor_counter SET initializations = initializations + 1 WHERE singleton = 1",
                []
            );
        },
        increment(transaction): number {
            transaction.run("UPDATE actor_counter SET value = value + 1 WHERE singleton = 1", []);
            return sqliteInteger(transaction, "value");
        },
        value(): number {
            return sqliteInteger(database, "value");
        },
        initializations(): number {
            return sqliteInteger(database, "initializations");
        }
    };

    return harness(new FaultingActorStore(store), operations);
}

function harness<TTransaction>(
    store: FaultingActorStore<TTransaction>,
    operations: CounterOperations<TTransaction>
): ActorHarness {
    const createActor = (): CounterActor<TTransaction> =>
        new CounterActor({ actor: ACTOR_REF, store }, operations);
    const actor = createActor();

    return {
        actor,
        restart: createActor,
        value: operations.value,
        initializations: operations.initializations,
        failNextCommitUnknown: () => store.failNextCommitUnknown(),
        failCommitUnknownAfter: (transactions) => store.failCommitUnknownAfter(transactions),
        failNextCommitWith: (error) => store.failNextCommitWith(error),
        recovery: () =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
    };
}

class StartActor<TTransaction> extends Actor<TTransaction> {
    public constructor(
        context: ActorContext<TTransaction>,
        start: ActorStartOperation<TTransaction>
    ) {
        super(context, start);
    }
}

class FaultingActorStore<TTransaction> implements ActorActivationStore<TTransaction> {
    #failure: unknown;
    #transactionsUntilFailure = 0;

    public constructor(private readonly store: ActorActivationStore<TTransaction>) {}

    public failNextCommitUnknown(): void {
        this.failNextCommitWith(new ActorCommitUnknownError());
    }

    public failCommitUnknownAfter(transactions: number): void {
        if (!Number.isSafeInteger(transactions) || transactions < 1) {
            throw new TypeError("Fault transaction count must be a positive safe integer");
        }
        this.#failure = new ActorCommitUnknownError();
        this.#transactionsUntilFailure = transactions;
    }

    public failNextCommitWith(error: unknown): void {
        this.#failure = error;
        this.#transactionsUntilFailure = 1;
    }

    public activateActor(
        actor: ActorRef,
        start: ActorStartOperation<TTransaction>
    ): ActorRecoveryState {
        return this.store.activateActor(actor, start);
    }

    public bindActor(actor: ActorRef): void {
        this.store.bindActor(actor);
    }

    public transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        const result = this.store.transaction(operation, ...guard);
        if (this.#transactionsUntilFailure > 0) {
            this.#transactionsUntilFailure -= 1;
        }
        if (this.#transactionsUntilFailure === 0 && this.#failure !== undefined) {
            const failure = this.#failure;
            this.#failure = undefined;
            throw failure;
        }
        return result;
    }

    public loadRecoveryState(
        transaction: TTransaction,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return this.store.loadRecoveryState(transaction, actor);
    }

    public saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void {
        this.store.saveRecoveryState(transaction, state);
    }
}

class NonActivatingActorStore<TTransaction extends object> implements ActorStore<TTransaction> {
    public constructor(private readonly store: MemoryActorStore<TTransaction>) {}

    public bindActor(actor: ActorRef): void {
        this.store.bindActor(actor);
    }

    public transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        return this.store.transaction(operation, ...guard);
    }

    public loadRecoveryState(
        transaction: TTransaction,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return this.store.loadRecoveryState(transaction, actor);
    }

    public saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void {
        this.store.saveRecoveryState(transaction, state);
    }
}

function sqliteInteger(database: TransactionalSqlite, column: string): number {
    const value = database.all(`SELECT ${column} FROM actor_counter WHERE singleton = 1`, [])[0]?.[
        column
    ];
    if (typeof value !== "number") {
        throw new TypeError(`Expected numeric counter column: ${column}`);
    }
    return value;
}

function staleFenceError(): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", "Actor command fence is stale");
}

const expiredTransactionReflections: readonly ((transaction: object) => unknown)[] = [
    (transaction) => Reflect.defineProperty(transaction, "defined", { value: true }),
    (transaction) => Reflect.deleteProperty(transaction, "value"),
    (transaction) => Reflect.get(transaction, "value"),
    (transaction) => Reflect.getOwnPropertyDescriptor(transaction, "value"),
    (transaction) => Reflect.getPrototypeOf(transaction),
    (transaction) => Reflect.has(transaction, "value"),
    (transaction) => Reflect.isExtensible(transaction),
    (transaction) => Reflect.ownKeys(transaction),
    (transaction) => Reflect.preventExtensions(transaction),
    (transaction) => Reflect.set(transaction, "value", 1),
    (transaction) => Reflect.setPrototypeOf(transaction, null)
];

function throwsOperationalError(code: AgentCoreError["code"]): (action: () => unknown) => boolean {
    return (action) => {
        try {
            action();
            return false;
        } catch (error) {
            expect(error).toBeInstanceOf(AgentCoreError);
            expect(error).not.toBeInstanceOf(TypeError);
            expect((error as AgentCoreError).code).toBe(code);
            return true;
        }
    };
}

function isOperationalError(code: AgentCoreError["code"]): (error: unknown) => boolean {
    return (error) => {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as AgentCoreError).code).toBe(code);
        return true;
    };
}

function noop(): void {}
