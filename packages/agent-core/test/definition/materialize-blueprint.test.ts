import { describe, expect, test } from "vitest";
import {
    ActorId,
    ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    strictJsonSchemaValidator,
    type JsonValue
} from "../../src/core";
import {
    ActorPlan,
    BlueprintDeclarationCodecPort,
    Config,
    DeploymentId,
    DeploymentKey,
    DesiredProjection,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    MaterializationPlan,
    MaterializationTopologyPort,
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageDependency,
    PackageId,
    PackageInstall,
    PackageLock,
    PackagePin,
    PackageRelease,
    PlacementSourcePort,
    PlatformCompatibility,
    PolicySet,
    ValidatedBlueprint,
    planMaterialization,
    validateBlueprint
} from "../../src/definition";
import { Blueprint } from "../../src/definition/blueprint";
import {
    LocalMaterializationStore,
    LocalMaterializer
} from "../../src/definition/materializer";
import {
    Automation,
    BindingName,
    Command,
    Contribution,
    Contributions,
    EventDeclaration,
    EventKind,
    EventPattern,
    FacetManifest,
    FacetPackageId,
    OperationDescriptor,
    OperationName,
    OperationRef,
    PayloadMapping,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName,
    SurfaceDescriptor,
    SurfaceId
} from "../../src/facets";
import { TenantId } from "../../src/identity";
import {
    MemoryManagedResourcePort,
    cloneManagedResources,
    type MemoryManagedResourceState
} from "./managed-resource-port";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });
const tenantId = new TenantId("platform-tenant");
const deploymentKey = new DeploymentKey("platform");
const objectSchema = new JsonSchema({ additionalProperties: true, type: "object" });
const declarationCodecs = new BlueprintDeclarationCodecPort(
    ["scopes", "agents", "slots", "subscriptions", "environments", "surfaces"].map((field) => ({
        field: field as import("../../src/definition/declaration").BlueprintDeclarationField,
        canonicalize: (value: JsonValue): JsonValue => value
    }))
);
const placementSource = new (class extends PlacementSourcePort {
    public sources(_release: PackageRelease, _manifest: FacetManifest) {
        return {
            substrate: ["dynamic", "provider", "bundled"],
            trust: ["dynamic", "provider", "bundled"]
        } as const;
    }
})();

const tenantActor = new ActorRef("tenant", new ActorId("platform-tenant"));
const workspaceActor = new ActorRef("workspace", new ActorId("platform-workspace"));
const environmentActor = new ActorRef("environment", new ActorId("platform-environment"));

const topology = new (class extends MaterializationTopologyPort {
    public actorFor(_validated: ValidatedBlueprint, projection: DesiredProjection): ActorRef {
        switch (projection.recordKind) {
            case "policy-set":
            case "scope-scaffold":
                return tenantActor;
            case "environment":
                return environmentActor;
            default:
                return workspaceActor;
        }
    }
})();

describe("complete Blueprint materialization", () => {
    test("projects every Blueprint construct to a record under its owning Actor", () => {
        const validated = fullBlueprint();
        const plan = planMaterialization({
            validatedBlueprint: validated,
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });

        const managed = applyPlan(plan);

        expect(managed.get(actorKey(tenantActor))).toEqual(["policy:platform", "scope:platform"]);
        expect(managed.get(actorKey(environmentActor))).toEqual(["environment:0"]);
        expect(managed.get(actorKey(workspaceActor))).toEqual([
            "agent:0",
            "contribution:blueprint:slots:0",
            "contribution:core.deploy.facet:automations:0",
            "contribution:core.deploy.facet:commands:0",
            "contribution:core.deploy.facet:custom.card:0",
            "contribution:core.deploy.facet:events:0",
            "contribution:core.deploy.facet:operations:0",
            "contribution:core.deploy.facet:slots:0",
            "contribution:core.deploy.facet:surfaces:0",
            "install:core.deploy:core.deploy.facet",
            "placement:core.deploy:core.deploy.facet",
            "subscription:automation:core.deploy.facet:0",
            "subscription:blueprint:0",
            "subscription:command:core.deploy.facet:deploy",
            "surface:platform"
        ]);
    });

    test("materializes each supported record kind and covers every Blueprint field", () => {
        const plan = planMaterialization({
            validatedBlueprint: fullBlueprint(),
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        const kinds = new Set(
            plan.actors.flatMap((actor) =>
                actor.projections.map((projection) => projection.recordKind)
            )
        );

        for (const kind of ManagedStateRecord.supportedRecordKinds()) {
            expect(kinds.has(kind)).toBe(true);
        }
        // Every Blueprint field surfaces as at least one projected record kind.
        expect(kinds).toEqual(
            new Set([
                "agent-profile",
                "environment",
                "facet-install",
                "facet-placement",
                "policy-set",
                "scope-scaffold",
                "slot-entry",
                "subscription",
                "surface-layout"
            ])
        );
    });

    test("each materialized record kind lands under exactly one owning Actor", () => {
        const plan = planMaterialization({
            validatedBlueprint: fullBlueprint(),
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        const ownersByKind = new Map<string, Set<string>>();
        for (const actor of plan.actors) {
            for (const projection of actor.projections) {
                const owners = ownersByKind.get(projection.recordKind) ?? new Set<string>();
                owners.add(actorKey(actor.actor));
                ownersByKind.set(projection.recordKind, owners);
            }
        }
        for (const owners of ownersByKind.values()) {
            expect(owners.size).toBe(1);
        }
    });

    test("re-applying an unchanged Blueprint reconciles to a semantic no-op", () => {
        const validated = fullBlueprint();
        const plan = planMaterialization({
            validatedBlueprint: validated,
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        const stores = new Map<string, TestStore>();
        const first = plan.actors.map((actor) => applyActor(actor, stores));
        expect(first.every((result) => result.insertedRecords.length > 0)).toBe(true);

        const second = plan.actors.map((actor) => applyActor(actor, stores));
        expect(second.every((result) => result.semanticNoop)).toBe(true);
        expect(second.every((result) => result.insertedRecords.length === 0)).toBe(true);
        expect(second.every((result) => !result.pointerChanged)).toBe(true);
    });

    test("mutating a single construct reconciles only that construct's record", () => {
        const stores = new Map<string, TestStore>();
        const first = planMaterialization({
            validatedBlueprint: fullBlueprint(),
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        for (const actor of first.actors) applyActor(actor, stores);

        const mutated = planMaterialization({
            validatedBlueprint: fullBlueprint({ approvals: ["execute"] }),
            tenantId,
            deploymentKey,
            generation: 2,
            topology
        });
        const results = new Map(
            mutated.actors.map((actor) => [actorKey(actor.actor), applyActor(actor, stores)])
        );

        expect(results.get(actorKey(tenantActor))?.actions).toContain("update");
        expect(results.get(actorKey(workspaceActor))?.semanticNoop).toBe(true);
        expect(results.get(actorKey(environmentActor))?.semanticNoop).toBe(true);
    });

    test("rejects a contribution that violates its slot's contribute-authority", () => {
        expect(() =>
            planMaterialization({
                validatedBlueprint: fullBlueprint({ slotContributor: "stranger.facet" }),
                tenantId,
                deploymentKey,
                generation: 1,
                topology
            })
        ).toThrow(/may not contribute to slot custom.card/);
    });

    test("rejects a duplicate command name in the same surface slot", () => {
        expect(() =>
            planMaterialization({
                validatedBlueprint: fullBlueprint({ duplicateCommand: true }),
                tenantId,
                deploymentKey,
                generation: 1,
                topology
            })
        ).toThrow(/Command deploy is not unique in surface slot/);
    });
});

interface FullBlueprintOptions {
    readonly approvals?: readonly ("execute" | "externalSend")[];
    readonly slotContributor?: string;
    readonly duplicateCommand?: boolean;
}

function fullBlueprint(options: FullBlueprintOptions = {}): ValidatedBlueprint {
    const facetId = "core.deploy.facet";
    const move = new PayloadMapping([]);
    const command = new Command({
        name: "deploy",
        title: "Deploy",
        arguments: objectSchema,
        operation: new OperationRef(`${facetId}:run`),
        binding: new BindingName("deploy"),
        surfaces: [new SlotName("surfaces")]
    });
    const duplicate = new Command({
        name: "deploy",
        title: "Deploy again",
        arguments: objectSchema,
        operation: new OperationRef(`${facetId}:run`),
        binding: new BindingName("deploy"),
        surfaces: [new SlotName("surfaces")]
    });
    const contributions = new Contributions([
        new Contribution(new SlotName("operations"), [
            new OperationDescriptor(
                new OperationName("run"),
                "execute",
                objectSchema,
                objectSchema,
                "Run.",
                true
            ).toData()
        ]),
        new Contribution(
            new SlotName("commands"),
            options.duplicateCommand === true
                ? [command.toData(), duplicate.toData()]
                : [command.toData()]
        ),
        new Contribution(new SlotName("automations"), [
            new Automation({
                source: new EventPattern("schedule.daily", ["self"]),
                target: new OperationRef(`${facetId}:run`),
                binding: new BindingName("deploy"),
                mapping: move,
                dedupe: "event",
                authority: "delegated"
            }).toData()
        ]),
        new Contribution(new SlotName("events"), [
            new EventDeclaration(
                new EventKind("deploy.completed"),
                "Completed.",
                objectSchema,
                "workspace"
            ).toData()
        ]),
        new Contribution(new SlotName("slots"), [
            new SlotDeclaration(
                new SlotName("custom.card"),
                objectSchema,
                new SlotAuthorityPolicy([options.slotContributor ?? facetId], ["scope.read"])
            ).toData()
        ]),
        new Contribution(new SlotName("custom.card"), [{ title: "Card" }]),
        new Contribution(new SlotName("surfaces"), [
            new SurfaceDescriptor(new SurfaceId("deploy.panel"), "Deployments").toData()
        ])
    ]);
    const release = packageRelease("core.deploy", contributions);
    const subscriptionTemplate = new Automation({
        source: new EventPattern("thing.happened", ["self"]),
        target: new OperationRef(`${facetId}:run`),
        binding: new BindingName("deploy")
    }).toData();
    const boardSlot = new SlotDeclaration(
        new SlotName("board.card"),
        objectSchema,
        new SlotAuthorityPolicy(["*"], ["*"])
    ).toData();
    const blueprint = new Blueprint({
        meta: { name: "platform", version: new SemVer("1.0.0") },
        packages: [
            new PackageInstall({
                request: new PackageDependency(new PackageId("core.deploy"), "^1"),
                config: new Config({})
            })
        ],
        policies: new PolicySet({ approvals: options.approvals ?? [] }),
        scopes: { projects: [{ key: "default" }] },
        agents: [{ instructions: "Help.", model: { policy: "balanced" }, name: "helper" }],
        slots: [boardSlot],
        subscriptions: [subscriptionTemplate],
        environments: [{ image: "sandbox:latest", name: "sandbox" }],
        surfaces: { layout: [{ slot: "surfaces" }] }
    });
    return validateBlueprint(blueprint, {
        lock: packageLock([release]),
        releases: [release],
        target,
        declarationCodecs,
        placement: placementSource,
        schemaValidator: strictJsonSchemaValidator
    });
}

function applyPlan(plan: MaterializationPlan): Map<string, readonly string[]> {
    const stores = new Map<string, TestStore>();
    for (const actorPlan of plan.actors) applyActor(actorPlan, stores);
    const managed = new Map<string, readonly string[]>();
    for (const [key, store] of stores) {
        managed.set(key, store.managedLogicalKeys());
    }
    return managed;
}

function applyActor(actorPlan: ActorPlan, stores: Map<string, TestStore>) {
    const key = actorKey(actorPlan.actor);
    const store = stores.get(key) ?? new TestStore(actorPlan.actor);
    stores.set(key, store);
    const materializer = new LocalMaterializer({
        actor: actorPlan.actor,
        store,
        resources: store.resourcePort
    });
    return materializer.apply(actorPlan);
}

function packageRelease(id: string, contributions: Contributions): PackageRelease {
    const version = new SemVer("1.0.0");
    const manifests = [
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version,
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions
        })
    ] as [FacetManifest];
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digestOf(`code:${id}`)),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifests[0].id,
                version: manifests[0].version,
                module: "./main.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId(id),
        version,
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests,
        codeManifest,
        provenance: { registry: "test" }
    });
}

function packageLock(releases: readonly PackageRelease[]): PackageLock {
    const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases });
    return new PackageLock({
        target,
        roots: releases.map((release) => new PackageDependency(release.id, "^1")),
        snapshotRevision: snapshot.revision,
        snapshotDigest: snapshot.digest,
        packages: releases.map(
            (release) =>
                new PackagePin(
                    release.id,
                    release.version,
                    release.manifestDigest,
                    release.codeDigest
                )
        )
    });
}

interface TestStoreState extends MemoryManagedResourceState {
    readonly generations: Map<string, MaterializationGeneration>;
    readonly records: Map<string, ManagedStateRecord>;
    readonly pointers: Map<string, MaterializationGenerationPointer>;
}

class TestStore extends LocalMaterializationStore<TestStoreState> {
    #state: TestStoreState = {
        generations: new Map(),
        records: new Map(),
        pointers: new Map(),
        resources: new Map()
    };
    public readonly resourcePort = new MemoryManagedResourcePort<TestStoreState>();

    public transaction<TResult>(
        operation: TransactionOperation<TestStoreState, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const draft: TestStoreState = {
            generations: new Map(this.#state.generations),
            records: new Map(this.#state.records),
            pointers: new Map(this.#state.pointers),
            resources: cloneManagedResources(this.#state.resources)
        };
        const result = operation(draft);
        this.#state = draft;
        return result;
    }

    public loadGeneration(
        transaction: TestStoreState,
        id: Digest
    ): MaterializationGeneration | undefined {
        return transaction.generations.get(id.value);
    }

    public insertGeneration(
        transaction: TestStoreState,
        generation: MaterializationGeneration
    ): void {
        transaction.generations.set(generation.id.value, generation);
    }

    public loadManagedState(
        transaction: TestStoreState,
        id: Digest
    ): ManagedStateRecord | undefined {
        return transaction.records.get(id.value);
    }

    public insertManagedState(transaction: TestStoreState, record: ManagedStateRecord): void {
        transaction.records.set(record.id.value, record);
    }

    public loadGenerationPointer(
        transaction: TestStoreState,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        return transaction.pointers.get(pointerKey(actor, deploymentId));
    }

    public compareAndSetGenerationPointer(
        transaction: TestStoreState,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        const key = pointerKey(actor, deploymentId);
        const current = transaction.pointers.get(key);
        const matches =
            expectedRevision === undefined
                ? current === undefined
                : current?.revision.equals(expectedRevision) === true;
        if (!matches) return false;
        transaction.pointers.set(key, next);
        return true;
    }

    public managedLogicalKeys(): readonly string[] {
        return [...this.#state.records.values()]
            .map((record) => record.logicalKey)
            .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    }
}

function actorKey(actor: ActorRef): string {
    return `${actor.kind}:${actor.id.value}`;
}

function pointerKey(actor: ActorRef, deploymentId: DeploymentId): string {
    return `${actor.kind}:${actor.id.value}:${deploymentId.value}`;
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
