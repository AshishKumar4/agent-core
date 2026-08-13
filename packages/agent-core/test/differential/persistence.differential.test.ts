import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    Actor,
    ActorFence,
    ActorId,
    ActorRecoveryState,
    ActorRef,
    MemoryActorStore,
    type ActorContext,
    type ActorKind
} from "../../src/actors";
import { type JsonObject } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { SqliteActorStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import { LeanOracle, modelFlag, modelName, modelNumber, modelObject } from "./oracle";

/*
 * Differential testing of Actor-local activation and the command fence gate (SPEC §8.1)
 * against the verified Lean model. `activateExec` and `admitsCommand` are the modeled
 * decisions themselves — `ActorStep` admits an activation exactly when `activateExec`
 * succeeds — so every AC-PERSISTENCE-001 theorem is stated over what the oracle answers
 * here, and a disagreement is a real semantic divergence.
 *
 * The activation sweep is exhaustive over the decision's own space rather than random: the
 * identity row is absent, this Actor's, or another's; the fencing record is absent, this
 * Actor's, or one whose payload names another Actor. Nine shapes, every one constructed.
 * Random storage would reach the interesting corners only by accident, which is how a
 * covering bug survived a passing property suite once already.
 *
 * The two stores refuse the corrupt shapes at different moments, and the suite says so.
 * `SqliteActorStore` reaches all four faults inside `activateActor`, which is the
 * precedence the model encodes. `MemoryActorStore.restore` rejects two of them earlier, at
 * snapshot decode, so the Memory comparison is admitted-versus-refused only. Both fail
 * closed; neither admits a shape the model refuses.
 */

const TENANT = 1;
const SELF_KIND: ActorKind = "run";
const SELF_ID = "differential-actor";
const OTHER_ID = "differential-other";

const selfActor = new ActorRef(SELF_KIND, new ActorId(SELF_ID));
const otherActor = new ActorRef(SELF_KIND, new ActorId(OTHER_ID));

/** The Lean `ActorRef` this suite exercises: one tenant, `run` actors keyed by a number. */
function modelActor(actor: ActorRef): JsonObject {
    return {
        kind: actor.kind,
        tenant: TENANT,
        id: actor.id.value === SELF_ID ? 7 : 8
    };
}

function modelRecovery(state: ActorRecoveryState | null): JsonObject | null {
    return state === null
        ? null
        : {
              actor: modelActor(state.actor),
              epoch: state.epoch,
              recoveries: state.recoveries
          };
}

interface StoredActorState {
    readonly identity: ActorRef | null;
    readonly recovery: ActorRecoveryState | null;
}

/** Every combination the decision distinguishes, with no shape left to chance. */
function storedActorStates(): readonly {
    readonly name: string;
    readonly stored: StoredActorState;
}[] {
    const identities: readonly (readonly [string, ActorRef | null])[] = [
        ["unbound", null],
        ["self", selfActor],
        ["foreign", otherActor]
    ];
    const recoveries: readonly (readonly [string, ActorRecoveryState | null])[] = [
        ["absent", null],
        ["self", new ActorRecoveryState(selfActor, 3, 2)],
        ["foreign", new ActorRecoveryState(otherActor, 3, 2)]
    ];
    return identities.flatMap(([identityName, identity]) =>
        recoveries.map(([recoveryName, recovery]) => ({
            name: `identity=${identityName} recovery=${recoveryName}`,
            stored: { identity, recovery }
        }))
    );
}

interface Outcome {
    readonly ok: boolean;
    readonly kind?: "created" | "recovered";
    readonly epoch?: number;
    readonly recoveries?: number;
    readonly fault?: string;
}

/**
 * The SQLite store's four refusals, by the exact error each raises. Mapping by message
 * rather than by code is deliberate: three of them share `codec.invalid`, and it is the
 * distinction between them that the model claims to reproduce.
 */
const SQLITE_FAULTS = new Map<string, string>([
    ["SQLite ActorStore is bound to a different Actor", "foreign-actor"],
    ["Actor recovery state does not match its storage key", "foreign-recovery"],
    ["Existing Actor storage is missing recovery state", "missing-recovery-state"],
    ["Unbound Actor storage cannot contain recovery state", "unbound-recovery-state"]
]);

function sqliteActivation(stored: StoredActorState): Outcome {
    const database = new TestSqlite();
    const store = new SqliteActorStore(database);
    if (stored.identity !== null) {
        database.run(
            "INSERT INTO actor_identity (singleton, actor_kind, actor_id) VALUES (1, ?, ?)",
            [stored.identity.kind, stored.identity.id.value]
        );
    }
    if (stored.recovery !== null) {
        // Keyed under the Actor being activated, so a payload naming another Actor is the
        // key/payload disagreement the store checks for rather than a row it never reads.
        database.run(
            "INSERT INTO actor_recovery_state (actor_kind, actor_id, state) VALUES (?, ?, ?)",
            [selfActor.kind, selfActor.id.value, ActorRecoveryState.codec.encode(stored.recovery)]
        );
    }
    try {
        const state = store.activateActor(selfActor, () => {});
        return { ok: true, epoch: state.epoch, recoveries: state.recoveries };
    } catch (error) {
        if (!(error instanceof AgentCoreError)) throw error;
        const fault = SQLITE_FAULTS.get(error.message);
        if (fault === undefined) throw error;
        return { ok: false, fault };
    }
}

function memoryActivationAdmitted(stored: StoredActorState): Outcome {
    try {
        const store = MemoryActorStore.restore<{ value: number }>(
            {
                version: 1,
                state: { value: 0 },
                actor:
                    stored.identity === null
                        ? null
                        : { kind: stored.identity.kind, id: stored.identity.id.value },
                recoveryState:
                    stored.recovery === null ? null : ActorRecoveryState.codec.encode(stored.recovery)
            },
            structuredClone
        );
        const state = store.activateActor(selfActor, () => {});
        return { ok: true, epoch: state.epoch, recoveries: state.recoveries };
    } catch (error) {
        if (!(error instanceof AgentCoreError)) throw error;
        return { ok: false };
    }
}

/** The activation faults the model names, from `activationFaultName` in the Lean oracle. */
const ACTIVATION_FAULTS = [
    "foreign-actor",
    "foreign-recovery",
    "missing-recovery-state",
    "unbound-recovery-state"
] as const;

/** The activation kinds the model names, from `ActivationKind` in the Lean oracle. */
const ACTIVATION_KINDS = ["created", "recovered"] as const;

async function modelActivation(stored: StoredActorState): Promise<Outcome> {
    const answer = await oracle.ask({
        op: "actor.activate",
        storage: {
            identity: stored.identity === null ? null : modelActor(stored.identity),
            recovery: modelRecovery(stored.recovery)
        },
        actor: modelActor(selfActor)
    });
    if (!modelFlag(answer, "ok")) {
        return { ok: false, fault: modelName(answer, "fault", ACTIVATION_FAULTS) };
    }
    const recovery = modelObject(answer, "recovery");
    return {
        ok: true,
        kind: modelName(answer, "kind", ACTIVATION_KINDS),
        epoch: modelNumber(recovery, "epoch"),
        recoveries: modelNumber(recovery, "recoveries")
    };
}

interface Counter {
    value: number;
}

class GateActor extends Actor<Counter> {
    public constructor(context: ActorContext<Counter>) {
        super(context, () => {});
    }

    public bump(fence: ActorFence): Promise<number> {
        return this.executeFenced(fence, (transaction) => {
            transaction.value += 1;
            return transaction.value;
        });
    }
}

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("Actor activation agrees with the verified model", () => {
    test(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] SQLite reproduces the model's activation on every storage shape",
        { tags: "p0" },
        async () => {
            for (const { name, stored } of storedActorStates()) {
                const model = await modelActivation(stored);
                const implementation = sqliteActivation(stored);
                expect(implementation.ok, `${name}: admission disagrees`).toBe(model.ok);
                if (!model.ok) {
                    expect(implementation.fault, `${name}: refusal disagrees`).toBe(model.fault);
                    continue;
                }
                expect(implementation.epoch, `${name}: epoch disagrees`).toBe(model.epoch);
                expect(implementation.recoveries, `${name}: recoveries disagrees`).toBe(
                    model.recoveries
                );
                expect(model.kind).toBe(
                    stored.recovery === null && stored.identity === null ? "created" : "recovered"
                );
            }
        }
    );

    test(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] Memory admits exactly the shapes the model admits",
        { tags: "p0" },
        async () => {
            for (const { name, stored } of storedActorStates()) {
                const model = await modelActivation(stored);
                const implementation = memoryActivationAdmitted(stored);
                expect(implementation.ok, `${name}: admission disagrees`).toBe(model.ok);
                if (!model.ok) continue;
                expect(implementation.epoch, `${name}: epoch disagrees`).toBe(model.epoch);
                expect(implementation.recoveries, `${name}: recoveries disagrees`).toBe(
                    model.recoveries
                );
            }
        }
    );

    test(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] repeated activation advances the epoch as the model says",
        { tags: "p0" },
        async () => {
            const store = new MemoryActorStore<Counter>({ value: 0 }, structuredClone);
            let stored: ActorRecoveryState | null = null;
            for (let activation = 0; activation < 4; activation += 1) {
                const model = await modelActivation({
                    identity: stored === null ? null : selfActor,
                    recovery: stored
                });
                const state = store.activateActor(selfActor, () => {});
                expect(state.epoch).toBe(model.epoch);
                expect(state.recoveries).toBe(model.recoveries);
                expect(state.recoveries).toBe(activation + 1);
                stored = state;
            }
        }
    );
});

describe("the Actor command fence gate agrees with the verified model", () => {
    test(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] every held/expected fence pair over a restart",
        { tags: "p0" },
        async () => {
            const store = new MemoryActorStore<Counter>({ value: 0 }, structuredClone);
            const first = new GateActor({ actor: selfActor, store });
            const firstFence = await first.currentFence();
            const second = new GateActor({ actor: selfActor, store });
            const secondFence = await second.currentFence();

            expect(secondFence.epoch).toBe(firstFence.epoch + 1);

            const stored = {
                actor: modelActor(selfActor),
                epoch: secondFence.epoch,
                recoveries: 2
            };
            const cases: readonly {
                readonly name: string;
                readonly actor: GateActor;
                readonly held: ActorFence;
                readonly expected: ActorFence;
            }[] = [
                {
                    name: "current incarnation, current fence",
                    actor: second,
                    held: secondFence,
                    expected: secondFence
                },
                {
                    name: "current incarnation, stale fence",
                    actor: second,
                    held: secondFence,
                    expected: firstFence
                },
                {
                    name: "current incarnation, foreign holder",
                    actor: second,
                    held: secondFence,
                    expected: new ActorFence(otherActor, secondFence.epoch)
                },
                {
                    name: "superseded incarnation, its own fence",
                    actor: first,
                    held: firstFence,
                    expected: firstFence
                },
                {
                    name: "superseded incarnation, the current fence",
                    actor: first,
                    held: firstFence,
                    expected: secondFence
                }
            ];

            for (const scenario of cases) {
                const model = await oracle.ask({
                    op: "actor.admits",
                    self: modelActor(selfActor),
                    held: { actor: modelActor(selfActor), epoch: scenario.held.epoch },
                    expected: {
                        actor: modelActor(scenario.expected.actor),
                        epoch: scenario.expected.epoch
                    },
                    stored
                });
                const admitted = await scenario.actor
                    .bump(scenario.expected)
                    .then(() => true)
                    .catch(() => false);
                expect(admitted, `${scenario.name}: gate disagrees`).toBe(model["admits"]);
            }
        }
    );

    test(
        "[C13-OWNERSHIP-ACTOR-CONTRACT] an un-activated store is unserveable in both",
        { tags: "p0" },
        async () => {
            const model = await oracle.ask({
                op: "actor.admits",
                self: modelActor(selfActor),
                held: { actor: modelActor(selfActor), epoch: 0 },
                expected: null,
                stored: null
            });
            expect(model["admits"]).toBe(false);

            const store = new MemoryActorStore<Counter>({ value: 0 }, structuredClone);
            store.bindActor(selfActor);
            expect(() => store.activateActor(selfActor, () => {})).toThrow(
                "Existing Actor storage is missing recovery state"
            );
        }
    );
});
