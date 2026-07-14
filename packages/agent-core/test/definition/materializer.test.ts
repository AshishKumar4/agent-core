import { describe, expect, test } from "vitest";
import * as Definition from "../../src/definition";
import {
    ActorId,
    ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    DesiredProjection,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    MaterializationPlan,
    PolicySet,
    policyProjection
} from "../../src/definition";
import {
    LocalMaterializationStore,
    LocalMaterializer,
    materializeActorPlan
} from "../../src/definition/materializer";
import { AgentCoreError } from "../../src/errors";
import { TenantId } from "../../src/identity";
import { RunPinEvidence, type ManagedResourceSnapshot } from "../../src/definition/reconciliation";
import {
    MemoryManagedResourcePort,
    cloneManagedResources,
    type MemoryManagedResourceState
} from "./managed-resource-port";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("same-Actor additive materialization", () => {
    test("[C13-POLICY-DIRECT-COLOCATION] keeps direct local mutation machinery out of the definition barrel", () => {
        expect("LocalMaterializationStore" in Definition).toBe(false);
        expect("LocalMaterializer" in Definition).toBe(false);
        expect("materializeActorPlan" in Definition).toBe(false);
        expect("materializationKinds" in Definition).toBe(false);
        expect("requireMaterializationKind" in Definition).toBe(false);
        expect("validateMaterializationKind" in Definition).toBe(false);
        expect(
            () =>
                new LocalMaterializer({
                    actor: actorRef("target"),
                    store: new MemoryMaterializationStore(actorRef("other")),
                    resources: new MemoryManagedResourcePort<StoreState>()
                })
        ).toThrow(/different Actor/);
    });

    test("[definition.managed-state] [definition.materialization-generation] [definition.materialization-generation-pointer] derives stable IDs and strictly round-trips generation state codecs", () => {
        const actor = actorRef("workspace-a");
        const first = actorPlan(actor, origin(1, "config-a"), [
            projection("slot:z", { value: 2 }),
            projection("slot:a", { value: 1 })
        ]);
        const reordered = actorPlan(actor, origin(1, "config-a"), [
            projection("slot:a", { value: 1 }),
            projection("slot:z", { value: 2 })
        ]);

        const left = materializeActorPlan(actor, first);
        const right = materializeActorPlan(actor, reordered);
        expect(() => materializeActorPlan(actorRef("foreign"), first)).toThrow(/exactly equal/);
        const pointer = MaterializationGenerationPointer.initial(
            actor,
            deploymentId,
            left.generation.id
        );

        expect(MaterializationGeneration.encode(right.generation)).toEqual(
            MaterializationGeneration.encode(left.generation)
        );
        expect(right.records.map((record) => record.id.value)).toEqual(
            left.records.map((record) => record.id.value)
        );
        expect(
            MaterializationGeneration.encode(
                MaterializationGeneration.decode(MaterializationGeneration.encode(left.generation))
            )
        ).toEqual(MaterializationGeneration.encode(left.generation));
        expect(
            ManagedStateRecord.encode(
                ManagedStateRecord.decode(ManagedStateRecord.encode(left.records[0]!))
            )
        ).toEqual(ManagedStateRecord.encode(left.records[0]!));
        expect(
            MaterializationGenerationPointer.encode(
                MaterializationGenerationPointer.decode(
                    MaterializationGenerationPointer.encode(pointer)
                )
            )
        ).toEqual(MaterializationGenerationPointer.encode(pointer));

        const envelope = jsonObject(MaterializationGeneration.encode(left.generation));
        const payload = jsonObjectValue(envelope["payload"]);
        expectCodecError(
            () =>
                MaterializationGeneration.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, status: "active" }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                MaterializationGenerationPointer.decode(
                    encodeCanonicalJson({
                        ...jsonObject(MaterializationGenerationPointer.encode(pointer)),
                        version: { major: 3, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
        const managedEnvelope = jsonObject(ManagedStateRecord.encode(left.records[0]!));
        expectCodecError(
            () =>
                ManagedStateRecord.decode(
                    encodeCanonicalJson({
                        ...managedEnvelope,
                        payload: {
                            ...jsonObjectValue(managedEnvelope["payload"]),
                            recordKind: "slot-entry"
                        }
                    })
                ),
            "codec.invalid"
        );
        expect(
            () =>
                new ManagedStateRecord({
                    ...left.records[0]!,
                    recordKind: "facet.slot-entry"
                })
        ).toThrow(/Unsupported materialization record kind/);
    });

    test("applies reordered plans once and makes an equal replay a no-op", () => {
        const actor = actorRef("workspace-a");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const materializationOrigin = origin(2, "config-a");
        const first = actorPlan(actor, materializationOrigin, [
            projection("slot:z", { value: 2 }),
            projection("slot:a", { value: 1 })
        ]);
        const reordered = actorPlan(actor, materializationOrigin, [
            projection("slot:a", { value: 1 }),
            projection("slot:z", { value: 2 })
        ]);

        const applied = materializer.apply(first);
        const replayed = materializer.apply(reordered);
        const snapshot = store.snapshot();

        expect(applied).toMatchObject({
            insertedGeneration: true,
            pointerChanged: true,
            semanticNoop: false
        });
        expect(applied.insertedRecords).toHaveLength(2);
        expect(replayed).toMatchObject({
            insertedGeneration: false,
            insertedRecords: [],
            pointerChanged: false,
            semanticNoop: true
        });
        expect(snapshot.generations).toHaveLength(1);
        expect(snapshot.records).toHaveLength(2);
        expect(snapshot.pointer?.revision.value).toBe(0);
        expect(snapshot.transactionCount).toBe(2);
    });

    test("journals a new origin when unchanged desired state is re-materialized", () => {
        const actor = actorRef("workspace-origin-noop");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        materializer.apply(
            actorPlan(actor, origin(1, "one"), [projection("policy:stable", { value: 1 })])
        );
        const result = materializer.apply(
            actorPlan(actor, origin(2, "two"), [projection("policy:stable", { value: 1 })])
        );
        expect(result.semanticNoop).toBe(true);
        expect(result.pointerChanged).toBe(true);
        expect(result.generation.origin.generation).toBe(2);
        expect(result.pointer.revision.value).toBe(1);
    });

    test("rejects immutable generation conflicts without retaining partial records", () => {
        const actor = actorRef("workspace-a");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const sharedOrigin = origin(3, "config-a");
        const accepted = actorPlan(actor, sharedOrigin, [projection("slot:a", { value: 1 })]);
        const conflicting = actorPlan(actor, sharedOrigin, [projection("slot:b", { value: 2 })]);
        materializer.apply(accepted);
        const before = store.snapshot();

        expect(() => materializer.apply(conflicting)).toThrow(
            /generation.*(?:immutable|strictly increase)/
        );

        const after = store.snapshot();
        expect(after.generations.map((generation) => generation.id.value)).toEqual(
            before.generations.map((generation) => generation.id.value)
        );
        expect(after.records.map((record) => record.id.value)).toEqual(
            before.records.map((record) => record.id.value)
        );
        expect(after.pointer?.generationId.value).toBe(before.pointer?.generationId.value);
    });

    test("moves only the active pointer and leaves old generations and state untouched", () => {
        const actor = actorRef("workspace-a");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const oldResult = materializer.apply(
            actorPlan(actor, origin(1, "config-a"), [projection("slot:a", { value: 1 })])
        );
        const nextResult = materializer.apply(
            actorPlan(actor, origin(2, "config-b"), [projection("slot:a", { value: 2 })])
        );
        const snapshot = store.snapshot();

        expect(snapshot.generations.map((generation) => generation.id.value).sort()).toEqual(
            [oldResult.generation.id.value, nextResult.generation.id.value].sort()
        );
        expect(snapshot.records).toHaveLength(2);
        expect(snapshot.pointer?.generationId.equals(nextResult.generation.id)).toBe(true);
        expect(snapshot.pointer?.revision.value).toBe(1);
        expect(snapshot.deletedRecords).toBe(0);
    });

    test("does not query existing Runs or require a current-generation fallback", () => {
        const actor = actorRef("workspace-a");
        const store = new MemoryMaterializationStore(actor, ["existing-run", "pinned-run"]);
        const materializer = localMaterializer(actor, store);

        expect(() =>
            materializer.apply(
                actorPlan(actor, origin(1, "config-a"), [projection("slot:a", { value: 1 })])
            )
        ).not.toThrow();
        expect(store.snapshot()).toMatchObject({
            runQueries: 0,
            runs: ["existing-run", "pinned-run"]
        });
    });

    test("rejects foreign targets and multi-Actor plans before writing", () => {
        const owner = actorRef("workspace-a");
        const foreign = actorRef("workspace-b");
        const store = new MemoryMaterializationStore(owner);
        const materializer = localMaterializer(owner, store);
        const materializationOrigin = origin(1, "config-a");
        const ownerPlan = actorPlan(owner, materializationOrigin, [
            projection("slot:a", { value: 1 })
        ]);
        const foreignPlan = actorPlan(foreign, materializationOrigin, [
            projection("slot:b", { value: 2 })
        ]);

        expect(() => materializer.apply(foreignPlan)).toThrow(/owning Actor/);
        expect(() =>
            materializer.apply(
                new MaterializationPlan({
                    origin: materializationOrigin,
                    actors: [ownerPlan, foreignPlan]
                })
            )
        ).toThrow(/multi-Actor/);
        expect(store.snapshot()).toMatchObject({
            generations: [],
            records: [],
            transactionCount: 0
        });
    });

    test.each([
        "test-resource",
        "binding",
        "scope",
        "agent-profile",
        "slot-entry",
        "facet.slot-entry",
        "authority.grant",
        "identity.role"
    ])("rechecks unsupported %s projections before opening a transaction", (recordKind) => {
        const actor = actorRef("tenant-a", "tenant");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const valid = actorPlan(actor, origin(1, "config-a"), [
            projection("policy:tenant", { value: 1 })
        ]);

        expect(() => materializer.apply(forgeActorPlanKind(valid, recordKind))).toThrow(
            /Unsupported materialization record kind/
        );
        expectEmpty(store);
    });

    test("rejects stale generation replay and requires a higher generation for rollback", () => {
        const actor = actorRef("workspace-a");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const first = actorPlan(actor, origin(1, "first"), [projection("slot:a", { value: 1 })]);
        const second = actorPlan(actor, origin(2, "second"), [projection("slot:a", { value: 2 })]);
        materializer.apply(first);
        materializer.apply(second);

        expect(() => materializer.apply(first)).toThrow(/strictly increase/);

        const rollback = actorPlan(actor, origin(3, "rollback"), [
            projection("slot:a", { value: 1 })
        ]);
        expect(materializer.apply(rollback).pointerChanged).toBe(true);
        expect(
            store
                .snapshot()
                .pointer?.generationId.equals(materializeActorPlan(actor, rollback).generation.id)
        ).toBe(true);
    });

    test("rolls back local writes when managed insertion or pointer CAS fails", () => {
        const workspace = actorRef("workspace-a");
        const insertFault = new MemoryMaterializationStore(workspace);
        insertFault.failManagedInsert = true;
        expect(() =>
            localMaterializer(workspace, insertFault).apply(
                actorPlan(workspace, origin(1, "insert"), [projection("slot:a", { value: 1 })])
            )
        ).toThrow(/injected managed-state fault/);
        expectEmpty(insertFault);

        const casFault = new MemoryMaterializationStore(workspace);
        casFault.failCas = true;
        expect(() =>
            localMaterializer(workspace, casFault).apply(
                actorPlan(workspace, origin(1, "cas"), [projection("slot:a", { value: 1 })])
            )
        ).toThrow(/changed concurrently/);
        expectEmpty(casFault);
    });

    test("reconciles create update and remove with one stable managed resource identity", () => {
        const actor = actorRef("workspace-reconcile");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        const created = materializer.apply(
            actorPlan(actor, origin(1, "one"), [projection("policy:stable", { value: 1 })])
        );
        const resourceId = store.snapshot().resources[0]!.resourceId;

        const updated = materializer.apply(
            actorPlan(actor, origin(2, "two"), [projection("policy:stable", { value: 2 })])
        );
        expect(updated.actions).toEqual(["update"]);
        expect(store.snapshot().resources[0]!.resourceId.equals(resourceId)).toBe(true);
        expect(store.snapshot().resources[0]!.revision.value).toBe(1);

        const removed = materializer.apply(actorPlan(actor, origin(3, "three"), []));
        expect(removed.actions).toEqual(["remove"]);
        expect(store.snapshot().resources).toEqual([]);
        expect(removed.pointer.revision.value).toBe(created.pointer.revision.value + 2);
    });

    test("rejects drift and rolls owner state back with journal state", () => {
        const actor = actorRef("workspace-drift");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        materializer.apply(
            actorPlan(actor, origin(1, "one"), [projection("policy:stable", { value: 1 })])
        );
        const activeDigest = store.snapshot().resources[0]!.desiredDigest;
        store.drift(digestOf("manual-edit"));
        const before = store.snapshot();

        expect(() =>
            materializer.apply(
                actorPlan(actor, origin(2, "two"), [projection("policy:stable", { value: 2 })])
            )
        ).toThrow(/drifted/);
        expect(store.snapshot()).toEqual(before);

        store.resourcePort.failAfterMutation = true;
        store.restoreResourceDigest(activeDigest);
        expect(() =>
            materializer.apply(
                actorPlan(actor, origin(2, "two"), [projection("policy:stable", { value: 2 })])
            )
        ).toThrow(/managed-resource fault/);
        expect(store.snapshot().resources[0]!.desiredDigest.equals(activeDigest)).toBe(true);
    });

    test("fails closed on unknown RunPins evidence without advancing local state", () => {
        const actor = actorRef("workspace-pinned");
        const store = new MemoryMaterializationStore(actor);
        const materializer = localMaterializer(actor, store);
        materializer.apply(
            actorPlan(actor, origin(1, "one"), [projection("policy:stable", { value: 1 })])
        );
        const before = store.snapshot();
        store.resourcePort.evidence = () => new RunPinEvidence("unknown", ["w5-unavailable"]);

        const blocked = materializer.apply(actorPlan(actor, origin(2, "two"), []));
        expect(blocked.blockers).toEqual(["unknown:w5-unavailable"]);
        expect(blocked.pointerChanged).toBe(false);
        expect(store.snapshot()).toMatchObject({
            generations: before.generations,
            records: before.records,
            pointer: before.pointer,
            resources: before.resources
        });
    });

    test("rejects foreign active generations and corrupt post-CAS pointer reads atomically", () => {
        const actor = actorRef("workspace-hostile-store");
        const foreign = new MemoryMaterializationStore(actor);
        const foreignMaterializer = localMaterializer(actor, foreign);
        foreignMaterializer.apply(
            actorPlan(actor, origin(1, "one"), [projection("policy:stable", { value: 1 })])
        );
        foreign.returnForeignGeneration = true;
        expect(() =>
            foreignMaterializer.apply(
                actorPlan(actor, origin(2, "two"), [projection("policy:stable", { value: 2 })])
            )
        ).toThrow(/different Actor/);

        for (const corruption of ["missing", "different"] as const) {
            const store = new MemoryMaterializationStore(actor);
            store.pointerCorruption = corruption;
            expect(() =>
                localMaterializer(actor, store).apply(
                    actorPlan(actor, origin(1, corruption), [
                        projection("policy:stable", { value: 1 })
                    ])
                )
            ).toThrow(corruption === "missing" ? /Missing active/ : /did not persist/);
            expectEmpty(store);
        }
    });

    test("reuses an equal immutable journal closure when activation was not yet pointed", () => {
        const actor = actorRef("workspace-recovered-journal");
        const store = new MemoryMaterializationStore(actor);
        const plan = actorPlan(actor, origin(1, "recovered"), [
            projection("policy:stable", { value: 1 })
        ]);
        store.seedHistory(plan);
        const result = localMaterializer(actor, store).apply(plan);
        expect(result.insertedRecords).toEqual([]);
        expect(result.insertedGeneration).toBe(false);
        expect(result.pointerChanged).toBe(true);
    });
});

interface StoreState extends MemoryManagedResourceState {
    readonly generations: Map<string, MaterializationGeneration>;
    readonly records: Map<string, ManagedStateRecord>;
    readonly pointers: Map<string, MaterializationGenerationPointer>;
}

interface StoreSnapshot {
    readonly generations: readonly MaterializationGeneration[];
    readonly records: readonly ManagedStateRecord[];
    readonly pointer: MaterializationGenerationPointer | undefined;
    readonly resources: readonly ManagedResourceSnapshot[];
    readonly runs: readonly string[];
    readonly transactionCount: number;
    readonly runQueries: number;
    readonly deletedRecords: number;
}

class MemoryMaterializationStore extends LocalMaterializationStore<StoreState> {
    #state: StoreState = emptyState();
    readonly #runs: readonly string[];
    #transactionCount = 0;
    public runQueries = 0;
    public deletedRecords = 0;
    public failManagedInsert = false;
    public failCas = false;
    public readonly resourcePort = new MemoryManagedResourcePort<StoreState>();
    public returnForeignGeneration = false;
    public pointerCorruption: "none" | "missing" | "different" = "none";
    #casCompleted = false;

    public constructor(actor: ActorRef, runs: readonly string[] = []) {
        super(actor);
        this.#runs = Object.freeze([...runs]);
    }

    public transaction<TResult>(
        operation: TransactionOperation<StoreState, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const draft = cloneState(this.#state);
        const result = operation(draft);
        this.#state = draft;
        this.#transactionCount += 1;
        return result;
    }

    public loadGeneration(
        transaction: StoreState,
        id: Digest
    ): MaterializationGeneration | undefined {
        const generation = transaction.generations.get(id.value);
        return generation === undefined || !this.returnForeignGeneration
            ? generation
            : Object.assign(Object.create(MaterializationGeneration.prototype), generation, {
                  actor: actorRef("foreign")
              });
    }

    public insertGeneration(transaction: StoreState, generation: MaterializationGeneration): void {
        transaction.generations.set(generation.id.value, generation);
    }

    public loadManagedState(transaction: StoreState, id: Digest): ManagedStateRecord | undefined {
        return transaction.records.get(id.value);
    }

    public insertManagedState(transaction: StoreState, record: ManagedStateRecord): void {
        transaction.records.set(record.id.value, record);
        if (this.failManagedInsert) throw new TypeError("injected managed-state fault");
    }

    public loadGenerationPointer(
        transaction: StoreState,
        actor: ActorRef,
        targetDeploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        const pointer = transaction.pointers.get(actorKey(actor, targetDeploymentId));
        if (!this.#casCompleted || this.pointerCorruption === "none") return pointer;
        if (this.pointerCorruption === "missing") return undefined;
        return pointer === undefined
            ? undefined
            : new MaterializationGenerationPointer({
                  actor: pointer.actor,
                  deploymentId: pointer.deploymentId,
                  generationId: digestOf("different-generation"),
                  revision: pointer.revision
              });
    }

    public compareAndSetGenerationPointer(
        transaction: StoreState,
        actor: ActorRef,
        targetDeploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        if (this.failCas) return false;
        const current = transaction.pointers.get(actorKey(actor, targetDeploymentId));
        if (
            current === undefined
                ? expectedRevision !== undefined
                : expectedRevision === undefined || !current.revision.equals(expectedRevision)
        ) {
            return false;
        }
        transaction.pointers.set(actorKey(actor, targetDeploymentId), next);
        this.#casCompleted = true;
        return true;
    }

    public snapshot(): StoreSnapshot {
        const pointer = [...this.#state.pointers.values()][0];
        return Object.freeze({
            generations: Object.freeze([...this.#state.generations.values()]),
            records: Object.freeze([...this.#state.records.values()]),
            pointer,
            resources: Object.freeze([...this.#state.resources.values()]),
            runs: this.#runs,
            transactionCount: this.#transactionCount,
            runQueries: this.runQueries,
            deletedRecords: this.deletedRecords
        });
    }

    public drift(desiredDigest: Digest): void {
        this.transaction((transaction) => {
            const current = [...transaction.resources.values()][0]!;
            transaction.resources.set(
                current.resourceId.value,
                Object.freeze({
                    ...current,
                    desiredDigest,
                    revision: current.revision.next()
                })
            );
        });
    }

    public restoreResourceDigest(desiredDigest: Digest): void {
        this.transaction((transaction) => {
            const current = [...transaction.resources.values()][0]!;
            transaction.resources.set(
                current.resourceId.value,
                Object.freeze({
                    ...current,
                    desiredDigest
                })
            );
        });
    }

    public seedHistory(plan: ActorPlan): void {
        const materialization = materializeActorPlan(plan.actor, plan);
        this.transaction((transaction) => {
            for (const record of materialization.records) {
                transaction.records.set(record.id.value, record);
            }
            transaction.generations.set(
                materialization.generation.id.value,
                materialization.generation
            );
        });
    }
}

function localMaterializer(
    actor: ActorRef,
    store: MemoryMaterializationStore
): LocalMaterializer<StoreState> {
    return new LocalMaterializer({ actor, store, resources: store.resourcePort });
}

function actorPlan(
    actor: ActorRef,
    materializationOrigin: ManagedOrigin,
    projections: readonly DesiredProjection[]
): ActorPlan {
    return new ActorPlan({
        actor,
        origin: materializationOrigin,
        projections: projections as [DesiredProjection, ...DesiredProjection[]]
    });
}

function projection(logicalKey: string, desired: { readonly value: number }): DesiredProjection {
    return policyProjection(
        logicalKey,
        new PolicySet({
            ...(desired.value % 2 === 0 ? { tiers: { execute: "mediated" as const } } : {}),
            ...(desired.value % 3 === 0 ? { approvals: ["externalSend" as const] } : {})
        })
    );
}

function forgeActorPlanKind(plan: ActorPlan, recordKind: string): ActorPlan {
    const projection = plan.projections[0]!;
    const unsupported = Object.assign(
        Object.create(DesiredProjection.prototype) as DesiredProjection,
        projection,
        { recordKind }
    );
    return Object.assign(Object.create(ActorPlan.prototype) as ActorPlan, plan, {
        projections: Object.freeze([unsupported])
    });
}

function origin(generation: number, config: string): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digestOf("attestation"),
        blueprintDigest: digestOf("blueprint"),
        packageLockDigest: digestOf("package-lock"),
        configDigest: digestOf(config),
        generation
    });
}

function actorRef(id: string, kind: "tenant" | "workspace" = "workspace"): ActorRef {
    return new ActorRef(kind, new ActorId(id));
}

function actorKey(actor: ActorRef, targetDeploymentId: DeploymentId): string {
    return `${actor.kind}:${actor.id.value}:${targetDeploymentId.value}`;
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function emptyState(): StoreState {
    return {
        generations: new Map(),
        records: new Map(),
        pointers: new Map(),
        resources: new Map()
    };
}

function cloneState(state: StoreState): StoreState {
    return {
        generations: new Map(state.generations),
        records: new Map(state.records),
        pointers: new Map(state.pointers),
        resources: cloneManagedResources(state.resources)
    };
}

function expectEmpty(store: MemoryMaterializationStore): void {
    expect(store.snapshot()).toMatchObject({
        generations: [],
        records: [],
        pointer: undefined,
        transactionCount: 0
    });
}

function jsonObject(bytes: Uint8Array): { readonly [key: string]: JsonValue } {
    return jsonObjectValue(decodeCanonicalJson(bytes));
}

function jsonObjectValue(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError("Expected JSON object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
