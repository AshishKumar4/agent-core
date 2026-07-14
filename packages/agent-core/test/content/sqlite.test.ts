import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { ContentOwnerEdge } from "../../src/content/retention";
import { ContentRef, Digest } from "../../src/core";
import {
    SqliteActorStore,
    SqliteContentStore,
    type TransactionalSqlite
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import { contentStoreContract } from "./contract";
import {
    at,
    bindingFor,
    contentOwner,
    contentRetentionContract,
    expectAgentCoreError,
    expectAgentCoreRejection
} from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

contentStoreContract("SQLite", () => new SqliteContentStore(new TestSqlite()));
contentRetentionContract("SQLite", () => {
    const database = new TestSqlite();
    const store = new SqliteContentStore(database);
    const owner = contentOwner();
    const retention = store.retention(owner.tenant, owner.actor);
    let now = at(0);
    const transient = store.transient(owner.tenant, owner.actor, () => now);
    return {
        store,
        retention,
        transient,
        setNow(value: Date): void {
            now = value;
        },
        transaction<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
            return database.transaction(
                () => operation(database),
                ...([] as SynchronousResultGuard<Result>)
            );
        },
        acquireInTransaction(transaction, binding, operationAt, bytes): unknown {
            return transient.acquireInTransaction(transaction, binding, operationAt, bytes);
        }
    };
});

describe("SqliteContentStore", () => {
    test("does not expose transient hold or GC methods", () => {
        expect(SqliteContentStore.prototype).not.toHaveProperty("putHeld");
        expect(SqliteContentStore.prototype).not.toHaveProperty("getHeld");
        expect(SqliteContentStore.prototype).not.toHaveProperty("release");
        expect(SqliteContentStore.prototype).not.toHaveProperty("reap");
    });

    test("[C13-CONTENT-RESOLUTION] resolves content and retention edges after an adapter restart", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const first = new SqliteContentStore(database);
        const retention = first.retention(owner.tenant, owner.actor);
        const stored = await first.put(encode("durable"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "durable", stored.ref);
        database.transaction(() => retention.retain(database, edge, at(10)));
        let now = at(15);
        const access = first.transient(owner.tenant, owner.actor, () => now);
        const binding = bindingFor("durable", "durable", at(40));
        await access.acquire(binding);

        const restarted = new SqliteContentStore(database);
        const restartedRetention = restarted.retention(owner.tenant, owner.actor);
        const restartedAccess = restarted.transient(owner.tenant, owner.actor, () => now);
        await expect(restarted.get(stored.ref)).resolves.toEqual(encode("durable"));
        const lease = await restartedAccess.acquire(binding);
        expect(lease?.matches(binding, at(39))).toBe(true);
        database.transaction(() => restartedRetention.release(database, edge, at(20)));
        now = at(30);
        await lease?.close();
        const collected = database.transaction(() =>
            restartedRetention.collect(database, { allowsCollection: () => true }, at(30))
        );
        expect(collected).toEqual([stored.ref]);
    });

    test("rejects a corrupt row on a content-address conflict", async () => {
        const database = new TestSqlite();
        const store = new SqliteContentStore(database);
        const bytes = encode("conflict");
        const stored = await store.put(bytes);
        database.run("UPDATE content_blobs SET size = size + 1 WHERE ref = ?", [stored.ref.value]);
        await expectAgentCoreRejection(store.put(bytes), "codec.invalid");
    });

    test("uses strict tables for blobs and retention", () => {
        const database = new TestSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);

        const rows = database.all(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'content_%'`,
            []
        );
        expect(rows).toHaveLength(5);
        for (const row of rows) expect(row["sql"]).toEqual(expect.stringMatching(/STRICT$/));
    });

    test("detects persisted owner-edge corruption before GC or mutation", async () => {
        const corruptions: readonly ((database: TestSqlite) => void)[] = [
            (database) =>
                database.run("UPDATE content_owner_edges SET ref = ?", [
                    "sha256:" + "0".repeat(64)
                ]),
            (database) =>
                database.run("UPDATE content_owner_edges SET record = ?", [Uint8Array.of(1, 2, 3)])
        ];
        for (const corrupt of corruptions) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            const stored = await store.put(encode("edge corruption"));
            const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "edge", stored.ref);
            database.transaction(() => retention.retain(database, edge, at(10)));
            corrupt(database);

            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, new Date())
                    ),
                "codec.invalid"
            );
            expectAgentCoreError(
                () => database.transaction(() => retention.release(database, edge, at(20))),
                "codec.invalid"
            );
        }
    });

    test("fails closed on malformed lease and unowned relation rows", async () => {
        const corruptions: readonly ((database: TestSqlite) => void)[] = [
            (database) =>
                database.run("UPDATE content_transient_leases SET record = ?", [
                    Uint8Array.of(1, 2, 3)
                ]),
            (database) => database.run("UPDATE content_relations SET tenant = ?", ["foreign"])
        ];
        for (const corrupt of corruptions) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            const access = store.transient(owner.tenant, owner.actor, () => at(10));
            await access.acquire(
                bindingFor("corrupt lease", "corrupt", at(30)),
                encode("corrupt lease")
            );
            corrupt(database);
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(30))
                    ),
                "codec.invalid"
            );
        }
    });

    test("rolls back transient bytes, relation, and lease together", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("atomic sqlite", "atomic-sqlite", at(30));

        expect(() =>
            database.transaction(() => {
                access.acquireInTransaction(database, binding, at(10), encode("atomic sqlite"));
                throw new TypeError("fault");
            })
        ).toThrow("fault");
        await expect(store.stat(binding.ref)).resolves.toBeUndefined();
        expect(database.all("SELECT * FROM content_relations", [])).toEqual([]);
        expect(database.all("SELECT * FROM content_transient_leases", [])).toEqual([]);
        await expect(access.acquire(binding, encode("atomic sqlite"))).resolves.toBeDefined();
    });

    test("reacquires an expired same-envelope lease after adapter restart", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const first = new SqliteContentStore(database);
        first.retention(owner.tenant, owner.actor);
        const initial = bindingFor("sqlite crash retry", "sqlite-crash", at(30));
        await first
            .transient(owner.tenant, owner.actor, () => at(10))
            .acquire(initial, encode("sqlite crash retry"));

        const restarted = new SqliteContentStore(database);
        restarted.retention(owner.tenant, owner.actor);
        const replacementBinding = { ...initial, expiresAt: at(60) };
        const replacement = await restarted
            .transient(owner.tenant, owner.actor, () => at(30))
            .acquire(replacementBinding);
        expect(replacement?.matches(replacementBinding, at(59))).toBe(true);
    });

    test("accepts root and live same-provenance Actor transactions but rejects stale scopes", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const retention = store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const actorStore = new SqliteActorStore(database);
        actorStore.bindActor(owner.actor);
        const rootContent = await store.put(encode("root provenance"));
        const rootEdge = new ContentOwnerEdge(
            owner.tenant,
            owner.actor,
            "root-provenance",
            rootContent.ref
        );
        database.transaction(() => retention.retain(database, rootEdge, at(10)));

        const scopedContent = await store.put(encode("scope provenance"));
        const scopedEdge = new ContentOwnerEdge(
            owner.tenant,
            owner.actor,
            "scope-provenance",
            scopedContent.ref
        );
        const binding = bindingFor("scope lease", "scope-provenance", at(30));
        let escaped: TransactionalSqlite | undefined;
        actorStore.transaction((transaction) => {
            escaped = transaction;
            retention.retain(transaction, scopedEdge, at(10));
            expect(
                access.acquireInTransaction(transaction, binding, at(10), encode("scope lease"))
            ).toBeDefined();
        });

        expectAgentCoreError(() => retention.release(escaped!, scopedEdge, at(20)), "actor.closed");
        expectAgentCoreError(
            () => access.acquireInTransaction(escaped!, binding, at(10)),
            "actor.closed"
        );
    });

    test("rejects same-identity transactions from another SQLite capability", async () => {
        const owner = contentOwner();
        const firstDatabase = new TestSqlite();
        const secondDatabase = new TestSqlite();
        const first = new SqliteContentStore(firstDatabase);
        const second = new SqliteContentStore(secondDatabase);
        const retention = first.retention(owner.tenant, owner.actor);
        second.retention(owner.tenant, owner.actor);
        const stored = await second.put(encode("foreign database"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "foreign-db", stored.ref);
        expectAgentCoreError(
            () => secondDatabase.transaction(() => retention.retain(secondDatabase, edge, at(10))),
            "protocol.invalid-state"
        );

        const access = first.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("foreign database lease", "foreign-db", at(30));
        expectAgentCoreError(
            () =>
                secondDatabase.transaction(() =>
                    access.acquireInTransaction(
                        secondDatabase,
                        binding,
                        at(10),
                        encode("foreign database lease")
                    )
                ),
            "protocol.invalid-state"
        );
    });

    test("validates ref, digest, size, and recomputed bytes on every read", async () => {
        const corruptions: readonly {
            readonly corrupt: (database: TestSqlite, ref: ContentRef) => ContentRef;
            readonly name: string;
        }[] = [
            {
                name: "ref",
                corrupt(database, ref): ContentRef {
                    const other = ContentRef.fromDigest(Digest.sha256(encode("other")));
                    database.run("UPDATE content_blobs SET ref = ? WHERE ref = ?", [
                        other.value,
                        ref.value
                    ]);
                    return other;
                }
            },
            {
                name: "digest",
                corrupt(database, ref): ContentRef {
                    database.run("UPDATE content_blobs SET digest = ? WHERE ref = ?", [
                        "0".repeat(64),
                        ref.value
                    ]);
                    return ref;
                }
            },
            {
                name: "size",
                corrupt(database, ref): ContentRef {
                    database.run("UPDATE content_blobs SET size = size + 1 WHERE ref = ?", [
                        ref.value
                    ]);
                    return ref;
                }
            },
            {
                name: "bytes",
                corrupt(database, ref): ContentRef {
                    database.run("UPDATE content_blobs SET bytes = ? WHERE ref = ?", [
                        encode("tampered"),
                        ref.value
                    ]);
                    return ref;
                }
            }
        ];

        for (const corruption of corruptions) {
            const database = new TestSqlite();
            const store = new SqliteContentStore(database);
            const stored = await store.put(encode("original"));
            const ref = corruption.corrupt(database, stored.ref);
            await expectAgentCoreRejection(store.get(ref), "codec.invalid");
            await expectAgentCoreRejection(store.stat(ref), "codec.invalid");
        }
    });
});
