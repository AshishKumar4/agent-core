import { describe, expect, test } from "vitest";
import { ActorRef } from "../../../src/actors";
import { Revision, SemVer } from "../../../src/core";
import {
    ActorPlan,
    Blueprint,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    PolicySet,
    policyProjection
} from "../../../src/definition";
import { TenantId } from "../../../src/identity";
import { SqliteMaterializationStore } from "../../../src/substrates";
import type { SqliteRow, SqliteValue } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import {
    actorRef,
    blueprint,
    digestOf,
    installGeneration,
    materializationState
} from "../../definition/materialization-store-contract";

const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("SQLite materialization store durability and ownership behavior", () => {
    test("verifies persisted pointer bytes through the CAS read-back seam", { tags: "p0" }, () => {
        const database = new PointerReadbackFaultSqlite();
        const actor = actorRef("pointer-readback");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-readback");
        installGeneration(store, fixture);

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
                        fixture.materialization.generation.id
                    )
                )
            )
        ).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Generation pointer CAS did not persist codec bytes"
            })
        );
    });

    test("fails pointer CAS closed for a missing pointer with an expected revision", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("pointer-missing-cas");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-missing-cas");
        installGeneration(store, fixture);

        expect(
            store.transaction((transaction) =>
                store.compareAndSetGenerationPointer(
                    transaction,
                    actor,
                    deploymentId,
                    new Revision(0),
                    new MaterializationGenerationPointer({
                        actor,
                        deploymentId,
                        generationId: fixture.materialization.generation.id,
                        revision: new Revision(1)
                    })
                )
            )
        ).toBe(false);
        expect(store.listGenerationPointers()).toEqual([]);
    });

    test("requires strictly increasing generation ordinals on pointer activation", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("pointer-ordinal");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-ordinal");
        installGeneration(store, fixture);
        const generationId = fixture.materialization.generation.id;
        const initial = MaterializationGenerationPointer.initial(
            actor,
            deploymentId,
            generationId
        );
        store.transaction((transaction) => {
            expect(
                store.compareAndSetGenerationPointer(
                    transaction,
                    actor,
                    deploymentId,
                    undefined,
                    initial
                )
            ).toBe(true);
        });

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetGenerationPointer(
                    transaction,
                    actor,
                    deploymentId,
                    initial.revision,
                    new MaterializationGenerationPointer({
                        actor,
                        deploymentId,
                        generationId,
                        revision: initial.revision.next()
                    })
                )
            )
        ).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.revision-conflict",
                message: "Materialization generation pointer must strictly increase generation"
            })
        );
        expect(store.getGenerationPointer(actor, deploymentId)?.revision.value).toBe(0);
    });

    test("reports pointers targeting missing generations as corrupt", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("pointer-missing-target");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-missing-target");
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
        database.run("DELETE FROM definition_materialization_generations", []);

        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored generation pointer targets missing or foreign state"
            })
        );
    });

    test("rejects generation replay when stored bytes were tampered", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("generation-tamper");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "generation-tamper");
        installGeneration(store, fixture);
        const generation = fixture.materialization.generation;
        database.run("UPDATE definition_materialization_generations SET record = ?", [
            Uint8Array.of(0)
        ]);

        expect(() => store.addGeneration(generation)).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Materialization generation ${generation.id.value} is immutable`
            })
        );
    });

    test("rejects managed state that its generation does not reference", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("generation-membership");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "generation-membership");
        installGeneration(store, fixture);
        const generation = fixture.materialization.generation;
        const member = fixture.materialization.records[0];
        expect(member).toBeDefined();
        if (member === undefined) return;
        const intruder = new ManagedStateRecord({
            actor,
            origin: member.origin,
            generationId: generation.id,
            logicalKey: "slot:unreferenced",
            recordKind: "policy-set",
            desired: new PolicySet({ approvals: ["execute"] }).toData()
        });

        expect(() =>
            store.transaction((transaction) => store.insertManagedState(transaction, intruder))
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Materialization generation ${generation.id.value} is immutable`
            })
        );
        expect(store.listManagedState()).toHaveLength(1);
    });

    test("rejects generation closures whose stored records were substituted", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("closure-substitution");
        const store = new SqliteMaterializationStore(database, actor);
        const closure = twoRecordClosure(actor, 1, "closure-substitution", ["slot:a", "slot:b"]);
        store.transaction((transaction) => {
            for (const record of closure.records) store.insertManagedState(transaction, record);
            store.insertGeneration(transaction, closure.generation);
        });
        const replaced = closure.records[1];
        expect(replaced).toBeDefined();
        if (replaced === undefined) return;
        database.run("DELETE FROM definition_managed_state WHERE id = ?", [replaced.id.value]);
        insertManagedStateRow(
            database,
            new ManagedStateRecord({
                actor,
                origin: replaced.origin,
                generationId: closure.generation.id,
                logicalKey: replaced.logicalKey,
                recordKind: "policy-set",
                desired: new PolicySet({ approvals: ["externalSend"] }).toData()
            })
        );

        expect(() => store.getGeneration(closure.generation.id)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Materialization generation closure does not match managed state"
            })
        );
    });

    test("surfaces foreign persisted rows through every listing seam", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const owner = actorRef("resident");
        const store = new SqliteMaterializationStore(database, owner);
        installGeneration(store, materializationState(owner, 1, "resident"));
        const foreign = actorRef("intruder", "workspace");
        const foreignFixture = materializationState(foreign, 2, "intruder");
        for (const record of foreignFixture.materialization.records) {
            insertManagedStateRow(database, record);
        }
        insertGenerationRow(database, foreignFixture.materialization.generation);
        insertPointerRow(
            database,
            MaterializationGenerationPointer.initial(
                foreign,
                deploymentId,
                foreignFixture.materialization.generation.id
            )
        );

        installGeneration(store, materializationState(owner, 2, "resident-two"));
        expect(() => store.listGenerations(foreign)).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Generation query belongs to a different Actor"
            })
        );
        expect(() => store.listGenerations()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Stored materialization generation belongs to a different Actor"
            })
        );
        expect(() => store.listManagedState()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Stored managed state belongs to a different Actor"
            })
        );
        expect(() => store.listGenerationPointers()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Stored materialization generation belongs to a different Actor"
            })
        );
        expect(() => new SqliteMaterializationStore(database, owner)).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Stored managed state belongs to a different Actor"
            })
        );
    });

    test("names the exact orphan managed-state corruption on restart", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("orphan-exact");
        new SqliteMaterializationStore(database, actor);
        insertManagedStateRow(
            database,
            materializationState(actor, 1, "orphan-exact").materialization.records[0] ??
                orphanFallback()
        );

        expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Managed state is not referenced by its generation"
            })
        );
    });

    test("keeps immutable replay errors exact for conflicting blueprints", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("blueprint-conflict"));
        const original = blueprint("platform", "1.0.0", { value: "original" });
        store.addBlueprint(original);

        expect(() =>
            store.addBlueprint(blueprint("platform", "1.0.0", { value: "conflict" }))
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Blueprint platform@1.0.0 is immutable"
            })
        );
        const stored = store.getBlueprint("platform", original.meta.version);
        expect(stored).toBeDefined();
        if (stored === undefined) return;
        expect(Blueprint.encode(stored)).toEqual(Blueprint.encode(original));
    });

    test("rejects plans that do not target exactly the store owner", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("plan-owner"));
        const foreignPlan = materializationState(actorRef("plan-outsider"), 1, "plan-outsider");

        expect(() => store.addPlan(foreignPlan.plan)).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Materialization plan must target exactly the store owner"
            })
        );
        expect(store.listPlans()).toEqual([]);
    });

    test("reports exact projection corruption for each stored record family", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("projection-drift");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "projection-drift");
        store.addBlueprint(blueprint("drift", "1.0.0", { tier: "drift" }));
        store.addPlan(fixture.plan);
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
        const record = fixture.materialization.records[0];
        expect(record).toBeDefined();
        if (record === undefined) return;

        database.run("UPDATE definition_blueprints SET digest = ?", [digestOf("drift").value]);
        expect(() => store.getBlueprint("drift", new SemVer("1.0.0"))).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Blueprint key or projection does not match codec bytes"
            })
        );

        database.run("UPDATE definition_materialization_plans SET generation = 7", []);
        expect(() => store.getPlan(fixture.plan.id)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored materialization-plan projection does not match codec bytes"
            })
        );

        database.run("UPDATE definition_managed_state SET logical_key = 'drifted'", []);
        expect(() => store.getManagedState(record.id)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored managed-state projection does not match codec bytes"
            })
        );
        database.run("UPDATE definition_managed_state SET logical_key = ?", [record.logicalKey]);

        database.run("UPDATE definition_materialization_generations SET config_digest = ?", [
            digestOf("generation-drift").value
        ]);
        expect(() => store.getGeneration(fixture.materialization.generation.id)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored generation projection does not match codec bytes"
            })
        );
        database.run("UPDATE definition_materialization_generations SET config_digest = ?", [
            fixture.materialization.generation.origin.configDigest.value
        ]);

        database.run("UPDATE definition_materialization_pointers SET generation_id = ?", [
            digestOf("pointer-drift").value
        ]);
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored generation-pointer projection does not match codec bytes"
            })
        );
    });

    test("rejects malformed raw projections with exact column errors", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("raw-projection");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "raw-projection");
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

        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run("UPDATE definition_materialization_pointers SET revision = -1", []);
        database.run("PRAGMA ignore_check_constraints = OFF", []);
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored materialization revision projection is malformed"
            })
        );

        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run("UPDATE definition_materialization_generations SET actor_id = ''", []);
        database.run("PRAGMA ignore_check_constraints = OFF", []);
        expect(() => store.getGeneration(fixture.materialization.generation.id)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored materialization actor_id projection is malformed"
            })
        );
    });

    test("fails closed when writes do not produce durable rows", { tags: "p1" }, () => {
        for (const [fault, subject, write] of [
            [
                "blueprint",
                "Blueprint",
                (store: SqliteMaterializationStore): void =>
                    store.addBlueprint(blueprint("dropped", "1.0.0", { tier: "dropped" }))
            ],
            [
                "plan",
                "materialization plan",
                (store: SqliteMaterializationStore): void =>
                    store.addPlan(
                        materializationState(actorRef("write-drop"), 1, "dropped-plan").plan
                    )
            ],
            [
                "managed-state",
                "managed state",
                (store: SqliteMaterializationStore): void =>
                    store.transaction((transaction) =>
                        store.insertManagedState(
                            transaction,
                            materializationState(actorRef("write-drop"), 1, "dropped-state")
                                .materialization.records[0] ?? orphanFallback()
                        )
                    )
            ]
        ] as const) {
            const database = new WriteDropSqlite();
            const store = new SqliteMaterializationStore(database, actorRef("write-drop"));
            database.fault = fault;
            expect(() => write(store)).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `${subject} insert did not produce a durable row`
                })
            );
        }
    });

    test("rejects non-binary stored record bytes", { tags: "p1" }, () => {
        const database = new BlueprintRowFaultSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("binary-bytes"));
        database.fault = true;

        expect(() => store.getBlueprint("alpha", new SemVer("1.0.0"))).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored materialization record bytes are malformed"
            })
        );
    });

    test("lists managed state, generations, and plans in canonical sorted order", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("canonical-order");
        const store = new SqliteMaterializationStore(database, actor);
        const first = twoRecordClosure(actor, 1, "order-one", ["slot:a", "slot:z"]);
        const second = twoRecordClosure(actor, 2, "order-two", ["slot:b", "slot:y"]);
        for (const closure of [second, first]) {
            store.transaction((transaction) => {
                for (const record of closure.records) {
                    store.insertManagedState(transaction, record);
                }
                store.insertGeneration(transaction, closure.generation);
            });
        }
        store.addPlan(materializationState(actor, 3, "order-plan-b").plan);
        store.addPlan(materializationState(actor, 4, "order-plan-a").plan);

        const stateKeys = store
            .listManagedState()
            .map((record) => `${record.generationId.value} ${record.logicalKey}`);
        expect(stateKeys).toHaveLength(4);
        expect(stateKeys).toEqual([...stateKeys].sort());
        const generationIds = store.listGenerations().map((generation) => generation.id.value);
        expect(generationIds).toHaveLength(2);
        expect(generationIds).toEqual([...generationIds].sort());
        const planIds = store.listPlans().map((plan) => plan.id.value);
        expect(planIds).toHaveLength(2);
        expect(planIds).toEqual([...planIds].sort());

        store.addBlueprint(blueprint("zeta", "1.0.0", { tier: "zeta" }));
        store.addBlueprint(blueprint("alpha", "2.0.0", { tier: "two" }));
        store.addBlueprint(blueprint("alpha", "1.0.0", { tier: "one" }));
        expect(
            store
                .listBlueprints()
                .map((value) => `${value.meta.name}@${value.meta.version.toString()}`)
        ).toEqual(["alpha@1.0.0", "alpha@2.0.0", "zeta@1.0.0"]);
    });

    test("orders Blueprints canonically whatever order the database returns", { tags: "p1" }, () => {
        const database = new ListRowsSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("blueprint-order"));
        store.addBlueprint(blueprint("beta", "1.0.0", { tier: "beta-one" }));
        store.addBlueprint(blueprint("alpha", "2.0.0", { tier: "alpha-two" }));
        store.addBlueprint(blueprint("alpha", "1.0.0", { tier: "alpha-one" }));
        database.table = "definition_blueprints";

        for (const order of permutations(3)) {
            database.order = order;
            expect(
                store
                    .listBlueprints()
                    .map((value) => `${value.meta.name}@${value.meta.version.toString()}`)
            ).toEqual(["alpha@1.0.0", "alpha@2.0.0", "beta@1.0.0"]);
        }
    });

    test("orders plans and generations canonically whatever order the database returns", { tags: "p1" }, () => {
        const database = new ListRowsSqlite();
        const actor = actorRef("listing-order");
        const store = new SqliteMaterializationStore(database, actor);
        const fixtures = [1, 2, 3].map((generation) =>
            materializationState(actor, generation, `listing-order-${generation}`)
        );
        for (const fixture of fixtures) {
            store.addPlan(fixture.plan);
            installGeneration(store, fixture);
        }
        const expectedPlans = fixtures.map((fixture) => fixture.plan.id.value).sort();
        const expectedGenerations = fixtures
            .map((fixture) => fixture.materialization.generation.id.value)
            .sort();

        database.table = "definition_materialization_plans";
        for (const order of permutations(3)) {
            database.order = order;
            expect(store.listPlans().map((plan) => plan.id.value)).toEqual(expectedPlans);
        }

        database.table = "definition_materialization_generations";
        for (const order of permutations(3)) {
            database.order = order;
            expect(store.listGenerations().map((generation) => generation.id.value)).toEqual(
                expectedGenerations
            );
        }
    });

    test("orders managed state by generation then logical key whatever order the database returns", { tags: "p1" }, () => {
        const database = new ListRowsSqlite();
        const actor = actorRef("managed-order");
        const store = new SqliteMaterializationStore(database, actor);
        const closures = [
            twoRecordClosure(actor, 1, "managed-order-one", ["slot:a", "slot:c"]),
            twoRecordClosure(actor, 2, "managed-order-two", ["slot:b", "slot:d"])
        ];
        for (const closure of closures) {
            store.transaction((transaction) => {
                for (const record of closure.records) {
                    store.insertManagedState(transaction, record);
                }
                store.insertGeneration(transaction, closure.generation);
            });
        }
        const expected = closures
            .flatMap((closure) => closure.records)
            .map((record) => `${record.generationId.value} ${record.logicalKey}`)
            .sort();
        database.table = "definition_managed_state";

        for (const order of permutations(4)) {
            database.order = order;
            expect(
                store
                    .listManagedState()
                    .map((record) => `${record.generationId.value} ${record.logicalKey}`)
            ).toEqual(expected);
        }
    });

    test("orders generation pointers by Actor then deployment for two live deployments", { tags: "p0" }, () => {
        const database = new ListRowsSqlite();
        const actor = actorRef("pointer-order");
        const store = new SqliteMaterializationStore(database, actor);
        const alternateId = DeploymentId.derive(tenantId, new DeploymentKey("alternate"));
        const first = materializationState(actor, 1, "pointer-order-one");
        const second = materializationState(
            actor,
            1,
            "pointer-order-two",
            "slot:pointer-order-two",
            "pointer-order-two",
            "alternate"
        );
        installGeneration(store, first);
        installGeneration(store, second);
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
                        first.materialization.generation.id
                    )
                )
            ).toBe(true);
            expect(
                store.compareAndSetGenerationPointer(
                    transaction,
                    actor,
                    alternateId,
                    undefined,
                    MaterializationGenerationPointer.initial(
                        actor,
                        alternateId,
                        second.materialization.generation.id
                    )
                )
            ).toBe(true);
        });
        const expected = [deploymentId.value, alternateId.value].sort();
        database.table = "definition_materialization_pointers";

        for (const order of permutations(2)) {
            database.order = order;
            expect(
                store.listGenerationPointers().map((pointer) => pointer.deploymentId.value)
            ).toEqual(expected);
        }
    });

    test("reports repeated stored rows as a duplicate immutable key", { tags: "p1" }, () => {
        const database = new ListRowsSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("duplicate-rows"));
        store.addBlueprint(blueprint("solo", "1.0.0", { tier: "solo" }));
        database.table = "definition_blueprints";
        database.order = [0, 0];

        expect(() => store.listBlueprints()).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored Blueprints contain a duplicate immutable key"
            })
        );
    });

    test("rejects a generation closure whose managed state repeats one logical key", { tags: "p1" }, () => {
        const database = new ListRowsSqlite();
        const actor = actorRef("closure-duplicate");
        const store = new SqliteMaterializationStore(database, actor);
        const closure = twoRecordClosure(actor, 1, "closure-duplicate", ["slot:a", "slot:b"]);
        store.transaction((transaction) => {
            for (const record of closure.records) store.insertManagedState(transaction, record);
            store.insertGeneration(transaction, closure.generation);
        });
        database.table = "definition_managed_state";
        database.order = [0, 0];

        expect(() => store.getGeneration(closure.generation.id)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Materialization generation contains conflicting logical keys"
            })
        );
    });

    test("rejects managed state whose Actor differs from its own generation", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const owner = actorRef("closure-owner");
        const store = new SqliteMaterializationStore(database, owner);
        const fixture = materializationState(owner, 1, "closure-owner");
        const actorPlan = fixture.plan.actors[0];
        expect(actorPlan).toBeDefined();
        if (actorPlan === undefined) return;
        const projection = actorPlan.projections[0];
        expect(projection).toBeDefined();
        if (projection === undefined) return;
        const generationId = fixture.materialization.generation.id;
        const foreignRecord = ManagedStateRecord.fromProjection(
            actorRef("closure-intruder", "workspace"),
            actorPlan.origin,
            generationId,
            projection
        );
        const generation = new MaterializationGeneration({
            actor: owner,
            origin: actorPlan.origin,
            actorPlanId: actorPlan.id,
            managedRecordIds: [foreignRecord.id]
        });
        expect(generation.id.equals(generationId)).toBe(true);
        insertManagedStateRow(database, foreignRecord);
        insertGenerationRow(database, generation);

        expect(() => store.getGeneration(generationId)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Managed state does not belong to its generation"
            })
        );
        expect(database.all("SELECT actor_id FROM definition_managed_state", [])).toEqual([
            { actor_id: "closure-intruder" }
        ]);
    });

    test("rejects a foreign generation with an empty closure on restart", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const owner = actorRef("empty-closure-owner");
        new SqliteMaterializationStore(database, owner);
        const foreign = actorRef("empty-closure-intruder", "workspace");
        const actorPlan = materializationState(foreign, 1, "empty-closure").plan.actors[0];
        expect(actorPlan).toBeDefined();
        if (actorPlan === undefined) return;
        insertGenerationRow(
            database,
            new MaterializationGeneration({
                actor: foreign,
                origin: actorPlan.origin,
                actorPlanId: actorPlan.id,
                managedRecordIds: []
            })
        );

        expect(() => new SqliteMaterializationStore(database, owner)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.invalid-state",
                message: "Stored materialization generation belongs to a different Actor"
            })
        );
        expect(
            database.all("SELECT actor_id FROM definition_materialization_generations", [])
        ).toEqual([{ actor_id: "empty-closure-intruder" }]);
    });

    test("rejects a drifted generation-pointer projection on restart", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("pointer-restart");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-restart");
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
        const drifted = digestOf("pointer-restart-drift").value;
        database.run("UPDATE definition_materialization_pointers SET generation_id = ?", [drifted]);

        expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored generation-pointer projection does not match codec bytes"
            })
        );
        expect(
            database.all("SELECT generation_id FROM definition_materialization_pointers", [])
        ).toEqual([{ generation_id: drifted }]);
    });

    test("rejects stored rows returned under a different immutable key", { tags: "p1" }, () => {
        const database = new SubstituteRowSqlite();
        const actor = actorRef("key-substitution");
        const store = new SqliteMaterializationStore(database, actor);
        const first = materializationState(actor, 1, "substitution-one");
        const second = materializationState(actor, 2, "substitution-two");
        store.addPlan(first.plan);
        store.addPlan(second.plan);
        installGeneration(store, first);
        installGeneration(store, second);
        const firstRecord = first.materialization.records[0];
        const secondRecord = second.materialization.records[0];
        expect(firstRecord).toBeDefined();
        expect(secondRecord).toBeDefined();
        if (firstRecord === undefined || secondRecord === undefined) return;
        const planRows = database.all(
            `SELECT id, blueprint_digest, package_lock_digest, config_digest, generation, record
             FROM definition_materialization_plans WHERE id = ?`,
            [second.plan.id.value]
        );
        const generationRows = database.all(
            `SELECT id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
                    config_digest, generation, record
             FROM definition_materialization_generations WHERE id = ?`,
            [second.materialization.generation.id.value]
        );
        const stateRows = database.all(
            `SELECT id, generation_id, actor_kind, actor_id, logical_key,
                    record_kind, desired_digest, record
             FROM definition_managed_state WHERE id = ?`,
            [secondRecord.id.value]
        );

        database.rows = planRows;
        database.pattern = /FROM definition_materialization_plans WHERE id = \?/u;
        expect(() => store.getPlan(first.plan.id)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored materialization-plan key does not match codec bytes"
            })
        );

        database.rows = generationRows;
        database.pattern = /FROM definition_materialization_generations WHERE id = \?/u;
        expect(() => store.getGeneration(first.materialization.generation.id)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored generation key does not match codec bytes"
            })
        );

        database.rows = stateRows;
        database.pattern = /FROM definition_managed_state WHERE id = \?/u;
        expect(() => store.getManagedState(firstRecord.id)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored managed-state key does not match codec bytes"
            })
        );
    });

    test("rejects a generation pointer row returned for a different deployment", { tags: "p0" }, () => {
        const database = new SubstituteRowSqlite();
        const actor = actorRef("pointer-substitution");
        const store = new SqliteMaterializationStore(database, actor);
        const alternateId = DeploymentId.derive(tenantId, new DeploymentKey("alternate"));
        const first = materializationState(actor, 1, "pointer-substitution-one");
        const second = materializationState(
            actor,
            1,
            "pointer-substitution-two",
            "slot:pointer-substitution-two",
            "pointer-substitution-two",
            "alternate"
        );
        installGeneration(store, first);
        installGeneration(store, second);
        store.transaction((transaction) => {
            for (const [target, fixture] of [
                [deploymentId, first],
                [alternateId, second]
            ] as const) {
                expect(
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        target,
                        undefined,
                        MaterializationGenerationPointer.initial(
                            actor,
                            target,
                            fixture.materialization.generation.id
                        )
                    )
                ).toBe(true);
            }
        });
        const alternateRows = database.all(
            `SELECT actor_kind, actor_id, deployment_id, generation_id, revision, record
             FROM definition_materialization_pointers
             WHERE actor_kind = ? AND actor_id = ? AND deployment_id = ?`,
            [actor.kind, actor.id.value, alternateId.value]
        );

        database.rows = alternateRows;
        database.pattern = /FROM definition_materialization_pointers\s+WHERE actor_kind/u;
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored generation pointer key does not match codec bytes"
            })
        );
    });

    test("rejects Blueprint rows returned for a different name or version", { tags: "p1" }, () => {
        const database = new SubstituteRowSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("blueprint-substitution"));
        store.addBlueprint(blueprint("alpha", "1.0.0", { tier: "alpha-one" }));
        store.addBlueprint(blueprint("alpha", "2.0.0", { tier: "alpha-two" }));
        store.addBlueprint(blueprint("beta", "1.0.0", { tier: "beta-one" }));
        const corruption = expect.objectContaining({
            name: "AgentCoreError",
            code: "codec.invalid",
            message: "Stored Blueprint key or projection does not match codec bytes"
        });
        const otherName = blueprintRows(database, "beta", "1.0.0");
        const otherVersion = blueprintRows(database, "alpha", "2.0.0");
        database.pattern = /FROM definition_blueprints\s+WHERE name = \? AND version = \?/u;

        for (const rows of [otherName, otherVersion]) {
            database.rows = rows;
            expect(() => store.getBlueprint("alpha", new SemVer("1.0.0"))).toThrowError(corruption);
        }
    });

    test("rejects raw column values whose SQLite type is malformed", { tags: "p1" }, () => {
        const database = new SubstituteRowSqlite();
        const actor = actorRef("raw-column-types");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "raw-column-types");
        installGeneration(store, fixture);
        store.addBlueprint(blueprint("alpha", "1.0.0", { tier: "alpha" }));
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
        const pointerRows = database.all(
            `SELECT actor_kind, actor_id, deployment_id, generation_id, revision, record
             FROM definition_materialization_pointers
             WHERE actor_kind = ? AND actor_id = ? AND deployment_id = ?`,
            [actor.kind, actor.id.value, deploymentId.value]
        );

        database.rows = blueprintRows(database, "alpha", "1.0.0").map((row) => ({
            ...row,
            name: 1
        }));
        database.pattern = /FROM definition_blueprints\s+WHERE name = \? AND version = \?/u;
        expect(() => store.getBlueprint("alpha", new SemVer("1.0.0"))).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored materialization name projection is malformed"
            })
        );

        database.rows = pointerRows.map((row) => ({ ...row, revision: 1.5 }));
        database.pattern = /FROM definition_materialization_pointers\s+WHERE actor_kind/u;
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored materialization revision projection is malformed"
            })
        );
    });

    test("rejects a pointer CAS read-back that returns a truncated record prefix", { tags: "p0" }, () => {
        const database = new TruncatedCasSqlite();
        const actor = actorRef("pointer-truncated");
        const store = new SqliteMaterializationStore(database, actor);
        const fixture = materializationState(actor, 1, "pointer-truncated");
        installGeneration(store, fixture);
        database.truncate = true;

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
                        fixture.materialization.generation.id
                    )
                )
            )
        ).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Generation pointer CAS returned malformed state"
            })
        );
        database.truncate = false;
        expect(store.getGenerationPointer(actor, deploymentId)).toBeUndefined();
        expect(database.all("SELECT actor_id FROM definition_materialization_pointers", [])).toEqual(
            []
        );
    });
});

class ListRowsSqlite extends TestSqlite {
    public table = "";
    public order: readonly number[] = [];

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (
            this.table === "" ||
            this.order.length === 0 ||
            !statement.includes(`FROM ${this.table}`) ||
            !statement.includes("ORDER BY") ||
            !this.order.every((index) => index < rows.length)
        ) {
            return rows;
        }
        return this.order.map((index) => rows[index]!);
    }
}

class SubstituteRowSqlite extends TestSqlite {
    public pattern: RegExp | undefined;
    public rows: readonly SqliteRow[] = [];

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.pattern?.test(statement) === true
            ? this.rows
            : super.all(statement, bindings);
    }
}

class TruncatedCasSqlite extends TestSqlite {
    public truncate = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (!this.truncate || !/INTO definition_materialization_pointers/u.test(statement)) {
            return rows;
        }
        return rows.map((row) => {
            const record = row["record"];
            return record instanceof Uint8Array ? { ...row, record: record.slice(0, 4) } : row;
        });
    }
}

function permutations(count: number): readonly (readonly number[])[] {
    const result: number[][] = [];
    const walk = (used: readonly number[]): void => {
        if (used.length === count) {
            result.push([...used]);
            return;
        }
        for (let index = 0; index < count; index += 1) {
            if (!used.includes(index)) walk([...used, index]);
        }
    };
    walk([]);
    return result;
}

function blueprintRows(
    database: TestSqlite,
    name: string,
    version: string
): readonly SqliteRow[] {
    return database.all(
        `SELECT name, version, digest, record FROM definition_blueprints
         WHERE name = ? AND version = ?`,
        [name, version]
    );
}

class PointerReadbackFaultSqlite extends TestSqlite {
    #armed = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (/INSERT INTO definition_materialization_pointers/u.test(statement)) {
            const rows = super.all(statement, bindings);
            this.#armed = true;
            return rows;
        }
        if (this.#armed && /FROM definition_materialization_pointers/u.test(statement)) {
            return [];
        }
        return super.all(statement, bindings);
    }
}

class WriteDropSqlite extends TestSqlite {
    public fault: "none" | "blueprint" | "plan" | "managed-state" = "none";

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (
            (this.fault === "blueprint" &&
                /INSERT OR IGNORE INTO definition_blueprints/u.test(statement)) ||
            (this.fault === "plan" &&
                /INSERT OR IGNORE INTO definition_materialization_plans/u.test(statement)) ||
            (this.fault === "managed-state" &&
                /INSERT OR IGNORE INTO definition_managed_state/u.test(statement))
        ) {
            return;
        }
        super.run(statement, bindings);
    }
}

class BlueprintRowFaultSqlite extends TestSqlite {
    public fault = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.fault && /FROM definition_blueprints/u.test(statement)) {
            return [
                {
                    name: "alpha",
                    version: "1.0.0",
                    digest: digestOf("alpha-blueprint").value,
                    record: "not-binary"
                }
            ];
        }
        return super.all(statement, bindings);
    }
}

interface TwoRecordClosure {
    readonly generation: MaterializationGeneration;
    readonly records: readonly ManagedStateRecord[];
}

function twoRecordClosure(
    actor: ActorRef,
    generation: number,
    seed: string,
    keys: readonly [string, string]
): TwoRecordClosure {
    const origin = new ManagedOrigin({
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
        origin,
        projections: [
            policyProjection(keys[0], PolicySet.empty()),
            policyProjection(keys[1], new PolicySet({ approvals: ["execute"] }))
        ]
    });
    const materializationGeneration = MaterializationGeneration.fromActorPlan(actorPlan);
    return {
        generation: materializationGeneration,
        records: actorPlan.projections.map((projection) =>
            ManagedStateRecord.fromProjection(
                actor,
                origin,
                materializationGeneration.id,
                projection
            )
        )
    };
}

function insertManagedStateRow(database: TestSqlite, record: ManagedStateRecord): void {
    database.run(
        `INSERT INTO definition_managed_state (
            id, generation_id, actor_kind, actor_id, logical_key,
            record_kind, desired_digest, record
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            record.id.value,
            record.generationId.value,
            record.actor.kind,
            record.actor.id.value,
            record.logicalKey,
            record.recordKind,
            record.desiredDigest.value,
            ManagedStateRecord.encode(record)
        ]
    );
}

function insertGenerationRow(database: TestSqlite, generation: MaterializationGeneration): void {
    database.run(
        `INSERT INTO definition_materialization_generations (
            id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
            config_digest, generation, record
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            generation.id.value,
            generation.actor.kind,
            generation.actor.id.value,
            generation.origin.blueprintDigest.value,
            generation.origin.packageLockDigest.value,
            generation.origin.configDigest.value,
            generation.origin.generation,
            MaterializationGeneration.encode(generation)
        ]
    );
}

function insertPointerRow(
    database: TestSqlite,
    pointer: MaterializationGenerationPointer
): void {
    database.run(
        `INSERT INTO definition_materialization_pointers (
            actor_kind, actor_id, deployment_id, generation_id, revision, record
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
            pointer.actor.kind,
            pointer.actor.id.value,
            pointer.deploymentId.value,
            pointer.generationId.value,
            pointer.revision.value,
            MaterializationGenerationPointer.encode(pointer)
        ]
    );
}

function orphanFallback(): ManagedStateRecord {
    throw new TypeError("Materialization fixture produced no managed state record");
}
