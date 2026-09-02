import { CompatRange, Digest, JsonSchema, SecretRef, SemVer } from "../../src/core";
import {
    ManagedOrigin,
    type LoadedBlueprint,
    type PreparedPackageContribution
} from "../../src/definition";
import {
    Automation,
    Command,
    EventDeclaration,
    EventKind,
    BindingName,
    Contribution,
    Contributions,
    EventPattern,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    Interceptor,
    InterceptorDeclaration,
    InterceptorId,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    Prompt,
    PromptContribution,
    PayloadMapping,
    ProvenanceMapping,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName,
    Surface,
    SurfaceDescriptor,
    commandAutomation,
    SurfaceId,
    type FacetData,
    type FacetLifecycleContext,
    type InterceptContext,
    type InterceptResult,
    type OperationContext
} from "../../src/facets";
import { ScopeRef, WorkspaceId } from "../../src/identity";
import {
    WorkspaceFacetMaterializer,
    WorkspacePackageFacetMaterialization
} from "../../src/composition";
import { FacetCorrespondenceValidator, type ValidatedFacetRuntime } from "../../src/operations";
import {
    SqliteWorkspaceRecords,
    SqliteWorkspaceSlotStore,
    type TransactionalSqlite
} from "../../src/substrates";
import { WorkspacePersistence, type ContentRetentionPort } from "../../src/workspaces";
import { beforeEach, describe, expect, test } from "vitest";
import { TestSqlite } from "../helpers/sqlite";
import {
    TestPackageInstallationProvenance,
    authenticatedInstallationFixture,
    sourceActor,
    tenant
} from "../workspaces/fixtures";
import { reaching } from "./fixture";
import { pin } from "../w3/slot-store-contract";

type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

const facetRef = new FacetRef("subscription.materializer:primary");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("workspace"));
const context = { installationId: "installation" };

class DurableRetention implements ContentRetentionPort<TransactionalSqlite> {
    public verify(): boolean {
        return true;
    }

    public retain(): void {}

    public release(): void {}

    public discard(): void {}
}

function operationDescriptor(): OperationDescriptor {
    const schema = new JsonSchema({ type: "object" });
    return new OperationDescriptor(new OperationName("execute"), "mutate", schema, schema);
}

class MaterializedOperation extends Operation {
    public readonly descriptor = operationDescriptor();

    public async execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return input;
    }
}

function surfaceDescriptor(): SurfaceDescriptor {
    return new SurfaceDescriptor(new SurfaceId("materialized.surface"), "Materialized");
}

function commandDeclaration(): Command {
    return new Command({
        name: "send",
        title: "Send",
        arguments: new JsonSchema({ type: "object" }),
        operation: new OperationRef("subscription.materializer:execute"),
        binding: new BindingName("executor"),
        surfaces: [new SlotName("custom.cards")]
    });
}

class MaterializedSurface extends Surface {
    public readonly descriptor = surfaceDescriptor();

    public async render(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return input;
    }
}

function interceptorDeclaration(): InterceptorDeclaration {
    return new InterceptorDeclaration(
        new InterceptorId("materialized.interceptor"),
        "operation.before",
        "gate",
        10
    );
}

class MaterializedInterceptor extends Interceptor {
    public readonly declaration = interceptorDeclaration();

    public intercept(_context: InterceptContext, value: FacetData): InterceptResult {
        return { proceed: true, value };
    }
}

class MaterializedFacet extends Facet {
    public readonly ref = facetRef;
    public readonly manifest: FacetManifest;

    public constructor(declared?: FacetManifest) {
        super();
        this.manifest = declared ?? manifest();
    }

    public operation(name: OperationName): Operation | undefined {
        return name.equals(new OperationName("execute")) ? new MaterializedOperation() : undefined;
    }

    public surface(id: SurfaceId): Surface | undefined {
        return id.equals(new SurfaceId("materialized.surface"))
            ? new MaterializedSurface()
            : undefined;
    }

    public interceptor(id: InterceptorId): Interceptor | undefined {
        return id.equals(new InterceptorId("materialized.interceptor"))
            ? new MaterializedInterceptor()
            : undefined;
    }

    public children(): readonly Facet[] {
        return [];
    }

    public async start(_context: FacetLifecycleContext): Promise<void> {}

    public async stop(_context: FacetLifecycleContext): Promise<void> {}
}

interface Harness {
    readonly database: TestSqlite;
    readonly records: SqliteWorkspaceRecords;
    readonly persistence: WorkspacePersistence<TransactionalSqlite>;
    readonly slots: SqliteWorkspaceSlotStore;
    readonly provenance: TestPackageInstallationProvenance<TransactionalSqlite>;
    readonly materializer: WorkspaceFacetMaterializer<
        TransactionalSqlite,
        TransactionalSqlite,
        typeof context
    >;
}

function createHarness(version = "1.0.0", expectedManifest = manifest()): Harness {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceRecords(database);
    const persistence = new WorkspacePersistence<TransactionalSqlite>(
        () => records,
        new DurableRetention(),
        sourceActor,
        tenant
    );
    const slots = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
    const provenance = new TestPackageInstallationProvenance<TransactionalSqlite>(
        authenticatedInstallationFixture(
            facetRef.value,
            pin("subscription.package", version),
            Digest.sha256(FacetManifest.encode(expectedManifest))
        )
    );
    return {
        database,
        records,
        persistence,
        slots,
        provenance,
        materializer: new WorkspaceFacetMaterializer(persistence, slots, provenance, scope)
    };
}

function manifest(): FacetManifest {
    const schema = new JsonSchema({ type: "object" });
    const slot = new SlotDeclaration(
        new SlotName("custom.cards"),
        schema,
        new SlotAuthorityPolicy(["installed"], ["scope.read"])
    );
    const operation = operationDescriptor();
    const automation = new Automation({
        source: new EventPattern("source.event", ["authenticated"]),
        target: new OperationRef("subscription.materializer:execute"),
        binding: new BindingName("executor")
    });
    const ingress = new IngressDeclaration(
        "/hooks/materialized",
        new IngressVerification("hmac", new SecretRef("env", "provider", "hook-secret")),
        new ProvenanceMapping([new FieldMove("/identity", { literal: "external" })])
    );
    return new FacetManifest({
        id: new FacetPackageId("subscription.materializer"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("automations"), [automation.toData()]),
            new Contribution(new SlotName("commands"), [commandDeclaration().toData()]),
            new Contribution(new SlotName("events"), [eventDeclaration().toData()]),
            new Contribution(new SlotName("ingress"), [ingress.toData()]),
            new Contribution(new SlotName("interceptors"), [interceptorDeclaration().toData()]),
            new Contribution(new SlotName("operations"), [operation.toData()]),
            new Contribution(new SlotName("prompt"), [
                new PromptContribution([
                    new Prompt("First", "First body", 1),
                    new Prompt("Second", "Second body", 2)
                ]).toData()
            ]),
            new Contribution(new SlotName("settings"), [schema.document]),
            new Contribution(new SlotName("slots"), [slot.toData()]),
            new Contribution(new SlotName("surfaces"), [surfaceDescriptor().toData()]),
            new Contribution(new SlotName("custom.cards"), [{ title: "Card" }])
        ])
    });
}

function eventDeclaration(): EventDeclaration {
    return new EventDeclaration(
        new EventKind("materialized.event"),
        "Materialized event",
        new JsonSchema({ type: "object" }),
        "workspace"
    );
}

/** The fixture manifest with one core slot's contribution replaced. */
function manifestWith(replacement: Contribution): FacetManifest {
    const base = manifest();
    return new FacetManifest({
        id: base.id,
        version: base.version,
        compat: base.compat,
        isolation: base.isolation,
        bindings: base.bindings,
        contributions: new Contributions(
            base.contributions.entries.map((contribution) =>
                contribution.slot.equals(replacement.slot) ? replacement : contribution
            )
        )
    });
}

function prepare(harness: Harness): PreparedPackageContribution {
    const prepared = harness.materializer.prepareContribution(harness.database, context);
    if (prepared === undefined) throw new TypeError("Expected prepared contribution");
    return prepared;
}

function validated(facet = new MaterializedFacet()): CorrespondentFacet {
    const result = new FacetCorrespondenceValidator().validate([facet.manifest], [facet]).facets[0];
    if (result === undefined) throw new TypeError("Expected validated Facet");
    return result;
}

function apply(harness: Harness, facet = new MaterializedFacet()) {
    const prepared = prepare(harness);
    return harness.database.transaction(() =>
        harness.materializer.materialize(harness.database, context, prepared, validated(facet))
    );
}

describe("Workspace Facet materializer", () => {
    let harness: Harness;

    beforeEach(() => {
        harness = createHarness();
    });

    test(
        "[facet.settings-layer] materializes every supported primitive atomically and replays as a no-op",
        { tags: "p0" },
        () => {
            const first = apply(harness);
            expect(first).toMatchObject({
                catalogEntries: 4,
                eventProducers: 1,
                ingressEndpoints: 1,
                interceptorEntries: 1,
                promptSections: 2,
                settingsLayers: 1,
                slotDeclarations: 1,
                slotEntries: 1,
                subscriptions: 2,
                surfaces: 1
            });
            expect(harness.slots.revision().value).toBe(1);
            expect(apply(harness)).toMatchObject(first);
            expect(harness.slots.revision().value).toBe(1);
            expect(harness.persistence.listCatalogEntries(harness.database)).toHaveLength(4);
            expect(harness.persistence.listPromptSections(harness.database)).toHaveLength(2);
            expect(harness.persistence.listSettingsLayers(harness.database)).toHaveLength(1);
            expect(harness.persistence.listIngressEndpoints(harness.database)).toHaveLength(1);
            expect(harness.persistence.listSurfaceRegistrations(harness.database)).toHaveLength(1);
            const subscriptions = harness.persistence.listSubscriptions(harness.database);
            expect(subscriptions).toHaveLength(2);
            const commandSubscription = subscriptions.find(
                (subscription) => subscription.source.kind === "command.invoked"
            );
            const automationSubscription = subscriptions.find(
                (subscription) => subscription.source.kind === "source.event"
            );
            expect(commandSubscription?.source.toData()).toEqual(
                commandAutomation(commandDeclaration()).source.toData()
            );
            expect(automationSubscription?.mapping.toData()).toEqual(
                PayloadMapping.identity.toData()
            );
            expect(harness.slots.listAllEntries(harness.database)).toHaveLength(1);
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] materializes an interceptor pipeline entry and a typed Event producer under the exact FacetRef and PackagePin",
        { tags: "p0" },
        () => {
            const result = apply(harness);
            const catalog = harness.persistence.listCatalogEntries(harness.database);
            const interceptorEntry = catalog.find((entry) => entry.kind === "interceptor");
            const eventEntry = catalog.find((entry) => entry.kind === "event");
            if (interceptorEntry === undefined || eventEntry === undefined) {
                throw new TypeError("Expected durable interceptor and Event producer records");
            }

            for (const entry of [interceptorEntry, eventEntry]) {
                expect(entry.attribution?.equals(result.attribution)).toBe(true);
                expect(entry.attribution?.contributor.equals(facetRef)).toBe(true);
                expect(entry.attribution?.package.equals(pin("subscription.package"))).toBe(true);
            }
            expect(interceptorEntry.name).toBe("materialized.interceptor");
            expect(interceptorEntry.declaration.toData()).toEqual(
                interceptorDeclaration().toData()
            );
            expect(eventEntry.name).toBe("materialized.event");
            expect(eventEntry.declaration.toData()).toEqual(eventDeclaration().toData());

            apply(harness);
            expect(
                harness.persistence
                    .listCatalogEntries(harness.database)
                    .map((entry) => entry.id.value)
                    .sort()
            ).toEqual(catalog.map((entry) => entry.id.value).sort());
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-MATERIALIZATION] gives one interceptor declaration one entry whichever way the manifest spelled it",
        { tags: "p1" },
        () => {
            // The fixture manifest spells the default selector out; this one leaves it
            // implicit. Two wire forms, one declaration, so one entry — a materializer that
            // stored the manifest bytes unchanged would produce two entry ids for it.
            const spelled = manifestWith(
                new Contribution(new SlotName("interceptors"), [
                    {
                        cutPoint: "operation.before",
                        id: "materialized.interceptor",
                        mode: "gate",
                        priority: 10
                    }
                ])
            );
            const implied = createHarness("1.0.0", spelled);
            const prepared = implied.materializer.prepareContribution(implied.database, context);
            if (prepared === undefined) throw new TypeError("Expected prepared contribution");
            implied.database.transaction(() =>
                implied.materializer.materialize(
                    implied.database,
                    context,
                    prepared,
                    validated(new MaterializedFacet(spelled))
                )
            );
            apply(harness);

            const spelledEntry = implied.persistence
                .listCatalogEntries(implied.database)
                .find((entry) => entry.kind === "interceptor");
            const canonicalEntry = harness.persistence
                .listCatalogEntries(harness.database)
                .find((entry) => entry.kind === "interceptor");
            expect(spelledEntry).toBeDefined();
            expect(spelledEntry?.id.value).toBe(canonicalEntry?.id.value);
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-MATERIALIZATION] refuses a malformed Event producer before writing any record",
        { tags: "p0" },
        () => {
            const malformed = manifestWith(
                new Contribution(new SlotName("events"), [{ kind: "materialized.event" }])
            );
            const broken = createHarness("1.0.0", malformed);
            const facet = new MaterializedFacet(malformed);
            const prepared = broken.materializer.prepareContribution(broken.database, context);
            if (prepared === undefined) throw new TypeError("Expected prepared contribution");

            expect(() =>
                broken.database.transaction(() =>
                    broken.materializer.materialize(
                        broken.database,
                        context,
                        prepared,
                        validated(facet)
                    )
                )
            ).toThrow(TypeError);
            expect(broken.slots.listAllEntries(broken.database)).toEqual([]);
            expect(broken.slots.revision().value).toBe(0);
            expect(broken.persistence.listCatalogEntries(broken.database)).toEqual([]);
            expect(broken.persistence.listPromptSections(broken.database)).toEqual([]);
        }
    );

    test(
        "reconciles a new PackagePin without retaining the old attribution",
        { tags: "p0" },
        () => {
            const first = apply(harness).attribution;
            harness.provenance.installation = authenticatedInstallationFixture(
                facetRef.value,
                pin("subscription.package", "2.0.0"),
                Digest.sha256(FacetManifest.encode(manifest()))
            );
            const second = apply(harness).attribution;

            expect(second.contributor.equals(first.contributor)).toBe(true);
            expect(second.package.equals(first.package)).toBe(false);
            expect(
                harness.persistence.listContributedCatalogEntries(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedPromptSections(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedSettingsLayers(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedIngressEndpoints(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedSurfaceRegistrations(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedSubscriptions(harness.database, first)
            ).toEqual([]);
            expect(
                harness.persistence.listContributedCatalogEntries(harness.database, second)
            ).toHaveLength(4);
            expect(harness.slots.revision().value).toBe(2);
        }
    );
    test(
        "re-materializes a withdrawn same-pin activation under a new generation",
        { tags: "p0" },
        () => {
            const attribution = apply(harness).attribution;
            const firstIngress = harness.persistence.listContributedIngressEndpoints(
                harness.database,
                attribution
            )[0];
            const firstSubscription = harness.persistence.listContributedSubscriptions(
                harness.database,
                attribution
            )[0];
            if (firstIngress === undefined || firstSubscription === undefined) {
                throw new TypeError("Expected materialized ingress and Subscription");
            }
            harness.database.transaction(() => {
                harness.persistence.retireIngressEndpoint(harness.database, firstIngress.id);
                harness.persistence.retireSubscription(harness.database, firstSubscription);
            });
            const installation = harness.provenance.installation;
            if (installation === undefined) {
                throw new TypeError("Expected authenticated installation");
            }
            harness.provenance.installation = {
                package: installation.package,
                packageFacet: installation.packageFacet,
                facet: installation.facet,
                manifestDigest: installation.manifestDigest,
                materialization: new ManagedOrigin({
                    tenantId: installation.materialization.tenantId,
                    deploymentId: installation.materialization.deploymentId,
                    attestationDigest: installation.materialization.attestationDigest,
                    blueprintDigest: installation.materialization.blueprintDigest,
                    packageLockDigest: installation.materialization.packageLockDigest,
                    configDigest: installation.materialization.configDigest,
                    generation: installation.materialization.generation + 1
                })
            };

            apply(harness);
            const nextIngress = harness.persistence.listContributedIngressEndpoints(
                harness.database,
                attribution
            )[0];
            const nextSubscription = harness.persistence.listContributedSubscriptions(
                harness.database,
                attribution
            )[0];
            expect(nextIngress?.id.equals(firstIngress.id)).toBe(false);
            expect(nextSubscription?.id.equals(firstSubscription.id)).toBe(false);
        }
    );

    test(
        "materializes the package's complete validated Facet set in one transaction",
        { tags: "p1" },
        () => {
            const packageMaterialization = new WorkspacePackageFacetMaterialization(
                harness.materializer,
                (operation, ...guard) =>
                    harness.database.transaction(() => operation(harness.database), ...guard),
                harness.database,
                () => context
            );
            packageMaterialization.materialize(reaching<LoadedBlueprint<unknown>>({}), [
                validated()
            ]);
            expect(harness.persistence.listCatalogEntries(harness.database)).toHaveLength(4);

            harness.provenance.installation = undefined;
            expect(() =>
                packageMaterialization.materialize(reaching<LoadedBlueprint<unknown>>({}), [
                    validated()
                ])
            ).toThrow(/has no current installation provenance/);
        }
    );

    test("refuses unvalidated or manifest-substituted Facet instances", { tags: "p0" }, () => {
        const prepared = prepare(harness);
        expect(() =>
            harness.database.transaction(() =>
                harness.materializer.materialize(
                    harness.database,
                    context,
                    prepared,
                    reaching<CorrespondentFacet>({
                        ref: facetRef,
                        manifest: manifest()
                    })
                )
            )
        ).toThrow(/correspondence validation evidence/);
        harness.materializer.discard(prepared);

        const installation = harness.provenance.installation;
        if (installation === undefined) {
            throw new TypeError("Expected authenticated installation");
        }
        const stale = prepare(harness);
        harness.provenance.installation = undefined;
        expect(() =>
            harness.database.transaction(() =>
                harness.materializer.materialize(harness.database, context, stale, validated())
            )
        ).toThrow(/provenance changed before materialization/);
        harness.provenance.installation = installation;
        harness.provenance.installation = {
            ...installation,
            manifestDigest: new Digest("f".repeat(64))
        };
        expect(() => apply(harness)).toThrow(
            /Facet instance, manifest, and authenticated installation do not match/
        );
        expect(harness.persistence.listCatalogEntries(harness.database)).toEqual([]);
        expect(harness.slots.revision().value).toBe(0);
    });

    test("rolls back every primitive when one later record write fails", { tags: "p0" }, () => {
        harness.database.run(
            `CREATE TRIGGER fail_prompt_materialization
             BEFORE INSERT ON workspace_records
             WHEN NEW.kind = 'promptSection'
             BEGIN SELECT RAISE(ABORT, 'injected prompt failure'); END`,
            []
        );

        expect(() => apply(harness)).toThrow(/injected prompt failure/);
        expect(harness.slots.revision().value).toBe(0);
        expect(harness.slots.listSlots(harness.database)).toEqual([]);
        expect(harness.slots.listAllEntries(harness.database)).toEqual([]);
        expect(harness.persistence.listCatalogEntries(harness.database)).toEqual([]);
        expect(harness.persistence.listPromptSections(harness.database)).toEqual([]);
        expect(harness.persistence.listSettingsLayers(harness.database)).toEqual([]);
        expect(harness.persistence.listIngressEndpoints(harness.database)).toEqual([]);
        expect(harness.persistence.listSurfaceRegistrations(harness.database)).toEqual([]);
        expect(harness.persistence.listSubscriptions(harness.database)).toEqual([]);
    });
});
