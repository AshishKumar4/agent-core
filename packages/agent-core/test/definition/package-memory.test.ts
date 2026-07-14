import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { MemoryPackageStore, type MemoryPackageSnapshot } from "../../src/definition/memory";
import { PackageLock } from "../../src/definition/package-lock";
import { PackageId } from "../../src/definition/id";
import { MetadataSnapshot, PackageRelease } from "../../src/definition/package";
import { SqlitePackageStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    digestOf,
    packageLock,
    packageRelease,
    packageStoreContract
} from "./package-store-contract";

packageStoreContract("memory", () => new MemoryPackageStore());

test("[package-store] memory and SQLite satisfy one shared codec-storage contract", () => {
    const stores = [new MemoryPackageStore(), new SqlitePackageStore(new TestSqlite())];
    for (const [index, store] of stores.entries()) {
        const value = packageRelease(`seam-${index}`, "1.0.0");
        store.add(value);
        expect(store.get(value.id, value.version)?.codeDigest.equals(value.codeDigest)).toBe(true);
    }
});

describe("MemoryPackageStore persistence", () => {
    test("[definition.package-release] [definition.metadata-snapshot] [definition.package-lock] restores releases, snapshots, and locks from a detached sorted snapshot", () => {
        const store = new MemoryPackageStore();
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

        const restored = new MemoryPackageStore(store.snapshot());
        const cloned = restored.clone();
        expect(cloned.list().map((release) => release.id.value)).toEqual(["alpha", "zeta"]);
        expect(PackageLock.encode(cloned.getLock(lock.digest)!)).toEqual(PackageLock.encode(lock));
    });

    test.each(["packageId", "version", "manifestDigest", "codeDigest"] as const)(
        "rejects a snapshot with a corrupt release %s projection",
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

            expect(() => new MemoryPackageStore(corrupted)).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects malformed release codec bytes in a snapshot", () => {
        const snapshot = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...snapshot,
                    releases: [{ ...snapshot.releases[0]!, bytes: new Uint8Array([0]) }]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test.each(["lockDigest", "snapshotDigest", "snapshotRevision"] as const)(
        "rejects a snapshot with a corrupt lock %s projection",
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

            expect(() => new MemoryPackageStore(corrupted)).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects malformed lock codec bytes and duplicate immutable keys", () => {
        const release = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...release,
                    releases: [release.releases[0]!, release.releases[0]!]
                })
        ).toThrow(/duplicate releases/);

        const lock = lockSnapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...lock,
                    locks: [lock.locks[0]!, lock.locks[0]!]
                })
        ).toThrow(/duplicate locks/);
        expect(
            () =>
                new MemoryPackageStore({
                    ...lock,
                    locks: [{ ...lock.locks[0]!, bytes: new Uint8Array([0]) }]
                })
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test("rejects duplicate snapshots and malformed snapshot scalar and byte fields", () => {
        const store = new MemoryPackageStore();
        const release = packageRelease("package", "1.0.0");
        const metadata = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        store.addSnapshot(metadata);
        const snapshot = store.snapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...snapshot,
                    snapshots: [snapshot.snapshots[0]!, snapshot.snapshots[0]!]
                })
        ).toThrow(/duplicate metadata snapshots/);
        expect(
            () =>
                new MemoryPackageStore({
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, revision: -1 }]
                })
        ).toThrow(/metadata revision is malformed/);
        expect(
            () =>
                new MemoryPackageStore({
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, digest: "" }]
                })
        ).toThrow(/snapshot digest is malformed/);
        expect(
            () =>
                new MemoryPackageStore({
                    ...snapshot,
                    snapshots: [{ ...snapshot.snapshots[0]!, bytes: "bad" as never }]
                })
        ).toThrow(/bytes are malformed/);

        const releaseRows = releaseSnapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...releaseRows,
                    releases: [{ ...releaseRows.releases[0]!, packageId: "" as never }]
                })
        ).toThrow(/package ID is malformed/);
        expect(
            () =>
                new MemoryPackageStore({
                    ...releaseRows,
                    releases: [{ ...releaseRows.releases[0]!, bytes: "bad" as never }]
                })
        ).toThrow(/bytes are malformed/);
        const lockRows = lockSnapshot();
        expect(
            () =>
                new MemoryPackageStore({
                    ...lockRows,
                    locks: [{ ...lockRows.locks[0]!, snapshotRevision: -1 }]
                })
        ).toThrow(/lock revision is malformed/);
    });
});

function releaseSnapshot(): MemoryPackageSnapshot {
    const store = new MemoryPackageStore();
    store.add(packageRelease("package", "1.0.0"));
    return store.snapshot();
}

function lockSnapshot(): MemoryPackageSnapshot {
    const store = new MemoryPackageStore();
    store.addLock(packageLock(digestOf("snapshot"), 1, [packageRelease("package", "1.0.0")]));
    return store.snapshot();
}
