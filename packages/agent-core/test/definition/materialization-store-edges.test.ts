import { describe, expect, test } from "vitest";
import {
    ActorId,
    ActorRef,
    requireSynchronousResult,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { Digest, Revision, SemVer } from "../../src/core";
import {
    Blueprint,
    DeploymentId,
    DeploymentKey,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationId,
    MaterializationGenerationPointer,
    MaterializationPlan,
    PolicySet
} from "../../src/definition";
import {
    MaterializationStore,
    type StoredBlueprint,
    type StoredManagedStateRecord,
    type StoredMaterializationGeneration,
    type StoredMaterializationGenerationPointer,
    type StoredMaterializationPlan
} from "../../src/definition/materialization-store";
import { MemoryMaterializationStore } from "../../src/definition/memory";
import { TenantId } from "../../src/identity";
import { forged } from "./record-data";
import {
    blueprint,
    installGeneration,
    materializationState,
    materializationStateWithKeys
} from "./materialization-store-contract";

const encoder = new TextEncoder();
const actor = new ActorRef("tenant", new ActorId("tenant"));
const deploymentId = DeploymentId.derive(new TenantId("tenant"), new DeploymentKey("platform"));

describe("MaterializationStore hostile adapter boundaries", () => {
    test("rejects aliased plan generation managed-state and pointer rows", { tags: "p0" }, () => {
        const store = hostileStore();
        store.alias = true;
        expect(() => store.getPlan(digest("alias-plan"))).toThrow(/key does not match/);
        expect(() =>
            store.getGeneration(new MaterializationGenerationId(digest("alias-generation").value))
        ).toThrow(/key does not match/);
        expect(() => store.getManagedState(digest("alias-state"))).toThrow(/key does not match/);
        expect(() =>
            store.getGenerationPointer(
                actor,
                DeploymentId.derive(new TenantId("tenant"), new DeploymentKey("other"))
            )
        ).toThrow(/key does not match/);
    });

    test("detects pointer adapter CAS refusal and missing persisted state", { tags: "p0" }, () => {
        for (const fault of ["refuse", "drop"] as const) {
            const store = hostileStore(false);
            const fixture = materializationState(actor, 1, fault);
            store.addPlan(fixture.plan);
            installGeneration(store, fixture);
            store.pointerFault = fault;
            const apply = () =>
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
                );
            if (fault === "refuse") expect(apply()).toBe(false);
            else expect(apply).toThrow(/did not persist/);
        }
    });

    test("rejects malformed adapter bytes and duplicate list keys", { tags: "p0" }, () => {
        const store = hostileStore();
        store.rows.blueprints[0] = {
            ...store.rows.blueprints[0]!,
            bytes: forged<Uint8Array>("bad")
        };
        expect(() => store.listBlueprints()).toThrow(/bytes are malformed/);
        const duplicate = hostileStore();
        duplicate.duplicatePlans = true;
        expect(() => duplicate.listPlans()).toThrow(/duplicate immutable key/);
        expect(duplicate.getBlueprint("missing", new SemVer("1.0.0"))).toBeUndefined();
    });

    test("rejects foreign rows behind honest adapters", { tags: "p0" }, () => {
        const foreign = new ActorRef("workspace", new ActorId("foreign"));
        const foreignState = materializationState(foreign, 1, "foreign-rows");

        const planStore = hostileStore(false);
        planStore.rows.plans.push(rowForPlan(foreignState.plan));
        expect(() => planStore.getPlan(foreignState.plan.id)).toThrow(/exactly the store owner/);

        const generationStore = hostileStore(false);
        generationStore.rows.generations.push(
            rowForGeneration(foreignState.materialization.generation)
        );
        for (const record of foreignState.materialization.records) {
            generationStore.rows.managedState.push(rowForManagedState(record));
        }
        expect(() => generationStore.listGenerations()).toThrow(
            /Stored materialization generation belongs to a different Actor/
        );

        const stateStore = hostileStore(false);
        stateStore.rows.managedState.push(
            rowForManagedState(foreignState.materialization.records[0]!)
        );
        expect(() => stateStore.listManagedState()).toThrow(
            /Stored managed state belongs to a different Actor/
        );
    });

    test("validates blueprint identity against requested keys", { tags: "p1" }, () => {
        const real = blueprint("real", "1.0.0", { value: "real" });
        const mangled = hostileStore(false);
        mangled.rows.blueprints.push({ ...rowForBlueprint(real), name: "wrong" });
        expect(() => mangled.listBlueprints()).toThrow(
            /Stored Blueprint key or projection does not match codec bytes/
        );

        const aliased = hostileStore(false);
        aliased.blueprintAlias = rowForBlueprint(real);
        expect(() => aliased.getBlueprint("alias", new SemVer("1.0.0"))).toThrow(
            /Stored Blueprint key or projection does not match codec bytes/
        );
        expect(() => aliased.getBlueprint("real", new SemVer("2.0.0"))).toThrow(
            /Stored Blueprint key or projection does not match codec bytes/
        );
    });

    test("pins projection and codec-byte diagnostics for stored records", { tags: "p2" }, () => {
        const planStore = hostileStore();
        planStore.rows.plans[0] = {
            ...planStore.rows.plans[0]!,
            generation: planStore.rows.plans[0]!.generation + 1
        };
        expect(() => planStore.listPlans()).toThrow(
            /Stored materialization-plan key or projection does not match codec bytes/
        );

        const generationStore = hostileStore();
        generationStore.rows.generations[0] = {
            ...generationStore.rows.generations[0]!,
            generation: generationStore.rows.generations[0]!.generation + 1
        };
        expect(() => generationStore.listGenerations()).toThrow(
            /Stored generation key or projection does not match codec bytes/
        );

        const stateStore = hostileStore();
        stateStore.rows.managedState[0] = {
            ...stateStore.rows.managedState[0]!,
            desiredDigest: digest("mangled-desired").value
        };
        expect(() => stateStore.listManagedState()).toThrow(
            /Stored managed-state key or projection does not match codec bytes/
        );

        const pointerStore = hostileStore();
        pointerStore.rows.pointers[0] = { ...pointerStore.rows.pointers[0]!, revision: 5 };
        expect(() => pointerStore.listGenerationPointers()).toThrow(
            /Stored generation-pointer projection does not match codec bytes/
        );

        const pointerDeployment = hostileStore();
        pointerDeployment.rows.pointers[0] = {
            ...pointerDeployment.rows.pointers[0]!,
            deploymentId: digest("mangled-deployment").value
        };
        expect(() => pointerDeployment.listGenerationPointers()).toThrow(
            /Stored generation-pointer projection does not match codec bytes/
        );

        const byteCases = [
            ["blueprints", /Stored Blueprint codec bytes are malformed/],
            ["plans", /Stored materialization plan codec bytes are malformed/],
            ["generations", /Stored materialization generation codec bytes are malformed/],
            ["managedState", /Stored managed state codec bytes are malformed/],
            ["pointers", /Stored generation pointer codec bytes are malformed/]
        ] as const;
        for (const [collection, message] of byteCases) {
            const corrupted = hostileStore();
            corrupted.rows[collection][0] = {
                ...corrupted.rows[collection][0]!,
                bytes: forged<Uint8Array>("bad")
            };
            const read = () => {
                if (collection === "blueprints") return corrupted.listBlueprints();
                if (collection === "plans") return corrupted.listPlans();
                if (collection === "generations") return corrupted.listGenerations();
                if (collection === "managedState") return corrupted.listManagedState();
                return corrupted.listGenerationPointers();
            };
            expect(read).toThrow(message);
        }
    });

    test("rejects pointers that target missing or foreign state", { tags: "p0" }, () => {
        const missing = hostileStore();
        missing.rows.generations.length = 0;
        missing.rows.managedState.length = 0;
        expect(() => missing.listGenerationPointers()).toThrow(
            /Stored generation pointer targets missing or foreign state/
        );

        const fixture = materializationState(actor, 1, "pointer-target");
        const otherDeployment = DeploymentId.derive(
            new TenantId("tenant"),
            new DeploymentKey("other")
        );
        const crossDeployment = hostileStore(false);
        crossDeployment.rows.generations.push(rowForGeneration(fixture.materialization.generation));
        for (const record of fixture.materialization.records) {
            crossDeployment.rows.managedState.push(rowForManagedState(record));
        }
        crossDeployment.rows.pointers.push(
            rowForPointer(
                new MaterializationGenerationPointer({
                    actor,
                    deploymentId: otherDeployment,
                    generationId: fixture.materialization.generation.id,
                    revision: new Revision(0)
                })
            )
        );
        expect(() => crossDeployment.listGenerationPointers()).toThrow(
            /Stored generation pointer targets missing or foreign state/
        );

        const foreign = new ActorRef("workspace", new ActorId("foreign"));
        const foreignPointer = hostileStore(false);
        foreignPointer.rows.generations.push(rowForGeneration(fixture.materialization.generation));
        for (const record of fixture.materialization.records) {
            foreignPointer.rows.managedState.push(rowForManagedState(record));
        }
        foreignPointer.rows.pointers.push(
            rowForPointer(
                new MaterializationGenerationPointer({
                    actor: foreign,
                    deploymentId,
                    generationId: fixture.materialization.generation.id,
                    revision: new Revision(0)
                })
            )
        );
        expect(() => foreignPointer.listGenerationPointers()).toThrow(
            /Stored generation pointer targets missing or foreign state/
        );
    });

    test("enforces exact managed-state closures per generation", { tags: "p0" }, () => {
        const fixture = materializationStateWithKeys(actor, 1, "closure", ["slot:aa", "slot:zz"]);
        const generation = fixture.materialization.generation;
        const stray = new ManagedStateRecord({
            actor,
            origin: generation.origin,
            generationId: generation.id,
            logicalKey: "slot:stray",
            recordKind: "policy-set",
            desired: new PolicySet({ approvals: ["execute"] }).toData()
        });
        const mixed = hostileStore(false);
        mixed.rows.generations.push(rowForGeneration(generation));
        mixed.rows.managedState.push(
            rowForManagedState(fixture.materialization.records[0]!),
            rowForManagedState(stray)
        );
        expect(() => mixed.getGeneration(generation.id)).toThrow(
            /Materialization generation closure does not match managed state/
        );

        const otherFixture = materializationState(actor, 2, "closure-other");
        const seed = new MaterializationGeneration({
            actor,
            origin: generation.origin,
            actorPlanId: digest("closure-plan"),
            managedRecordIds: []
        });
        const member = new ManagedStateRecord({
            actor,
            origin: generation.origin,
            generationId: seed.id,
            logicalKey: "slot:member",
            recordKind: "policy-set",
            desired: new PolicySet({}).toData()
        });
        const foreignRecord = otherFixture.materialization.records[0]!;
        const manual = new MaterializationGeneration({
            actor,
            origin: generation.origin,
            actorPlanId: digest("closure-plan"),
            managedRecordIds: [member.id, foreignRecord.id]
        });
        const disowned = hostileStore(false);
        disowned.unfilteredManagedState = true;
        disowned.rows.generations.push(rowForGeneration(manual));
        disowned.rows.managedState.push(
            rowForManagedState(member),
            rowForManagedState(foreignRecord)
        );
        expect(() => disowned.getGeneration(manual.id)).toThrow(
            /Managed state does not belong to its materialization generation/
        );

        const left = new ManagedStateRecord({
            actor,
            origin: generation.origin,
            generationId: seed.id,
            logicalKey: "slot:shared",
            recordKind: "policy-set",
            desired: new PolicySet({}).toData()
        });
        const right = new ManagedStateRecord({
            actor,
            origin: generation.origin,
            generationId: seed.id,
            logicalKey: "slot:shared",
            recordKind: "policy-set",
            desired: new PolicySet({ approvals: ["execute"] }).toData()
        });
        const duplicated = new MaterializationGeneration({
            actor,
            origin: generation.origin,
            actorPlanId: digest("closure-plan"),
            managedRecordIds: [left.id, right.id]
        });
        const conflicted = hostileStore(false);
        conflicted.rows.generations.push(rowForGeneration(duplicated));
        conflicted.rows.managedState.push(rowForManagedState(left), rowForManagedState(right));
        expect(() => conflicted.getGeneration(duplicated.id)).toThrow(
            /Materialization generation contains conflicting logical keys/
        );
    });

    test(
        "keeps stored codec bytes independent of adapter-scribbled projection buffers",
        { tags: "p0" },
        () => {
            // kills src/definition/materialization-store.ts:637,648,664,680,694 (projection defensive byte copies)
            const store = new ScribblingMaterializationStore(actor, emptyRows());
            const fixture = materializationState(actor, 1, "scribble");
            const stamped = blueprint("scribble", "1.0.0", { value: "scribble" });

            store.addBlueprint(stamped);
            store.addPlan(fixture.plan);
            installGeneration(store, fixture);
            expect(
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
            ).toBe(true);

            expect(Blueprint.encode(store.getBlueprint("scribble", new SemVer("1.0.0"))!)).toEqual(
                Blueprint.encode(stamped)
            );
            expect(MaterializationPlan.encode(store.getPlan(fixture.plan.id)!)).toEqual(
                MaterializationPlan.encode(fixture.plan)
            );
            expect(
                MaterializationGeneration.encode(
                    store.getGeneration(fixture.materialization.generation.id)!
                )
            ).toEqual(MaterializationGeneration.encode(fixture.materialization.generation));
            expect(store.listManagedState(fixture.materialization.generation.id)).toHaveLength(1);
            expect(store.getGenerationPointer(actor, deploymentId)?.revision.value).toBe(0);
        }
    );

    test(
        "rejects byte-divergent generation replays before decoding adapter rows",
        { tags: "p0" },
        () => {
            // kills src/definition/materialization-store.ts:822 (equalBytes byte-length guard)
            const store = hostileStore(false);
            const fixture = materializationState(actor, 1, "prefix");
            const generation = fixture.materialization.generation;
            const bytes = MaterializationGeneration.encode(generation);
            store.rows.generations.push({
                ...rowForGeneration(generation),
                bytes: bytes.slice(0, bytes.byteLength - 1)
            });

            expect(() =>
                store.transaction((transaction) => store.insertGeneration(transaction, generation))
            ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
        }
    );

    test(
        "reports a revision conflict when the active pointer generation disappears mid-CAS",
        { tags: "p0" },
        () => {
            // kills src/definition/materialization-store.ts:376 (current-generation guard in pointer CAS)
            const memory = new MemoryMaterializationStore(actor);
            const first = materializationState(actor, 1, "flap-first");
            const second = materializationState(actor, 2, "flap-second");
            installGeneration(memory, first);
            installGeneration(memory, second);
            const initial = MaterializationGenerationPointer.initial(
                actor,
                deploymentId,
                first.materialization.generation.id
            );
            memory.transaction((transaction) =>
                memory.compareAndSetGenerationPointer(
                    transaction,
                    actor,
                    deploymentId,
                    undefined,
                    initial
                )
            );
            const snapshot = memory.snapshot();
            const store = new FlappingGenerationStore(
                actor,
                {
                    blueprints: [...snapshot.blueprints],
                    plans: [...snapshot.plans],
                    generations: [...snapshot.generations],
                    managedState: [...snapshot.managedState],
                    pointers: [...snapshot.pointers]
                },
                first.materialization.generation.id
            );

            expect(() =>
                store.transaction((transaction) =>
                    store.compareAndSetGenerationPointer(
                        transaction,
                        actor,
                        deploymentId,
                        initial.revision,
                        initial.activate(second.materialization.generation.id)
                    )
                )
            ).toThrowError(expect.objectContaining({ code: "protocol.revision-conflict" }));
        }
    );
});

interface HostileRows {
    blueprints: StoredBlueprint[];
    plans: StoredMaterializationPlan[];
    generations: StoredMaterializationGeneration[];
    managedState: StoredManagedStateRecord[];
    pointers: StoredMaterializationGenerationPointer[];
}

class HostileMaterializationStore extends MaterializationStore<HostileRows> {
    public alias = false;
    public duplicatePlans = false;
    public pointerFault: "none" | "refuse" | "drop" = "none";
    public blueprintAlias: StoredBlueprint | undefined;
    public unfilteredManagedState = false;

    public constructor(
        owner: ActorRef,
        public readonly rows: HostileRows
    ) {
        super(owner);
    }

    public transaction<Result>(
        operation: TransactionOperation<HostileRows, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return requireSynchronousResult(operation(this.rows));
    }

    protected findBlueprint(_tx: HostileRows, name: string, version: string) {
        if (this.blueprintAlias !== undefined) return this.blueprintAlias;
        return this.rows.blueprints.find((row) => row.name === name && row.version === version);
    }
    protected blueprintRecords() {
        return this.rows.blueprints;
    }
    protected writeBlueprint(_tx: HostileRows, row: StoredBlueprint) {
        const existing = this.findBlueprint(this.rows, row.name, row.version);
        if (existing !== undefined) return existing;
        this.rows.blueprints.push(row);
        return row;
    }
    protected findPlan(_tx: HostileRows, id: string) {
        return this.alias && id === digest("alias-plan").value
            ? this.rows.plans[0]
            : this.rows.plans.find((row) => row.id === id);
    }
    protected planRecords() {
        return this.duplicatePlans && this.rows.plans[0] !== undefined
            ? [this.rows.plans[0], this.rows.plans[0]]
            : this.rows.plans;
    }
    protected writePlan(_tx: HostileRows, row: StoredMaterializationPlan) {
        const existing = this.rows.plans.find((value) => value.id === row.id);
        if (existing !== undefined) return existing;
        this.rows.plans.push(row);
        return row;
    }
    protected findGeneration(_tx: HostileRows, id: MaterializationGenerationId) {
        return this.alias && id.value === digest("alias-generation").value
            ? this.rows.generations[0]
            : this.rows.generations.find((row) => row.id.equals(id));
    }
    protected generationRecords() {
        return this.rows.generations;
    }
    protected writeGeneration(_tx: HostileRows, row: StoredMaterializationGeneration) {
        const existing = this.rows.generations.find((value) => value.id.equals(row.id));
        if (existing !== undefined) return existing;
        this.rows.generations.push(row);
        return row;
    }
    protected findManagedState(_tx: HostileRows, id: string) {
        return this.alias && id === digest("alias-state").value
            ? this.rows.managedState[0]
            : this.rows.managedState.find((row) => row.id === id);
    }
    protected managedStateRecords(_tx: HostileRows, generationId?: MaterializationGenerationId) {
        if (this.unfilteredManagedState) return this.rows.managedState;
        return this.rows.managedState.filter(
            (row) => generationId === undefined || row.generationId.equals(generationId)
        );
    }
    protected writeManagedState(_tx: HostileRows, row: StoredManagedStateRecord) {
        const existing = this.rows.managedState.find((value) => value.id === row.id);
        if (existing !== undefined) return existing;
        this.rows.managedState.push(row);
        return row;
    }
    protected findGenerationPointer(_tx: HostileRows, _actor: ActorRef, requested: DeploymentId) {
        return this.alias && !requested.equals(deploymentId)
            ? this.rows.pointers[0]
            : this.rows.pointers.find((row) => row.deploymentId === requested.value);
    }
    protected generationPointerRecords() {
        return this.rows.pointers;
    }
    protected writeGenerationPointer(
        _tx: HostileRows,
        _expected: Revision | undefined,
        row: StoredMaterializationGenerationPointer
    ): boolean {
        if (this.pointerFault === "refuse") return false;
        if (this.pointerFault !== "drop") this.rows.pointers.push(row);
        return true;
    }
}

class ScribblingMaterializationStore extends HostileMaterializationStore {
    protected override writeBlueprint(
        transaction: HostileRows,
        blueprint: StoredBlueprint
    ): StoredBlueprint {
        return super.writeBlueprint(transaction, scribbled(blueprint));
    }

    protected override writePlan(
        transaction: HostileRows,
        plan: StoredMaterializationPlan
    ): StoredMaterializationPlan {
        return super.writePlan(transaction, scribbled(plan));
    }

    protected override writeGeneration(
        transaction: HostileRows,
        generation: StoredMaterializationGeneration
    ): StoredMaterializationGeneration {
        return super.writeGeneration(transaction, scribbled(generation));
    }

    protected override writeManagedState(
        transaction: HostileRows,
        record: StoredManagedStateRecord
    ): StoredManagedStateRecord {
        return super.writeManagedState(transaction, scribbled(record));
    }

    protected override writeGenerationPointer(
        transaction: HostileRows,
        expectedRevision: Revision | undefined,
        pointer: StoredMaterializationGenerationPointer
    ): boolean {
        return super.writeGenerationPointer(transaction, expectedRevision, scribbled(pointer));
    }
}

class FlappingGenerationStore extends HostileMaterializationStore {
    #visibleFlappingReads = 1;

    public constructor(
        owner: ActorRef,
        rows: HostileRows,
        private readonly flappingId: MaterializationGenerationId
    ) {
        super(owner, rows);
    }

    protected override findGeneration(
        transaction: HostileRows,
        id: MaterializationGenerationId
    ): StoredMaterializationGeneration | undefined {
        if (id.equals(this.flappingId)) {
            if (this.#visibleFlappingReads === 0) return undefined;
            this.#visibleFlappingReads -= 1;
        }
        return super.findGeneration(transaction, id);
    }
}

function emptyRows(): HostileRows {
    return { blueprints: [], plans: [], generations: [], managedState: [], pointers: [] };
}

function scribbled<Row extends { readonly bytes: Uint8Array }>(row: Row): Row {
    const detached = { ...row, bytes: row.bytes.slice() };
    row.bytes.fill(0);
    return detached;
}

function hostileStore(complete = true): HostileMaterializationStore {
    const memory = new MemoryMaterializationStore(actor);
    if (complete) {
        const fixture = materializationState(actor, 1, "complete");
        memory.addBlueprint(blueprint("platform", "1.0.0", {}));
        memory.addPlan(fixture.plan);
        installGeneration(memory, fixture);
        memory.transaction((transaction) =>
            memory.compareAndSetGenerationPointer(
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
        );
    }
    const snapshot = memory.snapshot();
    return new HostileMaterializationStore(actor, {
        blueprints: [...snapshot.blueprints],
        plans: [...snapshot.plans],
        generations: [...snapshot.generations],
        managedState: [...snapshot.managedState],
        pointers: [...snapshot.pointers]
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function rowForBlueprint(value: Blueprint): StoredBlueprint {
    const bytes = Blueprint.encode(value);
    return {
        name: value.meta.name,
        version: value.meta.version.toString(),
        digest: Digest.sha256(bytes).value,
        bytes
    };
}

function rowForPlan(plan: MaterializationPlan): StoredMaterializationPlan {
    return {
        id: plan.id.value,
        blueprintDigest: plan.blueprintDigest.value,
        packageLockDigest: plan.packageLockDigest.value,
        configDigest: plan.configDigest.value,
        generation: plan.generation,
        bytes: MaterializationPlan.encode(plan)
    };
}

function rowForGeneration(generation: MaterializationGeneration): StoredMaterializationGeneration {
    return {
        id: generation.id,
        actorKind: generation.actor.kind,
        actorId: new ActorId(generation.actor.id.value),
        blueprintDigest: generation.origin.blueprintDigest.value,
        packageLockDigest: generation.origin.packageLockDigest.value,
        configDigest: generation.origin.configDigest.value,
        generation: generation.origin.generation,
        bytes: MaterializationGeneration.encode(generation)
    };
}

function rowForManagedState(record: ManagedStateRecord): StoredManagedStateRecord {
    return {
        id: record.id.value,
        generationId: record.generationId,
        actorKind: record.actor.kind,
        actorId: new ActorId(record.actor.id.value),
        logicalKey: record.logicalKey,
        recordKind: record.recordKind,
        desiredDigest: record.desiredDigest.value,
        bytes: ManagedStateRecord.encode(record)
    };
}

function rowForPointer(
    pointer: MaterializationGenerationPointer
): StoredMaterializationGenerationPointer {
    return {
        actorKind: pointer.actor.kind,
        actorId: new ActorId(pointer.actor.id.value),
        deploymentId: pointer.deploymentId.value,
        generationId: pointer.generationId,
        revision: pointer.revision.value,
        bytes: MaterializationGenerationPointer.encode(pointer)
    };
}
