import type { Digest, SemVer } from "../core";
import { AgentCoreError } from "../errors";
import { PackageId } from "./id";
import { PackageLock } from "./package-lock";
import { MetadataSnapshot, PackageRelease } from "./package";
import { compareText } from "./order";
import { invalidDefinitionState } from "./error";

export interface StoredPackageRelease {
    readonly packageId: PackageId;
    readonly version: string;
    readonly manifestDigest: string;
    readonly codeDigest: string;
    readonly bytes: Uint8Array;
}

export interface StoredPackageLock {
    readonly lockDigest: string;
    readonly snapshotDigest: string;
    readonly snapshotRevision: number;
    readonly bytes: Uint8Array;
}

export interface StoredMetadataSnapshot {
    readonly digest: string;
    readonly revision: number;
    readonly bytes: Uint8Array;
}

export abstract class PackageStore {
    public abstract add(release: PackageRelease): void;
    public abstract get(id: PackageId, version: SemVer): PackageRelease | undefined;
    public abstract list(id?: PackageId): readonly PackageRelease[];
    public abstract addSnapshot(snapshot: MetadataSnapshot): void;
    public abstract getSnapshot(digest: Digest): MetadataSnapshot | undefined;
    public abstract listSnapshots(): readonly MetadataSnapshot[];
    public abstract addLock(lock: PackageLock): void;
    public abstract getLock(lockDigest: Digest): PackageLock | undefined;
}

export abstract class ProjectedPackageStore extends PackageStore {
    public add(release: PackageRelease): void {
        const bytes = PackageRelease.encode(release);
        const canonical = PackageRelease.decode(bytes);
        const expected = projectRelease(canonical, bytes);
        const stored = this.insertRelease(expected);
        this.decodeRelease(stored, canonical.id, canonical.version);
        if (!equalBytes(stored.bytes, bytes)) {
            throw invalidDefinitionState(
                `Package release ${canonical.id.value}@${canonical.version.toString()} is immutable`
            );
        }
    }

    public get(id: PackageId, version: SemVer): PackageRelease | undefined {
        const stored = this.findRelease(id, version.toString());
        return stored === undefined ? undefined : this.decodeRelease(stored, id, version);
    }

    public list(id?: PackageId): readonly PackageRelease[] {
        const releases = this.listReleases(id)
            .map((stored) => this.decodeRelease(stored, id))
            .sort(compareReleases);
        for (let index = 1; index < releases.length; index += 1) {
            if (releaseKey(releases[index - 1]!) === releaseKey(releases[index]!)) {
                throw corruptPackage("Stored package releases contain a duplicate immutable key");
            }
        }
        return Object.freeze(releases);
    }

    public addSnapshot(snapshot: MetadataSnapshot): void {
        const bytes = MetadataSnapshot.encode(snapshot);
        const canonical = MetadataSnapshot.decode(bytes);
        const expected = projectSnapshot(canonical, bytes);
        const stored = this.insertSnapshot(expected);
        this.decodeSnapshot(stored, canonical.digest);
        if (!equalBytes(stored.bytes, bytes)) {
            throw invalidDefinitionState(
                `Metadata snapshot ${canonical.digest.value} is immutable`
            );
        }
    }

    public getSnapshot(digest: Digest): MetadataSnapshot | undefined {
        const stored = this.findSnapshot(digest.value);
        return stored === undefined ? undefined : this.decodeSnapshot(stored, digest);
    }

    public listSnapshots(): readonly MetadataSnapshot[] {
        const snapshots = this.snapshotRecords()
            .map((stored) => this.decodeSnapshot(stored))
            .sort(
                (left, right) =>
                    left.revision.value - right.revision.value ||
                    compareText(left.digest.value, right.digest.value)
            );
        requireUnique(
            snapshots.map((snapshot) => snapshot.digest.value),
            "Stored metadata snapshots contain a duplicate immutable key"
        );
        return Object.freeze(snapshots);
    }

    public addLock(lock: PackageLock): void {
        const bytes = PackageLock.encode(lock);
        const canonical = PackageLock.decode(bytes);
        const expected = projectLock(canonical, bytes);
        const stored = this.insertLock(expected);
        this.decodeLock(stored, canonical.digest);
        if (!equalBytes(stored.bytes, bytes)) {
            throw invalidDefinitionState(`Package lock ${canonical.digest.value} is immutable`);
        }
    }

    public getLock(lockDigest: Digest): PackageLock | undefined {
        const stored = this.findLock(lockDigest.value);
        return stored === undefined ? undefined : this.decodeLock(stored, lockDigest);
    }

    protected abstract findRelease(
        packageId: PackageId,
        version: string
    ): StoredPackageRelease | undefined;

    protected abstract listReleases(packageId?: PackageId): readonly StoredPackageRelease[];

    protected abstract insertRelease(release: StoredPackageRelease): StoredPackageRelease;

    protected abstract findSnapshot(digest: string): StoredMetadataSnapshot | undefined;

    protected abstract snapshotRecords(): readonly StoredMetadataSnapshot[];

    protected abstract insertSnapshot(snapshot: StoredMetadataSnapshot): StoredMetadataSnapshot;

    protected abstract findLock(lockDigest: string): StoredPackageLock | undefined;

    protected abstract insertLock(lock: StoredPackageLock): StoredPackageLock;

    private decodeRelease(
        stored: StoredPackageRelease,
        expectedId?: PackageId,
        expectedVersion?: SemVer
    ): PackageRelease {
        const bytes = copyBytes(stored.bytes, "package release");
        const release = PackageRelease.decode(bytes);
        const projection = projectRelease(release, bytes);
        if (
            !stored.packageId.equals(projection.packageId) ||
            stored.version !== projection.version ||
            stored.manifestDigest !== projection.manifestDigest ||
            stored.codeDigest !== projection.codeDigest ||
            (expectedId !== undefined && !release.id.equals(expectedId)) ||
            (expectedVersion !== undefined &&
                release.version.toString() !== expectedVersion.toString())
        ) {
            throw corruptPackage(
                "Stored package release key or projection does not match its codec bytes"
            );
        }
        return release;
    }

    private decodeSnapshot(
        stored: StoredMetadataSnapshot,
        expectedDigest?: Digest
    ): MetadataSnapshot {
        const bytes = copyBytes(stored.bytes, "metadata snapshot");
        const snapshot = MetadataSnapshot.decode(bytes);
        const projection = projectSnapshot(snapshot, bytes);
        if (
            stored.digest !== projection.digest ||
            stored.revision !== projection.revision ||
            (expectedDigest !== undefined && !snapshot.digest.equals(expectedDigest))
        ) {
            throw corruptPackage(
                "Stored metadata snapshot key or projection does not match codec bytes"
            );
        }
        return snapshot;
    }

    private decodeLock(stored: StoredPackageLock, expectedDigest: Digest): PackageLock {
        const bytes = copyBytes(stored.bytes, "package lock");
        const lock = PackageLock.decode(bytes);
        const projection = projectLock(lock, bytes);
        if (
            stored.lockDigest !== projection.lockDigest ||
            stored.snapshotDigest !== projection.snapshotDigest ||
            stored.snapshotRevision !== projection.snapshotRevision ||
            !lock.digest.equals(expectedDigest)
        ) {
            throw corruptPackage(
                "Stored package lock key or projection does not match its codec bytes"
            );
        }
        return lock;
    }
}

function projectSnapshot(snapshot: MetadataSnapshot, bytes: Uint8Array): StoredMetadataSnapshot {
    return {
        digest: snapshot.digest.value,
        revision: snapshot.revision.value,
        bytes: bytes.slice()
    };
}

function projectRelease(release: PackageRelease, bytes: Uint8Array): StoredPackageRelease {
    return {
        packageId: new PackageId(release.id.value),
        version: release.version.toString(),
        manifestDigest: release.manifestDigest.value,
        codeDigest: release.codeDigest.value,
        bytes: bytes.slice()
    };
}

function projectLock(lock: PackageLock, bytes: Uint8Array): StoredPackageLock {
    return {
        lockDigest: lock.digest.value,
        snapshotDigest: lock.snapshotDigest.value,
        snapshotRevision: lock.snapshotRevision.value,
        bytes: bytes.slice()
    };
}

function compareReleases(left: PackageRelease, right: PackageRelease): number {
    return (
        compareText(left.id.value, right.id.value) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function releaseKey(release: PackageRelease): string {
    return `${release.id.value}\0${release.version.toString()}`;
}

function requireUnique(values: readonly string[], message: string): void {
    if (new Set(values).size !== values.length) throw corruptPackage(message);
}

function copyBytes(bytes: Uint8Array, subject: string): Uint8Array {
    if (!(bytes instanceof Uint8Array)) {
        throw corruptPackage(`Stored ${subject} bytes are malformed`);
    }
    return bytes.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corruptPackage(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
