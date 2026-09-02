import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SemVer, canonicalTupleKey } from "../../src/core";
import {
    ActorPlan,
    DeferredManagedRecord,
    DeploymentId,
    DeploymentKey,
    InvocationDrainObligation,
    ManagedOrigin,
    AdoptedManagedRecord,
    PackageId,
    PackagePin,
    PackagePinHolder,
    PackageRetentionObligation,
    PendingObligationSet,
    PolicySet,
    ReconciliationDeferral,
    ReconciliationPlan,
    RecordedRunPinsReservationPort,
    RelianceHoldObligation,
    RouteReservationObligation,
    policyProjection,
    type DefinitionPinSet,
    type DesiredProjection,
    type ManagedResourceChange,
    type ManagedResourceSnapshot,
    type ReconciliationObligation,
    type ReconciliationObligationKind
} from "../../src/definition";
import {
    LocalMaterializer,
    materializeActorPlan,
    type LocalMaterializationResult
} from "../../src/definition/materializer";
import { FacetRef } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { InvocationId, RouteReservationId } from "../../src/interaction-references";
import {
    LocalRecordStore,
    MemoryManagedResourcePort,
    PinHoldingManagedResourcePort,
    type LocalRecordStoreState
} from "./managed-resource-port";
import { forged } from "./record-data";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));
const actor = new ActorRef("workspace", new ActorId("workspace-convergence"));

interface HeldWithdrawal {
    readonly result: LocalMaterializationResult;
    readonly store: LocalRecordStore;
    readonly held: readonly ManagedResourceSnapshot[];
}

interface ExpectedObligation {
    readonly kind: ReconciliationObligationKind;
    readonly record: string;
    readonly reason: string;
    readonly condition: string;
}

/**
 * SPEC 9.3: the Blueprint-managed record set a converged Scope holds is a function of the
 * Blueprint alone — independent of the order the materializer issued admissible changes in,
 * and of the managed set the Scope held before.
 */
describe("Blueprint convergence", () => {
    test(
        "[C13-BLUEPRINT-CONVERGENCE] reaches one Blueprint-managed record set from two issue orders and two prior managed states",
        { tags: "p0" },
        () => {
            // One Blueprint, four admissible paths to it. Two differ in the order the
            // materializer issued the installs and updates; two start from a Scope holding
            // a managed set the Blueprint never declares, so a reconciler that only ever
            // built the declared state from an empty Scope fails here.
            const paths = [
                ["direct from an empty Scope", [declared(1)]],
                ["a, c issued before b", [subset(1), declared(2)]],
                ["direct from a divergent prior set", [divergentPrior(1), declared(2)]],
                [
                    "b issued after a divergent prior set",
                    [divergentPrior(1), subset(2), declared(3)]
                ]
            ] as const satisfies readonly (readonly [string, readonly ActorPlan[]])[];

            const declaredSet = declaredIdentity(declared(1));
            expect(declaredSet).toHaveLength(3);
            for (const [label, steps] of paths) {
                expect(`${label}: ${applyPath(steps).join(" ")}`).toBe(
                    `${label}: ${declaredSet.join(" ")}`
                );
            }
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] holds a reliance withdrawal as an obligation naming its record, reason, and condition",
        { tags: "p0" },
        () => {
            const withdrawal = withdrawalHeldBy((change) =>
                ReconciliationDeferral.holding([
                    new RelianceHoldObligation(
                        new DeferredManagedRecord(change),
                        new FacetRef("acme.dashboard:cards")
                    )
                ])
            );

            expectHeldWithdrawal(withdrawal, {
                kind: "reliance",
                record: "acme.dashboard:cards",
                reason: "active Facet acme.dashboard:cards relies on the withdrawing Facet",
                condition: "no active Facet relies on the withdrawing Facet"
            });
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] holds each draining Invocation item as its own obligation",
        { tags: "p0" },
        () => {
            const withdrawal = withdrawalHeldBy((change) =>
                ReconciliationDeferral.holding([
                    new InvocationDrainObligation(
                        new DeferredManagedRecord(change),
                        new InvocationId("invocation-second")
                    ),
                    new InvocationDrainObligation(
                        new DeferredManagedRecord(change),
                        new InvocationId("invocation-first")
                    )
                ])
            );

            // Each admitted item is its own obligation rather than one aggregate the host
            // could discharge by settling whichever item it likes.
            expect(withdrawal.result.pending.obligations.map((entry) => entry.record)).toEqual([
                "invocation-first",
                "invocation-second"
            ]);
            expectHeldWithdrawal(withdrawal, {
                kind: "drain",
                record: "invocation-first",
                reason: "admitted Invocation item invocation-first is draining against the withdrawing Facet",
                condition: "that item holds a terminal current Receipt"
            });
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] holds each unadmitted RouteReservation as its own obligation",
        { tags: "p0" },
        () => {
            const withdrawal = withdrawalHeldBy((change) =>
                ReconciliationDeferral.holding([
                    new RouteReservationObligation(
                        new DeferredManagedRecord(change),
                        new RouteReservationId("reservation-unadmitted")
                    )
                ])
            );

            expectHeldWithdrawal(withdrawal, {
                kind: "reservation",
                record: "reservation-unadmitted",
                reason: "retired Subscriptions leave RouteReservation reservation-unadmitted unadmitted",
                condition: "its owning Actor has written its terminal rejected RouteDelivery"
            });
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] holds a Package release SPEC 5.2 still pins as an obligation naming its holder",
        { tags: "p0" },
        () => {
            const reservations = new RecordedRunPinsReservationPort<LocalRecordStoreState>();
            reservations.reserve(scratchState(), {
                holder: new PackagePinHolder("session", "environment-session:live"),
                pins: pinnedClosure(),
                sourceRevision: Revision.initial(),
                idempotencyKey: "session-holds-release"
            });
            const port = new PinHoldingManagedResourcePort<LocalRecordStoreState>(
                reservations,
                pinnedClosure(),
                pinnedRelease()
            );
            const store = new LocalRecordStore(actor, port);
            const materializer = new LocalMaterializer({ actor, store, resources: port });
            materializer.apply(withdrawn(1));
            const held = store.resources;

            expectHeldWithdrawal(
                { result: materializer.apply(retained(2)), store, held },
                {
                    kind: "retention",
                    record: canonicalTupleKey("definition.package-retention-record.v1", [
                        "acme.deploy",
                        "1.4.0"
                    ]),
                    reason: `${
                        new PackagePinHolder("session", "environment-session:live").key
                    } pins that Package release`,
                    condition:
                        "no Run, Turn, Session, tree checkpoint, or Snapshot pins that release or a Run explicitly migrates"
                }
            );
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] states convergence only as the pending set being empty",
        { tags: "p0" },
        () => {
            const reservations = new RecordedRunPinsReservationPort<LocalRecordStoreState>();
            const reservation = reservations.reserve(scratchState(), {
                holder: new PackagePinHolder("turn", "turn:holding"),
                pins: pinnedClosure(),
                sourceRevision: Revision.initial(),
                idempotencyKey: "turn-holds-release"
            });
            const port = new PinHoldingManagedResourcePort<LocalRecordStoreState>(
                reservations,
                pinnedClosure(),
                pinnedRelease()
            );
            const store = new LocalRecordStore(actor, port);
            const materializer = new LocalMaterializer({ actor, store, resources: port });
            materializer.apply(withdrawn(1));

            const holding = materializer.apply(retained(2));
            expect(holding.pending.converged).toBe(false);
            expect(holding.pending.obligations).toHaveLength(1);
            expect(store.resources).toHaveLength(2);

            // The same withdrawal converges once the obligation discharges, and nothing
            // else about the plan changed: convergence is that set being empty.
            reservations.release(scratchState(), reservation);
            const discharged = materializer.apply(retained(2));
            expect(discharged.pending.converged).toBe(true);
            expect(discharged.pending.obligations).toEqual([]);
            expect(managedIdentity(store.resources)).toEqual(declaredIdentity(retained(2)));

            // A convergence answer supplied beside the obligations is not constructible:
            // the outcome type derives it from the set it carries.
            // SAFETY: a structural counterfeit is the only way to present a convergence
            // answer beside the obligations; the real value object derives it, so the guard
            // can be reached no other way.
            const supplied = forged<PendingObligationSet>({
                converged: true,
                obligations: [
                    {
                        kind: "retention",
                        record: canonicalTupleKey("definition.package-retention-record.v1", [
                            "acme.deploy",
                            "1.4.0"
                        ])
                    }
                ]
            });
            expect(() => new ReconciliationPlan([], supplied)).toThrow(
                /carries its own pending set/
            );
            expect(new PendingObligationSet([pendingRetention()]).converged).toBe(false);
            expect(PendingObligationSet.empty.converged).toBe(true);
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] rejects a divergence no obligation expresses instead of leaving it pending",
        { tags: "p0" },
        () => {
            const port = new MemoryManagedResourcePort<LocalRecordStoreState>();
            const store = new LocalRecordStore(actor, port);
            const materializer = new LocalMaterializer({ actor, store, resources: port });
            materializer.apply(withdrawn(1));
            const held = store.resources;
            port.deferral = () =>
                ReconciliationDeferral.unanswerable("withdrawal set cannot be computed");

            // A host that cannot say which obligation holds the change has a divergence
            // SPEC 9.3 states no deferral for: the reconciliation is refused outright rather
            // than admitted with an empty pending set or an unstated blocker.
            expect(() => materializer.apply(retained(2))).toThrow(
                /divergence is not expressible as a pending obligation: withdrawal set cannot be computed/
            );
            expect(store.resources).toEqual(held);
            expect(store.managedRecords).toHaveLength(2);
            expect(() => ReconciliationDeferral.holding([])).toThrow(/at least one obligation/);
            expect(ReconciliationDeferral.unanswerable("no answer").obligations).toEqual([]);
            expect(ReconciliationDeferral.clear().answerable).toBe(true);
        }
    );

    test(
        "[C13-BLUEPRINT-CONVERGENCE] adopts a manual edit only as a change to the Blueprint",
        { tags: "p0" },
        () => {
            const port = new MemoryManagedResourcePort<LocalRecordStoreState>();
            const store = new LocalRecordStore(actor, port);
            const materializer = new LocalMaterializer({ actor, store, resources: port });
            materializer.apply(subset(1));
            const manual = manualEdit();
            store.writeManualEdit(manual);
            const adoption = new AdoptedManagedRecord(manual.resourceId, manual.desiredDigest);

            // Unadopted, an occupied resource is a record no generation attributes: the
            // reconciliation refuses it rather than absorbing it into the managed set.
            expect(() => materializer.apply(declared(2))).toThrow(
                /occupied outside the active generation/
            );

            // An adoption the desired generation does not declare would mark an
            // unattributed record Blueprint-managed, which is refused on its own terms.
            expect(() => materializer.apply(subset(2), [adoption])).toThrow(
                /cannot be adopted without a declaring Blueprint/
            );

            // A stale adoption names a state the resource no longer holds.
            expect(() =>
                materializer.apply(declared(2), [
                    new AdoptedManagedRecord(manual.resourceId, digest("some-other-state"))
                ])
            ).toThrow(/adoption names a state it no longer holds/);

            // Adopted as the change to the Blueprint that declares it, the record joins the
            // managed set holding exactly the declared state.
            const adopted = materializer.apply(declared(2), [adoption]);
            expect(adopted.actions).toEqual(["adopt", "noop", "noop"]);
            expect(adopted.pending.converged).toBe(true);
            expect(managedIdentity(store.resources)).toEqual(declaredIdentity(declared(2)));
            expect(
                store.managedRecords.filter((record) => record.logicalKey === "policy:b")
            ).toHaveLength(1);
            expect(() => materializer.apply(declared(3), [adoption, adoption])).toThrow(
                /adopted more than once/
            );
        }
    );
});

function applyPath(steps: readonly ActorPlan[]): readonly string[] {
    const port = new MemoryManagedResourcePort<LocalRecordStoreState>();
    const store = new LocalRecordStore(actor, port);
    const materializer = new LocalMaterializer({ actor, store, resources: port });
    for (const step of steps) {
        expect(materializer.apply(step).pending.converged).toBe(true);
    }
    return managedIdentity(store.resources);
}

/** What the Scope holds: one line per Blueprint-managed resource and its declared state. */
function managedIdentity(resources: readonly ManagedResourceSnapshot[]): readonly string[] {
    return resources
        .map(
            (resource) =>
                `${resource.recordKind}:${resource.logicalKey}=${resource.desiredDigest.value}`
        )
        .toSorted();
}

/** What the Blueprint declares, projected without consulting any Scope at all. */
function declaredIdentity(plan: ActorPlan): readonly string[] {
    return materializeActorPlan(actor, plan)
        .records.map(
            (record) => `${record.recordKind}:${record.logicalKey}=${record.desiredDigest.value}`
        )
        .toSorted();
}

function withdrawalHeldBy(
    deferral: (change: ManagedResourceChange) => ReconciliationDeferral
): HeldWithdrawal {
    const port = new MemoryManagedResourcePort<LocalRecordStoreState>();
    const store = new LocalRecordStore(actor, port);
    const materializer = new LocalMaterializer({ actor, store, resources: port });
    materializer.apply(withdrawn(1));
    const held = store.resources;
    port.deferral = deferral;
    return { result: materializer.apply(retained(2)), store, held };
}

function expectHeldWithdrawal(
    withdrawal: HeldWithdrawal,
    expected: ExpectedObligation
): ReconciliationObligation {
    const { result, store, held } = withdrawal;
    const obligation = result.pending.ofKind(expected.kind)[0]!;
    expect(result.pending.converged).toBe(false);
    expect(obligation.record).toBe(expected.record);
    expect(obligation.reason).toBe(expected.reason);
    expect(obligation.condition).toBe(expected.condition);
    expect(obligation.held.logicalKey).toBe("policy:withdrawn");
    expect(obligation.held.change).toBe("remove");
    expect(result.actions).toEqual(["noop", "remove"]);

    // A held deferral writes nothing: the withdrawal waits and the Scope keeps exactly the
    // managed set it had.
    expect(result.pointerChanged).toBe(false);
    expect(result.insertedGeneration).toBe(false);
    expect(result.insertedRecords).toEqual([]);
    expect(store.resources).toEqual(held);
    return obligation;
}

function pendingRetention(): PackageRetentionObligation {
    return new PackageRetentionObligation(
        new DeferredManagedRecord({
            kind: "remove",
            current: {
                actor,
                tenantId,
                deploymentId,
                resourceId: digest("held-resource"),
                logicalKey: "policy:withdrawn",
                recordKind: "policy-set",
                desiredDigest: digest("held-desired"),
                revision: Revision.initial()
            }
        }),
        pinnedRelease(),
        new PackagePinHolder("snapshot", "snapshot:pending")
    );
}

/** A resource an operator created by hand: the Blueprint's identity, an unmanaged state. */
function manualEdit(): ManagedResourceSnapshot {
    const record = materializeActorPlan(actor, declared(2)).records.find(
        (candidate) => candidate.logicalKey === "policy:b"
    )!;
    return Object.freeze({
        actor,
        tenantId,
        deploymentId,
        resourceId: record.resourceId,
        logicalKey: record.logicalKey,
        recordKind: record.recordKind,
        desiredDigest: digest("manual-edit"),
        revision: Revision.initial()
    });
}

function declared(generation: number): ActorPlan {
    return plan(generation, [
        projection("policy:a", 1),
        projection("policy:b", 2),
        projection("policy:c", 3)
    ]);
}

function subset(generation: number): ActorPlan {
    return plan(generation, [projection("policy:a", 1), projection("policy:c", 3)]);
}

function divergentPrior(generation: number): ActorPlan {
    return plan(generation, [projection("policy:a", 9), projection("policy:z", 2)]);
}

function withdrawn(generation: number): ActorPlan {
    return plan(generation, [projection("policy:withdrawn", 1), projection("policy:kept", 2)]);
}

function retained(generation: number): ActorPlan {
    return plan(generation, [projection("policy:kept", 2)]);
}

function plan(generation: number, projections: readonly DesiredProjection[]): ActorPlan {
    return new ActorPlan({ actor, origin: origin(generation), projections });
}

function projection(logicalKey: string, value: number): DesiredProjection {
    return policyProjection(
        logicalKey,
        new PolicySet(value === 1 ? {} : { maxDirectRevocationWindowMs: value * 1000 })
    );
}

function scratchState(): LocalRecordStoreState {
    return {
        generations: new Map(),
        records: new Map(),
        pointers: new Map(),
        resources: new Map()
    };
}

function pinnedClosure(): DefinitionPinSet {
    return {
        blueprint: { version: new SemVer("1.0.0"), digest: digest("blueprint") },
        packages: [pinnedRelease()]
    };
}

function pinnedRelease(): PackagePin {
    return new PackagePin(
        new PackageId("acme.deploy"),
        new SemVer("1.4.0"),
        digest("manifest"),
        digest("code")
    );
}

function origin(generation: number): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digest("attestation"),
        blueprintDigest: digest("blueprint"),
        packageLockDigest: digest("package-lock"),
        configDigest: digest("config"),
        generation
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
