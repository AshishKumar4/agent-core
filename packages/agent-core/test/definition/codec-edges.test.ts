import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    type JsonValue
} from "../../src/core";
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
    PackagePin,
    PackageRelease,
    PlatformCompatibility,
    PolicySet,
    policyProjection,
    type PackageProvenance,
    type PackageReleaseInit
} from "../../src/definition";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { fieldWithoutValue, forged, recordData } from "./record-data";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));
const actor = new ActorRef("workspace", new ActorId("workspace"));
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });

describe("definition codec adversarial edges", () => {
    test("rejects malformed origins Actor plans and materialization plans", { tags: "p1" }, () => {
        const materializationOrigin = origin(1);
        expect(() => ManagedOrigin.fromData(null)).toThrow(/object/);
        expect(() =>
            ManagedOrigin.fromData({ ...recordData(materializationOrigin), extra: true })
        ).toThrow(/missing or unknown/);
        expect(() =>
            ManagedOrigin.fromData({ ...recordData(materializationOrigin), tenantId: 1 })
        ).toThrow(/string/);
        expect(() =>
            ManagedOrigin.fromData({
                ...recordData(materializationOrigin),
                generation: -1
            })
        ).toThrow(/non-negative/);

        const plan = actorPlan(materializationOrigin);
        expect(() => ActorPlan.fromData(null)).toThrow(/object/);
        expect(() => ActorPlan.fromData({ ...recordData(plan), projections: null })).toThrow(
            /array/
        );
        expect(() =>
            ActorPlan.fromData({ ...recordData(plan), actor: { id: "x", kind: "bad" } })
        ).toThrow(/Actor kind/);
        const materialization = new MaterializationPlan({
            origin: materializationOrigin,
            actors: [plan]
        });
        expect(() =>
            MaterializationPlan.fromData({ ...recordData(materialization), actors: null })
        ).toThrow(/array/);
        expect(() =>
            MaterializationPlan.fromData(fieldWithoutValue(recordData(materialization), "origin"))
        ).toThrow(/required|missing/);
    });

    test(
        "rejects forged managed resource generation and pointer identities",
        { tags: "p0" },
        () => {
            const plan = actorPlan(origin(1));
            const generation = MaterializationGeneration.fromActorPlan(plan);
            const record = ManagedStateRecord.fromProjection(
                actor,
                plan.origin,
                generation.id,
                plan.projections[0]!
            );
            expect(
                () => new ManagedStateRecord({ ...record, desiredDigest: digest("wrong") })
            ).toThrow(/state digest/);
            expect(
                () => new ManagedStateRecord({ ...record, resourceId: digest("wrong") })
            ).toThrow(/resource ID/);
            expect(() => new ManagedStateRecord({ ...record, id: digest("wrong") })).toThrow(
                /state ID/
            );
            expect(() =>
                ManagedStateRecord.fromData(fieldWithoutValue(recordData(record), "desired"))
            ).toThrow(/required|missing/);
            expect(() =>
                ManagedStateRecord.fromData({
                    ...recordData(record),
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
                    ...recordData(generation),
                    managedRecordIds: null
                })
            ).toThrow(/array/);
            expect(() =>
                MaterializationGeneration.fromData({
                    ...recordData(generation),
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
                    ...recordData(pointer),
                    revision: -1
                })
            ).toThrow(/non-negative/);
            expect(() =>
                MaterializationGenerationPointer.fromData({
                    ...recordData(pointer),
                    actor: { id: "workspace", kind: "bad" }
                })
            ).toThrow(/Actor kind/);
        }
    );

    test("accepts generation zero and distinguishes origins by every field", { tags: "p1" }, () => {
        const zero = new ManagedOrigin({ ...originInit(), generation: 0 });
        expect(zero.generation).toBe(0);
        expect(ManagedOrigin.fromData(zero.toData()).generation).toBe(0);

        const base = new ManagedOrigin(originInit());
        expect(base.equals(new ManagedOrigin(originInit()))).toBe(true);
        const variants: readonly Partial<ReturnType<typeof originInit>>[] = [
            { tenantId: new TenantId("other-tenant") },
            { deploymentId: DeploymentId.derive(tenantId, new DeploymentKey("other")) },
            { attestationDigest: digest("other-attestation") },
            { blueprintDigest: digest("other-blueprint") },
            { packageLockDigest: digest("other-lock") },
            { configDigest: digest("other-config") },
            { generation: 2 }
        ];
        for (const variant of variants) {
            const other = new ManagedOrigin({ ...originInit(), ...variant });
            expect({ variant, equals: base.equals(other) }).toEqual({ variant, equals: false });
            expect({ variant, equals: other.equals(base) }).toEqual({ variant, equals: false });
        }
    });

    test("names every malformed managed origin field in its codec error", { tags: "p2" }, () => {
        const data = recordData(new ManagedOrigin(originInit()));
        expect(() => ManagedOrigin.fromData({ ...data, tenantId: 7 })).toThrow(
            "Managed origin Tenant ID must be a string"
        );
        expect(() => ManagedOrigin.fromData({ ...data, deploymentId: 7 })).toThrow(
            "Managed origin deployment ID must be a string"
        );
        expect(() => ManagedOrigin.fromData({ ...data, attestationDigest: 7 })).toThrow(
            "Managed origin attestation digest must be a string"
        );
        expect(() => ManagedOrigin.fromData({ ...data, blueprintDigest: 7 })).toThrow(
            "Blueprint digest must be a string"
        );
        expect(() => ManagedOrigin.fromData({ ...data, packageLockDigest: 7 })).toThrow(
            "Package lock digest must be a string"
        );
        expect(() => ManagedOrigin.fromData({ ...data, configDigest: 7 })).toThrow(
            "Config digest must be a string"
        );
        expect(() => ManagedOrigin.fromData(null)).toThrow("Managed origin must be an object");
        expect(() => ManagedOrigin.fromData([])).toThrow("Managed origin must be an object");
        expect(() => ManagedOrigin.fromData("payload")).toThrow("Managed origin must be an object");
    });

    test("rejects every malformed managed origin generation shape", { tags: "p1" }, () => {
        const data = recordData(new ManagedOrigin(originInit()));
        // Decoding narrows the field; the range belongs to the constructor, and the two
        // answer separately so neither can stand in for the other.
        for (const generation of [-1, -0.5, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
            expect(() => ManagedOrigin.fromData({ ...data, generation })).toThrow(
                "Managed origin generation must be a non-negative safe integer"
            );
        }
        const notNumbers: readonly JsonValue[] = ["3", true, null, [], {}];
        for (const generation of notNumbers) {
            expect(() => ManagedOrigin.fromData({ ...data, generation })).toThrow(
                "Managed origin generation must be a number"
            );
        }
        expect(ManagedOrigin.fromData({ ...data, generation: 0 }).generation).toBe(0);
    });

    test("freezes package pins and names malformed pin and lock fields", { tags: "p2" }, () => {
        const pin = new PackagePin(
            new PackageId("pinned"),
            new SemVer("1.0.0"),
            digest("manifest"),
            digest("code")
        );
        expect(Object.isFrozen(pin)).toBe(true);

        const pinData = recordData(pin);
        expect(() => PackagePin.fromData({ ...pinData, id: 7 })).toThrow(
            "Package pin ID must be a string"
        );
        expect(() => PackagePin.fromData({ ...pinData, version: 7 })).toThrow(
            "Package pin version must be a string"
        );
        expect(() => PackagePin.fromData({ ...pinData, manifestDigest: 7 })).toThrow(
            "Package manifest digest must be a string"
        );
        expect(() => PackagePin.fromData({ ...pinData, codeDigest: 7 })).toThrow(
            "Package code digest must be a string"
        );
        expect(() => PackagePin.fromData(null)).toThrow("Package pin must be an object");
        expect(() => PackagePin.fromData([])).toThrow("Package pin must be an object");
        expect(() => PackagePin.fromData("payload")).toThrow("Package pin must be an object");

        const lockData = recordData(
            new PackageLock({
                target,
                roots: [],
                snapshotRevision: Revision.initial(),
                snapshotDigest: digest("snapshot"),
                packages: [pin]
            })
        );
        expect(() => PackageLock.fromData({ ...lockData, snapshotDigest: 7 })).toThrow(
            "Package lock snapshot digest must be a string"
        );
        expect(() => PackageLock.fromData(null)).toThrow("Package lock must be an object");
        expect(() => PackageLock.fromData([])).toThrow("Package lock must be an object");
        expect(() => PackageLock.fromData("payload")).toThrow("Package lock must be an object");
        for (const snapshotRevision of ["1", -1, 0.5]) {
            expect(() => PackageLock.fromData({ ...lockData, snapshotRevision })).toThrow(
                "Package lock snapshot revision must be a non-negative safe integer"
            );
        }
    });

    test("rejects malformed Package locks releases and snapshots", { tags: "p1" }, () => {
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
        expect(() => PackageLock.fromData({ ...recordData(lock), roots: null })).toThrow(/array/);
        expect(() => PackageLock.fromData({ ...recordData(lock), snapshotRevision: -1 })).toThrow(
            /non-negative/
        );
        expect(() => PackageLock.fromData({ ...recordData(lock), snapshotDigest: 7 })).toThrow(
            /string/
        );

        const release = packageRelease();
        expect(
            () =>
                new PackageRelease({
                    ...releaseInit(release),
                    provenance: forged<PackageProvenance>(null)
                })
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
        expect(() => PackageRelease.fromData({ ...recordData(release), provenance: null })).toThrow(
            /provenance/
        );
        expect(() => PackageRelease.fromData({ ...recordData(release), manifests: [] })).toThrow(
            /at least one manifest/
        );
        expect(() =>
            PackageRelease.fromData({
                ...recordData(release),
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
            MetadataSnapshot.fromData({ ...recordData(snapshot), releases: null })
        ).toThrow(/array/);
        expect(() => MetadataSnapshot.fromData({ ...recordData(snapshot), revision: -1 })).toThrow(
            /non-negative/
        );
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
    return new ManagedOrigin({ ...originInit(), generation });
}

function originInit() {
    return {
        tenantId,
        deploymentId,
        attestationDigest: digest("attestation"),
        blueprintDigest: digest("blueprint"),
        packageLockDigest: digest("lock"),
        configDigest: digest("config"),
        generation: 1
    };
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
