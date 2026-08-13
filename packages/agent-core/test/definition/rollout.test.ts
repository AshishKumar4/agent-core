import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
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
    requirePlanAttestation,
    type MaterializationControlStore
} from "../../src/definition";
import {
    MemoryMaterializationControlStore,
    type MemoryMaterializationControlSnapshot
} from "../../src/definition/memory";
import { TenantId } from "../../src/identity";
import { SqliteMaterializationStore } from "../../src/substrates";
import { recordData } from "./record-data";
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

    test("restores pending memory rollout state and rejects dangling outbox", { tags: "p1" }, () => {
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

    test("[definition.validation-attestation] persists immutable validation attestations in Tenant control storage", { tags: "p0" }, () => {
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

    test("memory control store rejects stale CAS skipped revisions and orphan inserts", { tags: "p0" }, () => {
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

    test("restores SQLite control state and fails closed on projection corruption", { tags: "p0" }, () => {
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

    test("[definition.deployment] round-trips rollout records and rejects forged deployment transitions", { tags: "p0" }, () => {
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

    test("[definition.materialization-rollout] [definition.materialization-outbox] round-trips rollout and outbox codecs and rejects malformed states", { tags: "p1" }, () => {
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
                ...recordData(rollout),
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
                ...recordData(entry),
                status: "invalid"
            })
        ).toThrow(/status/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...recordData(entry),
                target: { id: "target", kind: "invalid" }
            })
        ).toThrow(/Actor kind/);
        expect(() => MaterializationOutboxEntry.fromData(null)).toThrow(/object/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...recordData(entry),
                attempts: "bad"
            })
        ).toThrow(/non-negative/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...recordData(entry),
                target: null
            })
        ).toThrow(/Actor.*object/);
        expect(() =>
            MaterializationOutboxEntry.fromData({
                ...recordData(entry),
                target: { id: 7, kind: "workspace" }
            })
        ).toThrow(/must be a string/);
        expect(() => DeploymentRecord.fromData(null)).toThrow(/object/);
        expect(() =>
            DeploymentRecord.fromData({
                ...recordData(DeploymentRecord.initial(tenantId, deploymentKey)),
                nextGeneration: "bad"
            })
        ).toThrow(/non-negative/);
        expect(() =>
            DeploymentRecord.fromData({
                ...recordData(DeploymentRecord.initial(tenantId, deploymentKey)),
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

    test("rejects forward rollback across deployments or without a higher generation", { tags: "p1" }, () => {
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

    test("surfaces every control-store CAS and missing-record failure", { tags: "p1" }, () => {
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

describe("materialization rollout mutation boundaries", () => {
    test("binds plans to their attestation digests field by field", { tags: "p0" }, () => {
        const materializationPlan = plan(1, ["a"]);
        const attestation = validationAttestation(1);
        expect(() => requirePlanAttestation(materializationPlan, attestation)).not.toThrow();

        const idMismatch = new ValidationAttestation({
            definitionDigest: digest("definition"),
            blueprintDigest: digest("blueprint:1"),
            packageLockDigest: digest("lock:1"),
            snapshotDigest: digest("other-snapshot"),
            configSchemaDigest: digest("schema"),
            declarationDigest: digest("declarations"),
            placementDigest: digest("placements"),
            target: new PlatformCompatibility({
                spec: new SemVer("1.0.0"),
                host: new SemVer("1.0.0")
            })
        });
        expect(idMismatch.blueprintDigest.equals(attestation.blueprintDigest)).toBe(true);
        expect(idMismatch.packageLockDigest.equals(attestation.packageLockDigest)).toBe(true);
        expect(() => requirePlanAttestation(materializationPlan, idMismatch)).toThrow(
            /does not match its persisted validation attestation/
        );

        const blueprintMismatch = new MaterializationPlan({
            origin: new ManagedOrigin({
                ...origin(1),
                blueprintDigest: digest("forged-blueprint")
            }),
            actors: []
        });
        expect(() => requirePlanAttestation(blueprintMismatch, attestation)).toThrow(
            /does not match its persisted validation attestation/
        );

        const lockMismatch = new MaterializationPlan({
            origin: new ManagedOrigin({
                ...origin(1),
                packageLockDigest: digest("forged-lock")
            }),
            actors: []
        });
        expect(() => requirePlanAttestation(lockMismatch, attestation)).toThrow(
            /does not match its persisted validation attestation/
        );
    });

    test("derives rollout and outbox identities in their canonical domains", { tags: "p1" }, () => {
        const materializationPlan = plan(1, ["a"]);
        const rollout = new MaterializationRollout({ plan: materializationPlan });
        expect(
            rollout.id.equals(
                Digest.sha256(
                    encodeCanonicalJson({
                        compensates: null,
                        domain: "agent-core.materialization-rollout.v1",
                        planId: rollout.plan.id.value,
                        previousPlanId: null
                    })
                )
            )
        ).toBe(true);

        const actorPlan = materializationPlan.actors[0]!;
        const entry = MaterializationOutboxEntry.pending(rollout.id, actorPlan);
        expect(
            entry.id.equals(
                Digest.sha256(
                    encodeCanonicalJson({
                        actorPlanId: actorPlan.id.value,
                        domain: "agent-core.materialization-outbox.v1",
                        rolloutId: rollout.id.value,
                        target: { id: actorPlan.actor.id.value, kind: actorPlan.actor.kind }
                    })
                )
            )
        ).toBe(true);
    });

    test("labels deployment rollout and outbox decode subjects", { tags: "p2" }, () => {
        const deploymentData = recordData(DeploymentRecord.initial(tenantId, deploymentKey));
        const deploymentCases = [
            [{ id: 7 }, /Deployment ID must be a string/],
            [{ tenantId: 7 }, /Deployment Tenant ID must be a string/],
            [{ key: 7 }, /Deployment key must be a string/],
            [{ activePlanId: 7 }, /Deployment active plan must be a string/],
            [{ pendingRolloutId: 7 }, /Deployment pending rollout must be a string/],
            [{ nextGeneration: 1.5 }, /Deployment next generation must be a non-negative safe integer/],
            [{ nextGeneration: -1 }, /Deployment next generation must be a non-negative safe integer/]
        ] as const;
        for (const [patch, message] of deploymentCases) {
            expect(() => DeploymentRecord.fromData({ ...deploymentData, ...patch })).toThrow(
                message
            );
        }
        expect(() => DeploymentRecord.fromData(null)).toThrow(/Deployment must be an object/);

        const linked = new MaterializationRollout({
            plan: plan(1, ["a"]),
            previousPlanId: digest("previous"),
            compensates: digest("failed")
        });
        const rolloutData = recordData(linked);
        const rolloutCases = [
            [{ id: 7 }, /Materialization rollout ID must be a string/],
            [{ previousPlanId: 7 }, /Previous plan ID must be a string/],
            [{ compensates: 7 }, /Compensated rollout ID must be a string/]
        ] as const;
        for (const [patch, message] of rolloutCases) {
            expect(() => MaterializationRollout.fromData({ ...rolloutData, ...patch })).toThrow(
                message
            );
        }
        expect(() => MaterializationRollout.fromData(["entry"])).toThrow(
            /Materialization rollout must be an object/
        );

        const entry = MaterializationOutboxEntry.pending(
            linked.id,
            linked.plan.actors[0]!
        ).acknowledge(digest("reply"));
        const entryData = recordData(entry);
        const entryCases = [
            [{ status: 7 }, /Materialization outbox status must be a string/],
            [{ rolloutId: 7 }, /Materialization outbox rollout ID must be a string/],
            [{ actorPlanId: 7 }, /Materialization outbox Actor plan ID must be a string/],
            [{ replyDigest: 7 }, /Materialization outbox reply digest must be a string/],
            [{ id: 7 }, /Materialization outbox ID must be a string/],
            [
                { target: { id: 7, kind: "workspace" } },
                /Materialization target Actor ID must be a string/
            ],
            [
                { target: { id: "target", kind: 7 } },
                /Materialization target Actor kind must be a string/
            ]
        ] as const;
        for (const [patch, message] of entryCases) {
            expect(() => MaterializationOutboxEntry.fromData({ ...entryData, ...patch })).toThrow(
                message
            );
        }
    });

    test("round-trips every materialization target Actor kind", { tags: "p1" }, () => {
        for (const kind of ["tenant", "run", "environment", "slate"] as const) {
            const actorPlan = new ActorPlan({
                actor: new ActorRef(kind, new ActorId(`${kind}-target`)),
                origin: origin(1),
                projections: []
            });
            const entry = MaterializationOutboxEntry.pending(digest("rollout"), actorPlan);
            expect(MaterializationOutboxEntry.fromData(entry.toData())).toEqual(entry);
        }
    });

    test("names generation and attempt counters when they cannot advance", { tags: "p2" }, () => {
        const maxed = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            undefined,
            undefined,
            Number.MAX_SAFE_INTEGER,
            Revision.initial()
        );
        expect(() => maxed.begin(digest("rollout"), Number.MAX_SAFE_INTEGER)).toThrow(
            /Deployment generation cannot advance/
        );
        const pendingMaxed = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            undefined,
            digest("pending"),
            Number.MAX_SAFE_INTEGER,
            Revision.initial()
        );
        expect(() =>
            pendingMaxed.compensate(
                digest("pending"),
                digest("compensation"),
                Number.MAX_SAFE_INTEGER
            )
        ).toThrow(/Deployment generation cannot advance/);

        const actorPlan = plan(1, ["a"]).actors[0]!;
        const exhausted = new MaterializationOutboxEntry(
            digest("rollout"),
            actorPlan.actor,
            actorPlan.id,
            "pending",
            Number.MAX_SAFE_INTEGER,
            undefined,
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        expect(() => exhausted.attempted()).toThrow(
            /Materialization outbox attempts cannot advance/
        );
    });

    test("reports compensation mismatch on deployments without a pending rollout", { tags: "p1" }, () => {
        expect(() =>
            DeploymentRecord.initial(tenantId, deploymentKey).compensate(
                digest("failed"),
                digest("compensation"),
                1
            )
        ).toThrow(/Deployment compensation does not match its failed pending rollout/);
    });

    test("links successor rollouts to the active plan they replace", { tags: "p1" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const first = beginRollout(controller, plan(1, ["a"]));
        acknowledgeAll(controller, store, first.id);
        controller.complete(first.id);

        const second = controller.begin(
            plan(2, ["b"]),
            deploymentKey,
            plan(1, ["a"]),
            undefined,
            validationAttestation(2)
        );
        expect(second.previousPlanId?.equals(first.plan.id)).toBe(true);
    });

    test("compensates pending rollouts exactly once per failed rollout", { tags: "p0" }, () => {
        const store = new MemoryMaterializationControlStore();
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
        expect(compensation.previousPlanId?.equals(first.plan.id)).toBe(true);

        expect(() =>
            controller.begin(
                plan(3, ["a"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(3)
            )
        ).toThrow(/already has a different pending rollout/);
        expect(() =>
            controller.begin(
                plan(3, ["a"]),
                deploymentKey,
                undefined,
                first.id,
                validationAttestation(3)
            )
        ).toThrow(/already has a different pending rollout/);
    });

    test("requires every target acknowledged before completing", { tags: "p0" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const rollout = beginRollout(controller, plan(1, ["a", "b"]));
        const entries = outbox(store, rollout.id);
        expect(entries).toHaveLength(2);
        controller.acknowledge(entries[0]!.id, receipt(entries[0]!, digest("reply:first")));

        expect(() => controller.complete(rollout.id)).toThrow(
            /cannot complete with pending targets/
        );
    });

    test("treats completion as idempotent only for the completed rollout", { tags: "p1" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const first = beginRollout(controller, plan(1, ["a"]));
        acknowledgeAll(controller, store, first.id);
        expect(controller.complete(first.id).activePlanId?.equals(first.plan.id)).toBe(true);
        expect(controller.complete(first.id).activePlanId?.equals(first.plan.id)).toBe(true);

        const second = beginRollout(controller, plan(2, ["b"]));
        acknowledgeAll(controller, store, second.id);
        expect(controller.complete(second.id).activePlanId?.equals(second.plan.id)).toBe(true);
        expect(() => controller.complete(first.id)).toThrow(
            /Deployment completion does not match its pending rollout/
        );
    });

    test("acknowledges idempotently without issuing redundant writes", { tags: "p1" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const rollout = beginRollout(controller, plan(1, ["a"]));
        const entry = outbox(store, rollout.id)[0]!;
        const reply = digest("reply");
        const acknowledged = controller.acknowledge(entry.id, receipt(entry, reply));

        let writes = 0;
        const write = store.compareAndSetOutbox.bind(store);
        store.compareAndSetOutbox = (transaction, expected, next) => {
            writes += 1;
            return write(transaction, expected, next);
        };
        expect(controller.acknowledge(entry.id, receipt(entry, reply))).toEqual(acknowledged);
        expect(writes).toBe(0);
    });

    test("validates outbox closure independently of listing order", { tags: "p1" }, () => {
        const rollout = new MaterializationRollout({ plan: plan(1, ["a", "b"]) });
        const expected = expectedOutboxEntries(rollout);
        expect(expected).toHaveLength(2);
        expect(() => requireExactOutboxClosure(rollout, [...expected].reverse())).not.toThrow();
        expect(() => requireExactOutboxClosure(rollout, [expected[0]!, expected[0]!])).toThrow(
            /exact target closure/
        );
    });

    test("accepts only attempt and acknowledgement outbox transitions", { tags: "p1" }, () => {
        const actorPlan = plan(1, ["a"]).actors[0]!;
        const entry = MaterializationOutboxEntry.pending(digest("rollout"), actorPlan);
        const acknowledged = entry.acknowledge(digest("reply"));
        expect(isLegalOutboxTransition(entry, entry.attempted())).toBe(true);
        expect(isLegalOutboxTransition(entry, acknowledged)).toBe(true);
        expect(isLegalOutboxTransition(entry, entry)).toBe(false);

        const ackedOnce = new MaterializationOutboxEntry(
            digest("rollout"),
            actorPlan.actor,
            actorPlan.id,
            "acknowledged",
            1,
            digest("reply"),
            new Revision(2)
        );
        const ackedTwice = new MaterializationOutboxEntry(
            digest("rollout"),
            actorPlan.actor,
            actorPlan.id,
            "acknowledged",
            2,
            digest("reply"),
            new Revision(3)
        );
        expect(isLegalOutboxTransition(ackedOnce, ackedTwice)).toBe(false);
    });

    test("accepts only allocation completion and compensation deployment transitions", { tags: "p1" }, () => {
        const dep = (
            active: Digest | undefined,
            pending: Digest | undefined,
            nextGeneration: number,
            revision: number
        ): DeploymentRecord =>
            new DeploymentRecord(
                deploymentId,
                tenantId,
                deploymentKey,
                active,
                pending,
                nextGeneration,
                new Revision(revision)
            );
        const initial = DeploymentRecord.initial(tenantId, deploymentKey);
        expect(isLegalDeploymentTransition(undefined, initial)).toBe(true);
        expect(isLegalDeploymentTransition(undefined, dep(undefined, undefined, 1, 1))).toBe(false);
        expect(isLegalDeploymentTransition(undefined, dep(undefined, undefined, 2, 0))).toBe(false);
        expect(isLegalDeploymentTransition(undefined, dep(digest("plan"), undefined, 1, 0))).toBe(
            false
        );
        expect(
            isLegalDeploymentTransition(undefined, dep(undefined, digest("rollout"), 1, 0))
        ).toBe(false);

        const begun = initial.begin(digest("rollout"), 1);
        expect(isLegalDeploymentTransition(initial, begun)).toBe(true);
        expect(isLegalDeploymentTransition(initial, dep(digest("plan"), undefined, 1, 1))).toBe(
            false
        );
        expect(
            isLegalDeploymentTransition(initial, dep(undefined, digest("rollout"), 1, 1))
        ).toBe(false);
        expect(
            isLegalDeploymentTransition(initial, dep(digest("plan"), digest("rollout"), 2, 1))
        ).toBe(false);
        expect(isLegalDeploymentTransition(initial, dep(undefined, undefined, 2, 1))).toBe(false);

        expect(isLegalDeploymentTransition(begun, dep(digest("plan"), undefined, 2, 2))).toBe(true);
        expect(
            isLegalDeploymentTransition(
                begun,
                begun.compensate(digest("rollout"), digest("compensation"), 2)
            )
        ).toBe(true);
        expect(isLegalDeploymentTransition(begun, dep(digest("plan"), undefined, 2, 5))).toBe(
            false
        );
        expect(isLegalDeploymentTransition(begun, dep(undefined, undefined, 2, 2))).toBe(false);
        expect(isLegalDeploymentTransition(begun, dep(digest("plan"), undefined, 3, 2))).toBe(
            false
        );
        expect(isLegalDeploymentTransition(begun, dep(undefined, undefined, 3, 2))).toBe(false);
        expect(
            isLegalDeploymentTransition(begun, dep(undefined, digest("rollout"), 3, 2))
        ).toBe(false);
        expect(
            isLegalDeploymentTransition(begun, dep(digest("intro"), digest("compensation"), 3, 2))
        ).toBe(false);

        const active = digest("active-plan");
        const current = dep(active, digest("second"), 2, 3);
        expect(
            isLegalDeploymentTransition(current, dep(active, digest("compensation"), 3, 4))
        ).toBe(true);
        expect(
            isLegalDeploymentTransition(current, dep(active, digest("compensation"), 2, 4))
        ).toBe(false);
        expect(
            isLegalDeploymentTransition(
                current,
                dep(digest("swapped"), digest("compensation"), 2, 4)
            )
        ).toBe(false);
        expect(
            isLegalDeploymentTransition(current, dep(undefined, digest("compensation"), 3, 4))
        ).toBe(false);
        expect(
            isLegalDeploymentTransition(
                current,
                dep(digest("swapped"), digest("compensation"), 3, 4)
            )
        ).toBe(false);

        const tenantB = new TenantId("tenant-b");
        expect(
            isLegalDeploymentTransition(
                begun,
                new DeploymentRecord(
                    DeploymentId.derive(tenantB, deploymentKey),
                    tenantB,
                    deploymentKey,
                    digest("plan"),
                    undefined,
                    2,
                    new Revision(2)
                )
            )
        ).toBe(false);
        const keyB = new DeploymentKey("elsewhere");
        expect(
            isLegalDeploymentTransition(
                begun,
                new DeploymentRecord(
                    DeploymentId.derive(tenantId, keyB),
                    tenantId,
                    keyB,
                    digest("plan"),
                    undefined,
                    2,
                    new Revision(2)
                )
            )
        ).toBe(false);
    });

    test("rejects forward rollback and union plans across deployments", { tags: "p1" }, () => {
        const active = plan(1, ["a"]);
        const otherKey = new DeploymentKey("elsewhere");
        const failedForeign = new MaterializationPlan({
            origin: new ManagedOrigin({
                ...origin(2),
                deploymentId: DeploymentId.derive(tenantId, otherKey)
            }),
            actors: []
        });
        expect(() => forwardRollbackPlan(active, failedForeign, origin(3))).toThrow(
            /Forward rollback must advance the same Tenant deployment/
        );

        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const first = beginRollout(controller, plan(1, ["a"]));
        acknowledgeAll(controller, store, first.id);
        controller.complete(first.id);
        store.loadPlan = () =>
            new MaterializationPlan({
                origin: new ManagedOrigin({
                    ...origin(1),
                    deploymentId: DeploymentId.derive(tenantId, otherKey)
                }),
                actors: []
            });
        expect(() =>
            controller.begin(
                plan(2, ["b"]),
                deploymentKey,
                undefined,
                undefined,
                validationAttestation(2)
            )
        ).toThrow(/Materialization rollout plans belong to different deployments/);
    });

    test("requires exact active-plan continuity across deployment transitions", { tags: "p0" }, () => {
        const initial = DeploymentRecord.initial(tenantId, deploymentKey);
        const forgedActive = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            digest("forged-active"),
            digest("pending"),
            2,
            new Revision(1)
        );
        expect(isLegalDeploymentTransition(initial, forgedActive)).toBe(false);

        const active = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            digest("active"),
            undefined,
            2,
            new Revision(2)
        );
        const begun = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            digest("active"),
            digest("pending"),
            3,
            new Revision(3)
        );
        const dropped = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            undefined,
            digest("pending"),
            3,
            new Revision(3)
        );
        expect(isLegalDeploymentTransition(active, begun)).toBe(true);
        expect(isLegalDeploymentTransition(active, dropped)).toBe(false);
    });

    test("completes a pending rollout whose plan already matches the active plan", { tags: "p0" }, () => {
        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        const store = new MemoryMaterializationControlStore(
            acknowledgedControlSnapshot(
                new DeploymentRecord(
                    deploymentId,
                    tenantId,
                    deploymentKey,
                    rollout.plan.id,
                    rollout.id,
                    2,
                    new Revision(1)
                ),
                rollout
            )
        );

        const completed = controllerFor(store).complete(rollout.id);

        expect(completed.pendingRolloutId).toBeUndefined();
        expect(completed.activePlanId?.equals(rollout.plan.id)).toBe(true);
        expect(completed.revision.value).toBe(2);
    });

    test("refuses to complete a rollout its deployment never began", { tags: "p0" }, () => {
        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        const store = new MemoryMaterializationControlStore(
            acknowledgedControlSnapshot(DeploymentRecord.initial(tenantId, deploymentKey), rollout)
        );

        expect(() => controllerFor(store).complete(rollout.id)).toThrow(
            "Deployment completion does not match its pending rollout"
        );
    });

    test("names a non-object control payload exactly", { tags: "p2" }, () => {
        expect(() => MaterializationRollout.fromData(null)).toThrow(
            "Materialization rollout must be an object"
        );
        expect(() => MaterializationOutboxEntry.fromData(null)).toThrow(
            "Materialization outbox must be an object"
        );
        expect(() => DeploymentRecord.fromData(null)).toThrow("Deployment must be an object");
    });

    // kills src/definition/rollout.ts:560 (dropping the compensates link from the candidate
    // rollout makes a same-generation compensation collide with the failed rollout identity)
    test("derives compensation rollout identity from its compensates link", { tags: "p0" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const failed = beginRollout(controller, plan(1, ["a"]));
        expect(() =>
            controller.begin(
                plan(1, ["a"]),
                deploymentKey,
                undefined,
                failed.id,
                validationAttestation(1)
            )
        ).toThrow(/not allocated/);
    });

    // kills src/definition/rollout.ts:625 (receipt outcome discriminant guard)
    test("rejects acknowledgement receipts whose outcome is not applied", { tags: "p0" }, () => {
        const store = new MemoryMaterializationControlStore();
        const controller = controllerFor(store);
        const rollout = beginRollout(controller, plan(1, ["a"]));
        const entry = outbox(store, rollout.id)[0]!;
        expect(() =>
            controller.acknowledge(entry.id, {
                ...receipt(entry, digest("reply")),
                outcome: "failed"
            } as never)
        ).toThrow(/does not match its target apply receipt/);
        expect(outbox(store, rollout.id)[0]!.status).toBe("pending");
    });

    // kills src/definition/rollout.ts:712 (independent id and rollout identity conjuncts)
    test("detects forged outbox identities that keep matching targets", { tags: "p1" }, () => {
        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        const expected = expectedOutboxEntries(rollout);
        const forgedId = Object.assign(
            Object.create(MaterializationOutboxEntry.prototype) as MaterializationOutboxEntry,
            expected[0],
            { id: digest("forged-outbox-id") }
        );
        expect(() => requireExactOutboxClosure(rollout, [forgedId])).toThrow(
            /exact target closure/
        );
        const forgedRollout = Object.assign(
            Object.create(MaterializationOutboxEntry.prototype) as MaterializationOutboxEntry,
            expected[0],
            { rolloutId: digest("forged-rollout-id") }
        );
        expect(() => requireExactOutboxClosure(rollout, [forgedRollout])).toThrow(
            /exact target closure/
        );
    });

    // kills src/definition/rollout.ts:737-739 (per-conjunct outbox transition guards)
    test("rejects forged outbox transitions that skip durable history", { tags: "p1" }, () => {
        const actorPlan = plan(1, ["a"]).actors[0]!;
        const entry = MaterializationOutboxEntry.pending(digest("rollout"), actorPlan);
        const forge = (
            base: MaterializationOutboxEntry,
            patch: Partial<Pick<MaterializationOutboxEntry, "attempts" | "revision">>
        ): MaterializationOutboxEntry =>
            Object.assign(
                Object.create(MaterializationOutboxEntry.prototype) as MaterializationOutboxEntry,
                base,
                patch
            );

        const pendingNext = forge(entry.attempted(), { attempts: entry.attempts });
        expect(isLegalOutboxTransition(entry, pendingNext)).toBe(false);

        const acknowledged = entry.acknowledge(digest("reply"));
        const reAcknowledged = forge(acknowledged, { revision: acknowledged.revision.next() });
        expect(isLegalOutboxTransition(acknowledged, reAcknowledged)).toBe(false);

        const skippedAttempts = forge(entry.attempted().acknowledge(digest("reply")), {
            revision: entry.revision.next()
        });
        expect(isLegalOutboxTransition(entry, skippedAttempts)).toBe(false);
    });

    // kills src/definition/rollout.ts:760 (identity conjuncts stay independently binding)
    test("rejects deployment transitions whose derived identity was forged", { tags: "p1" }, () => {
        const initial = DeploymentRecord.initial(tenantId, deploymentKey);
        const begun = initial.begin(digest("rollout"), 1);
        const forgedId = Object.assign(
            Object.create(DeploymentRecord.prototype) as DeploymentRecord,
            begun,
            { id: DeploymentId.derive(new TenantId("tenant-b"), deploymentKey) }
        );
        expect(isLegalDeploymentTransition(initial, forgedId)).toBe(false);
    });

    // kills src/definition/rollout.ts:869 (primitive payloads must fail the object guard)
    test("rejects primitive control payloads as non-objects", { tags: "p2" }, () => {
        expect(() => DeploymentRecord.fromData("text")).toThrow(/Deployment must be an object/);
        expect(() => MaterializationRollout.fromData(7)).toThrow(
            /Materialization rollout must be an object/
        );
        expect(() => MaterializationOutboxEntry.fromData("text")).toThrow(
            /Materialization outbox must be an object/
        );
    });
});

function acknowledgedControlSnapshot(
    deployment: DeploymentRecord,
    rollout: MaterializationRollout
): MemoryMaterializationControlSnapshot {
    return {
        attestations: [ValidationAttestation.encode(validationAttestation(rollout.plan.generation))],
        deployments: [DeploymentRecord.encode(deployment)],
        rollouts: [MaterializationRollout.encode(rollout)],
        outbox: rollout.plan.actors.map((actorPlan) =>
            MaterializationOutboxEntry.encode(
                MaterializationOutboxEntry.pending(rollout.id, actorPlan).acknowledge(
                    digest(`reply:${actorPlan.actor.id.value}`)
                )
            )
        )
    };
}

function rolloutContract<Transaction>(
    name: string,
    create: () => MaterializationControlStore<Transaction>
): void {
    test(`${name} [materialization-control-store] persists union-target outbox and completes only after every acknowledgement`, { tags: "p0" }, () => {
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

    test(`${name} allocates generations with CAS and keeps acknowledgements idempotent`, { tags: "p0" }, () => {
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

    test(`${name} creates forward rollback plans without rewinding target history`, { tags: "p1" }, () => {
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

    test(`${name} starts forward compensation while a prior rollout remains pending`, { tags: "p1" }, () => {
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

    test(`${name} compensates an initial pending rollout without an active predecessor`, { tags: "p1" }, () => {
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
