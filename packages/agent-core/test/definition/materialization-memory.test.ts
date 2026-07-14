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
    MaterializationGenerationPointer
} from "../../src/definition";
import { SqliteMaterializationStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    actorRef,
    blueprint,
    installGeneration,
    materializationState,
    materializationStoreContract
} from "./materialization-store-contract";

materializationStoreContract("memory", (owner) => new MemoryMaterializationStore(owner));

test("[materialization-store] memory and SQLite satisfy one shared codec-storage contract", () => {
    const owner = actorRef("materialization-seam");
    const stores = [
        new MemoryMaterializationStore(owner),
        new SqliteMaterializationStore(new TestSqlite(), owner)
    ];
    for (const [index, store] of stores.entries()) {
        const value = blueprint(`seam-${index}`, "1.0.0", { implementation: index });
        store.addBlueprint(value);
        expect(Blueprint.encode(store.getBlueprint(value.meta.name, value.meta.version)!)).toEqual(
            Blueprint.encode(value)
        );
    }
});

describe("MemoryMaterializationStore persistence", () => {
    test("[C13-BLUEPRINT-REMATERIALIZE] [definition.blueprint] [definition.materialization-plan] [definition.managed-state] [definition.materialization-generation] [definition.materialization-generation-pointer] restores a detached deterministic snapshot and clones all generation history", () => {
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
        expect(detached.managedState[0]!.generationId).toBeInstanceOf(MaterializationGenerationId);
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
            store.getGenerationPointer(actor, first.materialization.generation.origin.deploymentId)
                ?.revision.value
        ).toBe(1);

        const restored = new MemoryMaterializationStore(actor, store.snapshot());
        const cloned = restored.clone();
        expect(cloned.listBlueprints()).toHaveLength(2);
        expect(cloned.listPlans()).toHaveLength(2);
        expect(cloned.listGenerations()).toHaveLength(2);
        expect(cloned.listManagedState()).toHaveLength(2);
        expect(
            cloned
                .getGenerationPointer(actor, first.materialization.generation.origin.deploymentId)
                ?.generationId.equals(second.materialization.generation.id)
        ).toBe(true);
    });

    test("rejects asynchronous transactions without committing their draft", async () => {
        const store = new MemoryMaterializationStore(actorRef("workspace"));

        expect(() =>
            store.transaction(
                async () => undefined,
                "Actor transaction callbacks must be synchronous"
            )
        ).toThrow(/synchronous/);
        expect(store.listBlueprints()).toEqual([]);
        await Promise.resolve();
    });

    test.each([
        ["Blueprint", "blueprints"],
        ["plan", "plans"],
        ["generation", "generations"],
        ["managed state", "managedState"],
        ["pointer", "pointers"]
    ] as const)("rejects corrupt %s codec bytes in a snapshot", (_subject, collection) => {
        const snapshot = completeSnapshot();
        const corrupted = {
            ...snapshot,
            [collection]: [{ ...snapshot[collection][0]!, bytes: new Uint8Array([0]) }]
        } as MemoryMaterializationSnapshot;

        expect(() => new MemoryMaterializationStore(actorRef("workspace"), corrupted)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("rejects corrupt projections, dangling generation closure, and duplicate keys", () => {
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
    });

    test("rejects unsupported managed-state kinds during snapshot restore", () => {
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
    ] as const)("rejects malformed %s snapshot field %s", (collection, field) => {
        const snapshot = completeSnapshot();
        const corrupted = {
            ...snapshot,
            [collection]: [{ ...snapshot[collection][0]!, [field]: "" }]
        } as MemoryMaterializationSnapshot;
        expect(() => new MemoryMaterializationStore(actorRef("workspace"), corrupted)).toThrow(
            /malformed/
        );
    });

    test("rejects malformed snapshot bytes and duplicate pointer keys", () => {
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
    ] as const)("rejects detached %s projection mismatch in %s", (collection, field, value) => {
        const snapshot = completeSnapshot();
        const corrupted = {
            ...snapshot,
            [collection]: [{ ...snapshot[collection][0]!, [field]: value }]
        } as MemoryMaterializationSnapshot;
        expect(() => new MemoryMaterializationStore(actorRef("workspace"), corrupted)).toThrow();
    });
});

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
