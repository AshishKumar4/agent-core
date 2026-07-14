import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { MediaHint } from "../../src/content";
import { CompatRange, ContentRef, Digest, JsonSchema, Revision, SemVer } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    managedResourceId,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    MaterializationPlan,
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageDependency,
    PackageId,
    PackageLock,
    PackageRelease,
    PlatformCompatibility,
    PolicySet,
    policyProjection,
    type PackageReleaseInit
} from "../../src/definition";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";
import { TenantId } from "../../src/identity";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));
const actor = new ActorRef("workspace", new ActorId("workspace"));
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });

describe("definition codec adversarial edges", () => {
    test("rejects malformed origins Actor plans and materialization plans", () => {
        const materializationOrigin = origin(1);
        expect(() => ManagedOrigin.fromData(null)).toThrow(/object/);
        expect(() =>
            ManagedOrigin.fromData({ ...(materializationOrigin.toData() as object), extra: true })
        ).toThrow(/missing or unknown/);
        expect(() =>
            ManagedOrigin.fromData({ ...(materializationOrigin.toData() as object), tenantId: 1 })
        ).toThrow(/string/);
        expect(() =>
            ManagedOrigin.fromData({
                ...(materializationOrigin.toData() as object),
                generation: -1
            })
        ).toThrow(/non-negative/);

        const plan = actorPlan(materializationOrigin);
        expect(() => ActorPlan.fromData(null)).toThrow(/object/);
        expect(() =>
            ActorPlan.fromData({ ...(plan.toData() as object), projections: null })
        ).toThrow(/array/);
        expect(() =>
            ActorPlan.fromData({ ...(plan.toData() as object), actor: { id: "x", kind: "bad" } })
        ).toThrow(/Actor kind/);
        const materialization = new MaterializationPlan({
            origin: materializationOrigin,
            actors: [plan]
        });
        expect(() =>
            MaterializationPlan.fromData({ ...(materialization.toData() as object), actors: null })
        ).toThrow(/array/);
        expect(() =>
            MaterializationPlan.fromData({
                ...(materialization.toData() as object),
                origin: undefined
            } as never)
        ).toThrow(/required|missing/);
    });

    test("rejects forged managed resource generation and pointer identities", () => {
        const plan = actorPlan(origin(1));
        const generation = MaterializationGeneration.fromActorPlan(plan);
        const record = ManagedStateRecord.fromProjection(
            actor,
            plan.origin,
            generation.id,
            plan.projections[0]!
        );
        expect(() => new ManagedStateRecord({ ...record, desiredDigest: digest("wrong") })).toThrow(
            /state digest/
        );
        expect(() => new ManagedStateRecord({ ...record, resourceId: digest("wrong") })).toThrow(
            /resource ID/
        );
        expect(() => new ManagedStateRecord({ ...record, id: digest("wrong") })).toThrow(
            /state ID/
        );
        expect(() =>
            ManagedStateRecord.fromData({
                ...(record.toData() as object),
                desired: undefined
            } as never)
        ).toThrow(/required|missing/);
        expect(() =>
            ManagedStateRecord.fromData({
                ...(record.toData() as object),
                actor: { id: "workspace", kind: "bad" }
            })
        ).toThrow(/Actor kind/);
        expect(() => ManagedStateRecord.fromData(null)).toThrow(/object/);
        expect(() => managedResourceId(actor, plan.origin, " padded ", "policy-set")).toThrow(
            /canonical/
        );
        expect(
            () =>
                new MaterializationGeneration({
                    ...generation,
                    id: digest("wrong")
                })
        ).toThrow(/generation ID/);
        expect(
            () =>
                new MaterializationGeneration({
                    ...generation,
                    managedRecordIds: [record.id, record.id]
                })
        ).toThrow(/unique/);
        expect(() =>
            MaterializationGeneration.fromData({
                ...(generation.toData() as object),
                managedRecordIds: null
            })
        ).toThrow(/array/);
        expect(() =>
            MaterializationGeneration.fromData({
                ...(generation.toData() as object),
                managedRecordIds: [7]
            })
        ).toThrow(/string/);

        const pointer = MaterializationGenerationPointer.initial(
            actor,
            deploymentId,
            generation.id
        );
        expect(() =>
            MaterializationGenerationPointer.fromData({
                ...(pointer.toData() as object),
                revision: -1
            })
        ).toThrow(/non-negative/);
        expect(() =>
            MaterializationGenerationPointer.fromData({
                ...(pointer.toData() as object),
                actor: { id: "workspace", kind: "bad" }
            })
        ).toThrow(/Actor kind/);
    });

    test("rejects malformed Package locks releases and snapshots", () => {
        const lock = new PackageLock({
            target,
            roots: [],
            snapshotRevision: Revision.initial(),
            snapshotDigest: digest("snapshot"),
            packages: []
        });
        expect(
            () =>
                new PackageLock({
                    ...lock,
                    roots: [
                        new PackageDependency(new PackageId("same"), "^1"),
                        new PackageDependency(new PackageId("same"), "^2")
                    ]
                })
        ).toThrow(/roots/);
        expect(() => PackageLock.fromData(null)).toThrow(/object/);
        expect(() => PackageLock.fromData({ ...(lock.toData() as object), roots: null })).toThrow(
            /array/
        );
        expect(() =>
            PackageLock.fromData({ ...(lock.toData() as object), snapshotRevision: -1 })
        ).toThrow(/non-negative/);
        expect(() =>
            PackageLock.fromData({ ...(lock.toData() as object), snapshotDigest: 7 })
        ).toThrow(/string/);

        const release = packageRelease();
        expect(
            () => new PackageRelease({ ...releaseInit(release), provenance: null as never })
        ).toThrow(/provenance/);
        expect(
            () => new PackageRelease({ ...releaseInit(release), codeDigest: digest("wrong") })
        ).toThrow(/code digest/);
        expect(
            () =>
                new PackageRelease({
                    ...releaseInit(release),
                    manifests: [release.manifests[0]!, release.manifests[0]!]
                })
        ).toThrow(/manifests must be unique/);
        expect(() =>
            PackageRelease.fromData({ ...(release.toData() as object), provenance: null })
        ).toThrow(/provenance/);
        expect(() =>
            PackageRelease.fromData({ ...(release.toData() as object), manifests: [] })
        ).toThrow(/at least one manifest/);
        expect(() =>
            PackageRelease.fromData({
                ...(release.toData() as object),
                compatibility: { host: "*", spec: "*", unknown: true }
            })
        ).toThrow(/missing or unknown/);
        const booleanSchema = new PackageRelease({
            ...releaseInit(release),
            configSchema: new JsonSchema(true)
        });
        expect(PackageRelease.fromData(booleanSchema.toData()).configSchema?.document).toBe(true);

        const snapshot = new MetadataSnapshot({
            revision: Revision.initial(),
            releases: [release]
        });
        expect(() => MetadataSnapshot.fromData(null)).toThrow(/object/);
        expect(() =>
            MetadataSnapshot.fromData({ ...(snapshot.toData() as object), releases: null })
        ).toThrow(/array/);
        expect(() =>
            MetadataSnapshot.fromData({ ...(snapshot.toData() as object), revision: -1 })
        ).toThrow(/non-negative/);
    });
});

function actorPlan(materializationOrigin: ManagedOrigin): ActorPlan {
    return new ActorPlan({
        actor,
        origin: materializationOrigin,
        projections: [policyProjection("policy", PolicySet.empty())]
    });
}

function releaseInit(release: PackageRelease): PackageReleaseInit {
    return {
        id: release.id,
        version: release.version,
        compatibility: release.compatibility,
        dependencies: release.dependencies,
        manifests: release.manifests,
        manifestDigest: release.manifestDigest,
        codeDigest: release.codeDigest,
        codeManifest: release.codeManifest,
        provenance: release.provenance
    };
}

function origin(generation: number): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digest("attestation"),
        blueprintDigest: digest("blueprint"),
        packageLockDigest: digest("lock"),
        configDigest: digest("config"),
        generation
    });
}

function packageRelease(): PackageRelease {
    const manifest = new FacetManifest({
        id: new FacetPackageId("package.facet"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: Contributions.empty()
    });
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest("code")),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifest.id,
                version: manifest.version,
                module: "./main.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId("package"),
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: [manifest],
        codeManifest,
        provenance: { registry: "test" }
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
