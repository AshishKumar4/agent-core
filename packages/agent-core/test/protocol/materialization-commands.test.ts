import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId } from "../../src/agents";
import { Digest, Revision, decodeCanonicalJson, encodeCanonicalJson } from "../../src/core";
import { ActorPlan, DesiredProjection, MaterializationPlan } from "../../src/definition";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    MaterializationApplyLocalCommand,
    MaterializationCommandPayload,
    type CommandEnvelope,
    type MaterializationCommandBackend
} from "../../src/protocol";
import {
    MaterializationHarness,
    MaterializationHarnessStore,
    projection,
    type FakeRunUsage
} from "../definition/materialization-harness";

describe("materialization.applyLocal protocol command", () => {
    test("rolls back failed asynchronous Actor activation", () => {
        const actor = new ActorRef("tenant", new ActorId("materialization-target"));
        const store = new MaterializationHarnessStore(actor);
        expect(() => store.activateActor(actor, (() => Promise.resolve()) as never)).toThrow(
            /synchronous/
        );
        expect(store.state.recovery.size).toBe(0);
        expect(() => new MaterializationHarness(store)).not.toThrow();
    });

    test.each<FakeRunUsage>(["nonempty", "unknown"])(
        "applies a persisted plan without consulting %s Run usage",
        async (runUsage) => {
            const harness = new MaterializationHarness();
            const initial = await harness.dispatch(
                harness.envelope(
                    harness.plan(harness.actor, [projection("existing-resource")], 1),
                    { key: "initial-generation" }
                )
            );
            harness.setRunUsage(runUsage);
            const plan = harness.plan(harness.actor, [projection("local-resource")], 2);

            const result = await harness.dispatch(
                harness.envelope(plan, {
                    key: "next-generation",
                    revision: harness.planRevision()
                })
            );

            expect(initial.outcome).toBe("committed");
            expect(result.outcome).toBe("committed");
            expect(harness.managedLogicalKeys()).toEqual(["existing-resource", "local-resource"]);
            expect(harness.store.state.runUsage).toBe(runUsage);
            expect(harness.store.state.applyCount).toBe(2);
            expect(harness.store.state.applyAt).toEqual(MaterializationHarness.now);
        }
    );

    test("admits only the exact target Actor caller", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan();
        const callers = [
            {
                kind: "actor" as const,
                actor: new ActorRef(harness.actor.kind, new ActorId("wrong-workspace"))
            },
            {
                kind: "actor" as const,
                actor: new ActorRef("workspace", new ActorId(harness.actor.id.value))
            },
            {
                kind: "principal" as const,
                principal: new PrincipalRef(harness.tenant, new PrincipalId("not-an-actor"))
            }
        ];

        for (const [index, caller] of callers.entries()) {
            const result = await harness.dispatch(
                harness.envelope(plan, {
                    caller,
                    key: `wrong-caller-${index}`
                })
            );
            expect(result.outcome).toBe("rejectedAuthentication");
        }
        expect(harness.store.state.applyCount).toBe(0);
    });

    test("requires the target plan revision and forbids a supplied lease", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan();
        const stale = await harness.dispatch(
            harness.envelope(plan, {
                key: "stale-plan",
                revision: new Revision(7)
            })
        );
        const leased = await harness.dispatch(
            harness.envelope(plan, {
                key: "leased-plan",
                lease: {
                    turn: new TurnId("materialization-turn"),
                    holder: harness.principal,
                    epoch: 1
                }
            })
        );
        const missing = await harness.dispatch(
            harness.envelope(plan, {
                key: "missing-revision",
                omitRevision: true
            })
        );

        expect(stale.outcome).toBe("rejectedRevision");
        expect(leased.outcome).toBe("rejectedLease");
        expect(missing.outcome).toBe("rejectedMalformed");
        expect(harness.store.state.applyCount).toBe(0);
    });

    test("rejects persisted plans for a wrong target or multiple Actors", async () => {
        const harness = new MaterializationHarness();
        const other = new ActorRef("tenant", new ActorId("other-tenant"));
        const wrongTarget = await harness.dispatch(
            harness.envelope(harness.plan(other), { key: "wrong-target" })
        );
        const multiActor = await harness.dispatch(
            harness.envelope(harness.multiActorPlan(other), { key: "multi-actor" })
        );
        const unknownField = await harness.dispatch(
            harness.envelopeWithPayload(
                encodeCanonicalJson({
                    extra: true,
                    plan: "ignored"
                }),
                { key: "unknown-field" }
            )
        );

        expect(wrongTarget.outcome).toBe("rejectedAuthority");
        expect(multiActor.outcome).toBe("rejectedAuthority");
        expect(unknownField.outcome).toBe("rejectedMalformed");
        expect(harness.store.state.applyCount).toBe(0);
    });

    test("rejects a plan digest that was not persisted by the host", async () => {
        const harness = new MaterializationHarness();
        const missing = Digest.sha256(new TextEncoder().encode("missing-plan"));

        const result = await harness.dispatch(
            harness.envelopeWithPayload(MaterializationCommandPayload.applyLocal(missing))
        );

        expect(result.outcome).toBe("rejectedAuthority");
        expect(harness.store.state.applyCount).toBe(0);
    });

    test("rejects replay of an old generation after a newer plan is active", async () => {
        const harness = new MaterializationHarness();
        const oldPlan = harness.plan(harness.actor, [projection("old")], 1);
        const nextPlan = harness.plan(harness.actor, [projection("next")], 2);
        expect((await harness.dispatch(harness.envelope(oldPlan, { key: "old" }))).outcome).toBe(
            "committed"
        );
        expect(
            (
                await harness.dispatch(
                    harness.envelope(nextPlan, {
                        key: "next",
                        revision: harness.planRevision()
                    })
                )
            ).outcome
        ).toBe("committed");

        const stale = await harness.dispatch(
            harness.envelope(oldPlan, {
                key: "stale-replay",
                revision: harness.planRevision()
            })
        );
        expect(stale.outcome).toBe("rejectedLifecycle");
        expect(harness.store.state.records.snapshot().writes.at(-1)?.outcome).toBe(
            "rejectedLifecycle"
        );
        expect(harness.store.state.applyCount).toBe(2);
    });

    test("rejects an unsupported persisted plan at lifecycle before materialization", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan();
        const unsupported = forgePlanKind(plan, "facet.slot-entry");
        harness.persistPlan(unsupported);

        const result = await harness.dispatch(
            harness.envelopeWithPayload(MaterializationCommandPayload.applyLocal(plan.id), {
                key: "unsupported-lifecycle"
            })
        );

        expect(result.outcome).toBe("rejectedLifecycle");
        expect(harness.managedLogicalKeys()).toEqual([]);
        expect(harness.store.state.applyCount).toBe(0);
        expect(harness.store.state.records.snapshot().writes.at(-1)?.outcome).toBe(
            "rejectedLifecycle"
        );
    });

    test("rechecks support during execute and rolls the command transaction back", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan();
        const raw = harness.envelope(plan, { key: "unsupported-execute" });
        harness.persistApplyPlan(plan.id, forgePlanKind(plan, "slot-entry"));

        await expect(harness.dispatch(raw)).rejects.toThrow(
            /Unsupported materialization record kind/
        );

        expect(harness.managedLogicalKeys()).toEqual([]);
        expect(harness.store.state.applyCount).toBe(0);
        expect(harness.store.state.records.snapshot().writes).toEqual([]);
    });

    test("rejects a supported execute-time plan substituted under the authorized ID", async () => {
        const harness = new MaterializationHarness();
        const authorized = harness.plan(harness.actor, [projection("authorized")], 1);
        const raw = harness.envelope(authorized, { key: "supported-substitution" });
        const substituted = harness.plan(harness.actor, [projection("substituted")], 2);
        harness.persistApplyPlan(
            authorized.id,
            Object.assign(
                Object.create(MaterializationPlan.prototype) as MaterializationPlan,
                substituted,
                { id: authorized.id }
            )
        );

        await expect(harness.dispatch(raw)).rejects.toThrow(/ID does not match/);
        expect(harness.managedLogicalKeys()).toEqual([]);
        expect(harness.store.state.applyCount).toBe(0);
        expect(harness.store.state.records.snapshot().writes).toEqual([]);
    });

    test("rejects a second envelope prepared against absent pointer state", async () => {
        const harness = new MaterializationHarness();
        const first = harness.envelope(harness.plan(harness.actor, [projection("first")], 1), {
            key: "prepared-first"
        });
        const second = harness.envelope(harness.plan(harness.actor, [projection("second")], 2), {
            key: "prepared-second"
        });

        expect((await harness.dispatch(first)).outcome).toBe("committed");
        expect((await harness.dispatch(second)).outcome).toBe("rejectedRevision");
        expect(harness.managedLogicalKeys()).toEqual(["first"]);
    });

    test("replays duplicates before reading mutable plan state", async () => {
        const harness = new MaterializationHarness();
        const raw = harness.envelope(harness.plan(), { key: "same-plan" });
        const committed = await harness.dispatch(raw);
        harness.setPlanRevision(undefined);
        harness.setFault(true);

        const duplicate = await harness.dispatch(raw);

        expect(committed.outcome).toBe("committed");
        expect(duplicate.outcome).toBe("duplicate");
        expect(duplicate.reply).toEqual(committed.reply);
        expect(harness.store.state.applyCount).toBe(1);
    });

    test("rolls back a failed local apply and permits the same-key retry", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan(harness.actor, [projection("rolled-back-resource")]);
        const raw = harness.envelope(plan, { key: "faulted-plan" });
        harness.setFault(true);

        await expect(harness.dispatch(raw)).rejects.toThrow("injected local materialization fault");
        expect(harness.managedLogicalKeys()).toEqual([]);
        expect(harness.store.state.applyCount).toBe(0);
        expect(harness.planRevision().value).toBe(0);

        harness.setFault(false);
        const retry = await harness.dispatch(raw);
        expect(retry.outcome).toBe("committed");
        expect(harness.managedLogicalKeys()).toEqual(["rolled-back-resource"]);
        expect(harness.store.state.applyCount).toBe(1);
    });

    test("payload helper emits a command payload accepted by the strict codec", async () => {
        const harness = new MaterializationHarness();
        const plan = harness.plan();
        harness.persistPlan(plan);
        const payload = MaterializationCommandPayload.applyLocal(plan.id);

        expect(decodeCanonicalJson(payload)).toEqual({ planId: plan.id.value });

        const result = await harness.dispatch(harness.envelopeWithPayload(payload));

        expect(result.outcome).toBe("committed");
    });

    test.each([null, "string", [], {}, { planId: 7 }, { planId: "0".repeat(64), extra: true }])(
        "rejects malformed materialization payload %j before command gates",
        async (payload) => {
            const harness = new MaterializationHarness();
            const result = await harness.dispatch(
                harness.envelopeWithPayload(encodeCanonicalJson(payload))
            );
            expect(result.outcome).toBe("rejectedMalformed");
            expect(harness.store.state.applyCount).toBe(0);
        }
    );

    test("fails closed when direct command gates cannot load their exact plan", () => {
        const target = new ActorRef("workspace", new ActorId("target"));
        const controller = new ActorRef("tenant", new ActorId("tenant"));
        const backend: MaterializationCommandBackend<object, object> = {
            loadPlan: () => undefined,
            loadPlanForApply: () => undefined,
            currentRevision: () => undefined,
            permitsApply: () => false,
            applyLocal: () => new Uint8Array()
        };
        const tenant = new TenantId("tenant");
        const command = new MaterializationApplyLocalCommand(backend, target, controller, tenant);
        const envelope = { caller: { kind: "actor", actor: controller } } as CommandEnvelope;
        const payload = { planId: new Digest("0".repeat(64)) };
        expect(command.permitsLifecycle({}, envelope, payload)).toBe(false);
        expect(command.currentRevision({}, envelope, payload)).toBeUndefined();
        expect(() => command.execute({}, envelope, payload, MaterializationHarness.now)).toThrow(
            /missing or has a foreign target/
        );
        expect(() => command.authorize({}, envelope, null)).toThrow(/not decoded/);
        expect(() => new MaterializationApplyLocalCommand(backend, target, target, tenant)).toThrow(
            /Tenant Actor/
        );

        const harness = new MaterializationHarness();
        const plan = harness.plan();
        const substituted: MaterializationCommandBackend<object, object> = {
            ...backend,
            loadPlan: () => plan
        };
        const substitutedCommand = new MaterializationApplyLocalCommand(
            substituted,
            harness.actor,
            harness.actor,
            harness.tenant
        );
        expect(substitutedCommand.currentRevision({}, envelope, payload)).toBeUndefined();
    });
});

function forgePlanKind(plan: MaterializationPlan, recordKind: string): MaterializationPlan {
    const actorPlan = plan.actors[0]!;
    const projection = actorPlan.projections[0]!;
    const unsupported = Object.assign(
        Object.create(DesiredProjection.prototype) as DesiredProjection,
        projection,
        { recordKind }
    );
    const forgedActor = Object.assign(Object.create(ActorPlan.prototype) as ActorPlan, actorPlan, {
        projections: Object.freeze([unsupported])
    });
    return Object.assign(
        Object.create(MaterializationPlan.prototype) as MaterializationPlan,
        plan,
        { actors: Object.freeze([forgedActor]) }
    );
}
