// @ts-nocheck
import { describe, expect, test } from "vitest";
import { Revision, SemVer } from "../../src/core";
import { PackageId, PackageLock, PackageRelease } from "../../src/definition";
import {
    ProjectedPackageStore,
    type StoredMetadataSnapshot,
    type StoredPackageLock,
    type StoredPackageRelease
} from "../../src/definition/package-store";
import { digestOf, packageLock, packageRelease } from "./package-store-contract";
import { MetadataSnapshot } from "../../src/definition/package";

describe("ProjectedPackageStore hostile adapter boundaries", () => {
    test("rejects duplicate listed releases and snapshots", () => {
        const store = new HostilePackageStore();
        const release = packageRelease("package", "1.0.0");
        store.add(release);
        store.duplicateReleases = true;
        expect(() => store.list()).toThrow(/duplicate immutable key/);

        store.duplicateReleases = false;
        const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        store.addSnapshot(snapshot);
        store.duplicateSnapshots = true;
        expect(() => store.listSnapshots()).toThrow(/duplicate immutable key/);
    });

    test("rejects adapter substitutions for immutable release snapshot and lock writes", () => {
        const release = packageRelease("package", "1.0.0");
        const other = packageRelease("package", "1.0.0", digestOf("other-code"));
        const releaseStore = new HostilePackageStore();
        releaseStore.releaseWrite = rowForRelease(other);
        expect(() => releaseStore.add(release)).toThrow(/immutable|projection/);

        const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        const otherSnapshot = new MetadataSnapshot({
            revision: new Revision(2),
            releases: [release]
        });
        const snapshotStore = new HostilePackageStore();
        snapshotStore.snapshotWrite = rowForSnapshot(otherSnapshot);
        expect(() => snapshotStore.addSnapshot(snapshot)).toThrow(/immutable|projection/);

        const lock = packageLock(snapshot.digest, 1, [release]);
        const otherLock = packageLock(digestOf("other-snapshot"), 2, [release]);
        const lockStore = new HostilePackageStore();
        lockStore.lockWrite = rowForLock(otherLock);
        expect(() => lockStore.addLock(lock)).toThrow(/immutable|projection/);
    });

    test("rejects lookup aliases and malformed stored bytes", () => {
        const store = new HostilePackageStore();
        const release = packageRelease("package", "1.0.0");
        store.add(release);
        store.releaseAlias = rowForRelease(release);
        expect(() => store.get(new PackageId("alias"), new SemVer("1.0.0"))).toThrow(
            /key or projection/
        );

        const malformed = new HostilePackageStore();
        malformed.releaseAlias = { ...rowForRelease(release), bytes: "bad" as never };
        expect(() => malformed.get(new PackageId("alias"), new SemVer("1.0.0"))).toThrow(
            /bytes are malformed/
        );
        expect(malformed.getLock(digestOf("missing"))).toBeUndefined();
    });
});

class HostilePackageStore extends ProjectedPackageStore {
    readonly releases: StoredPackageRelease[] = [];
    readonly snapshots: StoredMetadataSnapshot[] = [];
    readonly locks: StoredPackageLock[] = [];
    public duplicateReleases = false;
    public duplicateSnapshots = false;
    public releaseWrite: StoredPackageRelease | undefined;
    public snapshotWrite: StoredMetadataSnapshot | undefined;
    public lockWrite: StoredPackageLock | undefined;
    public releaseAlias: StoredPackageRelease | undefined;

    protected findRelease(packageId: PackageId, version: string): StoredPackageRelease | undefined {
        if (packageId.value === "alias") return this.releaseAlias;
        return this.releases.find(
            (row) => row.packageId.equals(packageId) && row.version === version
        );
    }

    protected listReleases(): readonly StoredPackageRelease[] {
        return this.duplicateReleases && this.releases[0] !== undefined
            ? [this.releases[0], this.releases[0]]
            : this.releases;
    }

    protected insertRelease(release: StoredPackageRelease): StoredPackageRelease {
        const row = this.releaseWrite ?? release;
        this.releases.push(row);
        return row;
    }

    protected findSnapshot(digest: string): StoredMetadataSnapshot | undefined {
        return this.snapshots.find((row) => row.digest === digest);
    }

    protected snapshotRecords(): readonly StoredMetadataSnapshot[] {
        return this.duplicateSnapshots && this.snapshots[0] !== undefined
            ? [this.snapshots[0], this.snapshots[0]]
            : this.snapshots;
    }

    protected insertSnapshot(snapshot: StoredMetadataSnapshot): StoredMetadataSnapshot {
        const row = this.snapshotWrite ?? snapshot;
        this.snapshots.push(row);
        return row;
    }

    protected findLock(lockDigest: string): StoredPackageLock | undefined {
        return this.locks.find((row) => row.lockDigest === lockDigest);
    }

    protected insertLock(lock: StoredPackageLock): StoredPackageLock {
        const row = this.lockWrite ?? lock;
        this.locks.push(row);
        return row;
    }
}

function rowForRelease(release: ReturnType<typeof packageRelease>): StoredPackageRelease {
    return {
        packageId: new PackageId(release.id.value),
        version: release.version.toString(),
        manifestDigest: release.manifestDigest.value,
        codeDigest: release.codeDigest.value,
        bytes: PackageRelease.encode(release)
    };
}

function rowForSnapshot(snapshot: MetadataSnapshot): StoredMetadataSnapshot {
    return {
        digest: snapshot.digest.value,
        revision: snapshot.revision.value,
        bytes: MetadataSnapshot.encode(snapshot)
    };
}

function rowForLock(lock: ReturnType<typeof packageLock>): StoredPackageLock {
    return {
        lockDigest: lock.digest.value,
        snapshotDigest: lock.snapshotDigest.value,
        snapshotRevision: lock.snapshotRevision.value,
        bytes: PackageLock.encode(lock)
    };
}
