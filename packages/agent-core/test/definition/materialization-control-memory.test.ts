import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SemVer } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    DeploymentRecord,
    ManagedOrigin,
    MaterializationOutboxEntry,
    MaterializationPlan,
    MaterializationRollout,
    PlatformCompatibility,
    PolicySet,
    ValidationAttestation,
    policyProjection
} from "../../src/definition";
import { MemoryMaterializationControlStore } from "../../src/definition/memory";
import { TenantId } from "../../src/identity";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentKey = new DeploymentKey("platform");
const deploymentId = DeploymentId.derive(tenantId, deploymentKey);

describe("MemoryMaterializationControlStore integrity", () => {
    test("keeps control snapshots detached and deterministically ordered", { tags: "p1" }, () => {
        const store = new MemoryMaterializationControlStore();
        const first = validationAttestation(1);
        const second = validationAttestation(2);
        store.transaction((transaction) => {
            store.insertAttestation(transaction, second);
            store.insertAttestation(transaction, first);
        });
        expect([first, second].map((attestation) => attestation.id.value).sort()).toEqual([
            first.id.value,
            second.id.value
        ]);

        const snapshot = store.snapshot();
        expect(
            snapshot.attestations.map(
                (bytes) => ValidationAttestation.decode(bytes.slice()).id.value
            )
        ).toEqual([first.id.value, second.id.value]);
        snapshot.attestations[0]!.fill(0);
        expect(
            store
                .transaction((transaction) => store.loadAttestation(transaction, first.id))
                ?.id.equals(first.id)
        ).toBe(true);

        const detached = {
            attestations: store.snapshot().attestations.map((bytes) => bytes.slice()),
            deployments: [],
            rollouts: [],
            outbox: []
        };
        const restored = new MemoryMaterializationControlStore(detached);
        for (const bytes of detached.attestations) bytes.fill(0);
        expect(
            restored
                .transaction((transaction) => restored.loadAttestation(transaction, first.id))
                ?.id.equals(first.id)
        ).toBe(true);

        expect(
            () =>
                new MemoryMaterializationControlStore({
                    attestations: [
                        ValidationAttestation.encode(first),
                        ValidationAttestation.encode(first)
                    ],
                    deployments: [],
                    rollouts: [],
                    outbox: []
                })
        ).toThrow(/Control snapshot contains duplicate IDs/);
    });

    test("guards deployment CAS transitions through stored rollout lineage", { tags: "p0" }, () => {
        const illegal = new MemoryMaterializationControlStore();
        const forged = new DeploymentRecord(
            deploymentId,
            tenantId,
            deploymentKey,
            undefined,
            undefined,
            1,
            new Revision(1)
        );
        expect(() =>
            illegal.transaction((transaction) =>
                illegal.compareAndSetDeployment(transaction, undefined, forged)
            )
        ).toThrow(/Deployment transition is invalid/);
        expect(
            illegal.transaction((transaction) =>
                illegal.compareAndSetDeployment(
                    transaction,
                    new Revision(0),
                    DeploymentRecord.initial(tenantId, deploymentKey)
                )
            )
        ).toBe(false);

        const { store, deployment } = storeWithDeployment();
        const dangling = deployment.begin(digest("dangling-rollout"), 1);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, deployment.revision, dangling)
            )
        ).toThrow(/Deployment transition is invalid/);

        const wrongGenerationRollout = new MaterializationRollout({ plan: plan(2, ["a"]) });
        store.transaction((transaction) => {
            store.insertAttestation(transaction, validationAttestation(2));
            store.insertRollout(transaction, wrongGenerationRollout);
        });
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    deployment.revision,
                    deployment.begin(wrongGenerationRollout.id, 1)
                )
            )
        ).toThrow(/Deployment transition is invalid/);

        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        store.transaction((transaction) => store.insertRollout(transaction, rollout));
        const begun = deployment.begin(rollout.id, 1);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, deployment.revision, begun)
            )
        ).toBe(true);

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.complete(rollout.id, digest("wrong-plan"))
                )
            )
        ).toThrow(/Deployment transition is invalid/);

        const snapshot = store.snapshot();
        const detachedPending = new MemoryMaterializationControlStore({
            attestations: snapshot.attestations,
            deployments: snapshot.deployments,
            rollouts: [],
            outbox: []
        });
        expect(() =>
            detachedPending.transaction((transaction) =>
                detachedPending.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.complete(rollout.id, rollout.plan.id)
                )
            )
        ).toThrow(/Deployment transition is invalid/);

        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.complete(rollout.id, rollout.plan.id)
                )
            )
        ).toBe(true);
    });

    test("guards compensation lineage against forged rollout links", { tags: "p0" }, () => {
        const { store, deployment } = storeWithDeployment();
        const failed = new MaterializationRollout({ plan: plan(1, ["a"]) });
        store.transaction((transaction) => store.insertRollout(transaction, failed));
        const begun = deployment.begin(failed.id, 1);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, deployment.revision, begun)
            )
        ).toBe(true);

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.compensate(failed.id, digest("missing-compensation"), 2)
                )
            )
        ).toThrow(/Deployment transition is invalid/);

        const unlinked = new MaterializationRollout({ plan: plan(2, ["a"]) });
        const wrongGeneration = new MaterializationRollout({
            plan: plan(3, ["a"]),
            compensates: failed.id
        });
        const compensation = new MaterializationRollout({
            plan: plan(2, ["a"]),
            compensates: failed.id
        });
        store.transaction((transaction) => {
            store.insertAttestation(transaction, validationAttestation(2));
            store.insertAttestation(transaction, validationAttestation(3));
            store.insertRollout(transaction, unlinked);
            store.insertRollout(transaction, wrongGeneration);
            store.insertRollout(transaction, compensation);
        });

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.compensate(failed.id, unlinked.id, 2)
                )
            )
        ).toThrow(/Deployment transition is invalid/);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.compensate(failed.id, wrongGeneration.id, 2)
                )
            )
        ).toThrow(/Deployment transition is invalid/);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    begun.revision,
                    begun.compensate(failed.id, compensation.id, 2)
                )
            )
        ).toBe(true);
    });

    test("requires stored prerequisites and immutable outbox identities", { tags: "p0" }, () => {
        const bare = new MemoryMaterializationControlStore();
        bare.transaction((transaction) => {
            expect(
                bare.compareAndSetDeployment(
                    transaction,
                    undefined,
                    DeploymentRecord.initial(tenantId, deploymentKey)
                )
            ).toBe(true);
        });
        expect(() =>
            bare.transaction((transaction) =>
                bare.insertRollout(transaction, new MaterializationRollout({ plan: plan(1, ["a"]) }))
            )
        ).toThrow(/Materialization rollout requires its stored validation attestation/);

        const { store } = storeWithDeployment();
        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        const entry = MaterializationOutboxEntry.pending(rollout.id, rollout.plan.actors[0]!);
        store.transaction((transaction) => {
            store.insertRollout(transaction, rollout);
            store.insertOutbox(transaction, entry);
        });
        expect(() =>
            store.transaction((transaction) => store.insertOutbox(transaction, entry))
        ).not.toThrow();
        expect(() =>
            store.transaction((transaction) =>
                store.insertOutbox(transaction, entry.attempted())
            )
        ).toThrow(/Materialization outbox entry .* is immutable/);
    });

    test("outbox CAS honors exact revisions and legal transitions", { tags: "p0" }, () => {
        const { store } = storeWithDeployment();
        const rollout = new MaterializationRollout({ plan: plan(1, ["a", "b"]) });
        const [planA, planB] = rollout.plan.actors;
        const entryA = MaterializationOutboxEntry.pending(rollout.id, planA!);
        const entryB = MaterializationOutboxEntry.pending(rollout.id, planB!);
        store.transaction((transaction) => {
            store.insertRollout(transaction, rollout);
            store.insertOutbox(transaction, entryA);
        });

        expect(
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, new Revision(0), entryB)
            )
        ).toBe(false);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, new Revision(5), entryA.attempted())
            )
        ).toBe(false);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, new Revision(0), entryA.attempted())
            )
        ).toBe(true);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetOutbox(
                    transaction,
                    new Revision(1),
                    entryA.attempted().attempted().attempted()
                )
            )
        ).toThrow(/Materialization outbox transition is invalid/);
    });

    test("isolates transaction draft bytes from committed control state", { tags: "p0" }, () => {
        // kills src/definition/memory.ts:734 (transaction draft byte detachment)
        const store = new MemoryMaterializationControlStore();
        const attestation = validationAttestation(1);
        store.transaction((transaction) => store.insertAttestation(transaction, attestation));

        expect(() =>
            store.transaction((transaction) => {
                transaction.attestations.get(attestation.id.value)!.fill(0);
                throw new TypeError("injected rollback");
            })
        ).toThrow(/injected rollback/);
        expect(
            store
                .transaction((transaction) => store.loadAttestation(transaction, attestation.id))
                ?.id.equals(attestation.id)
        ).toBe(true);
    });

    test("names every missing closure linkage during snapshot restore", { tags: "p1" }, () => {
        const { store, deployment } = storeWithDeployment();
        const rollout = new MaterializationRollout({ plan: plan(1, ["a"]) });
        store.transaction((transaction) => {
            store.insertRollout(transaction, rollout);
            store.insertOutbox(
                transaction,
                MaterializationOutboxEntry.pending(rollout.id, rollout.plan.actors[0]!)
            );
            expect(
                store.compareAndSetDeployment(
                    transaction,
                    deployment.revision,
                    deployment.begin(rollout.id, 1)
                )
            ).toBe(true);
        });
        const snapshot = store.snapshot();

        expect(
            () =>
                new MemoryMaterializationControlStore({
                    attestations: snapshot.attestations,
                    deployments: [],
                    rollouts: snapshot.rollouts,
                    outbox: snapshot.outbox
                })
        ).toThrow(/Stored rollout has no deployment/);
        expect(
            () =>
                new MemoryMaterializationControlStore({
                    attestations: [],
                    deployments: snapshot.deployments,
                    rollouts: snapshot.rollouts,
                    outbox: snapshot.outbox
                })
        ).toThrow(/Stored rollout has no validation attestation/);
        expect(
            () =>
                new MemoryMaterializationControlStore({
                    attestations: snapshot.attestations,
                    deployments: snapshot.deployments,
                    rollouts: [],
                    outbox: snapshot.outbox
                })
        ).toThrow(/Stored outbox entry has no rollout/);
    });

    test("loads plans and outbox entries by exact identity", { tags: "p1" }, () => {
        const { store } = storeWithDeployment();
        const first = new MaterializationRollout({ plan: plan(1, ["a", "b"]) });
        const second = new MaterializationRollout({ plan: plan(2, ["a"]) });
        const [planA, planB] = first.plan.actors;
        const entryA = MaterializationOutboxEntry.pending(first.id, planA!);
        const entryB = MaterializationOutboxEntry.pending(first.id, planB!);
        expect([entryA.id.value, entryB.id.value].sort()).toEqual([
            entryA.id.value,
            entryB.id.value
        ]);
        store.transaction((transaction) => {
            store.insertAttestation(transaction, validationAttestation(2));
            store.insertRollout(transaction, first);
            store.insertRollout(transaction, second);
            store.insertOutbox(transaction, entryB);
            store.insertOutbox(transaction, entryA);
            store.insertOutbox(
                transaction,
                MaterializationOutboxEntry.pending(second.id, second.plan.actors[0]!)
            );
        });

        expect(
            store
                .transaction((transaction) => store.loadPlan(transaction, second.plan.id))
                ?.id.equals(second.plan.id)
        ).toBe(true);
        expect(
            store.transaction((transaction) => store.loadPlan(transaction, digest("missing-plan")))
        ).toBeUndefined();
        expect(
            store
                .transaction((transaction) => store.listOutbox(transaction, first.id))
                .map((entry) => entry.id.value)
        ).toEqual([entryA.id.value, entryB.id.value]);
    });
});

function storeWithDeployment(): {
    store: MemoryMaterializationControlStore;
    deployment: DeploymentRecord;
} {
    const store = new MemoryMaterializationControlStore();
    const deployment = DeploymentRecord.initial(tenantId, deploymentKey);
    store.transaction((transaction) => {
        store.insertAttestation(transaction, validationAttestation(1));
        expect(store.compareAndSetDeployment(transaction, undefined, deployment)).toBe(true);
    });
    return { store, deployment };
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

function validationAttestation(generation: number): ValidationAttestation {
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

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
