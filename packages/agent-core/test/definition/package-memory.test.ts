import { describe, expect, test } from "vitest";
import { Revision, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { MemoryPackageStore, type MemoryPackageSnapshot } from "../../src/definition/memory";
import { PackageLock } from "../../src/definition/package-lock";
import { PackageId } from "../../src/definition/id";
import { MetadataSnapshot, PackageRelease } from "../../src/definition/package";
import { SqlitePackageStore } from "../../src/substrates";
import { forged } from "./record-data";
import { TestSqlite } from "../helpers/sqlite";
import {
    digestOf,
    packageLock,
    packageRelease,
    packageStoreContract
} from "./package-store-contract";
import { recordingCustody } from "../helpers/custody";

packageStoreContract("memory", () => new MemoryPackageStore(recordingCustody()));

test("[package-store] memory and SQLite satisfy one shared codec-storage contract", { tags: "p1" }, () => {
    const stores = [new MemoryPackageStore(recordingCustody()), new SqlitePackageStore(new TestSqlite())];
    for (const [index, store] of stores.entries()) {
        const value = packageRelease(`seam-${index}`, "1.0.0");
        store.add(value);
        expect(store.get(value.id, value.version)?.codeDigest.equals(value.codeDigest)).toBe(true);
    }
});

describe("MemoryPackageStore persistence", () => {
    test("[definition.package-release] [definition.metadata-snapshot] [definition.package-lock] restores releases, snapshots, and locks from a detached sorted snapshot", { tags: "p1" }, () => {
        const store = new MemoryPackageStore(recordingCustody());
        const zeta = packageRelease("zeta", "2.0.0");
        const alpha = packageRelease("alpha", "1.0.0");
        const metadata = new MetadataSnapshot({
            revision: new Revision(5),
            releases: [zeta, alpha]
        });
        const lock = packageLock(metadata.digest, metadata.revision.value, [zeta, alpha]);
        store.add(zeta);
        store.add(alpha);
        store.addSnapshot(metadata);
        store.addLock(lock);

        const snapshot = store.snapshot();
        expect(snapshot.releases[0]!.packageId).toBeInstanceOf(PackageId);
        expect(snapshot.releases.map((release) => release.packageId.value)).toEqual([
            "alpha",
            "zeta"
        ]);
        expect(snapshot.snapshots.map((entry) => entry.digest)).toEqual([metadata.digest.value]);
        expect(snapshot.locks.map((entry) => entry.lockDigest)).toEqual([lock.digest.value]);
        snapshot.releases[0]!.bytes.fill(0);
        snapshot.snapshots[0]!.bytes.fill(0);
        snapshot.locks[0]!.bytes.fill(0);

        expect(PackageRelease.encode(store.get(alpha.id, alpha.version)!)).toEqual(
            PackageRelease.encode(alpha)
        );
        expect(MetadataSnapshot.encode(store.getSnapshot(metadata.digest)!)).toEqual(
            MetadataSnapshot.encode(metadata)
        );
        expect(PackageLock.encode(store.getLock(lock.digest)!)).toEqual(PackageLock.encode(lock));

        const restored = new MemoryPackageStore(recordingCustody(), store.snapshot());
        const cloned = restored.clone();
        expect(cloned.list().map((release) => release.id.value)).toEqual(["alpha", "zeta"]);
        expect(PackageLock.encode(cloned.getLock(lock.digest)!)).toEqual(PackageLock.encode(lock));
    });

    test("orders detached snapshot rows deterministically", { tags: "p1" }, () => {
        const store = new MemoryPackageStore(recordingCustody());
        store.add(packageRelease("zeta", "1.0.0"));
        store.add(packageRelease("alpha", "2.0.0"));
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
        expect([first, second, third].map((entry) => entry.digest.value).sort()).toEqual([
            third.digest.value,
            second.digest.value,
            first.digest.value
        ]);
        store.addSnapshot(second);
        store.addSnapshot(first);
        store.addSnapshot(third);
        const lockOne = packageLock(digestOf("snapshot"), 1, [packageRelease("l-one", "1.0.0")]);
        const lockTwo = packageLock(digestOf("snapshot"), 1, [packageRelease("l-two", "1.0.0")]);
        const lockThree = packageLock(digestOf("snapshot"), 1, [
            packageRelease("l-three", "1.0.0")
        ]);
        expect([lockOne, lockTwo, lockThree].map((lock) => lock.digest.value).sort()).toEqual([
            lockTwo.digest.value,
            lockOne.digest.value,
            lockThree.digest.value
        ]);
        store.addLock(lockOne);
        store.addLock(lockTwo);
        store.addLock(lockThree);

        const snapshot = store.snapshot();
        expect(
            snapshot.releases.map((release) => `${release.packageId.value}@${release.version}`)
        ).toEqual(["alpha@2.0.0", "zeta@1.0.0"]);
        expect(snapshot.snapshots.map((entry) => entry.digest)).toEqual([
            first.digest.value,
            second.digest.value,
            third.digest.value
        ]);
        expect(snapshot.locks.map((entry) => entry.lockDigest)).toEqual([
            lockTwo.digest.value,
            lockOne.digest.value,
            lockThree.digest.value
        ]);
    });

    test("restores boundary revisions and re-validates stored snapshot rows", { tags: "p1" }, () => {
        const store = new MemoryPackageStore(recordingCustody());
        const release = packageRelease("package", "1.0.0");
        const metadata = new MetadataSnapshot({ revision: new Revision(0), releases: [release] });
        store.addSnapshot(metadata);
        store.addLock(packageLock(metadata.digest, 0, [release]));

        expect(() => new MemoryPackageStore(recordingCustody(), store.snapshot())).not.toThrow();

        const snapshot = store.snapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    snapshots: [
                        { ...snapshot.snapshots[0]!, digest: digestOf("other").value }
                    ]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test(
        "keeps a stored metadata snapshot and package lock immutable against byte-divergent rewrites",
        { tags: "p0" },
        () => {
            const alpha = packageRelease("alpha", "1.0.0");
            const zeta = packageRelease("zeta", "2.0.0");
            const metadata = new MetadataSnapshot({
                revision: new Revision(4),
                releases: [alpha]
            });
            const lock = packageLock(metadata.digest, 4, [alpha, zeta]);
            const snapshotBytes = duplicatedReleaseSnapshotBytes(metadata);
            const lockBytes = reorderedLockBytes(lock);
            expect(snapshotBytes).not.toEqual(MetadataSnapshot.encode(metadata));
            expect(lockBytes).not.toEqual(PackageLock.encode(lock));

            const store = new MemoryPackageStore(recordingCustody(), {
                releases: [],
                snapshots: [
                    {
                        digest: metadata.digest.value,
                        revision: metadata.revision.value,
                        bytes: snapshotBytes
                    }
                ],
                locks: [
                    {
                        lockDigest: lock.digest.value,
                        snapshotDigest: lock.snapshotDigest.value,
                        snapshotRevision: lock.snapshotRevision.value,
                        bytes: lockBytes
                    }
                ]
            });

            expect(() => store.addSnapshot(metadata)).toThrow(
                `Metadata snapshot ${metadata.digest.value} is immutable`
            );
            expect(() => store.addLock(lock)).toThrow(
                `Package lock ${lock.digest.value} is immutable`
            );
            expect(store.snapshot().snapshots.map((row) => row.bytes)).toEqual([snapshotBytes]);
            expect(store.snapshot().locks.map((row) => row.bytes)).toEqual([lockBytes]);
        }
    );

    test("names malformed snapshot field types exactly", { tags: "p2" }, () => {
        const snapshot = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    releases: [{ ...snapshot.releases[0]!, version: forged<string>(7) }]
                })
        ).toThrow(/Memory package snapshot package version is malformed/);
    });

    test.each(["packageId", "version", "manifestDigest", "codeDigest"] as const)(
        "rejects a snapshot with a corrupt release %s projection", { tags: "p0" },
        (projection) => {
            const snapshot = releaseSnapshot();
            const release = snapshot.releases[0]!;
            const value =
                projection === "packageId"
                    ? "other"
                    : projection === "version"
                      ? "2.0.0"
                      : "0".repeat(64);
            const corrupted: MemoryPackageSnapshot = {
                ...snapshot,
                releases: [{ ...release, [projection]: value }]
            };

            expect(() => new MemoryPackageStore(recordingCustody(), corrupted)).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects malformed release codec bytes in a snapshot", { tags: "p0" }, () => {
        const snapshot = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    releases: [{ ...snapshot.releases[0]!, bytes: new Uint8Array([0]) }]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test.each(["lockDigest", "snapshotDigest", "snapshotRevision"] as const)(
        "rejects a snapshot with a corrupt lock %s projection", { tags: "p0" },
        (projection) => {
            const snapshot = lockSnapshot();
            const lock = snapshot.locks[0]!;
            const corrupted: MemoryPackageSnapshot = {
                ...snapshot,
                locks: [
                    {
                        ...lock,
                        [projection]:
                            projection === "snapshotRevision"
                                ? lock.snapshotRevision + 1
                                : projection === "snapshotDigest"
                                  ? digestOf("other").value
                                  : digestOf("other-lock").value
                    }
                ]
            };

            expect(() => new MemoryPackageStore(recordingCustody(), corrupted)).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects malformed lock codec bytes and duplicate immutable keys", { tags: "p0" }, () => {
        const release = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...release,
                    releases: [release.releases[0]!, release.releases[0]!]
                })
        ).toThrow(/duplicate releases/);

        const lock = lockSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...lock,
                    locks: [lock.locks[0]!, lock.locks[0]!]
                })
        ).toThrow(/duplicate locks/);
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...lock,
                    locks: [{ ...lock.locks[0]!, bytes: new Uint8Array([0]) }]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test("rejects duplicate snapshots and malformed snapshot scalar and byte fields", { tags: "p1" }, () => {
        const store = new MemoryPackageStore(recordingCustody());
        const release = packageRelease("package", "1.0.0");
        const metadata = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        store.addSnapshot(metadata);
        const snapshot = store.snapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    snapshots: [snapshot.snapshots[0]!, snapshot.snapshots[0]!]
                })
        ).toThrow(/duplicate metadata snapshots/);
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, revision: -1 }]
                })
        ).toThrow(/metadata revision is malformed/);
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, digest: "" }]
                })
        ).toThrow(/snapshot digest is malformed/);
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, bytes: forged<Uint8Array>("bad") }]
                })
        ).toThrow(/Memory package snapshot metadata snapshot bytes are malformed/);

        const releaseRows = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...releaseRows,
                    releases: [{ ...releaseRows.releases[0]!, packageId: forged<PackageId>("") }]
                })
        ).toThrow(/package ID is malformed/);
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...releaseRows,
                    releases: [{ ...releaseRows.releases[0]!, bytes: forged<Uint8Array>("bad") }]
                })
        ).toThrow(/Memory package snapshot package release bytes are malformed/);
        const lockRows = lockSnapshot();
        expect(
            () =>
                new MemoryPackageStore(recordingCustody(), {
                    ...lockRows,
                    locks: [{ ...lockRows.locks[0]!, snapshotRevision: -1 }]
                })
        ).toThrow(/lock revision is malformed/);
    });
});

function duplicatedReleaseSnapshotBytes(snapshot: MetadataSnapshot): Uint8Array {
    return recordEnvelope(MetadataSnapshot.codec, {
        digest: snapshot.digest.value,
        releases: [...snapshot.releases, ...snapshot.releases].map((release) => release.toData()),
        revision: snapshot.revision.value
    });
}

function reorderedLockBytes(lock: PackageLock): Uint8Array {
    return recordEnvelope(PackageLock.codec, {
        packages: [...lock.packages].reverse().map((pin) => pin.toData()),
        roots: [...lock.roots].reverse().map((root) => root.toData()),
        snapshotDigest: lock.snapshotDigest.value,
        snapshotRevision: lock.snapshotRevision.value,
        target: lock.target.toData()
    });
}

function recordEnvelope(
    codec: {
        readonly kind: string;
        readonly version: { readonly major: number; readonly minor: number };
    },
    payload: JsonValue
): Uint8Array {
    return encodeCanonicalJson({
        kind: codec.kind,
        version: { major: codec.version.major, minor: codec.version.minor },
        payload
    });
}

function releaseSnapshot(): MemoryPackageSnapshot {
    const store = new MemoryPackageStore(recordingCustody());
    store.add(packageRelease("package", "1.0.0"));
    return store.snapshot();
}

function lockSnapshot(): MemoryPackageSnapshot {
    const store = new MemoryPackageStore(recordingCustody());
    store.addLock(packageLock(digestOf("snapshot"), 1, [packageRelease("package", "1.0.0")]));
    return store.snapshot();
}
