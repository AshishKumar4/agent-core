import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    Revision,
    SemVer,
    decodeCanonicalJson,
    strictJsonSchemaValidator,
    type JsonValue
} from "../../../src/core";
import {
    Blueprint,
    BlueprintDeclarationCodecPort,
    DeploymentKey,
    MaterializationTopologyPort,
    MetadataSnapshot,
    PackageLock,
    PackageRelease,
    PlacementSourcePort,
    PlatformCompatibility,
    PolicySet,
    ValidatedBlueprint,
    planMaterialization,
    validateBlueprint,
    type BlueprintDeclarationField,
    type DesiredProjection,
    type MaterializationPlan
} from "../../../src/definition";
import { FacetManifest } from "../../../src/facets";
import { TenantId } from "../../../src/identity";
import { MaterializationHarness } from "../../definition/materialization-harness";

/*
 * The definition journey end to end: what a platform definer declares in a Blueprint is
 * planned, dispatched as a materialization command through the real ingress, and applied
 * exactly once — the declared PolicySet arriving as a managed record under the target Actor.
 */
const materializationActor = new ActorRef("tenant", new ActorId("materialization-target"));
const tenantId = new TenantId("materialization-tenant");
const deploymentKey = new DeploymentKey("journey");
const MATERIALIZED_KEYS = ["policy:platform", "scope:platform", "surface:platform"];
const platform = new PlatformCompatibility({
    spec: new SemVer("1.0.0"),
    host: new SemVer("1.0.0")
});

const declarationFields: readonly BlueprintDeclarationField[] = [
    "scopes",
    "agents",
    "slots",
    "subscriptions",
    "environments",
    "surfaces"
];
const declarationCodecs = new BlueprintDeclarationCodecPort(
    declarationFields.map((field) => ({
        field,
        canonicalize: (value: JsonValue): JsonValue => value
    }))
);

const placementSource = new (class extends PlacementSourcePort {
    public substrateModes(_release: PackageRelease, _manifest: FacetManifest) {
        return ["dynamic", "provider", "bundled"] as const;
    }

    // This profile hosts no §4.7 agent-authored code, so it declares no default backing
    // and a `code`-available Operation is refused at validation rather than assumed.
    public authoredCodeBackingDefault(): undefined {
        return undefined;
    }
})();

const topology = new (class extends MaterializationTopologyPort {
    public actorFor(_validated: ValidatedBlueprint, _projection: DesiredProjection): ActorRef {
        return materializationActor;
    }
})();

describe("declared Blueprint to applied materialization journey", () => {
    test(
        "applies the planned records of a declared Blueprint through the command protocol",
        { tags: "p1" },
        async () => {
            const declared = new PolicySet({ tiers: { execute: "mediated" } });
            const plan = planFor(declared);
            const harness = new MaterializationHarness();

            const result = await harness.dispatch(
                harness.envelope(plan, { key: "blueprint-journey" })
            );
            const records = harness.store.state.records.snapshot();

            expect(result.outcome).toBe("committed");
            expect(decodeCanonicalJson(result.reply)).toMatchObject({
                insertedRecords: 3,
                pointerChanged: true
            });
            expect(plan.origin.tenantId.equals(tenantId)).toBe(true);
            expect(plan.actors[0]!.projections.map((projection) => projection.recordKind)).toEqual([
                "policy-set",
                "scope-scaffold",
                "surface-layout"
            ]);
            expect(harness.managedLogicalKeys()).toEqual(MATERIALIZED_KEYS);
            expect(materializedPolicy(plan)).toEqual(declared.toData());
            expect(records.writes).toHaveLength(1);
            expect(records.audits).toHaveLength(2);
            expect(harness.store.state.applyCount).toBe(1);
        }
    );

    test("applies a replayed materialization envelope at most once", { tags: "p0" }, async () => {
        const plan = planFor(new PolicySet({}));
        const harness = new MaterializationHarness();
        const raw = harness.envelope(plan, { key: "blueprint-journey-replay" });

        const first = await harness.dispatch(raw);
        const duplicate = await harness.dispatch(raw);

        expect(first.outcome).toBe("committed");
        expect(duplicate.outcome).toBe("duplicate");
        expect(duplicate.reply).toEqual(first.reply);
        expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
        expect(harness.store.state.applyCount).toBe(1);
        expect(harness.managedLogicalKeys()).toEqual(MATERIALIZED_KEYS);
    });
});

function planFor(policies: PolicySet): MaterializationPlan {
    const blueprint = new Blueprint({
        meta: { name: "journey", version: new SemVer("1.0.0") },
        packages: [],
        policies,
        scopes: { projects: [{ key: "default" }] },
        agents: [],
        slots: [],
        subscriptions: [],
        environments: [],
        surfaces: { layout: [] }
    });
    const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [] });
    const validated = validateBlueprint(blueprint, {
        lock: new PackageLock({
            target: platform,
            roots: [],
            snapshotRevision: snapshot.revision,
            snapshotDigest: snapshot.digest,
            packages: []
        }),
        releases: [],
        target: platform,
        declarationCodecs,
        placement: placementSource,
        schemaValidator: strictJsonSchemaValidator
    });
    return planMaterialization({
        validatedBlueprint: validated,
        tenantId,
        deploymentKey,
        generation: 1,
        topology
    });
}

function materializedPolicy(plan: MaterializationPlan): JsonValue {
    const projection = plan.actors[0]!.projections.find(
        (candidate) => candidate.recordKind === "policy-set"
    );
    if (projection === undefined) {
        throw new TypeError("Expected a materialized policy-set record");
    }
    return PolicySet.fromData(projection.desired).toData();
}
