import { Digest, SemVer } from "../../core";
import { MetadataSnapshot, PackageId, PackageLock, PackageRelease } from "../../definition";
import { AgentCoreError } from "../../errors";
import type { SqliteRow } from "./sqlite";
import { TransactionalSqlite } from "./sqlite";

const CREATE_RELEASES = `CREATE TABLE IF NOT EXISTS definition_package_releases (
    package_id TEXT NOT NULL CHECK (length(package_id) > 0),
    version TEXT NOT NULL CHECK (length(version) > 0),
    manifest_digest TEXT NOT NULL CHECK (
        length(manifest_digest) = 64
        AND manifest_digest NOT GLOB '*[^0-9a-f]*'
    ),
    code_digest TEXT NOT NULL CHECK (
        length(code_digest) = 64
        AND code_digest NOT GLOB '*[^0-9a-f]*'
    ),
    record BLOB NOT NULL,
    PRIMARY KEY (package_id, version)
) STRICT`;

const CREATE_SNAPSHOTS = `CREATE TABLE IF NOT EXISTS definition_metadata_snapshots (
    digest TEXT PRIMARY KEY CHECK (
        length(digest) = 64
        AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_LOCKS = `CREATE TABLE IF NOT EXISTS definition_package_locks (
    lock_digest TEXT PRIMARY KEY CHECK (
        length(lock_digest) = 64
        AND lock_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_digest TEXT NOT NULL CHECK (
        length(snapshot_digest) = 64
        AND snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
    record BLOB NOT NULL
) STRICT`;

interface StoredPackageRelease {
    readonly packageId: PackageId;
    readonly version: string;
    readonly manifestDigest: string;
    readonly codeDigest: string;
    readonly bytes: Uint8Array;
}

interface StoredPackageLock {
    readonly lockDigest: string;
    readonly snapshotDigest: string;
    readonly snapshotRevision: number;
    readonly bytes: Uint8Array;
}

interface StoredMetadataSnapshot {
    readonly digest: string;
    readonly revision: number;
    readonly bytes: Uint8Array;
}

export class SqlitePackageStore {
    public constructor(private readonly database: TransactionalSqlite) {
        database.transaction(() => {
            database.run(CREATE_RELEASES, []);
            database.run(CREATE_SNAPSHOTS, []);
            database.run(CREATE_LOCKS, []);
        });
    }

    public add(release: PackageRelease): void {
        const candidateBytes = PackageRelease.encode(release);
        const candidate = PackageRelease.decode(candidateBytes);
        const stored = this.database.transaction(() => {
            this.database.run(
                `INSERT OR IGNORE INTO definition_package_releases (
                    package_id, version, manifest_digest, code_digest, record
                 ) VALUES (?, ?, ?, ?, ?)`,
                [
                    candidate.id.value,
                    candidate.version.toString(),
                    candidate.manifestDigest.value,
                    candidate.codeDigest.value,
                    candidateBytes
                ]
            );
            return this.findRelease(candidate.id, candidate.version.toString());
        });
        if (stored === undefined) {
            throw corruptPackage("Package release insert did not produce a durable row");
        }
        this.decodeRelease(stored, candidate.id, candidate.version);
        if (!equalBytes(stored.bytes, candidateBytes)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Package release ${candidate.id.value}@${candidate.version.toString()} is immutable`
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
        const candidateBytes = MetadataSnapshot.encode(snapshot);
        const candidate = MetadataSnapshot.decode(candidateBytes);
        const stored = this.database.transaction(() => {
            this.database.run(
                `INSERT OR IGNORE INTO definition_metadata_snapshots (digest, revision, record)
                 VALUES (?, ?, ?)`,
                [candidate.digest.value, candidate.revision.value, candidateBytes]
            );
            return this.findSnapshot(candidate.digest.value);
        });
        if (stored === undefined) {
            throw corruptPackage("Metadata snapshot insert did not produce a durable row");
        }
        this.decodeSnapshot(stored, candidate.digest);
        if (!equalBytes(stored.bytes, candidateBytes)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Metadata snapshot ${candidate.digest.value} is immutable`
            );
        }
    }

    public getSnapshot(digest: Digest): MetadataSnapshot | undefined {
        const stored = this.findSnapshot(digest.value);
        return stored === undefined ? undefined : this.decodeSnapshot(stored, digest);
    }

    public listSnapshots(): readonly MetadataSnapshot[] {
        return Object.freeze(
            this.database
                .all(
                    `SELECT digest, revision, record FROM definition_metadata_snapshots
             ORDER BY revision, digest`,
                    []
                )
                .map(storedSnapshot)
                .map((stored) => this.decodeSnapshot(stored))
        );
    }

    public addLock(lock: PackageLock): void {
        const candidateBytes = PackageLock.encode(lock);
        const candidate = PackageLock.decode(candidateBytes);
        const stored = this.database.transaction(() => {
            this.database.run(
                `INSERT OR IGNORE INTO definition_package_locks (
                    lock_digest, snapshot_digest, snapshot_revision, record
                 ) VALUES (?, ?, ?, ?)`,
                [
                    candidate.digest.value,
                    candidate.snapshotDigest.value,
                    candidate.snapshotRevision.value,
                    candidateBytes
                ]
            );
            return this.findLock(candidate.digest.value);
        });
        if (stored === undefined) {
            throw corruptPackage("Package lock insert did not produce a durable row");
        }
        this.decodeLock(stored, candidate.digest);
        if (!equalBytes(stored.bytes, candidateBytes)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Package lock ${candidate.digest.value} is immutable`
            );
        }
    }

    public getLock(lockDigest: Digest): PackageLock | undefined {
        const stored = this.findLock(lockDigest.value);
        return stored === undefined ? undefined : this.decodeLock(stored, lockDigest);
    }

    private findRelease(packageId: PackageId, version: string): StoredPackageRelease | undefined {
        const row = this.database.all(
            `SELECT package_id, version, manifest_digest, code_digest, record
             FROM definition_package_releases
             WHERE package_id = ? AND version = ?`,
            [packageId.value, version]
        )[0];
        return row === undefined ? undefined : storedRelease(row);
    }

    private listReleases(packageId?: PackageId): readonly StoredPackageRelease[] {
        const rows =
            packageId === undefined
                ? this.database.all(
                      `SELECT package_id, version, manifest_digest, code_digest, record
                 FROM definition_package_releases
                 ORDER BY package_id, version`,
                      []
                  )
                : this.database.all(
                      `SELECT package_id, version, manifest_digest, code_digest, record
                 FROM definition_package_releases
                 WHERE package_id = ?
                 ORDER BY package_id, version`,
                      [packageId.value]
                  );
        return rows.map(storedRelease);
    }

    private findSnapshot(digest: string): StoredMetadataSnapshot | undefined {
        const row = this.database.all(
            `SELECT digest, revision, record FROM definition_metadata_snapshots WHERE digest = ?`,
            [digest]
        )[0];
        return row === undefined ? undefined : storedSnapshot(row);
    }

    private findLock(lockDigest: string): StoredPackageLock | undefined {
        const row = this.database.all(
            `SELECT lock_digest, snapshot_digest, snapshot_revision, record
             FROM definition_package_locks
             WHERE lock_digest = ?`,
            [lockDigest]
        )[0];
        return row === undefined ? undefined : storedLock(row);
    }

    private decodeSnapshot(
        stored: StoredMetadataSnapshot,
        expectedDigest?: Digest
    ): MetadataSnapshot {
        const snapshot = MetadataSnapshot.decode(stored.bytes.slice());
        if (
            stored.digest !== snapshot.digest.value ||
            stored.revision !== snapshot.revision.value ||
            (expectedDigest !== undefined && !snapshot.digest.equals(expectedDigest))
        ) {
            throw corruptPackage(
                "Stored metadata snapshot key or projection does not match codec bytes"
            );
        }
        return snapshot;
    }

    private decodeRelease(
        stored: StoredPackageRelease,
        expectedId?: PackageId,
        expectedVersion?: SemVer
    ): PackageRelease {
        const release = PackageRelease.decode(stored.bytes.slice());
        if (
            !stored.packageId.equals(release.id) ||
            stored.version !== release.version.toString() ||
            stored.manifestDigest !== release.manifestDigest.value ||
            stored.codeDigest !== release.codeDigest.value ||
            (expectedId !== undefined && !release.id.equals(expectedId)) ||
            (expectedVersion !== undefined && !release.version.equals(expectedVersion))
        ) {
            throw corruptPackage(
                "Stored package release key or projection does not match its codec bytes"
            );
        }
        return release;
    }

    private decodeLock(stored: StoredPackageLock, expectedDigest: Digest): PackageLock {
        const lock = PackageLock.decode(stored.bytes.slice());
        if (
            stored.lockDigest !== lock.digest.value ||
            stored.snapshotDigest !== lock.snapshotDigest.value ||
            stored.snapshotRevision !== lock.snapshotRevision.value ||
            !lock.digest.equals(expectedDigest)
        ) {
            throw corruptPackage(
                "Stored package lock key or projection does not match its codec bytes"
            );
        }
        return lock;
    }
}

function storedRelease(row: SqliteRow): StoredPackageRelease {
    return {
        packageId: new PackageId(text(row, "package_id")),
        version: text(row, "version"),
        manifestDigest: text(row, "manifest_digest"),
        codeDigest: text(row, "code_digest"),
        bytes: bytes(row, "record")
    };
}

function storedLock(row: SqliteRow): StoredPackageLock {
    return {
        lockDigest: text(row, "lock_digest"),
        snapshotDigest: text(row, "snapshot_digest"),
        snapshotRevision: integer(row, "snapshot_revision"),
        bytes: bytes(row, "record")
    };
}

function storedSnapshot(row: SqliteRow): StoredMetadataSnapshot {
    return {
        digest: text(row, "digest"),
        revision: integer(row, "revision"),
        bytes: bytes(row, "record")
    };
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) {
        throw corruptPackage(`Stored package ${column} projection is malformed`);
    }
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptPackage(`Stored package ${column} projection is malformed`);
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) {
        throw corruptPackage(`Stored package ${column} bytes are malformed`);
    }
    return value.slice();
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

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corruptPackage(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
