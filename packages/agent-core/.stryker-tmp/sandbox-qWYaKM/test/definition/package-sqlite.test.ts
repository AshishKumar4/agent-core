// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { Digest, Revision } from "../../src/core";
import { PackageId } from "../../src/definition/id";
import { PackageLock } from "../../src/definition/package-lock";
import { MetadataSnapshot, PackageRelease } from "../../src/definition/package";
import {
    SqlitePackageStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    digestOf,
    packageLock,
    packageRelease,
    packageStoreContract
} from "./package-store-contract";

packageStoreContract("SQLite", () => new SqlitePackageStore(new TestSqlite()));

describe("SqlitePackageStore persistence", () => {
    test("survives adapter recreation over the same database", () => {
        const database = new TestSqlite();
        const release = packageRelease("package", "1.0.0");
        const metadata = new MetadataSnapshot({ revision: new Revision(2), releases: [release] });
        const lock = packageLock(metadata.digest, metadata.revision.value, [release]);
        const first = new SqlitePackageStore(database);
        first.add(release);
        first.addSnapshot(metadata);
        first.addLock(lock);

        const restarted = new SqlitePackageStore(database);
        expect(PackageRelease.encode(restarted.get(release.id, release.version)!)).toEqual(
            PackageRelease.encode(release)
        );
        expect(MetadataSnapshot.encode(restarted.getSnapshot(metadata.digest)!)).toEqual(
            MetadataSnapshot.encode(metadata)
        );
        expect(PackageLock.encode(restarted.getLock(lock.digest)!)).toEqual(
            PackageLock.encode(lock)
        );
    });

    test("survives closing and reopening a file-backed database", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-package-"));
        const path = join(directory, "packages.sqlite");
        const release = packageRelease("durable", "1.0.0+build");
        const digest = digestOf("durable-snapshot");
        const lock = packageLock(digest, 9, [release]);
        try {
            const firstDatabase = new FileSqlite(path);
            const first = new SqlitePackageStore(firstDatabase);
            first.add(release);
            first.addLock(lock);
            firstDatabase.close();

            const reopenedDatabase = new FileSqlite(path);
            const reopened = new SqlitePackageStore(reopenedDatabase);
            expect(PackageRelease.encode(reopened.get(release.id, release.version)!)).toEqual(
                PackageRelease.encode(release)
            );
            expect(PackageLock.encode(reopened.getLock(lock.digest)!)).toEqual(
                PackageLock.encode(lock)
            );
            reopenedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("uses strict tables and stores the authoritative codec bytes", () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const release = packageRelease("package", "1.0.0");
        const metadata = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        const lock = packageLock(metadata.digest, metadata.revision.value, [release]);
        store.add(release);
        store.addSnapshot(metadata);
        store.addLock(lock);

        const tables = database.all(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name IN (
                 'definition_metadata_snapshots',
                 'definition_package_locks',
                 'definition_package_releases'
             )
             ORDER BY name`,
            []
        );
        expect(tables).toHaveLength(3);
        expect(tables.map((row) => row["sql"])).toEqual(
            tables.map(() => expect.stringMatching(/STRICT$/))
        );
        expect(
            database.all("SELECT record FROM definition_package_releases", [])[0]?.["record"]
        ).toEqual(PackageRelease.encode(release));
        expect(
            database.all("SELECT record FROM definition_metadata_snapshots", [])[0]?.["record"]
        ).toEqual(MetadataSnapshot.encode(metadata));
        expect(
            database.all("SELECT record FROM definition_package_locks", [])[0]?.["record"]
        ).toEqual(PackageLock.encode(lock));
    });

    test.each(["package_id", "version", "manifest_digest", "code_digest"] as const)(
        "rejects a corrupt release %s projection",
        (projection) => {
            const database = new TestSqlite();
            const store = new SqlitePackageStore(database);
            const release = packageRelease("package", "1.0.0");
            store.add(release);
            const value =
                projection === "package_id"
                    ? "other"
                    : projection === "version"
                      ? "2.0.0"
                      : "0".repeat(64);
            database.run(`UPDATE definition_package_releases SET ${projection} = ?`, [value]);

            expect(() => store.list()).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects corrupt release codec bytes", () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const release = packageRelease("package", "1.0.0");
        store.add(release);
        database.run("UPDATE definition_package_releases SET record = ?", [new Uint8Array([0])]);

        expect(() => store.get(new PackageId("package"), release.version)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test.each(["lock_digest", "snapshot_digest", "snapshot_revision"] as const)(
        "rejects a corrupt lock %s projection",
        (projection) => {
            const database = new TestSqlite();
            const store = new SqlitePackageStore(database);
            const digest = digestOf("snapshot");
            const lock = packageLock(digest, 1, [packageRelease("package", "1.0.0")]);
            store.addLock(lock);
            const value =
                projection === "snapshot_revision"
                    ? 2
                    : digestOf(projection === "lock_digest" ? "other-lock" : "other").value;
            database.run(`UPDATE definition_package_locks SET ${projection} = ?`, [value]);

            expect(() =>
                store.getLock(
                    projection === "lock_digest" ? new Digest(value as string) : lock.digest
                )
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        }
    );

    test("rejects corrupt lock codec bytes", () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const digest = digestOf("snapshot");
        const lock = packageLock(digest, 1, []);
        store.addLock(lock);
        database.run("UPDATE definition_package_locks SET record = ?", [new Uint8Array([0])]);

        expect(() => store.getLock(lock.digest)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test.each(["digest", "revision", "record"] as const)(
        "rejects a corrupt metadata snapshot %s projection",
        (projection) => {
            const database = new TestSqlite();
            const store = new SqlitePackageStore(database);
            const release = packageRelease("package", "1.0.0");
            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
            store.addSnapshot(snapshot);
            const value =
                projection === "digest"
                    ? digestOf("other").value
                    : projection === "revision"
                      ? 2
                      : new Uint8Array([0]);
            database.run(`UPDATE definition_metadata_snapshots SET ${projection} = ?`, [value]);
            expect(() => store.listSnapshots()).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );

    test("rejects malformed SQLite projection scalar types", () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const release = packageRelease("package", "1.0.0");
        const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        store.add(release);
        store.addSnapshot(snapshot);
        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run("UPDATE definition_package_releases SET package_id = ''", []);
        database.run("UPDATE definition_metadata_snapshots SET revision = -1", []);
        database.run("PRAGMA ignore_check_constraints = OFF", []);
        expect(() => store.list()).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        expect(() => store.listSnapshots()).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test.each(["release", "snapshot", "lock"] as const)(
        "fails closed when a %s insert produces no durable row",
        (kind) => {
            const database = new DropInsertSqlite();
            const store = new SqlitePackageStore(database);
            database.dropInserts = true;
            const release = packageRelease("package", "1.0.0");
            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
            const lock = packageLock(snapshot.digest, 1, [release]);
            expect(() =>
                kind === "release"
                    ? store.add(release)
                    : kind === "snapshot"
                      ? store.addSnapshot(snapshot)
                      : store.addLock(lock)
            ).toThrow(/durable row/);
        }
    );
});

class DropInsertSqlite extends TestSqlite {
    public dropInserts = false;

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.dropInserts && /^\s*INSERT OR IGNORE INTO definition_/u.test(statement)) return;
        super.run(statement, bindings);
    }
}

class FileSqlite extends TransactionalSqlite {
    readonly #database: DatabaseSync;

    public constructor(path: string) {
        super();
        this.#database = new DatabaseSync(path);
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.prepare(statement).all(...bindings) as readonly SqliteRow[];
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.prepare(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.#database.exec("BEGIN");
        try {
            const result = requireSynchronousResult(operation());
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    public close(): void {
        this.#database.close();
    }
}
