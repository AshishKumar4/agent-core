// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SemVer } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    DeploymentRecord,
    ManagedOrigin,
    MaterializationPlan,
    MaterializationOutboxEntry,
    MaterializationPlanAdmissionPort,
    MaterializationRollout,
    MaterializationRolloutController,
    PolicySet,
    PlatformCompatibility,
    ValidationAttestation,
    expectedOutboxEntries,
    forwardRollbackPlan,
    isLegalDeploymentTransition,
    isLegalOutboxTransition,
    policyProjection,
    requireExactOutboxClosure,
    type MaterializationControlStore
} from "../../src/definition";
import {
    MemoryMaterializationControlStore,
    type MemoryMaterializationControlSnapshot
} from "../../src/definition/memory";
import { TenantId } from "../../src/identity";
import { SqliteMaterializationStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const tenantActor = new ActorRef("tenant", new ActorId(tenantId.value));
const deploymentKey = new DeploymentKey("platform");
const deploymentId = DeploymentId.derive(tenantId, deploymentKey);

describe("materialization rollout and outbox", () => {
    rolloutContract("memory", () => new MemoryMaterializationControlStore());
    rolloutContract("SQLite", () =>
        SqliteMaterializationStore.control(new TestSqlite(), tenantActor)
    );

    test("restores pending memory rollout state and rejects dangling outbox", () => {
        const store = new MemoryMaterializationControlStore();
        beginRollout(controllerFor(store), plan(1, ["a"]));
        const snapshot = store.snapshot();
        expect(new MemoryMaterializationControlStore(snapshot).snapshot()).toEqual(snapshot);

        const dangling: MemoryMaterializationControlSnapshot = {
            attestations: snapshot.attestations,
            deployments: snapshot.deployments,
            rollouts: [],
            outbox: snapshot.outbox
        };
        expect(() => new MemoryMaterializationControlStore(dangling)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
        expect(
            () =>
                new MemoryMaterializationControlStore({
                    attestations: snapshot.attestations,
                    deployments: snapshot.deployments,
                    rollouts: snapshot.rollouts,
                    outbox: []
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        expect(
            () =>
                new MemoryMaterializationControlStore({
                    ...snapshot,
                    deployments: [snapshot.deployments[0]!, snapshot.deployments[0]!]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        expect(
            () =>
                new MemoryMaterializationControlStore({
                    ...snapshot,
                    outbox: [new Uint8Array([0])]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test("[definition.validation-attestation] persists immutable validation attestations in Tenant control storage", () => {
        const store = new MemoryMaterializationControlStore();
        const attestation = validationAttestation();
        store.transaction((transaction) => store.insertAttestation(transaction, attestation));
        expect(
            store.transaction((transaction) => store.loadAttestation(transaction, attestation.id))
        ).toEqual(attestation);
        expect(
            store.transaction((transaction) =>
                store.loadAttestation(transaction, digest("missing-attestation"))
            )
        ).toBeUndefined();
        store.transaction((transaction) => store.insertAttestation(transaction, attestation));
        expect(
            new MemoryMaterializationControlStore(store.snapshot()).snapshot().attestations
        ).toHaveLength(1);
    });

    test("memory control store rejects stale CAS skipped revisions and orphan inserts", () => {
        const store = new MemoryMaterializationControlStore();
        const deployment = DeploymentRecord.initial(tenantId, deploymentKey);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, undefined, deployment)
            )
        ).toBe(true);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, undefined, deployment)
            )
        ).toBe(false);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    deployment.revision,
                    new DeploymentRecord(
                        deployment.id,
                        deployment.tenantId,
                        deployment.key,
                        undefined,
                        undefined,
                        deployment.nextGeneration,
                        deployment.revision.next().next()
                    )
                )
            )
        ).toThrow(/transition is invalid|transition history/);

        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        const empty = new MemoryMaterializationControlStore();
        expect(() =>
            empty.transaction((transaction) => empty.insertRollout(transaction, rollout))
        ).toThrow(/stored deployment/);
        const entry = MaterializationOutboxEntry.pending(rollout.id, rollout.plan.actors[0]!);
        expect(() =>
            store.transaction((transaction) => store.insertOutbox(transaction, entry))
        ).toThrow(/stored rollout/);
    });

    test("restores SQLite control state and fails closed on projection corruption", () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const rollout = controllerFor(store).begin(
            plan(1, ["a"]),
            deploymentKey,
            undefined,
            undefined,
            validationAttestation(1)
        );
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).not.toThrow();

        database.run(
            `UPDATE definition_materialization_rollouts SET generation = generation + 1 WHERE id = ?`,
            [rollout.id.value]
        );
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrow(
            /projection/
        );
    });

    test("[definition.deployment] round-trips rollout records and rejects forged deployment transitions", () => {
        const deployment = DeploymentRecord.initial(tenantId, deploymentKey);
        expect(DeploymentRecord.decode(DeploymentRecord.encode(deployment))).toEqual(deployment);
        expect(
            () =>
                new DeploymentRecord(
                    DeploymentId.derive(new TenantId("other"), deploymentKey),
                    tenantId,
                    deploymentKey,
                    undefined,
                    undefined,
                    1,
                    Revision.initial()
                )
        ).toThrow(/Deployment ID/);
        expect(
            () =>
                new DeploymentRecord(
                    deployment.id,
                    tenantId,
                    deploymentKey,
                    undefined,
                    undefined,
                    0,
                    Revision.initial()
                )
        ).toThrow(/positive/);
        expect(() => deployment.begin(digest("rollout"), 2)).toThrow(/allocated/);
        expect(() => deployment.complete(digest("rollout"), digest("plan"))).toThrow(/pending/);

        const begun = deployment.begin(digest("rollout"), 1);
        expect(() => begun.begin(digest("other"), 2)).toThrow(/already has/);
        expect(() => begun.complete(digest("other"), digest("plan"))).toThrow(/pending rollout/);
        expect(() => begun.compensate(digest("other"), digest("compensation"), 2)).toThrow(
            /failed pending rollout/
        );
        expect(() => begun.compensate(digest("rollout"), digest("compensation"), 3)).toThrow(
            /not allocated/
        );
        const compensated = begun.compensate(digest("rollout"), digest("compensation"), 2);
        expect(isLegalDeploymentTransition(deployment, begun)).toBe(true);
        expect(isLegalDeploymentTransition(begun, compensated)).toBe(true);
        expect(isLegalDeploymentTransition(begun, begun)).toBe(false);
        const maximum = new DeploymentRecord(
            deployment.id,
            deployment.tenantId,
            deployment.key,
            undefined,
            undefined,
            Number.MAX_SAFE_INTEGER,
            Revision.initial()
        );
        expect(() => maximum.begin(digest("rollout"), Number.MAX_SAFE_INTEGER)).toThrow(
            /cannot advance/
        );
    });

    test("[definition.materialization-rollout] [definition.materialization-outbox] round-trips rollout and outbox codecs and rejects malformed states", () => {
        const materializationPlan = plan(1, ["a"]);
        const rollout = new MaterializationRollout({ plan: materializationPlan });
        expect(MaterializationRollout.decode(MaterializationRollout.encode(rollout))).toEqual(
            rollout
        );
        expect(
            () =>
                new MaterializationRollout({
                    plan: materializationPlan,
                    id: digest("forged")
                })
        ).toThrow(/rollout ID/);
        const linked = new MaterializationRollout({
            plan: materializationPlan,
            previousPlanId: digest("previous"),
            compensates: digest("failed")
        });
        expect(
            MaterializationRollout.decode(MaterializationRollout.encode(linked)).toData()
        ).toEqual(linked.toData());
        expect(() => MaterializationRollout.fromData(null)).toThrow(/object/);
        expect(() =>
            MaterializationRollout.fromData({
                ...(rollout.toData() as object),
                plan: undefined
            } as never)
        ).toThrow(/required|missing|object/);

        const entry = MaterializationOutboxEntry.pending(
            rollout.id,
            materializationPlan.actors[0]!
        );
        expect(MaterializationOutboxEntry.decode(MaterializationOutboxEntry.encode(entry))).toEqual(
            entry
        );
        expect(entry.attempted().attempts).toBe(1);
        const acknowledged = entry.acknowledge(digest("reply"));
        expect(acknowledged.attempted()).toBe(acknowledged);
        expect(
            () =>
                new MaterializationOutboxEntry(
                    rollout.id,
                    entry.target,
                    entry.actorPlanId,
                    "pending",
                    -1,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(/attempts/);
        expect(
            () =>
                new MaterializationOutboxEntry(
                    rollout.id,
                    entry.target,
                    entry.actorPlanId,
                    "pending",
                    0,
                    digest("unexpected"),
                    Revision.initial()
                )
        ).toThrow(/acknowledged/);
        expect(
            () =>
                new MaterializationOutboxEntry(
                    rollout.id,
                    entry.target,
                    entry.actorPlanId,
                    "acknowledged",
                    0,
                    digest("reply"),
                    Revision.initial()
                )
        ).toThrow(/transition history/);
        expect(
            () =>
                new MaterializationOutboxEntry(
                    rollout.id,
                    entry.target,
                    entry.actorPlanId,
                    "pending",
                    0,
                    undefined,
                    Revision.initial(),
                    digest("forged")
                )
        ).toThrow(/outbox ID/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...(entry.toData() as object),
                status: "invalid"
            })
        ).toThrow(/status/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...(entry.toData() as object),
                target: { id: "target", kind: "invalid" }
            })
        ).toThrow(/Actor kind/);
        expect(() => MaterializationOutboxEntry.fromData(null)).toThrow(/object/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...(entry.toData() as object),
                attempts: "bad"
            })
        ).toThrow(/non-negative/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...(entry.toData() as object),
                target: null
            })
        ).toThrow(/Actor.*object/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...(entry.toData() as object),
                target: { id: 7, kind: "workspace" }
            })
        ).toThrow(/must be a string/);
        expect(() => DeploymentRecord.fromData(null)).toThrow(/object/);
        expect(() =>
            DeploymentRecord.fromData({
                ...(DeploymentRecord.initial(tenantId, deploymentKey).toData() as object),
                nextGeneration: "bad"
            })
        ).toThrow(/non-negative/);
        expect(() =>
            DeploymentRecord.fromData({
                ...(DeploymentRecord.initial(tenantId, deploymentKey).toData() as object),
                unknown: true
            })
        ).toThrow(/missing or unknown/);
        expect(() => entry.attempted().attempted().attempted()).not.toThrow();
        expect(() =>
            new MaterializationOutboxEntry(
                entry.rolloutId,
                entry.target,
                entry.actorPlanId,
                "pending",
                Number.MAX_SAFE_INTEGER,
                undefined,
                entry.revision
            ).attempted()
        ).toThrow(/cannot advance|transition history/);
        const expected = expectedOutboxEntries(rollout);
        expect(() => requireExactOutboxClosure(rollout, expected)).not.toThrow();
        expect(() => requireExactOutboxClosure(rollout, [...expected, expected[0]!])).toThrow(
            /exact target closure/
        );
        const forgedTarget = Object.assign(
            Object.create(MaterializationOutboxEntry.prototype) as MaterializationOutboxEntry,
            expected[0],
            { target: new ActorRef("workspace", new ActorId("forged")) }
        );
        expect(() => requireExactOutboxClosure(rollout, [forgedTarget])).toThrow(
            /exact target closure/
        );
        expect(isLegalOutboxTransition(entry, entry.attempted())).toBe(true);
        expect(isLegalOutboxTransition(entry, acknowledged)).toBe(true);
        expect(isLegalOutboxTransition(entry, entry)).toBe(false);
    });

    test("rejects forward rollback across deployments or without a higher generation", () => {
        const active = plan(1, ["a"]);
        const failed = plan(2, ["b"]);
        expect(() => forwardRollbackPlan(active, failed, origin(2))).toThrow(/advance/);
        const otherTenant = new TenantId("other");
        const foreignOrigin = new ManagedOrigin({
            ...origin(3),
            tenantId: otherTenant,
            deploymentId: DeploymentId.derive(otherTenant, deploymentKey)
        });
        expect(() => forwardRollbackPlan(active, failed, foreignOrigin)).toThrow(/same Tenant/);
    });

    test("surfaces every control-store CAS and missing-record failure", () => {
        expect(() =>
            controllerFor(new MemoryMaterializationControlStore()).begin(
                plan(1, ["a"]),
                deploymentKey
            )
        ).toThrow(/validation attestation/);
        expect(() =>
            controllerFor(new MemoryMaterializationControlStore()).begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(2)
            )
        ).toThrow(/does not match/);
        const deniedStore = new MemoryMaterializationControlStore();
        const denied = new MaterializationRolloutController(
            deniedStore,
            new (class extends MaterializationPlanAdmissionPort {
                public permits(): boolean {
                    return false;
                }
            })()
        );
        expect(() =>
            denied.begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(1)
            )
        ).toThrow(/topology is not admitted/);
        const initialization = new MemoryMaterializationControlStore();
        initialization.compareAndSetDeployment = () => false;
        expect(() =>
            controllerFor(initialization).begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(1)
            )
        ).toThrow(/initializing/);

        const begin = new MemoryMaterializationControlStore();
        const compareDeployment = begin.compareAndSetDeployment.bind(begin);
        let deploymentWrites = 0;
        begin.compareAndSetDeployment = (transaction, expected, deployment) => {
            deploymentWrites += 1;
            return deploymentWrites === 1
                ? compareDeployment(transaction, expected, deployment)
                : false;
        };
        expect(() =>
            controllerFor(begin).begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(1)
            )
        ).toThrow(/beginning/);

        const acknowledge = new MemoryMaterializationControlStore();
        const acknowledgeController = controllerFor(acknowledge);
        const rollout = beginRollout(acknowledgeController, plan(1, ["a"]));
        const entry = outbox(acknowledge, rollout.id)[0]!;
        acknowledge.compareAndSetOutbox = () => false;
        expect(() =>
            acknowledgeController.acknowledge(entry.id, receipt(entry, digest("reply")))
        ).toThrow(/acknowledging/);
        expect(() =>
            acknowledgeController.acknowledge(digest("missing"), receipt(entry, digest("reply")))
        ).toThrow(/Missing materialization outbox/);

        const complete = new MemoryMaterializationControlStore();
        const completeController = controllerFor(complete);
        const completedRollout = beginRollout(completeController, plan(1, ["a"]));
        acknowledgeAll(completeController, complete, completedRollout.id);
        complete.compareAndSetDeployment = () => false;
        expect(() => completeController.complete(completedRollout.id)).toThrow(/completing/);
        expect(() => completeController.complete(digest("missing"))).toThrow(
            /Missing materialization rollout/
        );

        const foreignTenant = new TenantId("foreign");
        const foreignDeployment = DeploymentId.derive(foreignTenant, deploymentKey);
        const foreign = new MaterializationPlan({
            origin: new ManagedOrigin({
                ...origin(2),
                tenantId: foreignTenant,
                deploymentId: foreignDeployment
            }),
            actors: []
        });
        expect(() =>
            controllerFor(new MemoryMaterializationControlStore()).begin(
                foreign,
                deploymentKey,
                plan(1, ["a"]),
                undefined,
                validationAttestation(2)
            )
        ).toThrow(/predecessor|different deployments/);

        const wrongKey = new DeploymentKey("wrong");
        expect(() =>
            controllerFor(new MemoryMaterializationControlStore()).begin(
                plan(1, ["a"]),
                wrongKey,
                undefined,
                undefined,
                validationAttestation(1)
            )
        ).toThrow(/different deployment/);

        const forgedTenantOrigin = new ManagedOrigin({
            ...origin(1),
            tenantId: new TenantId("forged")
        });
        expect(() =>
            controllerFor(new MemoryMaterializationControlStore()).begin(
                new MaterializationPlan({ origin: forgedTenantOrigin, actors: [] }),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(1)
            )
        ).toThrow(/different deployment/);

        const compensatedStore = new MemoryMaterializationControlStore();
        expect(() =>
            controllerFor(compensatedStore).begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                digest("failed-rollout"),
                validationAttestation(1)
            )
        ).toThrow(/unknown rollout/);
    });
});

function rolloutContract<Transaction>(
    name: string,
    create: () => MaterializationControlStore<Transaction>
): void {
    test(`${name} [materialization-control-store] persists union-target outbox and completes only after every acknowledgement`, () => {
        const store = create();
        const controller = controllerFor(store);
        const firstPlan = plan(1, ["a"]);
        const first = beginRollout(controller, firstPlan);
        expect(outbox(store, first.id).map((entry) => entry.target.id.value)).toEqual(["a"]);
        expect(() => controller.complete(first.id)).toThrow(/pending targets/);
        acknowledgeAll(controller, store, first.id);
        expect(controller.complete(first.id).activePlanId?.equals(first.plan.id)).toBe(true);

        const desired = plan(2, ["b"]);
        expect(() =>
            controller.begin(
                desired,
                deploymentKey,
                plan(1, ["stale"]),
                undefined,
                validationAttestation(2)
            )
        ).toThrow(/predecessor/);
        const second = beginRollout(controller, desired);
        expect(
            second.plan.actors.map((actorPlan) => [
                actorPlan.actor.id.value,
                actorPlan.projections.length
            ])
        ).toEqual([
            ["a", 0],
            ["b", 1]
        ]);
        acknowledgeAll(controller, store, second.id);
        expect(controller.complete(second.id).activePlanId?.equals(second.plan.id)).toBe(true);
        expect(controller.complete(second.id).activePlanId?.equals(second.plan.id)).toBe(true);
    });

    test(`${name} allocates generations with CAS and keeps acknowledgements idempotent`, () => {
        const store = create();
        const controller = controllerFor(store);
        const rollout = beginRollout(controller, plan(1, ["a"]));
        expect(beginRollout(controller, plan(1, ["a"])).id.equals(rollout.id)).toBe(true);
        expect(() => beginRollout(controller, plan(1, ["b"]))).toThrow(/pending|allocated/);
        const entry = outbox(store, rollout.id)[0]!;
        const reply = digest("reply");
        const acknowledged = controller.acknowledge(entry.id, receipt(entry, reply));
        expect(controller.acknowledge(entry.id, receipt(entry, reply))).toEqual(acknowledged);
        expect(() => controller.acknowledge(entry.id, receipt(entry, digest("other")))).toThrow(
            /immutable/
        );
        expect(() =>
            controller.acknowledge(entry.id, {
                ...receipt(entry, reply),
                actorPlanId: digest("wrong-plan")
            })
        ).toThrow(/does not match/);
        expect(() =>
            controller.acknowledge(entry.id, {
                ...receipt(entry, reply),
                outboxId: digest("wrong-outbox")
            })
        ).toThrow(/does not match/);

        const stored = outbox(store, rollout.id)[0]!;
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetOutbox(
                    transaction,
                    stored.revision,
                    new MaterializationOutboxEntry(
                        stored.rolloutId,
                        stored.target,
                        stored.actorPlanId,
                        "pending",
                        0,
                        undefined,
                        stored.revision.next(),
                        stored.id
                    )
                )
            )
        ).toThrow(/transition is invalid|transition history/);
    });

    test(`${name} creates forward rollback plans without rewinding target history`, () => {
        const active = plan(1, ["a"]);
        const failed = plan(2, ["b"]);
        const rollback = forwardRollbackPlan(active, failed, origin(3));
        expect(rollback.generation).toBe(3);
        expect(
            rollback.actors.map((actorPlan) => [
                actorPlan.actor.id.value,
                actorPlan.projections.length
            ])
        ).toEqual([
            ["a", 1],
            ["b", 0]
        ]);
        expect(rollback.id.equals(active.id)).toBe(false);
    });

    test(`${name} starts forward compensation while a prior rollout remains pending`, () => {
        const store = create();
        const controller = controllerFor(store);
        const first = beginRollout(controller, plan(1, ["a"]));
        acknowledgeAll(controller, store, first.id);
        controller.complete(first.id);
        const failed = beginRollout(controller, plan(2, ["b"]));
        const compensation = controller.begin(
            plan(3, ["a"]),
            deploymentKey,
            undefined,
            failed.id,
            validationAttestation(3)
        );
        expect(compensation.compensates?.equals(failed.id)).toBe(true);
        expect(compensation.plan.actors.map((actorPlan) => actorPlan.actor.id.value)).toEqual([
            "a",
            "b"
        ]);
        expect(
            controller
                .begin(
                    plan(3, ["a"]),
                    deploymentKey,
                    undefined,
                    failed.id,
                    validationAttestation(3)
                )
                .id.equals(compensation.id)
        ).toBe(true);
        expect(() =>
            controller.begin(
                plan(3, ["different"]),
                deploymentKey,
                undefined,
                failed.id,
                validationAttestation(3)
            )
        ).toThrow(/different pending rollout/);
    });

    test(`${name} compensates an initial pending rollout without an active predecessor`, () => {
        const store = create();
        const controller = controllerFor(store);
        const failed = beginRollout(controller, plan(1, ["a"]));
        const compensation = controller.begin(
            plan(2, []),
            deploymentKey,
            undefined,
            failed.id,
            validationAttestation(2)
        );
        expect(
            compensation.plan.actors.map((actorPlan) => [
                actorPlan.actor.id.value,
                actorPlan.projections.length
            ])
        ).toEqual([["a", 0]]);
        expect(
            controller
                .begin(plan(2, []), deploymentKey, undefined, failed.id, validationAttestation(2))
                .id.equals(compensation.id)
        ).toBe(true);
    });
}

function acknowledgeAll<Transaction>(
    controller: MaterializationRolloutController<Transaction>,
    store: MaterializationControlStore<Transaction>,
    rolloutId: Digest
): void {
    for (const entry of outbox(store, rolloutId)) {
        controller.acknowledge(entry.id, receipt(entry, digest(`reply:${entry.target.id.value}`)));
    }
}

function outbox<Transaction>(
    store: MaterializationControlStore<Transaction>,
    rolloutId: Digest
): readonly import("../../src/definition").MaterializationOutboxEntry[] {
    return store.transaction((transaction) => store.listOutbox(transaction, rolloutId));
}

function plan(generation: number, actors: readonly string[]): MaterializationPlan {
    const materializationOrigin = origin(generation);
    return new MaterializationPlan({
        origin: materializationOrigin,
        actors: actors.map(
            (id) =>
                new ActorPlan({
                    actor: new ActorRef("workspace", new ActorId(id)),
                    origin: materializationOrigin,
                    projections: [policyProjection(`policy:${id}`, PolicySet.empty())]
                })
        )
    });
}

function beginRollout<Transaction>(
    controller: MaterializationRolloutController<Transaction>,
    materializationPlan: MaterializationPlan
): MaterializationRollout {
    return controller.begin(
        materializationPlan,
        deploymentKey,
        undefined,
        undefined,
        validationAttestation(materializationPlan.generation)
    );
}

function controllerFor<Transaction>(
    store: MaterializationControlStore<Transaction>
): MaterializationRolloutController<Transaction> {
    return new MaterializationRolloutController(
        store,
        new (class extends MaterializationPlanAdmissionPort {
            public permits(): boolean {
                return true;
            }
        })()
    );
}

function origin(generation: number): ManagedOrigin {
    const attestation = validationAttestation(generation);
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: attestation.id,
        blueprintDigest: attestation.blueprintDigest,
        packageLockDigest: attestation.packageLockDigest,
        configDigest: digest(`config:${generation}`),
        generation
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function validationAttestation(generation = 1): ValidationAttestation {
    return new ValidationAttestation({
        definitionDigest: digest("definition"),
        blueprintDigest: digest(`blueprint:${generation}`),
        packageLockDigest: digest(`lock:${generation}`),
        snapshotDigest: digest("snapshot"),
        configSchemaDigest: digest("schema"),
        declarationDigest: digest("declarations"),
        placementDigest: digest("placements"),
        target: new PlatformCompatibility({
            spec: new SemVer("1.0.0"),
            host: new SemVer("1.0.0")
        })
    });
}

function receipt(
    entry: import("../../src/definition").MaterializationOutboxEntry,
    replyDigest: Digest
): import("../../src/definition").MaterializationApplyReceipt {
    return {
        outcome: "applied",
        rolloutId: entry.rolloutId,
        outboxId: entry.id,
        actorPlanId: entry.actorPlanId,
        replyDigest
    };
}
