import { describe, expect, test } from "vitest";
import {
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    Revision
} from "../../../src/core";
import { MetadataSnapshot, PackageLock } from "../../../src/definition";
import { SqlitePackageStore, type SqliteRow, type SqliteValue } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import { digestOf, packageLock, packageRelease } from "../../definition/package-store-contract";

class RowTamperSqlite extends TestSqlite {
    public tamper: ((statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[]) | undefined;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        return this.tamper === undefined ? rows : this.tamper(statement, rows);
    }
}

/**
 * Canonical JSON fixes object key order but not array order, so a record whose
 * payload array is permuted decodes to an identical value from different bytes.
 */
function permutedRecord(record: Uint8Array, field: string): Uint8Array {
    const envelope = decodeCanonicalJson(record);
    if (!isJsonObject(envelope)) throw new TypeError("Record envelope must be an object");
    const payload = envelope["payload"];
    if (!isJsonObject(payload)) throw new TypeError("Record payload must be an object");
    const entries = payload[field];
    if (!Array.isArray(entries) || entries.length < 2) {
        throw new TypeError(`Record payload ${field} must hold at least two entries`);
    }
    return encodeCanonicalJson({
        ...envelope,
        payload: { ...payload, [field]: [...entries].reverse() }
    });
}

describe("SQLite package store exact failure and projection behavior", () => {
    test("release conflicts carry the exact immutable error code and message", { tags: "p1" }, () => {
        const store = new SqlitePackageStore(new TestSqlite());
        const original = packageRelease("immutable", "1.0.0");
        const conflict = packageRelease("immutable", "1.0.0", digestOf("different-code"));
        store.add(original);

        expect(() => store.add(conflict)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Package release immutable@1.0.0 is immutable"
            })
        );
        expect(store.get(original.id, original.version)).toEqual(original);
    });

    test("list fails closed on duplicate stored release keys", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        store.add(packageRelease("a", "1.0.0"));
        store.add(packageRelease("b", "1.0.0"));
        database.tamper = (statement, rows) =>
            statement.includes("FROM definition_package_releases") &&
            statement.includes("ORDER BY")
                ? [...rows, ...rows]
                : rows;

        expect(() => store.list()).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored package releases contain a duplicate immutable key"
            })
        );
    });

    test("list restores canonical key order from decoded releases, not raw row order", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        store.add(packageRelease("a", "1.0.0"));
        store.add(packageRelease("a", "2.0.0"));
        store.add(packageRelease("a", "3.0.0"));
        store.add(packageRelease("b", "1.0.0"));
        // Permute the driver rows so ordering can only come from the comparator.
        database.tamper = (statement, rows) =>
            statement.includes("FROM definition_package_releases") &&
            statement.includes("ORDER BY") &&
            rows.length === 4
                ? [rows[3], rows[1], rows[0], rows[2]].flatMap((row) =>
                      row === undefined ? [] : [row]
                  )
                : rows;

        const keys = store.list().map((release) => `${release.id.value}@${release.version.toString()}`);
        expect(keys).toEqual(["a@1.0.0", "a@2.0.0", "a@3.0.0", "b@1.0.0"]);
    });

    test("getSnapshot returns undefined for a missing digest and restores revision zero exactly", { tags: "p1" }, () => {
        const store = new SqlitePackageStore(new TestSqlite());
        const snapshot = new MetadataSnapshot({
            revision: new Revision(0),
            releases: [packageRelease("snap", "1.0.0")]
        });
        store.addSnapshot(snapshot);

        expect(store.getSnapshot(digestOf("missing"))).toBeUndefined();
        const stored = store.getSnapshot(snapshot.digest);
        expect(stored?.revision.value).toBe(0);
        expect(stored).toBeDefined();
        if (stored === undefined) throw new TypeError("Expected stored snapshot");
        expect(MetadataSnapshot.encode(stored)).toEqual(MetadataSnapshot.encode(snapshot));
    });

    test("snapshot rows swapped across digests fail the expected-digest projection", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        const first = new MetadataSnapshot({
            revision: new Revision(0),
            releases: [packageRelease("first", "1.0.0")]
        });
        const second = new MetadataSnapshot({
            revision: new Revision(1),
            releases: [packageRelease("second", "1.0.0")]
        });
        store.addSnapshot(first);
        store.addSnapshot(second);
        const foreign = database.all(
            "SELECT digest, revision, record FROM definition_metadata_snapshots WHERE digest = ?",
            [second.digest.value]
        );
        database.tamper = (statement, rows) =>
            statement.includes("FROM definition_metadata_snapshots WHERE digest") ? foreign : rows;

        expect(() => store.getSnapshot(first.digest)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored metadata snapshot key or projection does not match codec bytes"
            })
        );
    });

    test("release rows swapped across keys fail the expected-id and expected-version projections", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        const wanted = packageRelease("a", "1.0.0");
        const otherVersion = packageRelease("a", "2.0.0");
        const otherPackage = packageRelease("b", "1.0.0");
        store.add(wanted);
        store.add(otherVersion);
        store.add(otherPackage);
        const rowFor = (id: string, version: string) =>
            database.all(
                `SELECT package_id, version, manifest_digest, code_digest, record
                 FROM definition_package_releases WHERE package_id = ? AND version = ?`,
                [id, version]
            );
        const foreignPackage = rowFor("b", "1.0.0");
        const foreignVersion = rowFor("a", "2.0.0");
        const projectionError = expect.objectContaining({
            code: "codec.invalid",
            message: "Stored package release key or projection does not match its codec bytes"
        });

        database.tamper = (statement, rows) =>
            statement.includes("WHERE package_id = ? AND version = ?") ? foreignPackage : rows;
        expect(() => store.get(wanted.id, wanted.version)).toThrow(projectionError);

        database.tamper = (statement, rows) =>
            statement.includes("WHERE package_id = ? AND version = ?") ? foreignVersion : rows;
        expect(() => store.get(wanted.id, wanted.version)).toThrow(projectionError);
    });

    test("lock rows with a forged key column fail the key projection", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        const lock = packageLock(digestOf("snapshot"), 1, [packageRelease("locked", "1.0.0")]);
        store.addLock(lock);
        database.tamper = (statement, rows) =>
            statement.includes("FROM definition_package_locks")
                ? rows.map((row) => ({ ...row, lock_digest: digestOf("foreign-lock-key").value }))
                : rows;

        expect(() => store.getLock(lock.digest)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored package lock key or projection does not match its codec bytes"
            })
        );
    });

    test("malformed stored snapshot projections fail closed with exact column messages", { tags: "p1" }, () => {
        const database = new RowTamperSqlite();
        const store = new SqlitePackageStore(database);
        const snapshot = new MetadataSnapshot({
            revision: new Revision(0),
            releases: [packageRelease("snap", "1.0.0")]
        });
        store.addSnapshot(snapshot);
        const corrupt = (column: string, value: SqliteValue) => {
            database.tamper = (statement, rows) =>
                statement.includes("FROM definition_metadata_snapshots WHERE digest")
                    ? rows.map((row) => ({ ...row, [column]: value }))
                    : rows;
        };
        const malformed = (column: string) =>
            expect.objectContaining({
                code: "codec.invalid",
                message: `Stored package ${column} projection is malformed`
            });

        corrupt("revision", "7");
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(malformed("revision"));
        corrupt("revision", 1.5);
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(malformed("revision"));
        corrupt("revision", -1);
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(malformed("revision"));
        corrupt("digest", "");
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(malformed("digest"));
        corrupt("digest", 7);
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(malformed("digest"));
        corrupt("record", "not-bytes");
        expect(() => store.getSnapshot(snapshot.digest)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored package record bytes are malformed"
            })
        );
    });

    test("a stored snapshot whose bytes differ under one digest is immutable", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const snapshot = new MetadataSnapshot({
            revision: new Revision(3),
            releases: [packageRelease("alpha", "1.0.0"), packageRelease("beta", "1.0.0")]
        });
        const permuted = permutedRecord(MetadataSnapshot.encode(snapshot), "releases");
        expect(permuted).not.toEqual(MetadataSnapshot.encode(snapshot));
        expect(MetadataSnapshot.decode(permuted).digest).toEqual(snapshot.digest);
        database.run(
            "INSERT INTO definition_metadata_snapshots (digest, revision, record) VALUES (?, ?, ?)",
            [snapshot.digest.value, snapshot.revision.value, permuted]
        );

        expect(() => store.addSnapshot(snapshot)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Metadata snapshot ${snapshot.digest.value} is immutable`
            })
        );
        expect(database.all("SELECT record FROM definition_metadata_snapshots", [])).toEqual([
            { record: permuted }
        ]);
    });

    test("a stored lock whose bytes differ under one digest is immutable", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqlitePackageStore(database);
        const lock = packageLock(digestOf("lock-snapshot"), 2, [
            packageRelease("alpha", "1.0.0"),
            packageRelease("beta", "1.0.0")
        ]);
        const permuted = permutedRecord(PackageLock.encode(lock), "packages");
        expect(permuted).not.toEqual(PackageLock.encode(lock));
        expect(PackageLock.decode(permuted).digest).toEqual(lock.digest);
        database.run(
            `INSERT INTO definition_package_locks (
                lock_digest, snapshot_digest, snapshot_revision, record
             ) VALUES (?, ?, ?, ?)`,
            [lock.digest.value, lock.snapshotDigest.value, lock.snapshotRevision.value, permuted]
        );

        expect(() => store.addLock(lock)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Package lock ${lock.digest.value} is immutable`
            })
        );
        expect(database.all("SELECT record FROM definition_package_locks", [])).toEqual([
            { record: permuted }
        ]);
    });
});
