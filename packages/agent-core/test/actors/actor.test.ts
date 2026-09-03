import { runInNewContext } from "node:vm";

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
    requireSynchronousResult,
    type ActorActivationStore,
    type ActorCloneOwnedState,
    type ActorContext,
    type ActorKind,
    type ActorStartOperation,
    type ActorStore,
    ActorFence,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { ActorRecoveryState } from "../../src/actors/fence";
import { MemoryActorStore } from "../../src/actors/store";
import { CodecDeclaration, encodeCanonicalJson, Revision, TextId } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { recordContractExecution } from "../../scripts/quality/oracle-execution-evidence.js";
import {
    SqliteActorStore,
    type ReadableSqlite,
    type TransactionalSqlite
} from "../../src/substrates";
import {
    sqliteInteger as requireSqliteInteger,
    TestSqlite as BaseTestSqlite
} from "../helpers/sqlite";

class TestSqlite extends BaseTestSqlite {
    public constructor() {
        super();
    }
}

const ACTOR_ID = new ActorId("actor-counter");
const ACTOR_REF = new ActorRef("run", ACTOR_ID);
const OTHER_ACTOR_REF = new ActorRef("workspace", new ActorId("actor-other"));
const ACTOR_KINDS: readonly ActorKind[] = ["tenant", "workspace", "run", "environment", "slate"];

/**
 * CounterActor owns no durable domain record. Actor adds its stable recovery carrier itself,
 * so an empty subclass declaration is the hostile case: a subclass cannot omit or manually
 * version bootstrap state.
 */
const COUNTER_CODECS = CodecDeclaration.empty;
const ACTOR_CODECS = CodecDeclaration.of([ActorRecoveryState.codec]);
const VERSIONED_COUNTER_CODECS = CodecDeclaration.of([
    { kind: "test.counter", version: { major: 1, minor: 1 } }
]);
const ROLLED_FORWARD_COUNTER_CODES = CodecDeclaration.of([
    { kind: "test.future", version: { major: 1, minor: 0 } }
]);
const ROLLED_FORWARD_CARRIER = CodecDeclaration.of([
    ActorRecoveryState.codec,
    ...ROLLED_FORWARD_COUNTER_CODES.declared
]);
const VERSIONED_CARRIER = CodecDeclaration.of([
    ActorRecoveryState.codec,
    ...VERSIONED_COUNTER_CODECS.declared
]);
const OLDER_MINOR_COUNTER_CODES = CodecDeclaration.of([
    { kind: "test.counter", version: { major: 1, minor: 0 } }
]);
const FOREIGN_MAJOR_COUNTER_CODES = CodecDeclaration.of([
    { kind: "test.counter", version: { major: 2, minor: 0 } }
]);
const FOREIGN_MAJOR_CARRIER = CodecDeclaration.of([
    ActorRecoveryState.codec,
    ...FOREIGN_MAJOR_COUNTER_CODES.declared
]);
const IMMUTABLE_READ_MESSAGE = "Actor read views are immutable";

/** What a clone-owned snapshot member hands back; the store must never walk into it. */
interface OwnedSnapshot {
    readonly tracked: boolean;
}
const MALFORMED_SNAPSHOT_MESSAGE = "Memory Actor snapshot is malformed";
const ASYNCHRONOUS_RESULT_MESSAGE = "Actor transaction callbacks must be synchronous";

interface CounterOperations<TTransaction> {
    initialize(transaction: TTransaction): void;
    increment(transaction: TTransaction): number;
    value(): number;
    initializations(): number;
}

interface EscapedCommand {
    readonly execution: Promise<never>;
    lateResult(): Promise<void>;
}

class CounterActor<TTransaction> extends Actor<TTransaction> {
    public constructor(
        context: ActorContext<TTransaction>,
        private readonly operations: CounterOperations<TTransaction>,
        declaration: CodecDeclaration = COUNTER_CODECS
    ) {
        super(context, declaration, (transaction) => operations.initialize(transaction));
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

    public returnThenable(): Promise<object> {
        const thenable = new Proxy(
            {},
            {
                get: (_target, property) => (property === "then" ? noop : undefined)
            }
        );
        return this.execute(() => thenable);
    }

    public returnStatefulThenableAfterIncrement(): Promise<object> {
        let reads = 0;
        return this.execute((transaction) => {
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
        const execution = this.execute((transaction): never => {
            this.operations.increment(transaction);
            late = Promise.resolve().then(() => {
                this.operations.increment(transaction);
            });
            // @ts-expect-error Runtime callbacks can violate the synchronous transaction contract.
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
    returnThenable(): Promise<object>;
    returnStatefulThenableAfterIncrement(): Promise<object>;
    escapePromise(): EscapedCommand;
    rotateFence(): Promise<ActorFence>;
    currentFence(): Promise<ActorFence>;
    close(): Promise<void>;
}

interface ActorHarness {
    readonly actor: CounterActorClient;
    restart(declaration?: CodecDeclaration): CounterActorClient;

    /** Stores raw bootstrap carrier bytes a newer release would have written. */
    declare(declaration: CodecDeclaration): void;
    declaration(): CodecDeclaration | undefined;
    value(): number;
    initializations(): number;
    recovery(): ActorRecoveryState | undefined;
    failNextCommitUnknown(): void;
    failCommitUnknownAfter(transactions: number): void;
    failNextCommitWith(error: InjectedCommitFailure): void;
    loseNextCommit(): void;
}

type InjectedCommitFailure = Error | (() => void);

type HarnessFactory = () => ActorHarness;

function actorStoreContract(name: string, create: HarnessFactory): void {
    describe(`${name} ActorStore contract`, () => {
        test(
            "runs an asynchronous mailbox outside synchronous transactions",
            { tags: "p1" },
            async () => {
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
                recordContractExecution("ActorStore contract", name);
            }
        );

        test(
            "[actor.recovery-state] recovers durable fencing state before a restarted actor serves",
            { tags: "p0" },
            async () => {
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
            }
        );

        test("rejects a fence that becomes stale while queued", { tags: "p0" }, async () => {
            const harness = create();
            const stale = await harness.actor.currentFence();
            const rotating = harness.actor.rotateFence();
            const queued = harness.actor.incrementFenced(stale);
            const current = await rotating;

            expect(current.epoch).toBe(stale.epoch + 1);
            await expect(queued).rejects.toMatchObject(staleFenceError());
            expect(harness.value()).toBe(0);
        });

        test("commits recovery before rolling a failed mutation back", { tags: "p0" }, async () => {
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

        test(
            "rejects runtime thenables and rolls their transaction back",
            { tags: "p0" },
            async () => {
                const harness = create();

                await expect(harness.actor.returnThenable()).rejects.toThrow(
                    "Actor transaction callbacks must be synchronous"
                );

                expect(harness.value()).toBe(0);
                expect(harness.recovery()?.recoveries).toBe(1);
            }
        );

        test(
            "rejects unstable thenable objects before committing state",
            { tags: "p0" },
            async () => {
                const harness = create();

                await expect(harness.actor.returnStatefulThenableAfterIncrement()).rejects.toThrow(
                    "Actor transaction callbacks must be synchronous"
                );

                expect(harness.value()).toBe(0);
                expect(harness.recovery()?.recoveries).toBe(1);
            }
        );

        test(
            "revokes an escaped Promise transaction before continuation",
            { tags: "p0" },
            async () => {
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
            }
        );

        test(
            "[C13-ADV-COMMAND-REJECTIONS] rejects commands after close and invalidates the durable fence",
            { tags: "p0" },
            async () => {
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
            }
        );

        test(
            "orders commands, fence reads, rotation, and close in one mailbox",
            { tags: "p1" },
            async () => {
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
            }
        );

        test(
            "fails closed after an unknown commit and recovers on a new incarnation",
            { tags: "p0" },
            async () => {
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
            }
        );

        // The other branch an unknown commit leaves open, and the one the design exists
        // for: the callback ran and the write was lost. A fence taken before the fault is
        // current in this branch and stale in the committed one, so an incarnation that
        // kept serving would admit on evidence that decides nothing. Closing is what makes
        // the two branches agree again, which is only observable once the fence held
        // beforehand is refused and a fresh incarnation resolves to the base state.
        test(
            "closes the incarnation when an unknown commit lost its write",
            { tags: "p0" },
            async () => {
                const harness = create();
                const previousFence = await harness.actor.currentFence();
                harness.loseNextCommit();

                const uncertain = harness.actor.increment();

                await expect(uncertain).rejects.toBeInstanceOf(ActorCommitUnknownError);
                expect(harness.value()).toBe(0);
                expect(harness.recovery()?.epoch).toBe(previousFence.epoch);
                await expect(harness.actor.incrementFenced(previousFence)).rejects.toMatchObject({
                    code: "actor.closed"
                });

                const restarted = harness.restart();
                expect((await restarted.currentFence()).epoch).toBe(previousFence.epoch + 1);
                await expect(restarted.increment()).resolves.toBe(1);
            }
        );

        test(
            "keeps an unknown close commit poisoned after FIFO prior work",
            { tags: "p0" },
            async () => {
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
            }
        );

        test(
            "finishes a queued close after prior work poisons the incarnation",
            { tags: "p1" },
            async () => {
                const harness = create();
                const previousFence = await harness.actor.currentFence();
                harness.failNextCommitUnknown();

                const uncertain = harness.actor.increment();
                const closing = harness.actor.close();

                await expect(uncertain).rejects.toBeInstanceOf(ActorCommitUnknownError);
                await expect(closing).resolves.toBeUndefined();
                expect(harness.recovery()?.epoch).toBe(previousFence.epoch);
            }
        );

        test(
            "poisons trusted commit-unknown subclasses before queued commands",
            { tags: "p0" },
            async () => {
                const harness = create();
                class ProtocolCommitUnknownError extends ActorCommitUnknownError {}
                harness.failNextCommitWith(new ProtocolCommitUnknownError());
                const uncertain = harness.actor.increment();
                const queued = harness.actor.increment();

                await expect(uncertain).rejects.toBeInstanceOf(ProtocolCommitUnknownError);
                await expect(queued).rejects.toMatchObject({ code: "actor.closed" });
                expect(harness.value()).toBe(1);
            }
        );

        test("does not let lookalike errors forge poisoning", { tags: "p0" }, async () => {
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

        test(
            "does not trust commit uncertainty thrown by a command callback",
            { tags: "p0" },
            async () => {
                const harness = create();

                await expect(harness.actor.forgeCommitUnknown()).rejects.toEqual(
                    expect.objectContaining({
                        code: "protocol.invalid-state",
                        message: "Commit uncertainty cannot originate inside an Actor transaction"
                    })
                );
                await expect(harness.actor.increment()).resolves.toBe(1);
            }
        );

        test(
            "closes a stale incarnation without advancing the current incarnation",
            { tags: "p0" },
            async () => {
                const harness = create();
                const restarted = harness.restart();
                const current = await restarted.currentFence();

                await expect(harness.actor.close()).resolves.toBeUndefined();

                expect((await restarted.currentFence()).epoch).toBe(current.epoch);
                await expect(restarted.increment()).resolves.toBe(1);
            }
        );

        test(
            "[C13-CODEC-INCOMPATIBILITY-TOTAL] adds the stable recovery carrier to an empty subclass declaration",
            { tags: "p0" },
            async () => {
                const harness = create();

                expect(harness.declaration()?.equals(ACTOR_CODECS)).toBe(true);
                await expect(harness.actor.increment()).resolves.toBe(1);

                harness.restart();

                expect(harness.declaration()?.equals(ACTOR_CODECS)).toBe(true);
                expect(harness.initializations()).toBe(2);
            }
        );

        test.each([
            [
                "an undeclared future kind",
                ROLLED_FORWARD_CARRIER,
                COUNTER_CODECS,
                ROLLED_FORWARD_COUNTER_CODES,
                "schema.unreadable"
            ],
            [
                "an unsupported minor",
                VERSIONED_CARRIER,
                OLDER_MINOR_COUNTER_CODES,
                VERSIONED_COUNTER_CODECS,
                "codec.invalid"
            ],
            [
                "an unknown major",
                FOREIGN_MAJOR_CARRIER,
                VERSIONED_COUNTER_CODECS,
                FOREIGN_MAJOR_COUNTER_CODES,
                "codec.unknown-major"
            ]
        ] as const)(
            "[C13-CODEC-INCOMPATIBILITY-TOTAL] constructs on a stable recovery carrier and refuses a set naming %s",
            async (_case, stored, reader, forwardReader, code) => {
                const harness = create();
                await expect(harness.actor.increment()).resolves.toBe(1);
                harness.declare(stored);
                const declared = harness.declaration();

                const rolledBack = harness.restart(reader);

                // The recovery carrier stayed at 1.0, so construction and fencing succeed;
                // only operations refuse the future declaration before start can decode work.
                expect(ActorRecoveryState.codec.version).toEqual({ major: 1, minor: 0 });
                expect(harness.initializations()).toBe(1);
                await expect(rolledBack.increment()).rejects.toMatchObject({ code });
                await expect(
                    rolledBack.incrementFenced(new ActorFence(ACTOR_REF, 0))
                ).rejects.toMatchObject({ code });
                await expect(rolledBack.currentFence()).rejects.toMatchObject({ code });
                await expect(rolledBack.rotateFence()).rejects.toMatchObject({ code });

                // The future carrier bytes remain addressable and unchanged; closing still
                // drains the refusing incarnation without writing a repair.
                expect(harness.value()).toBe(1);
                expect(declared?.equals(stored)).toBe(true);
                expect(harness.declaration()?.equals(stored)).toBe(true);
                await expect(rolledBack.close()).resolves.toBeUndefined();

                // A reader that understands the carrier serves it with no repair step.
                const rolledForward = harness.restart(forwardReader);

                expect(harness.initializations()).toBe(2);
                await expect(rolledForward.increment()).resolves.toBe(2);
            }
        );
    });
}

actorStoreContract("Memory", createMemoryHarness);
actorStoreContract("SQLite", createSqliteHarness);

describe("MemoryActorStore isolation", () => {
    test(
        "reports created and recovered activation without virtual construction",
        { tags: "p1" },
        () => {
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
        }
    );

    test("validates and narrows generic Actor stores without casts", { tags: "p1" }, () => {
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
        expect(() => {
            // @ts-expect-error Runtime callers can supply a non-ActorRef host value.
            createActorContext({}, atomic);
        }).toThrow(/requires an ActorRef/);
    });

    test(
        "rolls back Actor identity, recovery, and state when eager start fails",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "rejects a runtime thenable from eager start and rolls activation back",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "fails closed when an existing Actor identity has no recovery state",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] refuses a subclass that declares the stable recovery carrier itself",
        { tags: "p0" },
        () => {
            const store = new MemoryActorStore<{ starts: number }>({ starts: 0 }, structuredClone);
            const operations: CounterOperations<{ starts: number }> = {
                initialize: (transaction) => {
                    transaction.starts += 1;
                },
                increment: (transaction) => transaction.starts,
                value: () => store.snapshot().state.starts,
                initializations: () => store.snapshot().state.starts
            };

            expect(
                () => new CounterActor({ actor: ACTOR_REF, store }, operations, ACTOR_CODECS)
            ).toThrow("Actor subclasses must not declare the stable recovery carrier");
            expect(store.snapshot()).toMatchObject({
                actor: null,
                recordSetDeclaration: null,
                recoveryState: null,
                state: { starts: 0 }
            });
        }
    );

    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] commits and rolls the record-set carrier back with the activation that wrote it",
        { tags: "p0" },
        () => {
            const store = new MemoryActorStore<{ starts: number }>({ starts: 0 }, structuredClone);
            const carrier = CodecDeclaration.toBytes(VERSIONED_CARRIER);

            expect(
                () =>
                    new StartActor({ actor: ACTOR_REF, store }, (transaction) => {
                        store.saveRecordSetDeclaration(transaction, ACTOR_REF, carrier);
                        transaction.starts += 1;
                        throw new TypeError("Injected start failure");
                    })
            ).toThrow("Injected start failure");
            // The carrier is constituent Actor-store state, so the failed activation leaves
            // no declaration behind and no second owner holding one.
            expect(store.snapshot()).toMatchObject({
                actor: null,
                recordSetDeclaration: null,
                recoveryState: null,
                state: { starts: 0 }
            });

            const committed = new StartActor({ actor: ACTOR_REF, store }, (transaction) => {
                transaction.starts += 1;
            });
            const snapshot = store.snapshot();
            const committedCarrier = snapshot.recordSetDeclaration;
            if (committedCarrier === null || committedCarrier === undefined) {
                throw new TypeError("Expected a committed record-set carrier");
            }

            expect(committed).toBeInstanceOf(StartActor);
            expect(snapshot.state.starts).toBe(1);
            // Raw canonical bytes by design: a reader reaches them without decoding any
            // record of the set it is deciding compatibility for.
            expect(CodecDeclaration.fromBytes(committedCarrier).equals(ACTOR_CODECS)).toBe(true);
            expect(MemoryActorStore.restore(snapshot, structuredClone).snapshot()).toEqual(
                snapshot
            );
        }
    );

    test("rejects sharing one store across different Actor identities", { tags: "p0" }, () => {
        const store = new MemoryActorStore({ value: 0 }, structuredClone);
        store.bindActor(new ActorRef("run", new ActorId("actor-one")));

        expect(() => store.bindActor(new ActorRef("run", new ActorId("actor-two")))).toSatisfy(
            throwsOperationalError("protocol.invalid-state")
        );
    });

    test("treats Actor kind as part of storage identity", { tags: "p0" }, () => {
        const id = new ActorId("same-id");
        const store = new MemoryActorStore({ value: 0 }, structuredClone);
        store.bindActor(new ActorRef("run", id));

        expect(() => store.bindActor(new ActorRef("workspace", id))).toSatisfy(
            throwsOperationalError("protocol.invalid-state")
        );
    });

    test("rejects clone functions that retain mutable state aliases", { tags: "p0" }, () => {
        const initial = { nested: { value: 1 } };

        expect(() => new MemoryActorStore(initial, (value) => value)).toThrow(
            /detach all mutable state/
        );
        expect(() => new MemoryActorStore(initial, (value) => ({ ...value }))).toThrow(
            /detach all mutable state/
        );
    });

    test("rejects clone functions that do not return owned object state", { tags: "p0" }, () => {
        expect(
            () =>
                // @ts-expect-error Runtime clone implementations can violate their return contract.
                new MemoryActorStore({ value: 1 }, () => null)
        ).toThrow(/clones must return an object/);
    });

    test(
        "rejects nested transactions and recovery access outside its Actor scope",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "commits a detached draft that cannot be changed through nested references",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "expires an escaped write transaction with a typed capability error",
        { tags: "p0" },
        () => {
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
        }
    );

    test.each(["commit", "rollback"] as const)(
        "expires every reflective transaction capability after %s",
        { tags: "p0" },
        (outcome) => {
            const store = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
            let escaped: CounterDraft | undefined;
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

            const expired = escaped;
            if (expired === undefined) throw new TypeError("Transaction did not expose its scope");
            for (const reflection of expiredTransactionReflections)
                expect(() => reflection(expired)).toSatisfy(throwsOperationalError("actor.closed"));
        }
    );

    test("discards captured nested draft references after rollback", { tags: "p0" }, () => {
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

    test(
        "exposes detached immutable reads only inside the active transaction",
        { tags: "p0" },
        () => {
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
            const expiredRead = escaped;
            if (expiredRead === undefined)
                throw new TypeError("Read did not expose its frozen view");
            expect(() => {
                // @ts-expect-error Runtime callers can attempt to mutate a readonly view.
                expiredRead.nested.value = 3;
            }).toSatisfy(throwsOperationalError("protocol.invalid-state"));
        }
    );

    test(
        "snapshots and restores detached Actor identity and recovery bytes",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "restores a valid unbound snapshot without inventing Actor recovery",
        { tags: "p0" },
        () => {
            const restored = MemoryActorStore.restore(
                {
                    version: 1,
                    state: { value: 3 },
                    actor: null,
                    recoveryState: null
                },
                structuredClone
            );

            // A pre-carrier snapshot restores and re-emits at the current version with the
            // empty declaration, rather than being refused or preserved as a second shape.
            expect(restored.snapshot()).toEqual({
                version: 2,
                state: { value: 3 },
                actor: null,
                recordSetDeclaration: null,
                recoveryState: null
            });
        }
    );

    test(
        "fails closed on malformed, future-major, and mismatched recovery snapshots",
        { tags: "p0" },
        () => {
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
                payload: {
                    actor: { kind: actor.kind, id: actor.id.value },
                    epoch: 0,
                    recoveries: 1
                },
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
                MemoryActorStore.restore(
                    {
                        version: 1,
                        // @ts-expect-error Runtime snapshots can carry malformed state.
                        state: null,
                        actor: null,
                        recoveryState: null
                    },
                    structuredClone
                )
            ).toSatisfy(throwsOperationalError("codec.invalid"));
        }
    );

    test("rejects shared-memory state that cannot be detached", { tags: "p0" }, () => {
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

    test("traverses symbol and non-enumerable owned properties", { tags: "p0" }, () => {
        const symbol = Symbol("hidden-shared-memory");
        type HiddenSharedState = {
            visible: number;
            hidden?: Uint8Array;
            [symbol]?: Uint8Array;
        };
        const state: HiddenSharedState = { visible: 1 };
        Object.defineProperty(state, "hidden", {
            value: new Uint8Array(new SharedArrayBuffer(1)),
            enumerable: false
        });

        expect(() => new MemoryActorStore(state, structuredClone)).toThrow(
            /cannot contain shared memory/
        );

        const symbolic: HiddenSharedState = { visible: 1 };
        symbolic[symbol] = new Uint8Array(new SharedArrayBuffer(1));
        expect(() => new MemoryActorStore(symbolic, structuredClone)).toThrow(
            /cannot contain shared memory/
        );
    });

    test(
        "rejects aliases retained through symbol and non-enumerable properties",
        { tags: "p0" },
        () => {
            const symbol = Symbol("hidden-alias");
            const nested = { value: 1 };
            type HiddenAliasState = {
                visible: number;
                hidden?: typeof nested;
                [symbol]?: typeof nested;
            };
            const state: HiddenAliasState = { visible: 1 };
            Object.defineProperty(state, "hidden", { value: nested, enumerable: false });
            state[symbol] = nested;

            expect(
                () =>
                    new MemoryActorStore(state, (source) => {
                        const copy: HiddenAliasState = { visible: source.visible };
                        Object.defineProperty(copy, "hidden", { value: nested, enumerable: false });
                        copy[symbol] = nested;
                        return copy;
                    })
            ).toThrow(/detach all mutable state/);
        }
    );

    test("walks a non-callable snapshot-key value as ordinary state", { tags: "p0" }, () => {
        // The snapshot key names a method the store calls to obtain owned state.
        // Any non-callable value under that key is ordinary state: it must face the
        // same ownership and detachment walk as every other property, or forbidden
        // state hides behind the key.
        interface SnapshotKeyState {
            readonly [ACTOR_STATE_SNAPSHOT]: object;
        }
        const preserveKeys = (source: SnapshotKeyState): SnapshotKeyState =>
            Object.defineProperties(
                { [ACTOR_STATE_SNAPSHOT]: source[ACTOR_STATE_SNAPSHOT] },
                Object.getOwnPropertyDescriptors(source)
            );

        expect(
            () =>
                new MemoryActorStore<SnapshotKeyState>(
                    { [ACTOR_STATE_SNAPSHOT]: { fn: () => 1 } },
                    preserveKeys
                )
        ).toThrow(/cannot contain functions/);

        expect(
            () =>
                new MemoryActorStore<SnapshotKeyState>(
                    { [ACTOR_STATE_SNAPSHOT]: { buffer: new SharedArrayBuffer(8) } },
                    preserveKeys
                )
        ).toThrow(/cannot contain shared memory/);

        expect(
            () =>
                new MemoryActorStore<SnapshotKeyState>(
                    {
                        [ACTOR_STATE_SNAPSHOT]: Object.defineProperty({}, "reader", {
                            enumerable: true,
                            get: () => 1
                        })
                    },
                    preserveKeys
                )
        ).toThrow(/cannot contain accessor properties/);

        const shared = { value: 1 };
        expect(
            () =>
                new MemoryActorStore<SnapshotKeyState>(
                    { [ACTOR_STATE_SNAPSHOT]: shared },
                    preserveKeys
                )
        ).toThrow(/detach all mutable state/);
    });

    test(
        "does not exempt extensible TextId subclass state from clone ownership",
        { tags: "p0" },
        () => {
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
        }
    );

    test("does not treat an extensible TextId itself as an immutable leaf", { tags: "p0" }, () => {
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

    test("certifies only exact Revision instances as immutable leaves", { tags: "p0" }, () => {
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

    test(
        "traverses attached string, symbol, and non-enumerable TextId metadata",
        { tags: "p0" },
        () => {
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
        }
    );

    test("traverses mutable metadata held by a frozen TextId subclass", { tags: "p0" }, () => {
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

    test(
        "detaches frozen TextIds with private, symbol, and non-enumerable state",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "accepts detached extensible TextIds and protects their read metadata",
        { tags: "p1" },
        () => {
            class ExtensibleId extends TextId {
                public constructor(
                    value: string,
                    public readonly metadata: { value: number }
                ) {
                    super(value, "Extensible ID");
                }
            }
            const metadata = { value: 1 };
            const clone = (state: { id: ExtensibleId }) => ({
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
        }
    );

    test("freezes ActorId only after TextId initialization", { tags: "p1" }, () => {
        const id = new ActorId("frozen-actor-id");

        expect(Object.isFrozen(id)).toBe(true);
        expect(() => Object.defineProperty(id, "metadata", { value: {} })).toThrow(TypeError);
    });

    test("rejects accessor and function state that cannot prove ownership", { tags: "p0" }, () => {
        const accessor = { visible: 1 };
        Object.defineProperty(accessor, "hidden", { get: () => ({ value: 1 }) });

        expect(() => new MemoryActorStore(accessor, (source) => source)).toThrow(
            /accessor properties|detach all mutable state/
        );
        expect(() => new MemoryActorStore({ callback: noop }, (source) => ({ ...source }))).toThrow(
            /cannot contain functions/
        );
    });

    test(
        "makes cyclic collections, dates, and typed views immutable during reads",
        { tags: "p0" },
        () => {
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
        }
    );

    test("read-view dates copy without losing milliseconds", { tags: "p0" }, () => {
        interface State {
            expiresAt: Date;
        }
        const store = new MemoryActorStore<State>(
            { expiresAt: new Date(1_700_000_000_123) },
            structuredClone
        );

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                // A Proxy cannot carry the Date internal slot, so copying through
                // ToPrimitive must still preserve the exact instant: a lease expiry
                // copied via new Date(...) may never silently lose milliseconds.
                expect(new Date(view.expiresAt).getTime()).toBe(1_700_000_000_123);
                expect(view.expiresAt.getTime()).toBe(1_700_000_000_123);
                expect(Number(view.expiresAt)).toBe(1_700_000_000_123);
                expect(String(view.expiresAt)).toBe(String(new Date(1_700_000_000_123)));
            })
        );
    });

    test("preserves sparse, symbolic, and non-enumerable read state", { tags: "p1" }, () => {
        const symbol = Symbol("state");
        const sparse: number[] = [];
        sparse.length = 5;
        sparse[1] = 7;
        const initial = { sparse, hidden: 3, [symbol]: 4 };
        Object.defineProperty(initial, "hidden", { value: 3, enumerable: false });
        const store = new MemoryActorStore(initial, (source) => {
            const copy = {
                sparse: source.sparse.slice(),
                hidden: source.hidden,
                [symbol]: source[symbol]
            };
            Object.defineProperty(copy, "hidden", {
                value: source.hidden,
                enumerable: false
            });
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

    test(
        "preserves typed view offsets and shared backing in immutable reads",
        { tags: "p1" },
        () => {
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
        }
    );

    test("permits value reads across immutable built-in wrappers", { tags: "p1" }, () => {
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

    test(
        "rejects mutable custom class instances without an ownership contract",
        { tags: "p0" },
        () => {
            class MutableBox {
                public constructor(public value: number) {}
                public increment(): void {
                    this.value += 1;
                }
                public clone(): MutableBox {
                    return new MutableBox(this.value);
                }
            }
            const clone = (state: { box: MutableBox }) => ({
                box: state.box.clone()
            });
            expect(() => new MemoryActorStore({ box: new MutableBox(1) }, clone)).toThrow(
                /custom state objects must be frozen/
            );
        }
    );

    test("detaches clone-owned custom class data from immutable reads", { tags: "p0" }, () => {
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

            public [ACTOR_STATE_SNAPSHOT](): BoxSnapshot {
                return { nested: this.nested };
            }
        }
        interface BoxSnapshot {
            readonly nested: { value: number };
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

    test(
        "restored Actors advance recovery once and reject the prior fence",
        { tags: "p0" },
        async () => {
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
            const restarted = new CounterActor(
                { actor: ACTOR_REF, store: restoredStore },
                operations
            );

            await expect(restarted.incrementFenced(oldFence)).rejects.toMatchObject({
                code: "actor.stale-callback"
            });
            expect((await restarted.currentFence()).epoch).toBe(oldFence.epoch + 1);
            expect(
                restoredStore.transaction(
                    (transaction) =>
                        restoredStore.loadRecoveryState(transaction, ACTOR_REF)?.recoveries
                )
            ).toBe(2);
        }
    );
});

describe("SqliteActorStore recovery storage", () => {
    test(
        "fences two live incarnations using separate stores on one database",
        { tags: "p0" },
        async () => {
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
        }
    );

    test(
        "rolls back SQLite identity, recovery, and state when eager start fails",
        { tags: "p0" },
        () => {
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
        }
    );

    test("fails closed when a SQLite Actor identity has no recovery state", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(ACTOR_REF);

        expect(() => new StartActor({ actor: ACTOR_REF, store }, noop)).toSatisfy(
            throwsOperationalError("codec.invalid")
        );
    });

    test(
        "does not recreate a deleted recovery row under an existing identity",
        { tags: "p0" },
        () => {
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
        }
    );

    test("fails closed when SQLite recovery state has no Actor identity", { tags: "p0" }, () => {
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

    test(
        "binds reads and recovery operations to its exact active transaction",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "rejects nested Actor transactions across stores sharing one database",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "rejects nested SQLite scope transactions and expires escaped scopes",
        { tags: "p0" },
        () => {
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
            expect(() =>
                escapedTransaction!.run("CREATE TABLE escaped (value INTEGER)", [])
            ).toSatisfy(throwsOperationalError("actor.closed"));
            expect(() => escapedRead!.all("SELECT 1", [])).toSatisfy(
                throwsOperationalError("actor.closed")
            );
        }
    );

    test("rejects mutation statements from SQLite read scopes", { tags: "p0" }, () => {
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

    test("rejects malformed codec bytes", { tags: "p0" }, () => {
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

    test("rejects unknown-major codec bytes", { tags: "p0" }, () => {
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

    test("rejects recovery rows stored under a different Actor key", { tags: "p0" }, () => {
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

    test("rejects non-byte recovery state storage", { tags: "p0" }, () => {
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

    test(
        "rejects Actor identity changes inside and beside an active transaction",
        { tags: "p0" },
        () => {
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
        }
    );

    test("does not repair an incompatible pre-existing Actor schema", { tags: "p0" }, () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE actor_identity (singleton INTEGER PRIMARY KEY)", []);
        const store = new SqliteActorStore(database);

        expect(() => store.bindActor(ACTOR_REF)).toThrow();
        expect(database.all("SELECT singleton FROM actor_identity", [])).toEqual([]);
    });

    test("binds a SQLite database to exactly one Actor identity", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const first = new SqliteActorStore(database);
        const second = new SqliteActorStore(database);
        first.bindActor(new ActorRef("run", new ActorId("sqlite-actor-one")));

        expect(() =>
            second.bindActor(new ActorRef("run", new ActorId("sqlite-actor-two")))
        ).toSatisfy(throwsOperationalError("protocol.invalid-state"));
    });

    test("rejects a different Actor kind with the same SQLite Actor ID", { tags: "p0" }, () => {
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

describe("MemoryActorStore readonly view members", () => {
    test("denies every Map and Set mutator through a read view", { tags: "p0" }, () => {
        interface State {
            map: Map<string, { value: number }>;
            set: Set<string>;
        }
        const store = new MemoryActorStore<State>(
            { map: new Map([["key", { value: 1 }]]), set: new Set(["one"]) },
            structuredClone
        );
        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                const deniedCalls = [
                    () => view.map.clear(),
                    () => view.map.delete("key"),
                    () => view.map.forEach(noop),
                    () => view.map.set("other", { value: 2 }),
                    () => view.map.valueOf(),
                    () => view.set.add("two"),
                    () => view.set.clear(),
                    () => view.set.delete("one"),
                    () => view.set.forEach(noop),
                    () => view.set.valueOf()
                ];
                for (const call of deniedCalls) expect(call).toThrow(IMMUTABLE_READ_MESSAGE);

                expect(view.map.has("key")).toBe(true);
                expect(view.map.get("key")?.value).toBe(1);
                expect(view.map.size).toBe(1);
                expect([...view.map.keys()]).toEqual(["key"]);
                expect(view.set.has("one")).toBe(true);
                expect(view.set.size).toBe(1);
                expect([...view.set.values()]).toEqual(["one"]);
            })
        );

        expect(store.snapshot().state.map.get("key")?.value).toBe(1);
        expect(store.snapshot().state.set.has("one")).toBe(true);
    });

    test("denies typed array and DataView mutators through a read view", { tags: "p0" }, () => {
        interface State {
            bytes: Uint8Array;
            words: Uint16Array;
            data: DataView;
        }
        const store = new MemoryActorStore<State>(
            {
                bytes: Uint8Array.of(1, 2, 3),
                words: Uint16Array.of(7, 8, 9),
                data: new DataView(Uint8Array.of(4, 5, 6).buffer)
            },
            structuredClone
        );
        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                const deniedCalls = [
                    () => view.bytes.copyWithin(0, 1),
                    () => view.bytes.fill(0),
                    () => view.bytes.reverse(),
                    () => view.bytes.set(Uint8Array.of(0)),
                    () => view.bytes.sort(),
                    () => view.bytes.subarray(0),
                    () => view.bytes.valueOf(),
                    () => view.data.setInt8(0, 0),
                    () => view.data.setUint8(0, 0),
                    () => view.data.setInt16(0, 0),
                    () => view.data.setUint16(0, 0),
                    () => view.data.setFloat32(0, 0),
                    () => view.data.setFloat64(0, 0),
                    () => view.data.valueOf(),
                    () => view.data.toString(),
                    () => view.bytes[Symbol.iterator]()
                ];
                for (const call of deniedCalls) expect(call).toThrow(IMMUTABLE_READ_MESSAGE);

                expect(view.bytes.at(1)).toBe(2);
                expect(view.bytes.indexOf(3)).toBe(2);
                expect(view.bytes.includes(1)).toBe(true);
                expect(view.bytes.join("-")).toBe("1-2-3");
                expect(view.bytes.toString()).toBe("1,2,3");
                expect(view.bytes.slice(1)).toEqual(Uint8Array.of(2, 3));
                expect([...view.bytes.values()]).toEqual([1, 2, 3]);
                expect(view.bytes.length).toBe(3);
                expect(view.bytes.byteLength).toBe(3);

                expect(view.words.length).toBe(3);
                expect(view.words.at(2)).toBe(9);
                expect(view.words.byteLength).toBe(6);

                expect(view.data.getUint8(0)).toBe(4);
                expect(view.data.getUint16(1)).toBe(0x0506);
                expect(view.data.byteLength).toBe(3);

                expect(view.bytes.buffer.byteLength).toBe(3);
                expect(() => view.bytes.buffer.valueOf()).toThrow(IMMUTABLE_READ_MESSAGE);
                expect(new Uint8Array(view.bytes.buffer.slice(0))).toEqual(Uint8Array.of(1, 2, 3));
            })
        );
    });

    test(
        "refuses a Date member the read view does not declare, even one the host adds",
        { tags: "p0" },
        () => {
            // The rule this replaces admitted any Date member whose name did not begin
            // with `set`, which is a fact about how ECMA-262 spells its mutators rather
            // than anything declared here. A host-added mutator under any other name was
            // handed out bound to the live Date and wrote straight through the read view.
            const advance = function advance(this: Date): void {
                this.setUTCFullYear(this.getUTCFullYear() + 1);
            };
            Object.defineProperty(Date.prototype, "advance", {
                configurable: true,
                value: advance,
                writable: true
            });
            try {
                const instant = new Date("2024-01-01T00:00:00.000Z");
                const store = new MemoryActorStore<{ at: Date }>({ at: instant }, structuredClone);

                store.transaction((transaction) =>
                    store.read(transaction, (view) => {
                        expect(view.at.getTime()).toBe(instant.getTime());
                        expect(view.at.toISOString()).toBe("2024-01-01T00:00:00.000Z");
                        expect(() => view.at.setUTCFullYear(2030)).toThrow(IMMUTABLE_READ_MESSAGE);
                        // SAFETY: the host-added member is deliberately outside Date's
                        // declared type, so reaching it is what the assertion is about.
                        const advanced = view.at as Date & { readonly advance: () => void };
                        expect(() => advanced.advance()).toThrow(IMMUTABLE_READ_MESSAGE);
                    })
                );

                expect(store.snapshot().state.at.toISOString()).toBe("2024-01-01T00:00:00.000Z");
            } finally {
                Reflect.deleteProperty(Date.prototype, "advance");
            }
        }
    );

    test("refuses a DataView reader the read view does not declare", { tags: "p0" }, () => {
        // The replaced rule admitted any DataView member whose name began with `get`,
        // so a host-added accessor returning the live backing buffer escaped the copy
        // the read view exists to hand out.
        const getBackingBuffer = function getBackingBuffer(this: DataView): ArrayBuffer {
            // SAFETY: the probe is built over a DataView this test constructed on an
            // ArrayBuffer, so the backing buffer is never a SharedArrayBuffer here.
            return this.buffer as ArrayBuffer;
        };
        Object.defineProperty(DataView.prototype, "getBackingBuffer", {
            configurable: true,
            value: getBackingBuffer,
            writable: true
        });
        try {
            const store = new MemoryActorStore<{ data: DataView }>(
                { data: new DataView(Uint8Array.of(9, 8, 7).buffer) },
                structuredClone
            );

            store.transaction((transaction) =>
                store.read(transaction, (view) => {
                    expect(view.data.getUint8(0)).toBe(9);
                    // SAFETY: the host-added reader is deliberately outside DataView's
                    // declared type, so reaching it is what the assertion is about.
                    const leaky = view.data as DataView & {
                        readonly getBackingBuffer: () => ArrayBuffer;
                    };
                    expect(() => leaky.getBackingBuffer()).toThrow(IMMUTABLE_READ_MESSAGE);
                })
            );
        } finally {
            Reflect.deleteProperty(DataView.prototype, "getBackingBuffer");
        }
    });

    test("keeps plain arrays array-like through read views", { tags: "p1" }, () => {
        const store = new MemoryActorStore<{ list: number[] }>(
            { list: [1, 2, 3] },
            structuredClone
        );

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(Array.isArray(view.list)).toBe(true);
                expect(view.list.map((value) => value + 1)).toEqual([2, 3, 4]);
                expect([...view.list]).toEqual([1, 2, 3]);
                expect(view.list.length).toBe(3);
            })
        );
    });

    test("exposes data members and denies behavior through read views", { tags: "p0" }, () => {
        class ReadBox implements ActorCloneOwnedState {
            public readonly length = 3;

            public constructor(public readonly nested: { value: number }) {
                Object.freeze(this);
            }

            public get doubled(): number {
                return this.nested.value * 2;
            }

            public describe(): string {
                return `box:${this.nested.value}`;
            }

            public [ACTOR_STATE_SNAPSHOT](): ReadBoxSnapshot {
                return { nested: this.nested };
            }
        }
        interface ReadBoxSnapshot {
            readonly nested: { value: number };
        }
        class ReadId extends TextId {
            public constructor(
                value: string,
                public readonly metadata: { value: number }
            ) {
                super(value, "Read ID");
            }

            public get label(): string {
                return `id:${this.value}`;
            }
        }
        interface State {
            box: ReadBox;
            id: ReadId;
            items: number[];
            plain: { value: number };
            when: Date;
        }
        const store = new MemoryActorStore<State>(
            {
                box: new ReadBox({ value: 1 }),
                id: new ReadId("read-id", { value: 5 }),
                items: [1, 2, 3],
                plain: { value: 7 },
                when: new Date(1_000)
            },
            (state) => ({
                box: new ReadBox({ ...state.box.nested }),
                id: new ReadId(state.id.value, { ...state.id.metadata }),
                items: state.items.slice(),
                plain: { ...state.plain },
                when: new Date(state.when.getTime())
            })
        );

        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.box).toBeInstanceOf(ReadBox);
                expect(view.box.nested.value).toBe(1);
                expect(view.box.length).toBe(3);
                expect(() => view.box.describe()).toThrow(IMMUTABLE_READ_MESSAGE);
                expect(() => view.box.doubled).toThrow(IMMUTABLE_READ_MESSAGE);
                // @ts-expect-error Missing members exercise the runtime read boundary.
                expect(view.box.missing).toBeUndefined();

                expect(view.id.value).toBe("read-id");
                expect(view.id.toString()).toBe("read-id");
                expect(view.id.equals(new ReadId("read-id", { value: 5 }))).toBe(true);
                expect(view.id.metadata.value).toBe(5);
                expect(() => view.id.label).toThrow(IMMUTABLE_READ_MESSAGE);
                // @ts-expect-error Missing members exercise the runtime read boundary.
                expect(view.id.missing).toBeUndefined();

                expect(Array.isArray(view.items)).toBe(true);
                expect(view.items.length).toBe(3);
                expect(view.items.indexOf(2)).toBe(1);

                expect(view.plain.value).toBe(7);
                expect(view.plain.toString()).toBe("[object Object]");
                expect(
                    () =>
                        // @ts-expect-error Prototype access exercises the runtime read boundary.
                        view.plain.__proto__
                ).toThrow(IMMUTABLE_READ_MESSAGE);

                expect(view.when.getTime()).toBe(1_000);
                // @ts-expect-error Missing members exercise the runtime read boundary.
                expect(view.when.missing).toBeUndefined();
            })
        );
    });
});

describe("MemoryActorStore snapshot and transaction guards", () => {
    test("rejects every malformed Memory Actor snapshot shape", { tags: "p0" }, () => {
        const hostile: readonly unknown[] = [
            null,
            undefined,
            5,
            "snapshot",
            Object.assign(() => undefined, {
                version: 1,
                state: { value: 0 },
                actor: null,
                recoveryState: null
            }),
            {},
            { version: 1, state: { value: 0 }, actor: null },
            { version: 1, state: { value: 0 }, actor: null, recoveryState: null, extra: 1 },
            { version: 2, state: { value: 0 }, actor: null, recoveryState: null },
            { version: 1, state: null, actor: null, recoveryState: null },
            { version: 1, state: 5, actor: null, recoveryState: null },
            { version: 1, state: { value: 0 }, actor: null, recoveryState: "bytes" },
            { version: 1, state: { value: 0 }, actor: "run", recoveryState: null },
            { version: 1, state: { value: 0 }, actor: [], recoveryState: null },
            { version: 1, state: { value: 0 }, actor: {}, recoveryState: null },
            { version: 1, state: { value: 0 }, actor: { kind: "run" }, recoveryState: null },
            { version: 1, state: { value: 0 }, actor: { id: "actor" }, recoveryState: null },
            {
                version: 1,
                state: { value: 0 },
                actor: { kind: "run", id: "actor", extra: 1 },
                recoveryState: null
            },
            { version: 1, state: { value: 0 }, actor: { kind: "run", id: 5 }, recoveryState: null }
        ];

        for (const snapshot of hostile) {
            expectOperationalFailure(
                () => {
                    // @ts-expect-error Host snapshots reach restore before static validation.
                    MemoryActorStore.restore(snapshot, structuredClone);
                },
                "codec.invalid",
                MALFORMED_SNAPSHOT_MESSAGE
            );
        }
    });

    test("restores snapshots for every Actor kind and rejects the rest", { tags: "p0" }, () => {
        for (const kind of ACTOR_KINDS) {
            const restored = MemoryActorStore.restore<{ value: number }>(
                {
                    version: 1,
                    state: { value: 1 },
                    actor: { kind, id: `actor-${kind}` },
                    recoveryState: null
                },
                structuredClone
            );

            expect(restored.snapshot().actor).toEqual({ kind, id: `actor-${kind}` });
        }

        for (const kind of ["", "Run", "tenants", "unknown", 5, null]) {
            expectOperationalFailure(
                () => {
                    MemoryActorStore.restore(
                        {
                            version: 1,
                            state: { value: 1 },
                            // @ts-expect-error Runtime snapshots can carry a non-Actor kind.
                            actor: { kind, id: "actor" },
                            recoveryState: null
                        },
                        structuredClone
                    );
                },
                "codec.invalid",
                MALFORMED_SNAPSHOT_MESSAGE
            );
        }
    });

    test("names every corrupt Actor recovery snapshot failure", { tags: "p0" }, () => {
        const other = new ActorRef("run", new ActorId("other-snapshot-actor"));
        const bytes = ActorRecoveryState.codec.encode(ActorRecoveryState.initial(other));

        expectOperationalFailure(
            () =>
                MemoryActorStore.restore(
                    { version: 1, state: { value: 0 }, actor: null, recoveryState: bytes },
                    structuredClone
                ),
            "codec.invalid",
            "Unbound Actor snapshots cannot contain bootstrap state"
        );
        expectOperationalFailure(
            () =>
                MemoryActorStore.restore(
                    {
                        version: 1,
                        state: { value: 0 },
                        actor: { kind: ACTOR_REF.kind, id: ACTOR_REF.id.value },
                        recoveryState: bytes
                    },
                    structuredClone
                ),
            "codec.invalid",
            "Actor snapshot recovery state belongs to a different Actor"
        );

        const missing = MemoryActorStore.restore<{ starts: number }>(
            {
                version: 1,
                state: { starts: 0 },
                actor: { kind: ACTOR_REF.kind, id: ACTOR_REF.id.value },
                recoveryState: null
            },
            structuredClone
        );
        expectOperationalFailure(
            () =>
                new StartActor({ actor: ACTOR_REF, store: missing }, (transaction) => {
                    transaction.starts += 1;
                }),
            "codec.invalid",
            "Existing Actor storage is missing recovery state"
        );
    });

    test("binds Memory reads and recovery state to the active transaction", { tags: "p0" }, () => {
        const store = new MemoryActorStore<{ value: number }>({ value: 1 }, structuredClone);
        const foreign = { value: 1 };
        store.bindActor(ACTOR_REF);

        store.transaction((transaction) => {
            expectOperationalFailure(
                () => store.read(foreign, (view) => view.value),
                "actor.stale-callback",
                "Actor reads require the active transaction"
            );
            expectOperationalFailure(
                () => store.loadRecoveryState(foreign, ACTOR_REF),
                "actor.stale-callback",
                "Actor recovery state requires an active transaction"
            );
            expectOperationalFailure(
                () => store.saveRecoveryState(foreign, ActorRecoveryState.initial(ACTOR_REF)),
                "actor.stale-callback",
                "Actor recovery state requires an active transaction"
            );
            expect(store.read(transaction, (view) => view.value)).toBe(1);
        });

        expectOperationalFailure(
            () => store.read(foreign, (view) => view.value),
            "actor.stale-callback",
            "Actor reads require the active transaction"
        );

        const unbound = new MemoryActorStore<{ value: number }>({ value: 1 }, structuredClone);
        unbound.transaction((transaction) => {
            expectOperationalFailure(
                () => unbound.loadRecoveryState(transaction, ACTOR_REF),
                "actor.stale-callback",
                "Actor recovery state requires an active transaction"
            );
        });
    });

    test("keeps reads stale-callback outside any transaction", { tags: "p0" }, () => {
        const store = new MemoryActorStore<{ value: number }>({ value: 1 }, structuredClone);

        expectOperationalFailure(
            () => {
                // @ts-expect-error Runtime callers can omit the active transaction.
                store.read(undefined, (view) => view.value);
            },
            "actor.stale-callback",
            "Actor reads require the active transaction"
        );
    });

    test("rejects a second Actor identity bound inside a transaction", { tags: "p0" }, () => {
        const store = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);

        store.transaction(() => {
            store.bindActor(ACTOR_REF);
            expectOperationalFailure(
                () => store.bindActor(OTHER_ACTOR_REF),
                "protocol.invalid-state",
                "An ActorStore cannot be shared by different Actors"
            );
        });

        expect(store.snapshot().actor).toEqual({ kind: ACTOR_REF.kind, id: ACTOR_REF.id.value });
    });

    test("expires escaped transaction scopes with a named error", { tags: "p0" }, () => {
        const store = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
        let escaped: { value: number } | undefined;

        store.transaction((transaction) => {
            escaped = transaction;
            transaction.value = 1;
        });

        const expired = escaped;
        if (expired === undefined) throw new TypeError("Transaction did not capture its scope");
        expectOperationalFailure(
            () => expired.value,
            "actor.closed",
            "Actor transaction is no longer active"
        );
        expectOperationalFailure(
            () => {
                expired.value = 2;
            },
            "actor.closed",
            "Actor transaction is no longer active"
        );
        expect(store.snapshot().state.value).toBe(1);
    });

    test("requires initial and recovered activation states", { tags: "p1" }, () => {
        expect(() => ActorActivation.created(new ActorRecoveryState(ACTOR_REF, 1, 1))).toThrow(
            "Created Actor activation requires initial recovery state"
        );
        expect(() => ActorActivation.created(new ActorRecoveryState(ACTOR_REF, 0, 2))).toThrow(
            "Created Actor activation requires initial recovery state"
        );
        expect(() => ActorActivation.recovered(ActorRecoveryState.initial(ACTOR_REF))).toThrow(
            "Recovered Actor activation requires recovered state"
        );
        expect(ActorActivation.created(ActorRecoveryState.initial(ACTOR_REF)).kind).toBe("created");
        expect(ActorActivation.recovered(new ActorRecoveryState(ACTOR_REF, 1, 2)).kind).toBe(
            "recovered"
        );
    });

    test("rejects thenable and unstable transaction results", { tags: "p0" }, () => {
        let caught = 0;
        class ObservedPromise<T> extends Promise<T> {
            public override catch: Promise<T>["catch"] = (onRejected) => {
                caught += 1;
                return super.catch(onRejected);
            };
        }
        const observed = ObservedPromise.resolve(1);
        expect(observed).toBeInstanceOf(Promise);
        expect(() => requireSynchronousResult(observed)).toThrow(ASYNCHRONOUS_RESULT_MESSAGE);
        expect(caught).toBe(1);

        // oxlint-disable unicorn/no-thenable -- hostile fixtures for the synchronous-result guard
        const inheritedThenable = {};
        Object.setPrototypeOf(inheritedThenable, { then: noop });
        const asynchronous: readonly object[] = [
            Promise.resolve(1),
            Object.defineProperty({}, "then", { value: noop }),
            Object.defineProperty({}, "then", { value: 1 }),
            Object.defineProperty(() => undefined, "then", { value: noop }),
            inheritedThenable,
            new Proxy({}, {})
        ];
        // oxlint-enable unicorn/no-thenable
        for (const value of asynchronous) {
            expect(() => requireSynchronousResult(value)).toThrow(ASYNCHRONOUS_RESULT_MESSAGE);
        }

        let foreignCatches = 0;
        const foreignPromise: unknown = runInNewContext(
            `class ObservedPromise extends Promise {
                catch(onRejected) {
                    observeCatch();
                    return super.catch(onRejected);
                }
            }
            new ObservedPromise((_resolve, reject) => reject(new TypeError("foreign rejection")))`,
            { observeCatch: () => (foreignCatches += 1) }
        );
        const foreignOwnThenable: unknown = runInNewContext("({ then() {} })");
        const foreignInheritedThenable: unknown = runInNewContext("Object.create({ then() {} })");
        const foreignFunctionThenable: unknown = runInNewContext(
            "Object.assign(function value() {}, { then() {} })"
        );
        const foreignProxy: unknown = runInNewContext("new Proxy({}, {})");

        for (const value of [
            foreignPromise,
            foreignOwnThenable,
            foreignInheritedThenable,
            foreignFunctionThenable,
            foreignProxy
        ]) {
            expect(() => requireSynchronousResult(value)).toThrow(ASYNCHRONOUS_RESULT_MESSAGE);
        }
        expect(foreignCatches).toBe(1);

        const synchronous: readonly unknown[] = [
            null,
            undefined,
            0,
            "sync",
            false,
            {},
            [],
            noop,
            new Date(0)
        ];
        for (const value of synchronous) {
            expect(requireSynchronousResult(value)).toBe(value);
        }
    });
});

describe("MemoryActorStore ownership walk", () => {
    test("detects clone aliases behind every owned child edge", { tags: "p0" }, () => {
        const alias = "Memory Actor clones must detach all mutable state";
        const entry = { value: 1 };
        const key = { id: 1 };

        expect(
            () =>
                new MemoryActorStore({ map: new Map([["key", entry]]) }, (source) => ({
                    map: new Map(source.map)
                }))
        ).toThrow(alias);
        expect(
            () =>
                new MemoryActorStore({ map: new Map([[key, "entry"]]) }, (source) => ({
                    map: new Map(source.map)
                }))
        ).toThrow(alias);
        expect(
            () =>
                new MemoryActorStore({ set: new Set([entry]) }, (source) => ({
                    set: new Set(source.set)
                }))
        ).toThrow(alias);
        expect(
            () =>
                new MemoryActorStore({ bytes: Uint8Array.of(1, 2, 3) }, (source) => ({
                    bytes: new Uint8Array(source.bytes.buffer)
                }))
        ).toThrow(alias);
    });

    test("detects aliases reachable only through clone-owned snapshots", { tags: "p0" }, () => {
        interface NestedValue {
            value: number;
        }
        class PrivateBox implements ActorCloneOwnedState {
            readonly #nested: NestedValue;

            public constructor(nested: NestedValue) {
                this.#nested = nested;
                Object.freeze(this);
            }

            public alias(): PrivateBox {
                return new PrivateBox(this.#nested);
            }

            public detached(): PrivateBox {
                return new PrivateBox({ ...this.#nested });
            }

            public value(): number {
                return this.#nested.value;
            }

            public [ACTOR_STATE_SNAPSHOT](): NestedValue {
                return this.#nested;
            }
        }

        expect(
            () =>
                new MemoryActorStore({ box: new PrivateBox({ value: 1 }) }, (source) => ({
                    box: source.box.alias()
                }))
        ).toThrow("Memory Actor clones must detach all mutable state");

        const store = new MemoryActorStore({ box: new PrivateBox({ value: 1 }) }, (source) => ({
            box: source.box.detached()
        }));
        expect(store.snapshot().state.box.value()).toBe(1);
    });

    test("keeps clone-owned snapshot members out of the state graph", { tags: "p0" }, () => {
        interface State {
            readonly value: number;
            [ACTOR_STATE_SNAPSHOT](): OwnedSnapshot;
        }
        const owned = (): OwnedSnapshot => ({ tracked: true });
        const store = new MemoryActorStore<State>(
            { value: 1, [ACTOR_STATE_SNAPSHOT]: owned },
            (state) => ({ value: state.value, [ACTOR_STATE_SNAPSHOT]: owned })
        );

        expect(store.snapshot().state.value).toBe(1);
        store.transaction((transaction) =>
            store.read(transaction, (view) => {
                expect(view.value).toBe(1);
                expect(() => view[ACTOR_STATE_SNAPSHOT]()).toThrow(IMMUTABLE_READ_MESSAGE);
            })
        );
    });

    test("detects aliases held beside a callable snapshot key", { tags: "p0" }, () => {
        const owned = (): OwnedSnapshot => ({ tracked: true });

        expect(
            () =>
                new MemoryActorStore(
                    { nested: { value: 1 }, [ACTOR_STATE_SNAPSHOT]: owned },
                    (source) => ({ nested: source.nested, [ACTOR_STATE_SNAPSHOT]: owned })
                )
        ).toThrow("Memory Actor clones must detach all mutable state");

        const store = new MemoryActorStore(
            { nested: { value: 1 }, [ACTOR_STATE_SNAPSHOT]: owned },
            (source) => ({ nested: { ...source.nested }, [ACTOR_STATE_SNAPSHOT]: owned })
        );
        expect(store.snapshot().state.nested.value).toBe(1);
    });

    test("requires custom state objects to be frozen and clone-owned", { tags: "p0" }, () => {
        const message = "Memory Actor custom state objects must be frozen and clone-owned";
        class FrozenBox {
            public constructor(public readonly value: number) {
                Object.freeze(this);
            }
        }
        class UnfrozenBox implements ActorCloneOwnedState {
            public constructor(public readonly nested: { value: number }) {}

            public [ACTOR_STATE_SNAPSHOT](): BoxSnapshot {
                return { nested: this.nested };
            }
        }
        interface BoxSnapshot {
            readonly nested: { value: number };
        }

        expect(
            () =>
                new MemoryActorStore({ box: new FrozenBox(1) }, (source) => ({
                    box: new FrozenBox(source.box.value)
                }))
        ).toThrow(message);
        expect(
            () =>
                new MemoryActorStore({ box: new UnfrozenBox({ value: 1 }) }, (source) => ({
                    box: new UnfrozenBox({ ...source.box.nested })
                }))
        ).toThrow(message);
    });

    test(
        "accepts null-prototype state objects without an ownership contract",
        { tags: "p1" },
        () => {
            const bare = (value: number) => {
                const state = { value };
                Object.setPrototypeOf(state, null);
                return state;
            };
            const store = new MemoryActorStore({ bare: bare(1) }, (source) => ({
                bare: bare(source.bare.value)
            }));

            expect(store.snapshot().state.bare.value).toBe(1);
            store.transaction((transaction) =>
                store.read(transaction, (view) => {
                    expect(view.bare.value).toBe(1);
                })
            );
        }
    );

    test("rejects state the store cannot prove it owns", { tags: "p0" }, () => {
        const accessor = { visible: 1 };
        Object.defineProperty(accessor, "hidden", { get: () => ({ value: 1 }) });

        expect(() => new MemoryActorStore(accessor, (source) => ({ ...source }))).toThrow(
            "Memory Actor state cannot contain accessor properties"
        );
        expect(() => new MemoryActorStore({ callback: noop }, (source) => ({ ...source }))).toThrow(
            "Memory Actor state cannot contain functions"
        );
        expect(
            () =>
                // @ts-expect-error Runtime clone implementations can return null.
                new MemoryActorStore({ value: 1 }, () => null)
        ).toThrow("Memory Actor clones must return an object");
        expect(
            () =>
                // @ts-expect-error Runtime clone implementations can return primitives.
                new MemoryActorStore({ value: 1 }, () => 5)
        ).toThrow("Memory Actor clones must return an object");
        expect(
            () =>
                new MemoryActorStore(
                    { bytes: new Uint8Array(new SharedArrayBuffer(1)) },
                    (source) => structuredClone(source)
                )
        ).toThrow("Memory Actor state cannot contain shared memory");
        expect(
            () => new MemoryActorStore({ buffer: new SharedArrayBuffer(1) }, (source) => source)
        ).toThrow("Memory Actor state cannot contain shared memory");
    });
});

describe("Actor mailbox admission and commit poisoning", () => {
    test("rejects commands without entering the mailbox once closing", { tags: "p1" }, async () => {
        const harness = createMemoryHarness();
        const order: string[] = [];
        const closing = harness.actor.close().then(() => {
            order.push("close");
        });
        const command = harness.actor.increment();
        const settled = command.catch(() => {
            order.push("command");
        });

        await Promise.all([closing, settled]);

        expect(order).toEqual(["command", "close"]);
        await expect(command).rejects.toSatisfy(isOperationalError("actor.closed"));
        await expect(command).rejects.toThrow("Actor is closed");
    });

    test("closes a poisoned Actor without re-entering the mailbox", { tags: "p1" }, async () => {
        const harness = createMemoryHarness();
        harness.failNextCommitUnknown();

        await expect(harness.actor.increment()).rejects.toBeInstanceOf(ActorCommitUnknownError);
        await expect(harness.actor.currentFence()).rejects.toThrow("Actor is closed");

        let settled = false;
        const closing = harness.actor.close().then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(true);
        await closing;
    });

    test("advances the durable fence exactly once when closing", { tags: "p1" }, async () => {
        const harness = createMemoryHarness();
        const fence = await harness.actor.currentFence();

        await expect(harness.actor.close()).resolves.toBeUndefined();

        expect(harness.recovery()?.epoch).toBe(fence.epoch + 1);
    });

    test("rejects fence reads after a completed close", { tags: "p0" }, async () => {
        const harness = createMemoryHarness();

        await expect(harness.actor.close()).resolves.toBeUndefined();

        await expect(harness.actor.currentFence()).rejects.toMatchObject(
            new AgentCoreError("actor.closed", "Actor is closed")
        );
    });

    test("propagates non-stale faults raised while closing", { tags: "p1" }, async () => {
        const harness = createMemoryHarness();
        harness.failNextCommitWith(new TypeError("Injected close failure"));

        await expect(harness.actor.close()).rejects.toThrow("Injected close failure");
    });

    test(
        "keeps the incarnation open when a store refuses before its callback",
        { tags: "p1" },
        async () => {
            interface State {
                value: number;
                initializations: number;
            }
            const memory = new MemoryActorStore<State>(
                { value: 0, initializations: 0 },
                structuredClone
            );
            const refusing = new RefusingActorStore(memory);
            const actor = new CounterActor<State>(
                { actor: ACTOR_REF, store: refusing },
                {
                    initialize: (transaction) => {
                        transaction.initializations += 1;
                    },
                    increment: (transaction) => {
                        transaction.value += 1;
                        return transaction.value;
                    },
                    value: () => memory.snapshot().state.value,
                    initializations: () => memory.snapshot().state.initializations
                }
            );
            refusing.refuseNextTransaction();

            await expect(actor.increment()).rejects.toBeInstanceOf(ActorCommitUnknownError);
            await expect(actor.increment()).resolves.toBe(1);
        }
    );

    test("poisons an incarnation only for trusted commit uncertainty", { tags: "p0" }, async () => {
        expect(new ActorCommitUnknownError().message).toBe(
            "The Actor transaction commit result is unknown"
        );

        const poisoned = createMemoryHarness();
        poisoned.failNextCommitUnknown();
        await expect(poisoned.actor.increment()).rejects.toBeInstanceOf(ActorCommitUnknownError);
        await expect(poisoned.actor.increment()).rejects.toSatisfy(
            isOperationalError("actor.closed")
        );

        const harness = createMemoryHarness();
        const lookalike = new AgentCoreError("actor.closed", "Forged unknown commit");
        harness.failNextCommitWith(lookalike);
        await expect(harness.actor.increment()).rejects.toBe(lookalike);
        await expect(harness.actor.increment()).resolves.toBe(2);
        await expect(harness.actor.failAfterIncrement()).rejects.toThrow(
            "Injected transaction fault"
        );
        await expect(harness.actor.forgeCommitUnknown()).rejects.toThrow(
            "Commit uncertainty cannot originate inside an Actor transaction"
        );
        await expect(harness.actor.increment()).resolves.toBe(3);
    });

    test("refuses unfenced commands from a superseded incarnation", { tags: "p0" }, async () => {
        const harness = createMemoryHarness();
        const stale = await harness.actor.currentFence();
        const restarted = harness.restart();

        expect((await restarted.currentFence()).epoch).toBe(stale.epoch + 1);
        await expect(harness.actor.increment()).rejects.toThrow("Actor command fence is stale");
        await expect(harness.actor.currentFence()).rejects.toThrow("Actor command fence is stale");
        expect(harness.value()).toBe(0);
    });

    test("requires atomic activation storage that exposes a callable hook", { tags: "p1" }, () => {
        const memory = new MemoryActorStore<{ value: number }>({ value: 0 }, structuredClone);
        const nonActivating = new NonActivatingActorStore(memory);
        const forgedActivation = new ForgedActivationActorStore(memory);

        expect(isActorActivationStore(memory)).toBe(true);
        expect(isActorActivationStore(nonActivating)).toBe(false);
        expect(isActorActivationStore(forgedActivation)).toBe(false);
        expect(() => createActorContext(ACTOR_REF, nonActivating)).toThrow(
            "Actor context requires atomic activation storage"
        );
        expect(() => createActorContext(ACTOR_REF, forgedActivation)).toThrow(
            "Actor context requires atomic activation storage"
        );
        expect(() => {
            // @ts-expect-error Runtime callers can supply a non-ActorRef host value.
            createActorContext({}, memory);
        }).toThrow("Actor context requires an ActorRef");
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
    const createActor = (declaration: CodecDeclaration = COUNTER_CODECS) =>
        new CounterActor({ actor: ACTOR_REF, store }, operations, declaration);
    const actor = createActor();

    return {
        actor,
        restart: createActor,
        declare: (declaration) =>
            store.transaction((transaction) => {
                store.saveRecordSetDeclaration(
                    transaction,
                    ACTOR_REF,
                    CodecDeclaration.toBytes(declaration)
                );
            }),
        declaration: () =>
            store.transaction((transaction) => {
                const carrier = store.loadRecordSetDeclaration(transaction, ACTOR_REF);
                return carrier === undefined ? undefined : CodecDeclaration.fromBytes(carrier);
            }),
        value: operations.value,
        initializations: operations.initializations,
        failNextCommitUnknown: () => store.failNextCommitUnknown(),
        failCommitUnknownAfter: (transactions) => store.failCommitUnknownAfter(transactions),
        failNextCommitWith: (error) => store.failNextCommitWith(error),
        loseNextCommit: () => store.loseNextCommit(),
        recovery: () =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, ACTOR_REF))
    };
}

class StartActor<TTransaction> extends Actor<TTransaction> {
    public constructor(
        context: ActorContext<TTransaction>,
        start: ActorStartOperation<TTransaction>
    ) {
        super(context, CodecDeclaration.empty, start);
    }
}

// The sentinel that abandons a transaction from outside the Actor's own callback, so
// the store rolls back without the Actor ever seeing a commit-unknown error raised
// inside its command — which it would reject as a programmer fault instead.
const ABANDON_TRANSACTION = Symbol("abandon-transaction");

class FaultingActorStore<TTransaction> implements ActorActivationStore<TTransaction> {
    #failure: InjectedCommitFailure | undefined;
    #transactionsUntilFailure = 0;
    #loseNextCommit = false;

    public constructor(private readonly store: ActorActivationStore<TTransaction>) {}

    public failNextCommitUnknown(): void {
        this.failNextCommitWith(new ActorCommitUnknownError());
    }

    /**
     * Reports an unknown commit on the branch where the write was lost: the command
     * callback runs to completion inside a real transaction, the transaction is then
     * abandoned so the store rolls it back, and only then is the caller told the
     * outcome is unknown. failNextCommitWith reports the other branch — it lets the
     * inner transaction commit first — so between them the two cover both branches an
     * unknown commit leaves open.
     */
    public loseNextCommit(): void {
        this.#loseNextCommit = true;
    }

    public failCommitUnknownAfter(transactions: number): void {
        if (!Number.isSafeInteger(transactions) || transactions < 1) {
            throw new TypeError("Fault transaction count must be a positive safe integer");
        }
        this.#failure = new ActorCommitUnknownError();
        this.#transactionsUntilFailure = transactions;
    }

    public failNextCommitWith(error: InjectedCommitFailure): void {
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
        if (this.#loseNextCommit) {
            this.#loseNextCommit = false;
            try {
                this.store.transaction<TResult>(
                    (transaction): TResult => {
                        operation(transaction);
                        throw ABANDON_TRANSACTION;
                    },
                    ...guard
                );
            } catch (error) {
                if (error !== ABANDON_TRANSACTION) throw error;
            }
            throw new ActorCommitUnknownError();
        }
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

    public loadRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef
    ): Uint8Array | undefined {
        return this.store.loadRecordSetDeclaration(transaction, actor);
    }

    public saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.store.saveRecordSetDeclaration(transaction, actor, declaration);
    }
}

class RefusingActorStore<TTransaction> implements ActorActivationStore<TTransaction> {
    #refusals = 0;

    public constructor(private readonly store: ActorActivationStore<TTransaction>) {}

    public refuseNextTransaction(): void {
        this.#refusals = 1;
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
        if (this.#refusals > 0) {
            this.#refusals -= 1;
            throw new ActorCommitUnknownError("Refused before the transaction callback ran");
        }
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

    public loadRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef
    ): Uint8Array | undefined {
        return this.store.loadRecordSetDeclaration(transaction, actor);
    }

    public saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.store.saveRecordSetDeclaration(transaction, actor, declaration);
    }
}

class ForgedActivationActorStore<TTransaction extends object> implements ActorStore<TTransaction> {
    public readonly activateActor = 42;

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

    public loadRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef
    ): Uint8Array | undefined {
        return this.store.loadRecordSetDeclaration(transaction, actor);
    }

    public saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.store.saveRecordSetDeclaration(transaction, actor, declaration);
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

    public loadRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef
    ): Uint8Array | undefined {
        return this.store.loadRecordSetDeclaration(transaction, actor);
    }

    public saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.store.saveRecordSetDeclaration(transaction, actor, declaration);
    }
}

function sqliteInteger(database: ReadableSqlite, column: string): number {
    return requireSqliteInteger(
        database.all(`SELECT ${column} FROM actor_counter WHERE singleton = 1`, [])[0],
        column,
        `numeric counter column: ${column}`
    );
}

function staleFenceError(): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", "Actor command fence is stale");
}

interface CounterDraft {
    value: number;
    defined?: boolean;
}

type ExpiredDraftProbe = (transaction: CounterDraft) => void;

const expiredTransactionReflections: readonly ExpiredDraftProbe[] = [
    (transaction) => Reflect.defineProperty(transaction, "defined", { value: true }),
    (transaction) => Reflect.deleteProperty(transaction, "value"),
    (transaction) => transaction.value,
    (transaction) => Object.getOwnPropertyDescriptor(transaction, "value"),
    (transaction) => Object.getPrototypeOf(transaction),
    (transaction) => "value" in transaction,
    (transaction) => Object.isExtensible(transaction),
    (transaction) => Reflect.ownKeys(transaction),
    (transaction) => Object.preventExtensions(transaction),
    (transaction) => {
        transaction.value = 1;
    },
    (transaction) => Object.setPrototypeOf(transaction, null)
];

/**
 * The operational failure an action threw. A TypeError is a defect in the store
 * rather than an outcome it reports, so it is refused here as loudly as a value
 * that is no failure at all — the distinction every caller below asserts on.
 */
function assertOperationalError(cause: unknown): asserts cause is AgentCoreError {
    if (cause instanceof TypeError || !(cause instanceof AgentCoreError)) {
        throw new TypeError(`Expected an operational failure, got ${String(cause)}`);
    }
}

function throwsOperationalError(code: AgentCoreError["code"]): (action: () => void) => boolean {
    return (action) => {
        try {
            action();
            return false;
        } catch (error) {
            assertOperationalError(error);
            expect(error.code).toBe(code);
            return true;
        }
    };
}

function expectOperationalFailure(
    action: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        action();
    } catch (error) {
        assertOperationalError(error);
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        return;
    }
    throw new TypeError(`Expected an operational failure: ${code} ${message}`);
}

function isOperationalError(
    code: AgentCoreError["code"]
): (cause: unknown) => cause is AgentCoreError {
    return (cause): cause is AgentCoreError => {
        assertOperationalError(cause);
        expect(cause.code).toBe(code);
        return true;
    };
}

function noop(): void {}
