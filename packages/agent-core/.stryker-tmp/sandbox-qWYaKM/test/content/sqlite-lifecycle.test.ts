// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import { ContentOwnerEdge } from "../../src/content/retention";
import { ContentRef, Digest } from "../../src/core";
import { TenantId } from "../../src/identity";
import {
    SqliteContentStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import {
    at,
    bindingFor,
    contentOwner,
    expectAgentCoreError,
    expectAgentCoreRejection
} from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

class InterceptingSqlite extends TransactionalSqlite {
    public mutateRows:
        ((statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[]) | undefined;
    public afterRun: ((statement: string) => void) | undefined;

    public constructor(public readonly inner: TestSqlite = new TestSqlite()) {
        super();
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = this.inner.all(statement, bindings);
        return this.mutateRows?.(statement, rows) ?? rows;
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.inner.run(statement, bindings);
        this.afterRun?.(statement);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.inner.transaction(operation, ...([] as SynchronousResultGuard<Result>));
    }
}

function replaceColumn(column: string, value: SqliteValue): (row: SqliteRow) => SqliteRow {
    return (row) => ({ ...row, [column]: value });
}

function mutateTableRows(
    database: InterceptingSqlite,
    table: string,
    mutate: (row: SqliteRow) => SqliteRow
): void {
    database.mutateRows = (statement, rows) =>
        statement.includes(table) ? rows.map(mutate) : rows;
}

describe("SQLite content row validation", () => {
    test("rejects every malformed selected blob column as operational corruption", async () => {
        const corruptions: readonly [column: string, value: SqliteValue][] = [
            ["ref", 1],
            ["digest", 1],
            ["bytes", "not-bytes"],
            ["media_type", 1],
            ["size", "1"],
            ["size", -1],
            ["size", 1.5]
        ];
        for (const [column, value] of corruptions) {
            const database = new InterceptingSqlite();
            const store = new SqliteContentStore(database);
            const stored = await store.put(encode("row-shape"));
            mutateTableRows(database, "FROM content_blobs", replaceColumn(column, value));
            await expectAgentCoreRejection(store.get(stored.ref), "codec.invalid");
        }
    });

    test("returns exact stat shape with and without media and rejects malformed media", async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const stored = await store.put(encode("stat-shape"));
        await expect(store.stat(stored.ref)).resolves.toEqual({
            ref: stored.ref,
            digest: stored.digest,
            size: 10,
            hint: undefined
        });
        mutateTableRows(database, "FROM content_blobs", replaceColumn("media_type", ""));
        await expectAgentCoreRejection(store.stat(stored.ref), "codec.invalid");
    });

    test("rolls back a blob when post-insert verification cannot observe it", async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        let hide = false;
        database.afterRun = (statement) => {
            if (statement.includes("INSERT OR IGNORE INTO content_blobs")) hide = true;
        };
        database.mutateRows = (statement, rows) =>
            hide && statement.includes("FROM content_blobs WHERE ref") ? [] : rows;

        await expectAgentCoreRejection(store.put(encode("invisible-insert")), "codec.invalid");
        expect(database.inner.all("SELECT * FROM content_blobs", [])).toEqual([]);
    });

    test("rejects incompatible pre-existing content schema without partial writes", async () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE content_blobs (ref TEXT PRIMARY KEY) STRICT", []);
        const store = new SqliteContentStore(database);
        await expect(store.put(encode("schema-mismatch"))).rejects.toBeInstanceOf(Error);
        expect(database.all("SELECT * FROM content_blobs", [])).toEqual([]);
    });
});

describe("SQLite retention row validation", () => {
    test("classifies missing and malformed storage bindings", () => {
        const owner = contentOwner();
        const missingDatabase = new TestSqlite();
        const missingStore = new SqliteContentStore(missingDatabase);
        const retention = missingStore.retention(owner.tenant, owner.actor);
        missingDatabase.run("DELETE FROM content_retention_binding", []);
        expectAgentCoreError(
            () =>
                missingDatabase.transaction(() =>
                    retention.collect(missingDatabase, { allowsCollection: () => true }, at(10))
                ),
            "protocol.invalid-state"
        );

        const malformedDatabase = new InterceptingSqlite();
        const malformedStore = new SqliteContentStore(malformedDatabase);
        malformedStore.retention(owner.tenant, owner.actor);
        mutateTableRows(
            malformedDatabase,
            "FROM content_retention_binding",
            replaceColumn("tenant", 1)
        );
        expectAgentCoreError(
            () => malformedStore.retention(owner.tenant, owner.actor),
            "codec.invalid"
        );
    });

    test("propagates an active SQLite driver TypeError from the binding read", () => {
        const database = new InterceptingSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const retention = store.retention(owner.tenant, owner.actor);
        const fault = new TypeError("injected active SQLite read fault");
        database.mutateRows = (statement, rows) => {
            if (statement.includes("FROM content_retention_binding")) throw fault;
            return rows;
        };

        let failure: unknown;
        try {
            database.transaction(() =>
                retention.collect(database, { allowsCollection: () => true }, at(10))
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toBe(fault);
        expect(failure).toBeInstanceOf(TypeError);
    });

    test("rejects every owner-edge metadata mismatch and selected column type", async () => {
        const mismatchUpdates: readonly [column: string, value: SqliteValue][] = [
            ["owner_key", "different-owner"],
            ["tenant", "different-tenant"],
            ["actor_kind", "run"],
            ["actor_id", "different-actor"],
            ["ref", `sha256:${"0".repeat(64)}`]
        ];
        for (const [column, value] of mismatchUpdates) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            const stored = await store.put(encode("edge-columns"));
            const edge = new ContentOwnerEdge(
                owner.tenant,
                owner.actor,
                "edge-columns",
                stored.ref
            );
            database.transaction(() => retention.retain(database, edge, at(10)));
            database.run(`UPDATE content_owner_edges SET ${column} = ?`, [value]);
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }

        for (const column of ["owner_key", "tenant", "actor_kind", "actor_id", "ref"] as const) {
            const database = new InterceptingSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            const stored = await store.put(encode(`edge-type-${column}`));
            const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "edge-type", stored.ref);
            database.transaction(() => retention.retain(database, edge, at(10)));
            mutateTableRows(database, "FROM content_owner_edges", replaceColumn(column, 1));
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }
    });

    test("rejects every relation ownership mismatch and malformed nullable timestamp", async () => {
        const metadata: readonly [column: string, value: SqliteValue][] = [
            ["tenant", "different-tenant"],
            ["actor_kind", "run"],
            ["actor_id", "different-actor"]
        ];
        for (const [column, value] of metadata) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            const binding = bindingFor("relation-columns", `relation-${column}`, at(30));
            await store
                .transient(owner.tenant, owner.actor, () => at(10))
                .acquire(binding, encode("relation-columns"));
            database.run(`UPDATE content_relations SET ${column} = ?`, [value]);
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }

        for (const value of ["bad", -1, 1.5] as const) {
            const database = new InterceptingSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            await store
                .transient(owner.tenant, owner.actor, () => at(10))
                .acquire(
                    bindingFor("relation-type", `relation-type-${value}`, at(30)),
                    encode("relation-type")
                );
            mutateTableRows(
                database,
                "FROM content_relations",
                replaceColumn("unowned_since", value)
            );
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }
    });

    test("rejects every transient lease metadata mismatch and selected column type", async () => {
        const updates: readonly [column: string, value: SqliteValue][] = [
            ["lease_key", "0".repeat(64)],
            ["tenant", "different-tenant"],
            ["actor_kind", "run"],
            ["actor_id", "different-actor"],
            ["ref", `sha256:${"0".repeat(64)}`],
            ["digest", "0".repeat(64)],
            ["acquired_at", 11],
            ["expires_at", 31],
            ["closed_at", 20]
        ];
        for (const [column, value] of updates) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            await store
                .transient(owner.tenant, owner.actor, () => at(10))
                .acquire(
                    bindingFor("lease-columns", `lease-${column}`, at(30)),
                    encode("lease-columns")
                );
            database.run(`UPDATE content_transient_leases SET ${column} = ?`, [value]);
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }

        for (const column of [
            "lease_key",
            "tenant",
            "actor_kind",
            "actor_id",
            "ref",
            "digest",
            "acquired_at",
            "expires_at",
            "closed_at",
            "record"
        ] as const) {
            const database = new InterceptingSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            await store
                .transient(owner.tenant, owner.actor, () => at(10))
                .acquire(
                    bindingFor("lease-types", `lease-type-${column}`, at(30)),
                    encode("lease-types")
                );
            mutateTableRows(
                database,
                "FROM content_transient_leases",
                replaceColumn(column, "bad")
            );
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        retention.collect(database, { allowsCollection: () => true }, at(20))
                    ),
                "codec.invalid"
            );
        }
    });

    test("fails closed for missing related blobs, relations, and invalid unowned deadlines", async () => {
        const cases: readonly ((database: TestSqlite) => void)[] = [
            (database) => database.run("DELETE FROM content_blobs", []),
            (database) => database.run("DELETE FROM content_relations", []),
            (database) => database.run("UPDATE content_relations SET unowned_since = NULL", [])
        ];
        for (const corrupt of cases) {
            const database = new TestSqlite();
            const owner = contentOwner();
            const store = new SqliteContentStore(database);
            const retention = store.retention(owner.tenant, owner.actor);
            await store
                .transient(owner.tenant, owner.actor, () => at(10))
                .acquire(
                    bindingFor("missing-relation", "missing-relation", at(30)),
                    encode("missing-relation")
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

    test("rejects immutable lease collision, missing bytes, foreign bindings, and bound owner reuse", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const retention = store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        await expect(
            access.acquire(bindingFor("missing-sqlite", "missing-sqlite", at(30)))
        ).resolves.toBeUndefined();
        const binding = bindingFor("sqlite-collision", "sqlite-collision", at(30));
        const lease = await access.acquire(binding, encode("sqlite-collision"));
        const otherDigest = Digest.sha256(encode("other-sqlite"));
        await expectAgentCoreRejection(
            access.acquire({
                ...binding,
                ref: ContentRef.fromDigest(otherDigest),
                digest: otherDigest
            }),
            "protocol.invalid-state"
        );
        await expectAgentCoreRejection(
            access.acquire({ ...binding, tenant: new TenantId("foreign") }),
            "protocol.invalid-state"
        );
        await expectAgentCoreRejection(
            access.acquire({
                ...binding,
                actor: new ActorRef("workspace", new ActorId("foreign"))
            }),
            "protocol.invalid-state"
        );
        await lease!.close();
        await lease!.close();
        database.transaction(() =>
            retention.collect(database, { allowsCollection: () => true }, at(10))
        );
        expectAgentCoreError(() => lease!.read(), "codec.invalid");
        expectAgentCoreError(
            () => store.retention(new TenantId("foreign"), owner.actor),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () => store.transient(owner.tenant, new ActorRef("workspace", new ActorId("foreign"))),
            "protocol.invalid-state"
        );
    });

    test("rolls back edge, lease, close, and collection when SQLite faults after mutation", async () => {
        const scenarios: readonly {
            readonly pattern: string;
            prepare(
                database: InterceptingSqlite,
                store: SqliteContentStore
            ): Promise<() => unknown>;
            verify(database: InterceptingSqlite): void;
        }[] = [
            {
                pattern: "INSERT INTO content_owner_edges",
                async prepare(database, store) {
                    const owner = contentOwner();
                    const retention = store.retention(owner.tenant, owner.actor);
                    const stored = await store.put(encode("fault-edge"));
                    const edge = new ContentOwnerEdge(
                        owner.tenant,
                        owner.actor,
                        "fault-edge",
                        stored.ref
                    );
                    return () =>
                        database.transaction(() => retention.retain(database, edge, at(10)));
                },
                verify(database) {
                    expect(database.inner.all("SELECT * FROM content_owner_edges", [])).toEqual([]);
                }
            },
            {
                pattern: "INSERT INTO content_transient_leases",
                async prepare(database, store) {
                    const owner = contentOwner();
                    const access = store.transient(owner.tenant, owner.actor, () => at(10));
                    const binding = bindingFor("fault-lease", "fault-lease", at(30));
                    return () =>
                        database.transaction(() =>
                            access.acquireInTransaction(
                                database,
                                binding,
                                at(10),
                                encode("fault-lease")
                            )
                        );
                },
                verify(database) {
                    expect(
                        database.inner.all("SELECT * FROM content_transient_leases", [])
                    ).toEqual([]);
                    expect(database.inner.all("SELECT * FROM content_relations", [])).toEqual([]);
                    expect(database.inner.all("SELECT * FROM content_blobs", [])).toEqual([]);
                }
            }
        ];
        for (const scenario of scenarios) {
            const database = new InterceptingSqlite();
            const store = new SqliteContentStore(database);
            const operation = await scenario.prepare(database, store);
            database.afterRun = (statement) => {
                if (statement.includes(scenario.pattern))
                    throw new TypeError("injected SQLite fault");
            };
            expect(operation).toThrow("injected SQLite fault");
            scenario.verify(database);
        }
    });

    test("rolls back post-insert owner verification failure", async () => {
        const database = new InterceptingSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("owner-verification"));
        const edge = new ContentOwnerEdge(
            owner.tenant,
            owner.actor,
            "owner-verification",
            stored.ref
        );
        let hide = false;
        database.afterRun = (statement) => {
            if (statement.includes("INSERT INTO content_owner_edges")) hide = true;
        };
        database.mutateRows = (statement, rows) =>
            hide && statement.includes("WHERE owner_key = ?") ? [] : rows;
        expectAgentCoreError(
            () => database.transaction(() => retention.retain(database, edge, at(10))),
            "codec.invalid"
        );
        expect(database.inner.all("SELECT * FROM content_owner_edges", [])).toEqual([]);
    });

    test("rolls back a transient lease whose inserted content cannot be verified", async () => {
        const database = new InterceptingSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("lease-verification", "lease-verification", at(30));
        let hide = false;
        database.afterRun = (statement) => {
            if (statement.includes("INSERT OR IGNORE INTO content_blobs")) hide = true;
        };
        database.mutateRows = (statement, rows) =>
            hide && statement.includes("FROM content_blobs WHERE ref") ? [] : rows;
        expectAgentCoreError(
            () =>
                database.transaction(() =>
                    access.acquireInTransaction(
                        database,
                        binding,
                        at(10),
                        encode("lease-verification")
                    )
                ),
            "codec.invalid"
        );
        expect(database.inner.all("SELECT * FROM content_blobs", [])).toEqual([]);
        expect(database.inner.all("SELECT * FROM content_relations", [])).toEqual([]);
        expect(database.inner.all("SELECT * FROM content_transient_leases", [])).toEqual([]);
    });

    test("detects leased content disappearing after lease validation", async () => {
        const database = new InterceptingSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("lease-read", "lease-read", at(30));
        const lease = await access.acquire(binding, encode("lease-read"));
        let contentReads = 0;
        database.mutateRows = (statement, rows) => {
            if (!statement.includes("FROM content_blobs WHERE ref")) return rows;
            contentReads += 1;
            return contentReads === 3 ? [] : rows;
        };
        expectAgentCoreError(() => lease!.read(), "codec.invalid");
    });

    test("uses the default observation clock for transient acquisition", async () => {
        const database = new TestSqlite();
        const owner = contentOwner();
        const store = new SqliteContentStore(database);
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor);
        const binding = bindingFor(
            "sqlite-default-clock",
            "sqlite-default-clock",
            new Date(8_000_000_000_000_000)
        );
        const lease = await access.acquire(binding, encode("sqlite-default-clock"));
        expect(lease?.read()).toEqual(encode("sqlite-default-clock"));
    });
});

describe("SQLite content restart", () => {
    test("restores blob, owner, relation, and lease state after a file-backed restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-content-"));
        const path = join(directory, "content.sqlite");
        const owner = contentOwner();
        try {
            const firstDatabase = new FileSqlite(path);
            const first = new SqliteContentStore(firstDatabase);
            const retention = first.retention(owner.tenant, owner.actor);
            const stored = await first.put(encode("file-restart"));
            const edge = new ContentOwnerEdge(
                owner.tenant,
                owner.actor,
                "file-restart",
                stored.ref
            );
            firstDatabase.transaction(() => retention.retain(firstDatabase, edge, at(10)));
            const binding = {
                ...bindingFor("file-restart", "file-restart", at(40)),
                ref: stored.ref,
                digest: stored.digest
            };
            await first.transient(owner.tenant, owner.actor, () => at(20)).acquire(binding);
            firstDatabase.close();

            const restartedDatabase = new FileSqlite(path);
            const restarted = new SqliteContentStore(restartedDatabase);
            const restartedRetention = restarted.retention(owner.tenant, owner.actor);
            const restartedAccess = restarted.transient(owner.tenant, owner.actor, () => at(30));
            await expect(restarted.get(stored.ref)).resolves.toEqual(encode("file-restart"));
            const lease = await restartedAccess.acquire(binding);
            expect(lease?.matches(binding, at(39))).toBe(true);
            restartedDatabase.transaction(() =>
                restartedRetention.release(restartedDatabase, edge, at(25))
            );
            await lease!.close();
            expect(
                restartedDatabase.transaction(() =>
                    restartedRetention.collect(
                        restartedDatabase,
                        { allowsCollection: () => true },
                        at(30)
                    )
                )
            ).toEqual([stored.ref]);
            restartedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
