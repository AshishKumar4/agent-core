import { CompatRange, JsonSchema, SecretRef, SemVer } from "../../src/core";
import type { PreparedPackageContribution } from "../../src/definition";
import {
    Automation,
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
    OperationDescriptor,
    OperationName,
    OperationRef,
    Prompt,
    PromptContribution,
    ProvenanceMapping,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName,
    SurfaceDescriptor,
    SurfaceId,
    type FacetLifecycleContext,
    type Interceptor,
    type Operation,
    type Surface
} from "../../src/facets";
import { ScopeRef, WorkspaceId } from "../../src/identity";
import { WorkspaceFacetMaterializer } from "../../src/composition";
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
import { pin } from "../w3/slot-store-contract";

const facetRef = new FacetRef("subscription.materializer:primary");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("workspace"));
const context = { installationId: "installation" };

class DurableRetention implements ContentRetentionPort<TransactionalSqlite> {
    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(): void {}
}

class MaterializedFacet extends Facet {
    public readonly ref = facetRef;
    public readonly manifest = manifest();

    public operation(): Operation | undefined {
        return undefined;
    }

    public surface(): Surface | undefined {
        return undefined;
    }

    public interceptor(): Interceptor | undefined {
        return undefined;
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

function createHarness(version = "1.0.0"): Harness {
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
        authenticatedInstallationFixture(facetRef.value, pin("subscription.package", version))
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
    const operation = new OperationDescriptor(
        new OperationName("execute"),
        "mutate",
        schema,
        schema
    );
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
            new Contribution(new SlotName("ingress"), [ingress.toData()]),
            new Contribution(new SlotName("operations"), [operation.toData()]),
            new Contribution(new SlotName("prompt"), [
                new PromptContribution([
                    new Prompt("First", "First body", 1),
                    new Prompt("Second", "Second body", 2)
                ]).toData()
            ]),
            new Contribution(new SlotName("settings"), [schema.document]),
            new Contribution(new SlotName("slots"), [slot.toData()]),
            new Contribution(new SlotName("surfaces"), [
                new SurfaceDescriptor(
                    new SurfaceId("materialized.surface"),
                    "Materialized"
                ).toData()
            ]),
            new Contribution(new SlotName("custom.cards"), [{ title: "Card" }])
        ])
    });
}

function prepare(harness: Harness): PreparedPackageContribution {
    const prepared = harness.materializer.prepareContribution(harness.database, context);
    if (prepared === undefined) throw new TypeError("Expected prepared contribution");
    return prepared;
}

function apply(harness: Harness, facet = new MaterializedFacet()) {
    const prepared = prepare(harness);
    return harness.database.transaction(() =>
        harness.materializer.materialize(harness.database, context, prepared, facet)
    );
}

describe("Workspace Facet materializer", () => {
    let harness: Harness;

    beforeEach(() => {
        harness = createHarness();
    });

    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] [C13-FACET-CONTRIBUTION-MATERIALIZATION] [facet.settings-layer] materializes every supported primitive atomically and replays as a no-op",
        { tags: "p0" },
        () => {
            const first = apply(harness);
            expect(first).toMatchObject({
                catalogEntries: 1,
                ingressEndpoints: 1,
                promptSections: 2,
                settingsLayers: 1,
                slotDeclarations: 1,
                slotEntries: 1,
                subscriptions: 1,
                surfaces: 1
            });
            expect(harness.slots.revision().value).toBe(1);
            expect(apply(harness)).toMatchObject(first);
            expect(harness.slots.revision().value).toBe(1);
            expect(harness.persistence.listCatalogEntries(harness.database)).toHaveLength(1);
            expect(harness.persistence.listPromptSections(harness.database)).toHaveLength(2);
            expect(harness.persistence.listSettingsLayers(harness.database)).toHaveLength(1);
            expect(harness.persistence.listIngressEndpoints(harness.database)).toHaveLength(1);
            expect(harness.persistence.listSurfaceRegistrations(harness.database)).toHaveLength(1);
            expect(harness.persistence.listSubscriptions(harness.database)).toHaveLength(1);
            expect(harness.slots.listAllEntries(harness.database)).toHaveLength(1);
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] reconciles a new PackagePin without retaining the old attribution",
        { tags: "p0" },
        () => {
            const first = apply(harness).attribution;
            harness.provenance.installation = authenticatedInstallationFixture(
                facetRef.value,
                pin("subscription.package", "2.0.0")
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
            ).toHaveLength(1);
            expect(harness.slots.revision().value).toBe(2);
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-MATERIALIZATION] [C13-FACET-START-ATOMIC] rolls back every primitive when one later record write fails",
        { tags: "p0" },
        () => {
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
        }
    );
});
