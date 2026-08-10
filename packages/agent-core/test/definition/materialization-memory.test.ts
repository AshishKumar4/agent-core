import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import {
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    MemoryMaterializationStore,
    type MemoryMaterializationSnapshot
} from "../../src/definition/memory";
import {
    Blueprint,
    MaterializationGenerationId,
    MaterializationGenerationPointer,
    MaterializationPlan
} from "../../src/definition";
import { SqliteMaterializationStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    actorRef,
    blueprint,
    installGeneration,
    materializationState,
    materializationStateWithKeys,
    materializationStoreContract
} from "./materialization-store-contract";

materializationStoreContract("memory", (owner) => new MemoryMaterializationStore(owner));

test(
    "[materialization-store] memory and SQLite satisfy one shared codec-storage contract",
    { tags: "p1" },
    () => {
        const owner = actorRef("materialization-seam");
        const stores = [
            new MemoryMaterializationStore(owner),
            new SqliteMaterializationStore(new TestSqlite(), owner)
        ];
        for (const [index, store] of stores.entries()) {
            const value = blueprint(`seam-${index}`, "1.0.0", { implementation: index });
            store.addBlueprint(value);
            expect(
                Blueprint.encode(store.getBlueprint(value.meta.name, value.meta.version)!)
            ).toEqual(Blueprint.encode(value));
        }
    }
);

describe("MemoryMaterializationStore persistence", () => {
    test(
        "[C13-BLUEPRINT-REMATERIALIZE] [definition.blueprint] [definition.materialization-plan] [definition.managed-state] [definition.materialization-generation] [definition.materialization-generation-pointer] restores a detached deterministic snapshot and clones all generation history",
        { tags: "p1" },
        () => {
            const actor = actorRef("workspace");
            const first = materializationState(actor, 1, "first");
            const second = materializationState(actor, 2, "second");
            const store = new MemoryMaterializationStore(actor);
            store.addBlueprint(blueprint("zeta", "1.0.0", { value: "zeta" }));
            store.addBlueprint(blueprint("alpha", "1.0.0", { value: "alpha" }));
            store.addPlan(second.plan);
            store.addPlan(first.plan);
            installGeneration(store, first);
            installGeneration(store, second);
            store.transaction((transaction) => {
                const initial = MaterializationGenerationPointer.initial(
                    actor,
                    first.materialization.generation.origin.deploymentId,
                    first.materialization.generation.id
                );
                expect(
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        first.materialization.generation.origin.deploymentId,
                        undefined,
                        initial
                    )
                ).toBe(true);
                expect(
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        first.materialization.generation.origin.deploymentId,
                        initial.revision,
                        initial.activate(second.materialization.generation.id)
                    )
                ).toBe(true);
            });

            const detached = store.snapshot();
            expect(detached.generations[0]!.id).toBeInstanceOf(MaterializationGenerationId);
            expect(detached.generations[0]!.actorId).toBeInstanceOf(ActorId);
            expect(detached.managedState[0]!.generationId).toBeInstanceOf(
                MaterializationGenerationId
            );
            expect(detached.pointers[0]!.actorId).toBeInstanceOf(ActorId);
            expect(detached.blueprints.map((row) => row.name)).toEqual(["alpha", "zeta"]);
            expect(detached.plans.map((row) => row.id)).toEqual(
                detached.plans.map((row) => row.id).sort()
            );
            detached.blueprints[0]!.bytes.fill(0);
            detached.plans[0]!.bytes.fill(0);
            detached.generations[0]!.bytes.fill(0);
            detached.managedState[0]!.bytes.fill(0);
            detached.pointers[0]!.bytes.fill(0);

            expect(store.getBlueprint("alpha", new SemVer("1.0.0"))).toBeDefined();
            expect(store.listPlans()).toHaveLength(2);
            expect(store.listGenerations()).toHaveLength(2);
            expect(store.listManagedState()).toHaveLength(2);
            expect(
                store.getGenerationPointer(
                    actor,
                    first.materialization.generation.origin.deploymentId
                )?.revision.value
            ).toBe(1);

            const restored = new MemoryMaterializationStore(actor, store.snapshot());
            const cloned = restored.clone();
            expect(cloned.listBlueprints()).toHaveLength(2);
            expect(cloned.listPlans()).toHaveLength(2);
            expect(cloned.listGenerations()).toHaveLength(2);
            expect(cloned.listManagedState()).toHaveLength(2);
            expect(
                cloned
                    .getGenerationPointer(
                        actor,
                        first.materialization.generation.origin.deploymentId
                    )
                    ?.generationId.equals(second.materialization.generation.id)
            ).toBe(true);
        }
    );

    test("orders detached materialization snapshot rows deterministically", { tags: "p1" }, () => {
        const actor = actorRef("ordering");
        const store = new MemoryMaterializationStore(actor);
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
        expect([planAlpha, planBeta].map((fixture) => fixture.plan.id.value).sort()).toEqual([
            planBeta.plan.id.value,
            planAlpha.plan.id.value
        ]);
        expect(
            [first, second, third]
                .map((fixture) => fixture.materialization.generation.id.value)
                .sort()
        ).toEqual([
            second.materialization.generation.id.value,
            first.materialization.generation.id.value,
            third.materialization.generation.id.value
        ]);

        const detached = store.snapshot();
        expect(detached.plans.map((row) => row.id)).toEqual([
            planBeta.plan.id.value,
            planAlpha.plan.id.value
        ]);
        expect(detached.generations.map((row) => row.id.value)).toEqual([
            second.materialization.generation.id.value,
            first.materialization.generation.id.value,
            third.materialization.generation.id.value
        ]);
        expect(detached.managedState.map((row) => row.generationId.value)).toEqual([
            second.materialization.generation.id.value,
            first.materialization.generation.id.value,
            third.materialization.generation.id.value
        ]);
        expect(detached.managedState.map((row) => row.logicalKey)).toEqual([
            "slot:mm",
            "slot:kk",
            "slot:pp"
        ]);
    });

    test("orders generation pointers by deployment across deployments", { tags: "p1" }, () => {
        const actor = actorRef("ordering");
        const store = new MemoryMaterializationStore(actor);
        const fixtures = ["dep-b", "dep-a", "dep-c"].map((key) =>
            materializationState(actor, 1, key, `slot:${key}`, key, key)
        );
        for (const fixture of fixtures) {
            installGeneration(store, fixture);
            store.transaction((transaction) => {
                expect(
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        fixture.materialization.generation.origin.deploymentId,
                        undefined,
                        MaterializationGenerationPointer.initial(
                            actor,
                            fixture.materialization.generation.origin.deploymentId,
                            fixture.materialization.generation.id
                        )
                    )
                ).toBe(true);
            });
        }
        const deployments = fixtures.map(
            (fixture) => fixture.materialization.generation.origin.deploymentId.value
        );
        expect([...deployments].sort()).toEqual([deployments[1], deployments[2], deployments[0]]);

        expect(store.listGenerationPointers()).toHaveLength(3);
        for (const fixture of fixtures) {
            expect(
                store.getGenerationPointer(
                    actor,
                    fixture.materialization.generation.origin.deploymentId
                )?.revision.value
            ).toBe(0);
        }
        expect(store.snapshot().pointers.map((row) => row.deploymentId)).toEqual([
            deployments[1],
            deployments[2],
            deployments[0]
        ]);
    });

    test("rejects Tenant control records in Actor-local snapshots", { tags: "p0" }, () => {
        const tenant = actorRef("control");
        const control = new MemoryMaterializationStore(tenant);
        control.addBlueprint(blueprint("platform", "1.0.0", {}));
        control.addPlan(materializationState(tenant, 1, "control").plan);
        const snapshot = control.snapshot();
        const empty = {
            blueprints: [],
            plans: [],
            generations: [],
            managedState: [],
            pointers: []
        };

        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace-owner", "workspace"), {
                    ...empty,
                    blueprints: snapshot.blueprints
                })
        ).toThrow(/Actor-local materialization snapshots cannot contain Tenant control records/);
        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace-owner", "workspace"), {
                    ...empty,
                    plans: snapshot.plans
                })
        ).toThrow(/Actor-local materialization snapshots cannot contain Tenant control records/);
    });

    test("restores multi-record generations from a detached snapshot", { tags: "p1" }, () => {
        const actor = actorRef("workspace");
        const fixture = materializationStateWithKeys(actor, 1, "restore-two", [
            "slot:aa",
            "slot:zz"
        ]);
        const store = new MemoryMaterializationStore(actor);
        installGeneration(store, fixture);

        const restored = new MemoryMaterializationStore(actor, store.snapshot());
        expect(restored.listManagedState(fixture.materialization.generation.id)).toHaveLength(2);
        expect(
            restored
                .listManagedState(fixture.materialization.generation.id)
                .map((record) => record.logicalKey)
        ).toEqual(["slot:aa", "slot:zz"]);
    });

    test("names malformed snapshot rows with their exact subject", { tags: "p2" }, () => {
        const snapshot = completeSnapshot();
        const cases: readonly [keyof MemoryMaterializationSnapshot, string, unknown, RegExp][] = [
            [
                "plans",
                "generation",
                -1,
                /Memory materialization snapshot materialization plan generation is malformed/
            ],
            [
                "plans",
                "generation",
                1.5,
                /Memory materialization snapshot materialization plan generation is malformed/
            ],
            [
                "blueprints",
                "name",
                7,
                /Memory materialization snapshot Blueprint name is malformed/
            ],
            [
                "generations",
                "id",
                "1".repeat(64),
                /Memory materialization snapshot generation ID is malformed/
            ],
            [
                "generations",
                "actorId",
                "other",
                /Memory materialization snapshot generation Actor ID is malformed/
            ],
            [
                "managedState",
                "generationId",
                "1".repeat(64),
                /Memory materialization snapshot managed-state generation ID is malformed/
            ],
            [
                "managedState",
                "actorId",
                "other",
                /Memory materialization snapshot managed-state Actor ID is malformed/
            ],
            [
                "pointers",
                "actorId",
                "other",
                /Memory materialization snapshot generation-pointer Actor ID is malformed/
            ],
            [
                "pointers",
                "generationId",
                "1".repeat(64),
                /Memory materialization snapshot generation-pointer generation ID is malformed/
            ],
            [
                "pointers",
                "revision",
                -1,
                /Memory materialization snapshot generation-pointer revision is malformed/
            ],
            [
                "blueprints",
                "bytes",
                "bad",
                /Memory materialization snapshot Blueprint bytes are malformed/
            ],
            [
                "plans",
                "bytes",
                "bad",
                /Memory materialization snapshot materialization plan bytes are malformed/
            ],
            [
                "generations",
                "bytes",
                "bad",
                /Memory materialization snapshot generation bytes are malformed/
            ],
            [
                "managedState",
                "bytes",
                "bad",
                /Memory materialization snapshot managed state bytes are malformed/
            ],
            [
                "pointers",
                "bytes",
                "bad",
                /Memory materialization snapshot generation pointer bytes are malformed/
            ]
        ];
        for (const [collection, field, value, message] of cases) {
            const corrupted = {
                ...snapshot,
                [collection]: [{ ...snapshot[collection][0]!, [field]: value }]
            } as MemoryMaterializationSnapshot;
            expect(() => new MemoryMaterializationStore(actorRef("workspace"), corrupted)).toThrow(
                message
            );
        }
    });

    test(
        "rejects asynchronous transactions without committing their draft",
        { tags: "p0" },
        async () => {
            const store = new MemoryMaterializationStore(actorRef("workspace"));

            expect(() =>
                store.transaction(
                    async () => undefined,
                    "Actor transaction callbacks must be synchronous"
                )
            ).toThrow(/synchronous/);
            expect(store.listBlueprints()).toEqual([]);
            await Promise.resolve();
        }
    );

    test.each([
        ["Blueprint", "blueprints"],
        ["plan", "plans"],
        ["generation", "generations"],
        ["managed state", "managedState"],
        ["pointer", "pointers"]
    ] as const)(
        "rejects corrupt %s codec bytes in a snapshot",
        { tags: "p0" },
        (_subject, collection) => {
            const snapshot = completeSnapshot();
            const corrupted = {
                ...snapshot,
                [collection]: [{ ...snapshot[collection][0]!, bytes: new Uint8Array([0]) }]
            } as MemoryMaterializationSnapshot;

            expect(
                () => new MemoryMaterializationStore(actorRef("workspace"), corrupted)
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        }
    );

    test(
        "rejects corrupt projections, dangling generation closure, and duplicate keys",
        { tags: "p0" },
        () => {
            const snapshot = completeSnapshot();
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        blueprints: [{ ...snapshot.blueprints[0]!, digest: "0".repeat(64) }]
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        plans: [
                            { ...snapshot.plans[0]!, generation: snapshot.plans[0]!.generation + 1 }
                        ]
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        generations: [{ ...snapshot.generations[0]!, actorId: "other" as never }]
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        managedState: [{ ...snapshot.managedState[0]!, logicalKey: "other" }]
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        pointers: [{ ...snapshot.pointers[0]!, revision: new Revision(9).value }]
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        managedState: []
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        generations: [],
                        pointers: []
                    })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
            expect(
                () =>
                    new MemoryMaterializationStore(actorRef("workspace"), {
                        ...snapshot,
                        generations: [snapshot.generations[0]!, snapshot.generations[0]!]
                    })
            ).toThrow(/duplicate materialization generations/);
        }
    );

    test("rejects unsupported managed-state kinds during snapshot restore", { tags: "p1" }, () => {
        const snapshot = completeSnapshot();

        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace"), {
                    ...snapshot,
                    managedState: [{ ...snapshot.managedState[0]!, recordKind: "facet.slot-entry" }]
                })
        ).toThrow(/Unsupported materialization record kind/);

        const row = snapshot.managedState[0]!;
        const envelope = requireObject(decodeCanonicalJson(row.bytes));
        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace"), {
                    ...snapshot,
                    managedState: [
                        {
                            ...row,
                            bytes: encodeCanonicalJson({
                                ...envelope,
                                payload: {
                                    ...requireObject(envelope["payload"]!),
                                    recordKind: "slot-entry"
                                }
                            })
                        }
                    ]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test.each([
        ["blueprints", "name"],
        ["plans", "id"],
        ["generations", "actorKind"],
        ["managedState", "logicalKey"],
        ["pointers", "deploymentId"]
    ] as const)("rejects malformed %s snapshot field %s", { tags: "p0" }, (collection, field) => {
        const snapshot = completeSnapshot();
        const corrupted = {
            ...snapshot,
            [collection]: [{ ...snapshot[collection][0]!, [field]: "" }]
        } as MemoryMaterializationSnapshot;
        expect(() => new MemoryMaterializationStore(actorRef("workspace"), corrupted)).toThrow(
            /malformed/
        );
    });

    test(
        "keeps a stored materialization plan immutable against a byte-divergent rewrite",
        { tags: "p0" },
        () => {
            const owner = actorRef("plan-bytes");
            const fixture = materializationStateWithKeys(owner, 1, "plan-bytes", [
                "slot:aa",
                "slot:zz"
            ]);
            const divergent = reorderedProjectionPlanBytes(fixture.plan);
            expect(divergent).not.toEqual(MaterializationPlan.encode(fixture.plan));

            const store = new MemoryMaterializationStore(owner, {
                blueprints: [],
                plans: [
                    {
                        id: fixture.plan.id.value,
                        blueprintDigest: fixture.plan.blueprintDigest.value,
                        packageLockDigest: fixture.plan.packageLockDigest.value,
                        configDigest: fixture.plan.configDigest.value,
                        generation: fixture.plan.generation,
                        bytes: divergent
                    }
                ],
                generations: [],
                managedState: [],
                pointers: []
            });

            expect(() => store.addPlan(fixture.plan)).toThrow(
                `Materialization plan ${fixture.plan.id.value} is immutable`
            );
            expect(store.snapshot().plans.map((row) => row.bytes)).toEqual([divergent]);
        }
    );

    test("rejects malformed snapshot bytes and duplicate pointer keys", { tags: "p0" }, () => {
        const snapshot = completeSnapshot();
        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace"), {
                    ...snapshot,
                    blueprints: [{ ...snapshot.blueprints[0]!, bytes: "bad" as never }]
                })
        ).toThrow(/bytes are malformed/);
        expect(
            () =>
                new MemoryMaterializationStore(actorRef("workspace"), {
                    ...snapshot,
                    pointers: [snapshot.pointers[0]!, snapshot.pointers[0]!]
                })
        ).toThrow(/duplicate generation pointers/);
    });

    test.each([
        ["blueprints", "version", "2.0.0"],
        ["plans", "id", "1".repeat(64)],
        ["plans", "blueprintDigest", "1".repeat(64)],
        ["plans", "packageLockDigest", "1".repeat(64)],
        ["plans", "configDigest", "1".repeat(64)],
        ["generations", "id", "1".repeat(64)],
        ["generations", "actorKind", "run"],
        ["generations", "blueprintDigest", "1".repeat(64)],
        ["generations", "packageLockDigest", "1".repeat(64)],
        ["generations", "configDigest", "1".repeat(64)],
        ["managedState", "id", "1".repeat(64)],
        ["managedState", "generationId", "1".repeat(64)],
        ["managedState", "actorKind", "run"],
        ["managedState", "actorId", "other"],
        ["managedState", "recordKind", "facet-placement"],
        ["managedState", "desiredDigest", "1".repeat(64)],
        ["pointers", "actorKind", "run"],
        ["pointers", "actorId", "other"],
        ["pointers", "generationId", "1".repeat(64)]
    ] as const)(
        "rejects detached %s projection mismatch in %s",
        { tags: "p0" },
        (collection, field, value) => {
            const snapshot = completeSnapshot();
            const corrupted = {
                ...snapshot,
                [collection]: [{ ...snapshot[collection][0]!, [field]: value }]
            } as MemoryMaterializationSnapshot;
            expect(
                () => new MemoryMaterializationStore(actorRef("workspace"), corrupted)
            ).toThrow();
        }
    );
});

function reorderedProjectionPlanBytes(plan: MaterializationPlan): Uint8Array {
    return encodeCanonicalJson({
        kind: MaterializationPlan.codec.kind,
        version: {
            major: MaterializationPlan.codec.version.major,
            minor: MaterializationPlan.codec.version.minor
        },
        payload: {
            actors: plan.actors.map((actorPlan) => ({
                actor: { id: actorPlan.actor.id.value, kind: actorPlan.actor.kind },
                id: actorPlan.id.value,
                origin: actorPlan.origin.toData(),
                projections: [...actorPlan.projections]
                    .reverse()
                    .map((projection) => projection.toData())
            })),
            id: plan.id.value,
            origin: plan.origin.toData()
        }
    });
}

function completeSnapshot(): MemoryMaterializationSnapshot {
    const actor = actorRef("workspace");
    const fixture = materializationState(actor, 1, "snapshot");
    const store = new MemoryMaterializationStore(actor);
    store.addBlueprint(blueprint("platform", "1.0.0", {}));
    store.addPlan(fixture.plan);
    installGeneration(store, fixture);
    store.transaction((transaction) => {
        expect(
            store.compareAndSetGenerationPointer(
                transaction,
                actor,
                fixture.materialization.generation.origin.deploymentId,
                undefined,
                MaterializationGenerationPointer.initial(
                    actor,
                    fixture.materialization.generation.origin.deploymentId,
                    fixture.materialization.generation.id
                )
            )
        ).toBe(true);
    });
    return store.snapshot();
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected JSON object");
    }
    return value as { readonly [key: string]: JsonValue };
}
