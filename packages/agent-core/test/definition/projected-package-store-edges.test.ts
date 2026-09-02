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
import { forged } from "./record-data";
import { recordingCustody } from "../helpers/custody";

describe("ProjectedPackageStore hostile adapter boundaries", () => {
    test("rejects duplicate listed releases and snapshots", { tags: "p1" }, () => {
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

    test(
        "rejects adapter substitutions for immutable release snapshot and lock writes",
        { tags: "p0" },
        () => {
            const release = packageRelease("package", "1.0.0");
            const other = packageRelease("package", "1.0.0", digestOf("other-code"));
            const releaseStore = new HostilePackageStore();
            releaseStore.releaseWrite = rowForRelease(other);
            expect(() => releaseStore.add(release)).toThrow(/immutable|projection/);

            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
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
        }
    );

    test("rejects lookup aliases and malformed stored bytes", { tags: "p1" }, () => {
        const store = new HostilePackageStore();
        const release = packageRelease("package", "1.0.0");
        store.add(release);
        store.releaseAlias = rowForRelease(release);
        expect(() => store.get(new PackageId("alias"), new SemVer("1.0.0"))).toThrow(
            /key or projection/
        );

        const malformed = new HostilePackageStore();
        malformed.releaseAlias = { ...rowForRelease(release), bytes: forged<Uint8Array>("bad") };
        expect(() => malformed.get(new PackageId("alias"), new SemVer("1.0.0"))).toThrow(
            /Stored package release bytes are malformed/
        );
        expect(malformed.getLock(digestOf("missing"))).toBeUndefined();
    });

    test("validates stored release keys against their codec bytes", { tags: "p1" }, () => {
        const release = packageRelease("package", "1.0.0");

        const mangledId = new HostilePackageStore();
        mangledId.releases.push({ ...rowForRelease(release), packageId: new PackageId("wrong") });
        expect(() => mangledId.list()).toThrow(/key or projection/);

        const mangledVersion = new HostilePackageStore();
        mangledVersion.releases.push({ ...rowForRelease(release), version: "9.9.9" });
        expect(() => mangledVersion.list()).toThrow(/key or projection/);

        const versionBlind = new HostilePackageStore();
        versionBlind.add(release);
        versionBlind.versionBlind = true;
        expect(() => versionBlind.get(release.id, new SemVer("9.9.9"))).toThrow(
            /key or projection/
        );
    });

    test(
        "validates snapshot and lock projections against requested digests",
        { tags: "p1" },
        () => {
            const release = packageRelease("package", "1.0.0");
            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
            const other = new MetadataSnapshot({ revision: new Revision(2), releases: [release] });

            const mangledDigest = new HostilePackageStore();
            mangledDigest.snapshots.push({
                ...rowForSnapshot(snapshot),
                digest: digestOf("mangled").value
            });
            expect(() => mangledDigest.listSnapshots()).toThrow(/key or projection/);

            const mangledRevision = new HostilePackageStore();
            mangledRevision.snapshots.push({ ...rowForSnapshot(snapshot), revision: 9 });
            expect(() => mangledRevision.listSnapshots()).toThrow(/key or projection/);

            const aliasedSnapshot = new HostilePackageStore();
            aliasedSnapshot.snapshotAlias = rowForSnapshot(other);
            expect(() => aliasedSnapshot.getSnapshot(snapshot.digest)).toThrow(/key or projection/);

            const lock = packageLock(snapshot.digest, 1, [release]);
            const aliasedLock = new HostilePackageStore();
            aliasedLock.lockAlias = { ...rowForLock(lock), lockDigest: digestOf("mangled").value };
            expect(() => aliasedLock.getLock(lock.digest)).toThrow(/key or projection/);
        }
    );

    test(
        "keeps stored codec bytes independent of adapter-scribbled projection buffers",
        { tags: "p0" },
        () => {
            // kills src/definition/package-store.ts:205,215,224 (projection defensive byte copies)
            const store = new ScribblingPackageStore();
            const release = packageRelease("scribble", "1.0.0");
            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
            const lock = packageLock(snapshot.digest, 1, [release]);

            store.add(release);
            store.addSnapshot(snapshot);
            store.addLock(lock);

            expect(PackageRelease.encode(store.get(release.id, release.version)!)).toEqual(
                PackageRelease.encode(release)
            );
            expect(MetadataSnapshot.encode(store.getSnapshot(snapshot.digest)!)).toEqual(
                MetadataSnapshot.encode(snapshot)
            );
            expect(PackageLock.encode(store.getLock(lock.digest)!)).toEqual(
                PackageLock.encode(lock)
            );
        }
    );

    test("names malformed stored snapshot and lock bytes exactly", { tags: "p2" }, () => {
        const release = packageRelease("package", "1.0.0");
        const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        const snapshotStore = new HostilePackageStore();
        snapshotStore.snapshotWrite = {
            ...rowForSnapshot(snapshot),
            bytes: forged<Uint8Array>("bad")
        };
        expect(() => snapshotStore.addSnapshot(snapshot)).toThrow(
            /Stored metadata snapshot bytes are malformed/
        );

        const lock = packageLock(snapshot.digest, 1, [release]);
        const lockStore = new HostilePackageStore();
        lockStore.lockWrite = { ...rowForLock(lock), bytes: forged<Uint8Array>("bad") };
        expect(() => lockStore.addLock(lock)).toThrow(/Stored package lock bytes are malformed/);
    });
});

class HostilePackageStore extends ProjectedPackageStore {
    public constructor() {
        super(recordingCustody());
    }

    readonly releases: StoredPackageRelease[] = [];
    readonly snapshots: StoredMetadataSnapshot[] = [];
    readonly locks: StoredPackageLock[] = [];
    public duplicateReleases = false;
    public duplicateSnapshots = false;
    public releaseWrite: StoredPackageRelease | undefined;
    public snapshotWrite: StoredMetadataSnapshot | undefined;
    public lockWrite: StoredPackageLock | undefined;
    public releaseAlias: StoredPackageRelease | undefined;
    public snapshotAlias: StoredMetadataSnapshot | undefined;
    public lockAlias: StoredPackageLock | undefined;
    public versionBlind = false;

    protected findRelease(packageId: PackageId, version: string): StoredPackageRelease | undefined {
        if (packageId.value === "alias") return this.releaseAlias;
        if (this.versionBlind) return this.releases[0];
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
        if (this.snapshotAlias !== undefined) return this.snapshotAlias;
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
        if (this.lockAlias !== undefined) return this.lockAlias;
        return this.locks.find((row) => row.lockDigest === lockDigest);
    }

    protected insertLock(lock: StoredPackageLock): StoredPackageLock {
        const row = this.lockWrite ?? lock;
        this.locks.push(row);
        return row;
    }
}

class ScribblingPackageStore extends HostilePackageStore {
    protected override insertRelease(release: StoredPackageRelease): StoredPackageRelease {
        return super.insertRelease(scribbled(release));
    }

    protected override insertSnapshot(snapshot: StoredMetadataSnapshot): StoredMetadataSnapshot {
        return super.insertSnapshot(scribbled(snapshot));
    }

    protected override insertLock(lock: StoredPackageLock): StoredPackageLock {
        return super.insertLock(scribbled(lock));
    }
}

function scribbled<Row extends { readonly bytes: Uint8Array }>(row: Row): Row {
    const detached = { ...row, bytes: row.bytes.slice() };
    row.bytes.fill(0);
    return detached;
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
