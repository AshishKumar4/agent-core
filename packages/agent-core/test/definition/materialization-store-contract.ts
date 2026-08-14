import { describe, expect, test } from "vitest";
import {
    ActorId,
    ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { Digest, Revision, SemVer, encodeCanonicalJson, type JsonValue } from "../../src/core";
import {
    ActorPlan,
    Blueprint,
    BlueprintMeta,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationId,
    MaterializationGenerationPointer,
    MaterializationPlan,
    POLICY_IMPACTS,
    PolicySet,
    policyProjection,
    type EnforcementTier,
    type EnforcementTierOverrides
} from "../../src/definition";
import { materializeActorPlan, type LocalMaterialization } from "../../src/definition/materializer";
import { TenantId } from "../../src/identity";
import { tamperedRecord } from "./record-data";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

export function materializationStoreContract<TTransaction>(
    name: string,
    create: (owner: ActorRef) => MaterializationStoreContract<TTransaction>
): void {
    describe(`${name} MaterializationStore contract`, () => {
        test("returns undefined for every absent immutable record and deployment pointer", { tags: "p1" }, () => {
            const actor = actorRef("empty");
            const store = create(actor);
            expect(store.getBlueprint("missing", new SemVer("1.0.0"))).toBeUndefined();
            expect(store.getPlan(digestOf("missing-plan"))).toBeUndefined();
            expect(
                store.getGeneration(
                    new MaterializationGenerationId(digestOf("missing-generation").value)
                )
            ).toBeUndefined();
            expect(store.getManagedState(digestOf("missing-state"))).toBeUndefined();
            expect(store.getGenerationPointer(actor, deploymentId)).toBeUndefined();
        });

        test("stores codec records synchronously and lists every record deterministically", { tags: "p1" }, () => {
            const workspace = actorRef("z-workspace");
            const store = create(workspace);
            const zetaBlueprint = blueprint("zeta", "1.0.0", { tier: "zeta" });
            const alphaTwo = blueprint("alpha", "2.0.0", { tier: "two" });
            const alphaOne = blueprint("alpha", "1.0.0", { tier: "one" });
            const workspaceState = materializationState(workspace, 2, "workspace");

            store.addBlueprint(zetaBlueprint);
            store.addBlueprint(alphaTwo);
            store.addBlueprint(alphaOne);
            store.addPlan(workspaceState.plan);
            installGeneration(store, workspaceState);

            const blueprintResult = store.getBlueprint("alpha", new SemVer("1.0.0"));
            const planResult = store.getPlan(workspaceState.plan.id);
            const generationResult = store.getGeneration(
                workspaceState.materialization.generation.id
            );
            const stateResult = store.getManagedState(
                workspaceState.materialization.records[0]!.id
            );

            expect(blueprintResult).not.toBeInstanceOf(Promise);
            expect(planResult).not.toBeInstanceOf(Promise);
            expect(generationResult).not.toBeInstanceOf(Promise);
            expect(stateResult).not.toBeInstanceOf(Promise);
            expect(Blueprint.encode(blueprintResult!)).toEqual(Blueprint.encode(alphaOne));
            expect(MaterializationPlan.encode(planResult!)).toEqual(
                MaterializationPlan.encode(workspaceState.plan)
            );
            expect(store.listBlueprints().map((value) => blueprintKey(value))).toEqual([
                "alpha@1.0.0",
                "alpha@2.0.0",
                "zeta@1.0.0"
            ]);
            expect(store.listBlueprints("alpha").map((value) => blueprintKey(value))).toEqual([
                "alpha@1.0.0",
                "alpha@2.0.0"
            ]);
            expect(store.listPlans().map((value) => value.id.value)).toEqual([
                workspaceState.plan.id.value
            ]);
            expect(store.listGenerations().map((value) => actorKey(value.actor))).toEqual([
                actorKey(workspace)
            ]);
            expect(store.listGenerations(workspace)).toHaveLength(1);
            expect(
                store.listManagedState(workspaceState.materialization.generation.id)
            ).toHaveLength(1);
            expect(Object.isFrozen(store.listManagedState())).toBe(true);
        });

        test("lists plans generations and managed state in canonical order", { tags: "p1" }, () => {
            const actor = actorRef("ordering");
            const store = create(actor);
            const planAlpha = materializationState(actor, 1, "p-alpha");
            const planBeta = materializationState(actor, 2, "p-beta");
            const first = materializationState(actor, 1, "g-alpha", "slot:kk");
            const second = materializationState(actor, 2, "g-beta", "slot:mm");
            const third = materializationState(actor, 3, "g-gamma", "slot:pp");

            store.addPlan(planAlpha.plan);
            store.addPlan(planBeta.plan);
            installGeneration(store, first);
            installGeneration(store, second);
            installGeneration(store, third);

            // Canonical order is content-addressed identity order, which is not the order
            // the generations were installed in.
            const orderedGenerations = [first, second, third]
                .map((fixture) => fixture.materialization.generation.id.value)
                .sort();
            expect(orderedGenerations).not.toEqual([
                first.materialization.generation.id.value,
                second.materialization.generation.id.value,
                third.materialization.generation.id.value
            ]);
            expect(store.listPlans().map((plan) => plan.id.value)).toEqual(
                [planAlpha.plan.id.value, planBeta.plan.id.value].sort()
            );
            expect(store.listGenerations().map((generation) => generation.id.value)).toEqual(
                orderedGenerations
            );
            expect(store.listManagedState().map((record) => record.generationId.value)).toEqual(
                orderedGenerations
            );
            const stored = store.getManagedState(first.materialization.records[0]!.id);
            expect(ManagedStateRecord.encode(stored!)).toEqual(
                ManagedStateRecord.encode(first.materialization.records[0]!)
            );
        });

        test("orders managed state within one generation by logical key", { tags: "p1" }, () => {
            const actor = actorRef("ordering");
            const store = create(actor);
            const fixture = materializationStateWithKeys(actor, 1, "g-two", [
                "slot:zz",
                "slot:aa"
            ]);
            installGeneration(store, fixture);

            expect(
                store
                    .listManagedState(fixture.materialization.generation.id)
                    .map((record) => record.logicalKey)
            ).toEqual(["slot:aa", "slot:zz"]);
        });

        test("replays managed state through addManagedState in a multi-record generation", { tags: "p1" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationStateWithKeys(actor, 1, "replay", [
                "slot:aa",
                "slot:zz"
            ]);
            installGeneration(store, fixture);
            installGeneration(store, fixture);

            for (const record of fixture.materialization.records) {
                expect(() => store.addManagedState(record)).not.toThrow();
            }
            expect(store.listManagedState(fixture.materialization.generation.id)).toHaveLength(2);
        });

        test("seals a stored generation closure against new managed state", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "sealed");
            installGeneration(store, fixture);
            const record = fixture.materialization.records[0]!;
            const intruder = new ManagedStateRecord({
                actor,
                origin: record.origin,
                generationId: record.generationId,
                logicalKey: "slot:intruder",
                recordKind: "policy-set",
                desired: new PolicySet({ approvals: ["execute"] }).toData()
            });

            expect(() =>
                store.transaction((transaction) => {
                    store.insertManagedState(transaction, intruder);
                })
            ).toThrow(/Materialization generation .* is immutable/);
            expect(store.listManagedState()).toHaveLength(1);
        });

        test("rejects divergent record sets under one generation identity", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "divergent");
            installGeneration(store, fixture);
            const generation = fixture.materialization.generation;
            const divergent = new MaterializationGeneration({
                actor,
                origin: generation.origin,
                actorPlanId: generation.actorPlanId,
                managedRecordIds: [digestOf("forged-record")]
            });
            expect(divergent.id.equals(generation.id)).toBe(true);

            expect(() =>
                store.transaction((transaction) => {
                    store.insertGeneration(transaction, divergent);
                })
            ).toThrow(/Materialization generation .* is immutable/);
        });

        test("rejects divergent codec bytes under one managed-state identity", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "identity");
            installGeneration(store, fixture);
            const record = fixture.materialization.records[0]!;
            const divergent = new ManagedStateRecord({
                actor,
                origin: new ManagedOrigin({
                    tenantId: record.origin.tenantId,
                    deploymentId: record.origin.deploymentId,
                    attestationDigest: record.origin.attestationDigest,
                    blueprintDigest: digestOf("forged-blueprint"),
                    packageLockDigest: record.origin.packageLockDigest,
                    configDigest: record.origin.configDigest,
                    generation: record.origin.generation
                }),
                generationId: record.generationId,
                logicalKey: record.logicalKey,
                recordKind: record.recordKind,
                desired: record.desired
            });
            expect(divergent.id.equals(record.id)).toBe(true);

            expect(() =>
                store.transaction((transaction) => {
                    store.insertManagedState(transaction, divergent);
                })
            ).toThrow(/Managed state .* is immutable/);
        });

        test("rejects generation queries for a foreign Actor", { tags: "p0" }, () => {
            const store = create(actorRef("owner"));

            expect(() => store.listGenerations(actorRef("foreign"))).toThrow(/different Actor/);
        });

        test("rejects multi-actor plans even when they include the owner", { tags: "p0" }, () => {
            const owner = actorRef("owner");
            const store = create(owner);
            const origin = materializationState(owner, 1, "multi").plan.origin;
            const multi = new MaterializationPlan({
                origin,
                actors: [
                    new ActorPlan({
                        actor: owner,
                        origin,
                        projections: [policyProjection("slot:owner", new PolicySet({}))]
                    }),
                    new ActorPlan({
                        actor: new ActorRef("workspace", new ActorId("zz-other")),
                        origin,
                        projections: [policyProjection("slot:other", new PolicySet({}))]
                    })
                ]
            });

            expect(() => store.addPlan(multi)).toThrow(/exactly the store owner/);
            expect(store.listPlans()).toEqual([]);
        });

        test("returns false for a revision-expecting CAS on an absent pointer", { tags: "p1" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "absent");
            installGeneration(store, fixture);

            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        new Revision(0),
                        MaterializationGenerationPointer.initial(
                            actor,
                            deploymentId,
                            fixture.materialization.generation.id
                        ).activate(fixture.materialization.generation.id)
                    )
                )
            ).toBe(false);
            expect(store.getGenerationPointer(actor, deploymentId)).toBeUndefined();
        });

        test("rejects pointer CAS onto the currently active generation", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "active");
            installGeneration(store, fixture);
            const initial = MaterializationGenerationPointer.initial(
                actor,
                deploymentId,
                fixture.materialization.generation.id
            );
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        initial
                    )
                )
            ).toBe(true);

            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        initial.revision,
                        initial.activate(fixture.materialization.generation.id)
                    )
                )
            ).toThrow(/strictly increase/);
        });

        test("makes equal immutable record replay idempotent", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const candidateBlueprint = blueprint("platform", "1.0.0", { tier: "mediated" });
            const state = materializationState(actor, 1, "stable");

            store.addBlueprint(candidateBlueprint);
            store.addBlueprint(Blueprint.decode(Blueprint.encode(candidateBlueprint)));
            store.addPlan(state.plan);
            store.addPlan(MaterializationPlan.decode(MaterializationPlan.encode(state.plan)));
            installGeneration(store, state);
            installGeneration(store, state);

            expect(store.listBlueprints()).toHaveLength(1);
            expect(store.listPlans()).toHaveLength(1);
            expect(store.listGenerations()).toHaveLength(1);
            expect(store.listManagedState()).toHaveLength(1);
        });

        test("rejects immutable key conflicts and rolls their partial state back", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const original = blueprint("platform", "1.0.0", { value: "original" });
            const conflict = blueprint("platform", "1.0.0", { value: "conflict" });
            store.addBlueprint(original);

            expect(() => store.addBlueprint(conflict)).toThrowError(
                expect.objectContaining({
                    code: "protocol.invalid-state"
                })
            );
            expect(() => store.addBlueprint(conflict)).toThrow(
                /Blueprint platform.1\.0\.0 is immutable/
            );
            expect(Blueprint.encode(store.getBlueprint("platform", new SemVer("1.0.0"))!)).toEqual(
                Blueprint.encode(original)
            );

            const accepted = materializationState(actor, 1, "accepted", "slot:a");
            const generationConflict = materializationState(actor, 1, "accepted", "slot:b");
            installGeneration(store, accepted);
            expect(() => installGeneration(store, generationConflict)).toThrowError(
                expect.objectContaining({ code: "protocol.invalid-state" })
            );
            expect(store.listGenerations()).toHaveLength(1);
            expect(store.listManagedState()).toHaveLength(1);
        });

        test("uses exact revision CAS and requires a new higher generation for rollback", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const first = materializationState(actor, 1, "first");
            const second = materializationState(actor, 2, "second");
            const rollback = materializationState(actor, 3, "rollback", "slot:first", "first");
            installGeneration(store, first);
            installGeneration(store, second);
            installGeneration(store, rollback);

            const initial = MaterializationGenerationPointer.initial(
                actor,
                deploymentId,
                first.materialization.generation.id
            );
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        initial
                    )
                )
            ).toBe(true);
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        initial
                    )
                )
            ).toBe(false);

            const advanced = initial.activate(second.materialization.generation.id);
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        new Revision(7),
                        advanced
                    )
                )
            ).toBe(false);
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        initial.revision,
                        advanced
                    )
                )
            ).toBe(true);

            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        advanced.revision,
                        advanced.activate(first.materialization.generation.id)
                    )
                )
            ).toThrow(/strictly increase/);

            const rolledBack = advanced.activate(rollback.materialization.generation.id);
            expect(
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        advanced.revision,
                        rolledBack
                    )
                )
            ).toBe(true);
            expect(
                store
                    .getGenerationPointer(actor, deploymentId)
                    ?.generationId.equals(rollback.materialization.generation.id)
            ).toBe(true);
            expect(store.getGenerationPointer(actor, deploymentId)?.revision.value).toBe(2);
            expect(store.listGenerations(actor)).toHaveLength(3);
            expect(store.listManagedState()).toHaveLength(3);
        });

        test("rolls back a failed transaction and exposes no destructive lifecycle API", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const state = materializationState(actor, 1, "rollback");

            expect(() =>
                store.transaction((transaction) => {
                    for (const record of state.materialization.records) {
                        store.insertManagedState(transaction, record);
                    }
                    store.insertGeneration(transaction, state.materialization.generation);
                    throw new TypeError("injected rollback");
                })
            ).toThrow(/injected rollback/);
            expect(store.listManagedState()).toEqual([]);
            expect(store.listGenerations()).toEqual([]);

            for (const method of ["delete", "remove", "retire", "update"]) {
                expect(method in store).toBe(false);
            }
        });

        test("rejects pointers with foreign Actors, missing generations, or skipped revisions", { tags: "p0" }, () => {
            const actor = actorRef("workspace");
            const store = create(actor);
            const foreign = actorRef("foreign");
            const state = materializationState(actor, 1, "pointer");
            installGeneration(store, state);
            const generationId = state.materialization.generation.id;

            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        MaterializationGenerationPointer.initial(
                            foreign,
                            deploymentId,
                            generationId
                        )
                    )
                )
            ).toThrow(/different Actor/);
            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        MaterializationGenerationPointer.initial(
                            actor,
                            deploymentId,
                            new MaterializationGenerationId(digestOf("missing").value)
                        )
                    )
                )
            ).toThrow(/stored generation/);
            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        undefined,
                        new MaterializationGenerationPointer({
                            actor,
                            deploymentId,
                            generationId,
                            revision: new Revision(1)
                        })
                    )
                )
            ).toThrow(/exactly one revision/);
            expect(store.listGenerationPointers()).toEqual([]);
        });

        test("rejects plans and records for a foreign Actor", { tags: "p0" }, () => {
            const owner = actorRef("owner");
            const foreign = actorRef("foreign");
            const store = create(owner);
            const foreignState = materializationState(foreign, 1, "foreign");

            expect(() => store.addPlan(foreignState.plan)).toThrow(/store owner/);
            expect(() => store.addManagedState(foreignState.materialization.records[0]!)).toThrow(
                /different Actor/
            );
            expect(() => store.addGeneration(foreignState.materialization.generation)).toThrow(
                /different Actor/
            );
        });

        test("rejects unsupported managed state at insertion boundaries", { tags: "p1" }, () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "unsupported");
            const unsupported = forgeManagedStateKind(
                fixture.materialization.records[0]!,
                "facet.slot-entry"
            );

            expect(() => store.addManagedState(unsupported)).toThrow(
                /Unsupported materialization record kind/
            );
            expect(() =>
                store.transaction((transaction) => {
                    store.insertManagedState(transaction, unsupported);
                })
            ).toThrow(/Unsupported materialization record kind|codec.invalid/);
            expect(store.listManagedState()).toEqual([]);
        });

        test("checks canonical codec ownership before persisting hostile objects", { tags: "p0" }, () => {
            const owner = actorRef("owner");
            const foreign = actorRef("foreign");
            const store = create(owner);
            const ownerState = materializationState(owner, 1, "owner");
            const foreignState = materializationState(foreign, 1, "foreign");

            expect(() => store.addPlan(encodeAs(ownerState.plan, foreignState.plan))).toThrow(
                /store owner/
            );
            expect(() =>
                store.addManagedState(
                    encodeAs(
                        ownerState.materialization.records[0]!,
                        foreignState.materialization.records[0]!
                    )
                )
            ).toThrow(/different Actor/);
            expect(() =>
                store.addGeneration(
                    encodeAs(
                        ownerState.materialization.generation,
                        foreignState.materialization.generation
                    )
                )
            ).toThrow(/different Actor/);

            expect(store.listPlans()).toEqual([]);
            expect(store.listManagedState()).toEqual([]);
            expect(store.listGenerations()).toEqual([]);
        });

        test("rejects conflicting logical keys within one generation", { tags: "p0" }, () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const fixture = materializationState(actor, 1, "first", "policy:shared");
            const first = fixture.materialization.records[0]!;
            const conflict = new ManagedStateRecord({
                actor,
                origin: first.origin,
                generationId: first.generationId,
                logicalKey: first.logicalKey,
                recordKind: "policy-set",
                desired: new PolicySet({ approvals: ["execute"] }).toData()
            });

            expect(() =>
                store.transaction((transaction) => {
                    store.insertManagedState(transaction, first);
                    store.insertManagedState(transaction, conflict);
                })
            ).toThrow(/logical key|UNIQUE/);
            expect(store.listManagedState()).toEqual([]);
        });

        test("rolls back standalone managed state without its generation", { tags: "p0" }, () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const record = materializationState(actor, 1, "orphan").materialization.records[0]!;

            expect(() => store.addManagedState(record)).toThrow(/stored generation/);
            expect(store.listManagedState()).toEqual([]);
        });

        test("canonicalizes standalone managed state exactly once before closure validation", { tags: "p1" }, () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const installed = materializationState(actor, 1, "installed");
            const orphan = materializationState(actor, 2, "orphan").materialization.records[0]!;
            installGeneration(store, installed);
            let reads = 0;
            const stateful = tamperedRecord(installed.materialization.records[0]!,
                {
                    toData: () => {
                        reads += 1;
                        return reads === 1
                            ? orphan.toData()
                            : installed.materialization.records[0]!.toData();
                    }
                }
            );

            expect(() => store.addManagedState(stateful)).toThrow(/stored generation/);
            expect(reads).toBe(1);
            expect(store.listManagedState()).toHaveLength(1);
        });

        test.each(["tenant", "workspace", "run", "environment", "slate"] as const)(
            "opens Actor-local materialization persistence for %s owners",
            { tags: "p1" },
            (kind) => {
                const actor = new ActorRef(kind, new ActorId(`${kind}-owner`));
                const store = create(actor);
                const fixture = materializationState(actor, 1, `${kind}-state`);
                if (kind === "tenant") store.addPlan(fixture.plan);
                else expect(() => store.addPlan(fixture.plan)).toThrow(/Tenant control Actor/);
                installGeneration(store, fixture);
                store.transaction((transaction) => {
                    expect(
                        store.compareAndSetGenerationPointer(
                            transaction,
                            actor,
                            deploymentId,
                            undefined,
                            MaterializationGenerationPointer.initial(
                                actor,
                                deploymentId,
                                fixture.materialization.generation.id
                            )
                        )
                    ).toBe(true);
                });
                expect(store.listGenerations()).toHaveLength(1);
                expect(store.getGenerationPointer(actor, deploymentId)?.revision.value).toBe(0);
            }
        );
    });
}

export interface MaterializationStoreContract<TTransaction> {
    transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult;
    addBlueprint(blueprint: Blueprint): void;
    getBlueprint(name: string, version: SemVer): Blueprint | undefined;
    listBlueprints(name?: string): readonly Blueprint[];
    addPlan(plan: MaterializationPlan): void;
    getPlan(id: Digest): MaterializationPlan | undefined;
    listPlans(): readonly MaterializationPlan[];
    addGeneration(generation: MaterializationGeneration): void;
    getGeneration(id: MaterializationGenerationId): MaterializationGeneration | undefined;
    listGenerations(actor?: ActorRef): readonly MaterializationGeneration[];
    addManagedState(record: ManagedStateRecord): void;
    getManagedState(id: Digest): ManagedStateRecord | undefined;
    listManagedState(generationId?: MaterializationGenerationId): readonly ManagedStateRecord[];
    getGenerationPointer(
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined;
    listGenerationPointers(): readonly MaterializationGenerationPointer[];
    loadGeneration(
        transaction: TTransaction,
        id: MaterializationGenerationId
    ): MaterializationGeneration | undefined;
    insertGeneration(transaction: TTransaction, generation: MaterializationGeneration): void;
    loadManagedState(transaction: TTransaction, id: Digest): ManagedStateRecord | undefined;
    insertManagedState(transaction: TTransaction, record: ManagedStateRecord): void;
    loadGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined;
    compareAndSetGenerationPointer(
        transaction: TTransaction,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean;
}

export interface MaterializationFixture {
    readonly actor: ActorRef;
    readonly plan: MaterializationPlan;
    readonly materialization: LocalMaterialization;
}

export function blueprint(name: string, version: string, policies: JsonValue): Blueprint {
    return new Blueprint({
        meta: new BlueprintMeta(name, new SemVer(version)),
        packages: [],
        policies: policyFromData(policies),
        agents: []
    });
}

function policyFromData(data: JsonValue): PolicySet {
    const digest = Digest.sha256(encodeCanonicalJson(data)).value;
    const tierAt = (index: number): EnforcementTier =>
        Number.parseInt(digest[index]!, 16) % 2 === 0 ? "direct" : "mediated";
    const tiers: EnforcementTierOverrides = {
        observe: tierAt(0),
        mutate: tierAt(1),
        externalSend: tierAt(2),
        execute: tierAt(3),
        delegate: tierAt(4),
        administer: tierAt(5)
    };
    const approvals = POLICY_IMPACTS.filter(
        (_, index) => Number.parseInt(digest[index + POLICY_IMPACTS.length]!, 16) % 2 === 0
    );
    return new PolicySet({
        tiers,
        approvals
    });
}

export function materializationState(
    actor: ActorRef,
    generation: number,
    seed: string,
    logicalKey = `slot:${seed}`,
    desiredSeed = seed,
    deploymentKey = "platform"
): MaterializationFixture {
    return materializationFixture(actor, generation, seed, [logicalKey], desiredSeed, deploymentKey);
}

export function materializationStateWithKeys(
    actor: ActorRef,
    generation: number,
    seed: string,
    logicalKeys: readonly string[]
): MaterializationFixture {
    return materializationFixture(actor, generation, seed, logicalKeys, seed, "platform");
}

function materializationFixture(
    actor: ActorRef,
    generation: number,
    seed: string,
    logicalKeys: readonly string[],
    desiredSeed: string,
    deploymentKey: string
): MaterializationFixture {
    const managedOrigin = new ManagedOrigin({
        tenantId,
        deploymentId: DeploymentId.derive(tenantId, new DeploymentKey(deploymentKey)),
        attestationDigest: digestOf(`attestation:${seed}`),
        blueprintDigest: digestOf(`blueprint:${seed}`),
        packageLockDigest: digestOf(`lock:${seed}`),
        configDigest: digestOf(`config:${seed}`),
        generation
    });
    const actorPlan = new ActorPlan({
        actor,
        origin: managedOrigin,
        projections: logicalKeys.map((logicalKey) =>
            policyProjection(logicalKey, policyForSeed(desiredSeed))
        )
    });
    return {
        actor,
        plan: new MaterializationPlan({ origin: managedOrigin, actors: [actorPlan] }),
        materialization: materializeActorPlan(actor, actorPlan)
    };
}

function policyForSeed(seed: string): PolicySet {
    return new PolicySet({
        tiers: seed.length % 2 === 0 ? { execute: "mediated" } : {},
        approvals: seed.length % 3 === 0 ? ["externalSend"] : []
    });
}

function forgeManagedStateKind(record: ManagedStateRecord, recordKind: string): ManagedStateRecord {
    return tamperedRecord(record,
        { recordKind }
    );
}

/**
 * A record that reads as one value but encodes as another, so a store can be shown re-reading
 * what it actually wrote instead of trusting the record it was handed.
 */
function encodeAs<Value extends { toData(): JsonValue }>(visible: Value, encoded: Value): Value {
    // SAFETY: the copy carries Value's prototype and fields but never ran its constructor, and
    // its toData deliberately disagrees with the rest of it. Only the store check asserted to
    // reject the mismatch ever reads it.
    const bare = Object.create(Object.getPrototypeOf(visible)) as Value;
    return Object.assign(bare, visible, { toData: () => encoded.toData() });
}

export function actorRef(id: string, kind: "tenant" | "workspace" = "tenant"): ActorRef {
    return new ActorRef(kind, new ActorId(id));
}

export function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

export function installGeneration<TTransaction>(
    store: MaterializationStoreContract<TTransaction>,
    fixture: MaterializationFixture
): void {
    store.transaction((transaction) => {
        for (const record of fixture.materialization.records) {
            store.insertManagedState(transaction, record);
        }
        store.insertGeneration(transaction, fixture.materialization.generation);
    });
}

function blueprintKey(value: Blueprint): string {
    return `${value.meta.name}@${value.meta.version.toString()}`;
}

function actorKey(actor: ActorRef): string {
    return `${actor.kind}:${actor.id.value}`;
}
