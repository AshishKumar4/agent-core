import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import { CompatRange, ContentRef, Digest, Revision, SemVer, requireNonempty } from "../../src/core";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule
} from "../../src/definition/code-manifest";
import { PlatformCompatibility } from "../../src/definition/compatibility";
import { PackageId } from "../../src/definition/id";
import { PackageLock, PackagePin } from "../../src/definition/package-lock";
import type { PackageStore } from "../../src/definition/package-store";
import { MetadataSnapshot, PackageDependency, PackageRelease } from "../../src/definition/package";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";
import { MemoryPackageStore } from "../../src/definition/memory";
import type { PackageContentCustody } from "../../src/definition/package-store";

const encoder = new TextEncoder();
const compatibilityTarget = new PlatformCompatibility({
    spec: new SemVer("1.0.0"),
    host: new SemVer("1.0.0")
});

export function packageStoreContract(name: string, create: () => PackageStore): void {
    describe(`${name} PackageStore contract`, () => {
        test("adds and gets an exact package release synchronously", { tags: "p1" }, () => {
            const store = create();
            const release = packageRelease("package", "1.2.3+build");

            expect(store.add(release)).toBeUndefined();
            const stored = store.get(release.id, release.version);

            expect(stored).not.toBeInstanceOf(Promise);
            expect(stored).toBeDefined();
            expect(PackageRelease.encode(stored!)).toEqual(PackageRelease.encode(release));
            expect(store.get(release.id, new SemVer("1.2.4"))).toBeUndefined();
            expect(store.get(new PackageId("missing"), release.version)).toBeUndefined();
        });

        test("lists all or one package in canonical key order", { tags: "p1" }, () => {
            const store = create();
            const releases = [
                packageRelease("zeta", "1.0.0"),
                packageRelease("alpha", "2.0.0"),
                packageRelease("alpha", "10.0.0"),
                packageRelease("alpha", "1.0.0+zeta"),
                packageRelease("alpha", "1.0.0+alpha")
            ];
            for (const release of releases) store.add(release);

            const all = store.list();
            expect(all).not.toBeInstanceOf(Promise);
            expect(all.map(releaseKey)).toEqual([
                "alpha@1.0.0+alpha",
                "alpha@1.0.0+zeta",
                "alpha@10.0.0",
                "alpha@2.0.0",
                "zeta@1.0.0"
            ]);
            expect(store.list(new PackageId("alpha")).map(releaseKey)).toEqual([
                "alpha@1.0.0+alpha",
                "alpha@1.0.0+zeta",
                "alpha@10.0.0",
                "alpha@2.0.0"
            ]);
            expect(store.list(new PackageId("missing"))).toEqual([]);
            expect(Object.isFrozen(all)).toBe(true);
        });

        test("makes an equal release replay idempotent", { tags: "p0" }, () => {
            const store = create();
            const release = packageRelease("same", "1.0.0");
            const replay = PackageRelease.decode(PackageRelease.encode(release));

            store.add(release);
            expect(() => store.add(replay)).not.toThrow();
            expect(store.list()).toHaveLength(1);
        });

        test(
            "rejects a different release under an immutable full-version key",
            { tags: "p0" },
            () => {
                const store = create();
                const original = packageRelease("same", "1.0.0");
                const conflict = packageRelease("same", "1.0.0", digestOf("different-code"));
                store.add(original);

                expect(() => store.add(conflict)).toThrow(/immutable/);
                expect(PackageRelease.encode(store.get(original.id, original.version)!)).toEqual(
                    PackageRelease.encode(original)
                );
                expect(store.list()).toHaveLength(1);
            }
        );

        test("persists exact metadata snapshots", { tags: "p1" }, () => {
            const store = create();
            const snapshot = new MetadataSnapshot({
                revision: new Revision(7),
                releases: [packageRelease("package", "1.0.0")]
            });

            store.addSnapshot(snapshot);
            expect(() =>
                store.addSnapshot(MetadataSnapshot.decode(MetadataSnapshot.encode(snapshot)))
            ).not.toThrow();

            expect(MetadataSnapshot.encode(store.getSnapshot(snapshot.digest)!)).toEqual(
                MetadataSnapshot.encode(snapshot)
            );
            expect(store.listSnapshots().map((value) => value.digest.value)).toEqual([
                snapshot.digest.value
            ]);
        });

        test(
            "misses absent snapshots and orders them by revision then digest",
            { tags: "p1" },
            () => {
                const store = create();
                expect(store.getSnapshot(digestOf("missing-snapshot"))).toBeUndefined();

                const first = new MetadataSnapshot({
                    revision: new Revision(1),
                    releases: [packageRelease("m-two", "1.0.0")]
                });
                const second = new MetadataSnapshot({
                    revision: new Revision(2),
                    releases: [packageRelease("m-three", "1.0.0")]
                });
                const third = new MetadataSnapshot({
                    revision: new Revision(3),
                    releases: [packageRelease("m-five", "1.0.0")]
                });
                expect(
                    [first, second, third].map((snapshot) => snapshot.digest.value).sort()
                ).toEqual([third.digest.value, second.digest.value, first.digest.value]);
                store.addSnapshot(second);
                store.addSnapshot(first);
                store.addSnapshot(third);

                expect(store.listSnapshots().map((snapshot) => snapshot.revision.value)).toEqual([
                    1, 2, 3
                ]);
                expect(store.listSnapshots().map((snapshot) => snapshot.digest.value)).toEqual([
                    first.digest.value,
                    second.digest.value,
                    third.digest.value
                ]);
            }
        );

        test("persists package locks by canonical lock digest", { tags: "p1" }, () => {
            const store = create();
            const digest = digestOf("snapshot");
            const lock = packageLock(digest, 7, [
                packageRelease("zeta", "2.0.0"),
                packageRelease("alpha", "1.0.0")
            ]);

            expect(store.addLock(lock)).toBeUndefined();
            const stored = store.getLock(lock.digest);

            expect(stored).not.toBeInstanceOf(Promise);
            expect(PackageLock.encode(stored!)).toEqual(PackageLock.encode(lock));
            expect(store.getLock(digestOf("missing"))).toBeUndefined();
        });

        test(
            "makes equal lock replay idempotent and stores multiple locks per snapshot",
            { tags: "p0" },
            () => {
                const store = create();
                const digest = digestOf("snapshot");
                const original = packageLock(digest, 3, [packageRelease("root", "1.0.0")]);
                const replay = PackageLock.decode(PackageLock.encode(original));
                const other = packageLock(digest, 3, [packageRelease("other", "2.0.0")]);

                store.addLock(original);
                expect(() => store.addLock(replay)).not.toThrow();
                expect(() => store.addLock(other)).not.toThrow();
                expect(PackageLock.encode(store.getLock(original.digest)!)).toEqual(
                    PackageLock.encode(original)
                );
                expect(PackageLock.encode(store.getLock(other.digest)!)).toEqual(
                    PackageLock.encode(other)
                );
                expect(original.snapshotDigest.equals(other.snapshotDigest)).toBe(true);
                expect(original.digest.equals(other.digest)).toBe(false);
            }
        );
    });
}

export function packageRelease(
    id: string,
    version: string,
    codeDigest = digestOf(`code:${id}:${version}`)
): PackageRelease {
    const manifests = requireNonempty(
        [
            new FacetManifest({
                id: new FacetPackageId(`${id}.facet`),
                version: new SemVer(version),
                compat: CompatRange.any(),
                isolation: ["dynamic"],
                bindings: [],
                contributions: Contributions.empty()
            })
        ],
        "Facet manifests"
    );
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(codeDigest),
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
        version: new SemVer(version),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests,
        codeManifest,
        provenance: { registry: "test" }
    });
}

export function packageLock(
    snapshotDigest: Digest,
    snapshotRevision: number,
    releases: readonly PackageRelease[]
): PackageLock {
    return new PackageLock({
        target: compatibilityTarget,
        roots: releases.map(
            (release) => new PackageDependency(release.id, release.version.toString())
        ),
        snapshotDigest,
        snapshotRevision: new Revision(snapshotRevision),
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

export function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function releaseKey(release: PackageRelease): string {
    return `${release.id.value}@${release.version.toString()}`;
}

/**
 * The in-memory package store behind its plane barrel, so a test outside the definition
 * context reaches it the way production does.
 */
export function memoryPackageStore(custody: PackageContentCustody): MemoryPackageStore {
    return new MemoryPackageStore(custody);
}
