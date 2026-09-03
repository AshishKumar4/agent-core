import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SemVer } from "../../src/core";
import {
    ActorPlan,
    applyReconciliation,
    DeferredManagedRecord,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    PackageId,
    PackagePin,
    PackagePinHolder,
    PackageRetentionObligation,
    PendingObligationSet,
    PlacementPolicy,
    planReconciliation,
    policyProjection,
    PolicySet,
    ReconciliationDeferral,
    ReconciliationPlan,
    RelianceHoldObligation,
    RunPinEvidence,
    type ManagedResourceChange,
    type ManagedResourceSnapshot
} from "../../src/definition";
import { TenantId } from "../../src/identity";
import { FacetRef } from "../../src/facets";
import { forged } from "./record-data";
import {
    MemoryManagedResourcePort,
    type MemoryManagedResourceState
} from "./managed-resource-port";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const actor = new ActorRef("workspace", new ActorId("workspace"));
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("reconciliation adversarial boundaries", () => {
    test("rejects duplicate desired and duplicate owner snapshots", { tags: "p1" }, () => {
        const desired = record(1, "policy:a", PolicySet.empty());
        const state = memoryState();
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        expect(() => planReconciliation(state, port, owner(), [], [desired, desired])).toThrow(
            /duplicate managed resource/
        );

        const snapshot = snapshotOf(desired);
        const duplicatePort =
            new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                public override list(): readonly ManagedResourceSnapshot[] {
                    return [snapshot, snapshot];
                }
            })();
        expect(() => planReconciliation(state, duplicatePort, owner(), [desired], [])).toThrow(
            /duplicate identity/
        );
    });

    test("rejects missing occupied foreign and removal drift", { tags: "p0" }, () => {
        const previous = record(1, "policy:a", PolicySet.empty());
        const desired = record(
            2,
            "policy:a",
            new PolicySet({ placement: PlacementPolicy.all(), approvals: ["execute"] })
        );
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

    test(
        "rejects malformed deferrals and owner adapters that lie about mutation",
        { tags: "p0" },
        () => {
            const previous = record(1, "policy:a", PolicySet.empty());
            const desired = record(
                2,
                "policy:a",
                new PolicySet({ placement: PlacementPolicy.all(), approvals: ["execute"] })
            );
            const state = memoryState(snapshotOf(previous));
            const malformed =
                new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                    public override deferrals(): ReconciliationDeferral {
                        return forged<ReconciliationDeferral>({});
                    }
                })();
            expect(() =>
                planReconciliation(state, malformed, owner(), [previous], [desired])
            ).toThrow(/malformed deferral/);

            const foreign =
                new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                    public override deferrals(
                        _transaction: MemoryManagedResourceState,
                        change: ManagedResourceChange
                    ): ReconciliationDeferral {
                        return ReconciliationDeferral.holding([
                            new RelianceHoldObligation(
                                new DeferredManagedRecord({
                                    ...change,
                                    current: { ...change.current, resourceId: digest("elsewhere") }
                                }),
                                new FacetRef("core:dependent")
                            )
                        ]);
                    }
                })();
            expect(() =>
                planReconciliation(state, foreign, owner(), [previous], [desired])
            ).toThrow(/deferral names another record/);

            const noRemove =
                new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                    public override remove(): void {}
                })();
            const removal = planReconciliation(state, noRemove, owner(), [previous], []);
            expect(() => applyReconciliation(state, noRemove, removal)).toThrow(
                /removal did not persist/
            );

            const wrongCreate =
                new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                    public override create(
                        _transaction: MemoryManagedResourceState,
                        next: ManagedStateRecord
                    ) {
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
                applyReconciliation(
                    state,
                    noRemove,
                    new ReconciliationPlan(
                        [],
                        new PendingObligationSet([
                            new PackageRetentionObligation(
                                new DeferredManagedRecord({
                                    kind: "remove",
                                    current: snapshotOf(previous)
                                }),
                                pinnedRelease(),
                                new PackagePinHolder("run", "run-holding")
                            )
                        ])
                    )
                )
            ).not.toThrow();
            expect(() =>
                applyReconciliation(
                    state,
                    noRemove,
                    new ReconciliationPlan(
                        [{ kind: "noop", current: snapshotOf(previous), desired: previous }],
                        PendingObligationSet.empty
                    )
                )
            ).not.toThrow();
        }
    );

    test(
        "derives removals from the previous closure even when list omits resources",
        { tags: "p1" },
        () => {
            const previous = record(1, "policy:a", PolicySet.empty());
            const state = memoryState(snapshotOf(previous));
            const omitted =
                new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
                    public override list(): readonly ManagedResourceSnapshot[] {
                        return [];
                    }
                })();
            expect(
                planReconciliation(state, omitted, owner(), [previous], []).actions
            ).toMatchObject([{ kind: "remove" }]);

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
        }
    );
});

describe("reconciliation ordering and persistence proof", () => {
    test(
        "orders actions create update noop remove with identity tie-breaks",
        { tags: "p1" },
        () => {
            const candidates = ["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) =>
                record(1, `policy:${suffix}`, PolicySet.empty())
            );
            const ranked = [...candidates].sort((left, right) =>
                left.resourceId.value < right.resourceId.value ? -1 : 1
            );
            const updatePrevious = ranked[0]!;
            const updateDesired = record(
                2,
                updatePrevious.logicalKey,
                new PolicySet({ placement: PlacementPolicy.all(), approvals: ["execute"] })
            );
            const noop = ranked[1]!;
            const removeSmall = ranked[2]!;
            const removeLarge = ranked[3]!;
            const createSmall = ranked[4]!;
            const createLarge = ranked[5]!;
            const state = memoryState();
            for (const kept of [updatePrevious, noop, removeSmall, removeLarge]) {
                state.resources.set(kept.resourceId.value, snapshotOf(kept));
            }
            const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();

            const plan = planReconciliation(
                state,
                port,
                owner(),
                [removeLarge, removeSmall, updatePrevious, noop],
                [updateDesired, createLarge, noop, createSmall]
            );

            expect(plan.converged).toBe(true);
            expect(plan.actions.map((action) => action.kind)).toEqual([
                "create",
                "create",
                "update",
                "noop",
                "remove",
                "remove"
            ]);
            expect(
                plan.actions.map((action) =>
                    action.kind === "create"
                        ? action.desired.resourceId.value
                        : action.current.resourceId.value
                )
            ).toEqual(
                [createSmall, createLarge, updatePrevious, noop, removeSmall, removeLarge].map(
                    (entry) => entry.resourceId.value
                )
            );
        }
    );

    test("sorts the pending set canonically across obligation kinds", { tags: "p1" }, () => {
        const updatePrevious = record(1, "policy:update", PolicySet.empty());
        const updateDesired = record(
            2,
            "policy:update",
            new PolicySet({ placement: PlacementPolicy.all(), approvals: ["execute"] })
        );
        const removed = record(1, "policy:removed", PolicySet.empty());
        const state = memoryState();
        state.resources.set(updatePrevious.resourceId.value, snapshotOf(updatePrevious));
        state.resources.set(removed.resourceId.value, snapshotOf(removed));
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        port.deferral = (change) =>
            change.kind === "update"
                ? ReconciliationDeferral.holding([
                      new RelianceHoldObligation(
                          new DeferredManagedRecord(change),
                          new FacetRef("core:dependent")
                      )
                  ])
                : RunPinEvidence.retained([
                      new PackagePinHolder("snapshot", "snapshot-late"),
                      new PackagePinHolder("run", "run-early")
                  ]).deferral(new DeferredManagedRecord(change), pinnedRelease());

        const plan = planReconciliation(
            state,
            port,
            owner(),
            [updatePrevious, removed],
            [updateDesired]
        );
        expect(plan.converged).toBe(false);
        expect(plan.pending.obligations.map((obligation) => obligation.key)).toEqual(
            [...plan.pending.obligations].map((obligation) => obligation.key).toSorted()
        );
        expect(plan.pending.ofKind("reliance").map((obligation) => obligation.record)).toEqual([
            "core:dependent"
        ]);
        expect(plan.pending.ofKind("retention").map((obligation) => obligation.reason)).toEqual(
            [
                new PackagePinHolder("run", "run-early"),
                new PackagePinHolder("snapshot", "snapshot-late")
            ]
                .map((holder) => `${holder.key} pins that Package release`)
                .toSorted()
        );
    });

    test("applies nothing while any obligation stands", { tags: "p0" }, () => {
        const desired = record(1, "policy:gated", PolicySet.empty());
        const state = memoryState();
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();

        applyReconciliation(
            state,
            port,
            new ReconciliationPlan(
                [{ kind: "create", desired }],
                new PendingObligationSet([
                    new PackageRetentionObligation(
                        new DeferredManagedRecord({
                            kind: "remove",
                            current: snapshotOf(desired)
                        }),
                        pinnedRelease(),
                        new PackagePinHolder("tree-checkpoint", "checkpoint-gated")
                    )
                ])
            )
        );
        expect(state.resources.size).toBe(0);
    });

    test("rejects snapshots whose logical identity drifted from the record", { tags: "p1" }, () => {
        const desired = record(1, "policy:a", PolicySet.empty());
        const state = memoryState();
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();

        state.resources.set(
            desired.resourceId.value,
            Object.freeze({ ...snapshotOf(desired), logicalKey: "policy:other" })
        );
        expect(() => planReconciliation(state, port, owner(), [desired], [desired])).toThrow(
            /foreign ownership or identity/
        );

        state.resources.set(
            desired.resourceId.value,
            Object.freeze({ ...snapshotOf(desired), recordKind: "slot-entry" })
        );
        expect(() => planReconciliation(state, port, owner(), [desired], [desired])).toThrow(
            /foreign ownership or identity/
        );
    });

    test("rejects owner adapters that persist stale desired state", { tags: "p0" }, () => {
        const previous = record(1, "policy:a", PolicySet.empty());
        const desired = record(
            2,
            "policy:a",
            new PolicySet({ placement: PlacementPolicy.all(), approvals: ["execute"] })
        );
        const state = memoryState(snapshotOf(previous));
        const stale = new (class extends MemoryManagedResourcePort<MemoryManagedResourceState> {
            public override update(
                transaction: MemoryManagedResourceState,
                current: ManagedResourceSnapshot,
                next: ManagedStateRecord
            ): ManagedResourceSnapshot {
                const snapshot = Object.freeze({
                    actor: next.actor,
                    tenantId: next.origin.tenantId,
                    deploymentId: next.origin.deploymentId,
                    resourceId: next.resourceId,
                    logicalKey: next.logicalKey,
                    recordKind: next.recordKind,
                    desiredDigest: current.desiredDigest,
                    revision: current.revision.next()
                });
                transaction.resources.set(next.resourceId.value, snapshot);
                return snapshot;
            }
        })();

        const plan = planReconciliation(state, stale, owner(), [previous], [desired]);
        expect(() => applyReconciliation(state, stale, plan)).toThrow(
            /Managed resource .* did not persist desired state/
        );
    });

    test("labels duplicate identities with their generation subject", { tags: "p2" }, () => {
        const desired = record(1, "policy:a", PolicySet.empty());
        const port = new MemoryManagedResourcePort<MemoryManagedResourceState>();
        expect(() =>
            planReconciliation(memoryState(), port, owner(), [desired, desired], [])
        ).toThrow(/previous generation contains duplicate managed resource identity/);
        expect(() =>
            planReconciliation(memoryState(), port, owner(), [], [desired, desired])
        ).toThrow(/desired generation contains duplicate managed resource identity/);
    });
});

function pinnedRelease(): PackagePin {
    return new PackagePin(
        new PackageId("acme.deploy"),
        new SemVer("1.4.0"),
        digest("manifest"),
        digest("code")
    );
}

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
