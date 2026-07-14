import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageDependency,
    PackageId,
    PackageLock,
    PackagePin,
    PackageRelease,
    PlatformCompatibility
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("20.0.0") });

describe("package releases", () => {
    test("[definition.package-release] canonicalizes immutable metadata and round-trips its strict codec", () => {
        const dependencies = [
            new PackageDependency(new PackageId("zeta"), "^2.0.0"),
            new PackageDependency(new PackageId("alpha"), ">=1 <2")
        ];
        const provenance = { source: { registry: "internal" }, signed: true };
        const codeRefs = [contentRef("z-code"), contentRef("a-code")];
        const release = packageRelease("root", "1.2.3-rc.1+linux", dependencies, {
            codeRefs,
            configSchema: new JsonSchema({ type: "object" }),
            provenance
        });
        dependencies.reverse();
        provenance.source.registry = "changed";
        codeRefs.pop();

        expect(
            release.dependencies.map((dependency) => [dependency.id.value, dependency.range])
        ).toEqual([
            ["alpha", ">=1.0.0 <2.0.0-0"],
            ["zeta", ">=2.0.0 <3.0.0-0"]
        ]);
        expect(release.codeManifest.modules.map((module) => module.content.value)).toEqual([
            contentRef("a-code").value,
            contentRef("z-code").value
        ]);
        expect(release.provenance).toEqual({ signed: true, source: { registry: "internal" } });
        expect(Object.isFrozen(release)).toBe(true);
        expect(Object.isFrozen(release.dependencies)).toBe(true);
        expect(Object.isFrozen(release.provenance.source)).toBe(true);

        const encoded = PackageRelease.encode(release);
        const decoded = PackageRelease.decode(encoded);
        expect(PackageRelease.encode(decoded)).toEqual(encoded);
        expect(decoded.version.toString()).toBe("1.2.3-rc.1+linux");
        expect(decoded.configSchema?.document).toEqual({ type: "object" });
    });

    test("rejects malformed, duplicate, empty, and noncanonical release metadata", () => {
        expect(() => new PackageId(" padded ")).toThrow(/canonical/);
        expect(() => new PackageDependency(new PackageId("dep"), " ")).toThrow(/nonblank/);
        expect(() => new PackageDependency(new PackageId("dep"), "not a range")).toThrow(/valid/);
        expect(() =>
            packageRelease("root", "1.0.0", [
                new PackageDependency(new PackageId("dep"), "^1"),
                new PackageDependency(new PackageId("dep"), "^2")
            ])
        ).toThrow(/dependency IDs/);

        const release = packageRelease("root", "1.0.0");
        expect(
            () =>
                new PackageRelease({
                    id: release.id,
                    version: release.version,
                    compatibility: release.compatibility,
                    dependencies: release.dependencies,
                    manifests: release.manifests,
                    codeManifest: release.codeManifest,
                    manifestDigest: digestOf("forged-manifest-digest"),
                    codeDigest: release.codeDigest,
                    provenance: release.provenance
                })
        ).toThrow(/canonical manifests/);
        expect(
            () =>
                new PackageRelease({
                    id: release.id,
                    version: release.version,
                    compatibility: release.compatibility,
                    dependencies: release.dependencies,
                    manifests: [] as unknown as [FacetManifest, ...FacetManifest[]],
                    codeManifest: release.codeManifest,
                    manifestDigest: release.manifestDigest,
                    codeDigest: release.codeDigest,
                    provenance: release.provenance
                })
        ).toThrow(/at least one manifest/);
        const foreignEntrypoint = new PackageCodeManifest({
            compatibilityDate: release.codeManifest.compatibilityDate,
            modules: release.codeManifest.modules,
            entrypoints: [
                new PackageCodeEntrypoint({
                    facet: new FacetPackageId("foreign.facet"),
                    version: release.manifests[0].version,
                    module: release.codeManifest.entrypoints[0].module
                })
            ]
        });
        expect(
            () =>
                new PackageRelease({
                    id: release.id,
                    version: release.version,
                    compatibility: release.compatibility,
                    dependencies: release.dependencies,
                    manifests: release.manifests,
                    codeManifest: foreignEntrypoint,
                    provenance: release.provenance
                })
        ).toThrow(/exactly match/);
        expect(() =>
            PackageRelease.fromData({
                ...(release.toData() as object),
                id: 7
            })
        ).toThrow(/must be a string/);

        const envelope = requireObject(decodeCanonicalJson(PackageRelease.encode(release)));
        const payload = requireObject(envelope["payload"]!);
        expectCodecError(
            () =>
                PackageRelease.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, unknown: true }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                PackageRelease.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: {
                            ...payload,
                            dependencies: [{ id: "dep", range: "^1" }]
                        }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                PackageRelease.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        version: { major: 3, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });
});

describe("metadata snapshots", () => {
    test("[definition.metadata-snapshot] copies, sorts, freezes, and round-trips one immutable metadata revision", () => {
        const releases = [
            packageRelease("zeta", "1.0.0"),
            packageRelease("alpha", "2.0.0"),
            packageRelease("alpha", "1.0.0")
        ];
        const snapshot = new MetadataSnapshot({ revision: new Revision(7), releases });
        const digest = snapshot.digest.value;
        releases.reverse();
        releases[0] = packageRelease("mutated", "9.0.0");

        expect(snapshot.releases.map((release) => `${release.id}@${release.version}`)).toEqual([
            "alpha@1.0.0",
            "alpha@2.0.0",
            "zeta@1.0.0"
        ]);
        expect(snapshot.digest.value).toBe(digest);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.releases)).toBe(true);

        const encoded = MetadataSnapshot.encode(snapshot);
        expect(MetadataSnapshot.encode(MetadataSnapshot.decode(encoded))).toEqual(encoded);
        expect(
            () =>
                new MetadataSnapshot({
                    revision: snapshot.revision,
                    releases: snapshot.releases,
                    digest: digestOf("wrong")
                })
        ).toThrow(/digest/);
    });

    test("deduplicates identical releases and rejects conflicting full-version metadata", () => {
        const release = packageRelease("same", "1.0.0+build");
        const duplicate = PackageRelease.decode(PackageRelease.encode(release));
        const snapshot = new MetadataSnapshot({
            revision: Revision.initial(),
            releases: [release, duplicate]
        });
        expect(snapshot.releases).toHaveLength(1);

        const conflict = packageRelease("same", "1.0.0+build", [], {
            codeDigest: digestOf("different-code")
        });
        expect(
            () =>
                new MetadataSnapshot({
                    revision: Revision.initial(),
                    releases: [release, conflict]
                })
        ).toThrow(/Conflicting metadata.*same@1.0.0\+build/);

        const otherBuild = packageRelease("same", "1.0.0+other");
        expect(
            new MetadataSnapshot({
                revision: Revision.initial(),
                releases: [release, otherBuild]
            }).releases
        ).toHaveLength(2);
    });
});

describe("package locks", () => {
    test("[definition.package-lock] sorts complete pins and round-trips byte deterministically", () => {
        const snapshotDigest = digestOf("snapshot");
        const pins = [pin("zeta", "2.0.0"), pin("alpha", "1.0.0+build")];
        const lock = new PackageLock({
            target,
            roots: [],
            snapshotRevision: new Revision(4),
            snapshotDigest,
            packages: pins
        });
        pins.reverse();

        expect(lock.packages.map((entry) => entry.id.value)).toEqual(["alpha", "zeta"]);
        expect(Object.isFrozen(lock.packages)).toBe(true);
        const encoded = PackageLock.encode(lock);
        expect(lock.digest.equals(Digest.sha256(encoded))).toBe(true);
        expect(PackageLock.encode(PackageLock.decode(encoded))).toEqual(encoded);
    });

    test("rejects duplicate pins and unknown codec fields", () => {
        expect(
            () =>
                new PackageLock({
                    target,
                    roots: [],
                    snapshotRevision: Revision.initial(),
                    snapshotDigest: digestOf("snapshot"),
                    packages: [pin("same", "1.0.0"), pin("same", "2.0.0")]
                })
        ).toThrow(/one version/);

        const lock = new PackageLock({
            target,
            roots: [],
            snapshotRevision: Revision.initial(),
            snapshotDigest: digestOf("snapshot"),
            packages: []
        });
        const envelope = requireObject(decodeCanonicalJson(PackageLock.encode(lock)));
        const payload = requireObject(envelope["payload"]!);
        expectCodecError(
            () =>
                PackageLock.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, legacy: true }
                    })
                ),
            "codec.invalid"
        );
    });
});

interface ReleaseOverrides {
    readonly codeDigest?: Digest;
    readonly codeRefs?: readonly ContentRef[];
    readonly configSchema?: JsonSchema;
    readonly provenance?: { source: { registry: string }; signed: boolean };
}

function packageRelease(
    id: string,
    version: string,
    dependencies: readonly PackageDependency[] = [],
    overrides: ReleaseOverrides = {}
): PackageRelease {
    const manifests = [manifest(`${id}.facet`, version)] as [FacetManifest];
    const references = [
        ...(overrides.codeRefs ?? [
            ContentRef.fromDigest(overrides.codeDigest ?? digestOf(`code:${id}:${version}`))
        ])
    ].sort((left, right) => left.value.localeCompare(right.value));
    const modules = references.map(
        (reference, index) =>
            new PackageCodeModule({
                specifier: `./module-${index}.js`,
                content: reference,
                media: new MediaHint("application/javascript"),
                imports:
                    index === 0
                        ? references.slice(1).map((_, child) => `./module-${child + 1}.js`)
                        : []
            })
    ) as [PackageCodeModule, ...PackageCodeModule[]];
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules,
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifests[0].id,
                version: manifests[0].version,
                module: "./module-0.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId(id),
        version: new SemVer(version),
        compatibility: new CompatRange("^1.0.0", ">=20.0.0"),
        dependencies,
        manifests,
        codeManifest,
        provenance: overrides.provenance ?? { source: { registry: "test" }, signed: true },
        ...(overrides.configSchema === undefined ? {} : { configSchema: overrides.configSchema })
    });
}

function manifest(id: string, version: string): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer(version),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([])
    });
}

function pin(id: string, version: string): PackagePin {
    return new PackagePin(
        new PackageId(id),
        new SemVer(version),
        digestOf(`manifest:${id}:${version}`),
        digestOf(`code:${id}:${version}`)
    );
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function contentRef(value: string): ContentRef {
    return ContentRef.fromDigest(digestOf(value));
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
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
