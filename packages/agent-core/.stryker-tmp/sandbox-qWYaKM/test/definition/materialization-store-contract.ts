// @ts-nocheck
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
    policyProjection
} from "../../src/definition";
import { materializeActorPlan, type LocalMaterialization } from "../../src/definition/materializer";
import { TenantId } from "../../src/identity";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

export function materializationStoreContract<TTransaction>(
    name: string,
    create: (owner: ActorRef) => MaterializationStoreContract<TTransaction>
): void {
    describe(`${name} MaterializationStore contract`, () => {
        test("returns undefined for every absent immutable record and deployment pointer", () => {
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

        test("stores codec records synchronously and lists every record deterministically", () => {
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

        test("makes equal immutable record replay idempotent", () => {
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

        test("rejects immutable key conflicts and rolls their partial state back", () => {
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

        test("uses exact revision CAS and requires a new higher generation for rollback", () => {
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

        test("rolls back a failed transaction and exposes no destructive lifecycle API", () => {
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

        test("rejects pointers with foreign Actors, missing generations, or skipped revisions", () => {
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

        test("rejects plans and records for a foreign Actor", () => {
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

        test("rejects unsupported managed state at insertion boundaries", () => {
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

        test("checks canonical codec ownership before persisting hostile objects", () => {
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

        test("rejects conflicting logical keys within one generation", () => {
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

        test("rolls back standalone managed state without its generation", () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const record = materializationState(actor, 1, "orphan").materialization.records[0]!;

            expect(() => store.addManagedState(record)).toThrow(/stored generation/);
            expect(store.listManagedState()).toEqual([]);
        });

        test("canonicalizes standalone managed state exactly once before closure validation", () => {
            const actor = actorRef("owner");
            const store = create(actor);
            const installed = materializationState(actor, 1, "installed");
            const orphan = materializationState(actor, 2, "orphan").materialization.records[0]!;
            installGeneration(store, installed);
            let reads = 0;
            const stateful = Object.assign(
                Object.create(ManagedStateRecord.prototype) as ManagedStateRecord,
                installed.materialization.records[0]!,
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
    const tiers = Object.fromEntries(
        POLICY_IMPACTS.map((impact, index) => [
            impact,
            Number.parseInt(digest[index]!, 16) % 2 === 0 ? "direct" : "mediated"
        ])
    ) as import("../../src/definition").EnforcementTierOverrides;
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
    desiredSeed = seed
): MaterializationFixture {
    const managedOrigin = new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digestOf(`attestation:${seed}`),
        blueprintDigest: digestOf(`blueprint:${seed}`),
        packageLockDigest: digestOf(`lock:${seed}`),
        configDigest: digestOf(`config:${seed}`),
        generation
    });
    const actorPlan = new ActorPlan({
        actor,
        origin: managedOrigin,
        projections: [policyProjection(logicalKey, policyForSeed(desiredSeed))]
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
    return Object.assign(
        Object.create(ManagedStateRecord.prototype) as ManagedStateRecord,
        record,
        { recordKind }
    );
}

function encodeAs<Value extends { toData(): JsonValue }>(visible: Value, encoded: Value): Value {
    return Object.assign(Object.create(Object.getPrototypeOf(visible)) as Value, visible, {
        toData: () => encoded.toData()
    });
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
