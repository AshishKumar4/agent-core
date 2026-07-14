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
    DeploymentId,
    DeploymentKey,
    MaterializationGenerationId,
    MaterializationGenerationPointer
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
import {
    blueprint,
    installGeneration,
    materializationState
} from "./materialization-store-contract";

const encoder = new TextEncoder();
const actor = new ActorRef("tenant", new ActorId("tenant"));
const deploymentId = DeploymentId.derive(new TenantId("tenant"), new DeploymentKey("platform"));

describe("MaterializationStore hostile adapter boundaries", () => {
    test("rejects aliased plan generation managed-state and pointer rows", () => {
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

    test("detects pointer adapter CAS refusal and missing persisted state", () => {
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

    test("rejects malformed adapter bytes and duplicate list keys", () => {
        const store = hostileStore();
        store.rows.blueprints[0] = { ...store.rows.blueprints[0]!, bytes: "bad" as never };
        expect(() => store.listBlueprints()).toThrow(/bytes are malformed/);
        const duplicate = hostileStore();
        duplicate.duplicatePlans = true;
        expect(() => duplicate.listPlans()).toThrow(/duplicate immutable key/);
        expect(duplicate.getBlueprint("missing", new SemVer("1.0.0"))).toBeUndefined();
    });
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
