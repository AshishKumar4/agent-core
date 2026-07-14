import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    PolicySet,
    applyReconciliation,
    planReconciliation,
    policyProjection,
    type ManagedResourceSnapshot
} from "../../src/definition";
import { TenantId } from "../../src/identity";
import {
    MemoryManagedResourcePort,
    type MemoryManagedResourceState
} from "./managed-resource-port";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const actor = new ActorRef("workspace", new ActorId("workspace"));
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("reconciliation adversarial boundaries", () => {
    test("rejects duplicate desired and duplicate owner snapshots", () => {
        const desired = record(1, "policy:a", PolicySet.empty());
        const state = memoryState();
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        expect(() => planReconciliation(state, port, owner(), [], [desired, desired])).toThrow(
            /duplicate managed resource/
        );

        const snapshot = snapshotOf(desired);
        const duplicatePort =
            new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                public list(): readonly ManagedResourceSnapshot[] {
                    return [snapshot, snapshot];
                }
            })();
        expect(() => planReconciliation(state, duplicatePort, owner(), [desired], [])).toThrow(
            /duplicate identity/
        );
    });

    test("rejects missing occupied foreign and removal drift", () => {
        const previous = record(1, "policy:a", PolicySet.empty());
        const desired = record(2, "policy:a", new PolicySet({ approvals: ["execute"] }));
        const state = memoryState();
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        expect(() => planReconciliation(state, port, owner(), [previous], [desired])).toThrow(
            /drifted missing/
        );

        state.resources.set(
            previous.resourceId.value,
            Object.freeze({
                ...snapshotOf(previous),
                actor: new ActorRef("workspace", new ActorId("foreign"))
            })
        );
        expect(() => planReconciliation(state, port, owner(), [], [desired])).toThrow(
            /foreign ownership/
        );

        state.resources.set(previous.resourceId.value, snapshotOf(previous));
        expect(() => planReconciliation(state, port, owner(), [], [desired])).toThrow(
            /occupied outside/
        );

        state.resources.set(
            previous.resourceId.value,
            Object.freeze({
                ...snapshotOf(previous),
                desiredDigest: digest("manual")
            })
        );
        expect(() => planReconciliation(state, port, owner(), [previous], [])).toThrow(
            /removed after drift/
        );
    });

    test("rejects malformed pin evidence and owner adapters that lie about mutation", () => {
        const previous = record(1, "policy:a", PolicySet.empty());
        const desired = record(2, "policy:a", new PolicySet({ approvals: ["execute"] }));
        const state = memoryState(snapshotOf(previous));
        const malformed = new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
            public pinEvidence(): import("../../src/definition").RunPinEvidence {
                return {} as import("../../src/definition").RunPinEvidence;
            }
        })();
        expect(() => planReconciliation(state, malformed, owner(), [previous], [desired])).toThrow(
            /malformed RunPins/
        );

        const noRemove = new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
            public remove(): void {}
        })();
        const removal = planReconciliation(state, noRemove, owner(), [previous], []);
        expect(() => applyReconciliation(state, noRemove, removal)).toThrow(
            /removal did not persist/
        );

        const wrongCreate =
            new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                public create(_transaction: MemoryManagedResourceState, next: ManagedStateRecord) {
                    return snapshotOf(next);
                }
            })();
        expect(() =>
            applyReconciliation(
                memoryState(),
                wrongCreate,
                planReconciliation(memoryState(), wrongCreate, owner(), [], [previous])
            )
        ).toThrow(/mutation did not persist/);

        expect(() =>
            applyReconciliation(state, noRemove, {
                actions: [],
                blockers: ["unknown:w5"]
            })
        ).not.toThrow();
        expect(() =>
            applyReconciliation(state, noRemove, {
                actions: [{ kind: "noop", current: snapshotOf(previous), desired: previous }],
                blockers: []
            })
        ).not.toThrow();
    });

    test("derives removals from the previous closure even when list omits resources", () => {
        const previous = record(1, "policy:a", PolicySet.empty());
        const state = memoryState(snapshotOf(previous));
        const omitted = new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
            public list(): readonly ManagedResourceSnapshot[] {
                return [];
            }
        })();
        expect(planReconciliation(state, omitted, owner(), [previous], []).actions).toMatchObject([
            { kind: "remove" }
        ]);

        const extra = record(1, "policy:extra", PolicySet.empty());
        state.resources.set(extra.resourceId.value, snapshotOf(extra));
        expect(() => planReconciliation(state, omitted, owner(), [previous], [])).not.toThrow();
        const listing = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        expect(() => planReconciliation(state, listing, owner(), [previous], [])).toThrow(
            /absent from generation closure/
        );

        const missing = memoryState();
        expect(() => planReconciliation(missing, listing, owner(), [previous], [])).toThrow(
            /drifted missing before removal/
        );
    });
});

function record(generation: number, logicalKey: string, policy: PolicySet): ManagedStateRecord {
    const materializationOrigin = origin(generation);
    const actorPlan = new ActorPlan({
        actor,
        origin: materializationOrigin,
        projections: [policyProjection(logicalKey, policy)]
    });
    const materializationGeneration = MaterializationGeneration.fromActorPlan(actorPlan);
    return ManagedStateRecord.fromProjection(
        actor,
        materializationOrigin,
        materializationGeneration.id,
        actorPlan.projections[0]!
    );
}

function snapshotOf(record: ManagedStateRecord): ManagedResourceSnapshot {
    return Object.freeze({
        ...owner(),
        resourceId: record.resourceId,
        logicalKey: record.logicalKey,
        recordKind: record.recordKind,
        desiredDigest: record.desiredDigest,
        revision: Revision.initial()
    });
}

function memoryState(snapshot?: ManagedResourceSnapshot): MemoryManagedResourceState {
    return {
        resources: new Map(snapshot === undefined ? [] : [[snapshot.resourceId.value, snapshot]])
    };
}

function owner() {
    return { tenantId, deploymentId, actor };
}

function origin(generation: number): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digest(`attestation:${generation}`),
        blueprintDigest: digest(`blueprint:${generation}`),
        packageLockDigest: digest(`lock:${generation}`),
        configDigest: digest(`config:${generation}`),
        generation
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
