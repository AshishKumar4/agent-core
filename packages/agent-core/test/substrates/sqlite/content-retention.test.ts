import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../../src/actors";
import { ContentOwnerEdge, type ContentCollectionCandidate } from "../../../src/content";
import { ContentRef, Digest } from "../../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../../src/errors";
import { TenantId } from "../../../src/identity";
import {
    SqliteContentRetention,
    SqliteContentStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite";
import { at, bindingFor, contentOwner } from "../../content/retention-contract";
import { TestSqlite } from "../../helpers/sqlite";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

class InterceptingSqlite extends TransactionalSqlite {
    public mutateRows:
        | ((statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[])
        | undefined;
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

function caught(operation: () => unknown): unknown {
    try {
        operation();
    } catch (error) {
        return error;
    }
    return undefined;
}

function expectExactError(
    operation: () => unknown,
    code: AgentCoreErrorCode,
    message: string
): void {
    const failure = caught(operation);
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).toMatchObject({ code, message });
}

function expectErrorMatching(
    operation: () => unknown,
    code: AgentCoreErrorCode,
    pattern: RegExp
): void {
    const failure = caught(operation);
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).toMatchObject({ code, message: expect.stringMatching(pattern) });
}

async function expectExactRejection(
    operation: Promise<unknown>,
    code: AgentCoreErrorCode,
    message: string
): Promise<void> {
    let failure: unknown;
    try {
        await operation;
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).toMatchObject({ code, message });
}

function collectAll(
    database: TransactionalSqlite,
    retention: SqliteContentRetention,
    observedAt: Date
): readonly ContentRef[] {
    return database.transaction(() =>
        retention.collect(database, { allowsCollection: () => true }, observedAt)
    );
}

function unownedSince(database: TransactionalSqlite, ref: ContentRef): SqliteValue | undefined {
    const row = database.all("SELECT unowned_since FROM content_relations WHERE ref = ?", [
        ref.value
    ])[0];
    return row?.["unowned_since"];
}

function column(
    database: TransactionalSqlite,
    statement: string,
    name: string
): readonly (SqliteValue | undefined)[] {
    return database.all(statement, []).map((row) => row[name]);
}

function hideBlobReadsFrom(database: InterceptingSqlite, first: number): void {
    let reads = 0;
    database.mutateRows = (statement, rows) => {
        if (!statement.includes("FROM content_blobs WHERE ref")) return rows;
        reads += 1;
        return reads >= first ? [] : rows;
    };
}

function harness(now: () => Date = () => at(10)): {
    readonly database: TestSqlite;
    readonly store: SqliteContentStore;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly retention: SqliteContentRetention;
    readonly access: ReturnType<SqliteContentStore["transient"]>;
} {
    const database = new TestSqlite();
    const store = new SqliteContentStore(database);
    const owner = contentOwner();
    return {
        database,
        store,
        tenant: owner.tenant,
        actor: owner.actor,
        retention: store.retention(owner.tenant, owner.actor),
        access: store.transient(owner.tenant, owner.actor, now)
    };
}

describe("SQLite content retention state validation", () => {
    test("rejects owned-relation drift with the exact diagnostic", { tags: "p1" }, async () => {
        const missingRelation = harness();
        const stored = await missingRelation.store.put(encode("owned-drift"));
        const edge = new ContentOwnerEdge(
            missingRelation.tenant,
            missingRelation.actor,
            "owned-drift",
            stored.ref
        );
        missingRelation.database.transaction(() =>
            missingRelation.retention.retain(missingRelation.database, edge, at(10))
        );
        missingRelation.database.run("DELETE FROM content_relations", []);
        expectExactError(
            () => collectAll(missingRelation.database, missingRelation.retention, at(20)),
            "codec.invalid",
            "Owned content relation is malformed"
        );

        const unownedMarker = harness();
        const marked = await unownedMarker.store.put(encode("owned-drift"));
        const markedEdge = new ContentOwnerEdge(
            unownedMarker.tenant,
            unownedMarker.actor,
            "owned-drift",
            marked.ref
        );
        unownedMarker.database.transaction(() =>
            unownedMarker.retention.retain(unownedMarker.database, markedEdge, at(10))
        );
        unownedMarker.database.run("UPDATE content_relations SET unowned_since = 5", []);
        expectExactError(
            () => collectAll(unownedMarker.database, unownedMarker.retention, at(20)),
            "codec.invalid",
            "Owned content relation is malformed"
        );
    });

    test("rejects unowned-relation drift with the exact diagnostic", { tags: "p1" }, async () => {
        const orphanOwnership = harness();
        const stored = await orphanOwnership.store.put(encode("unowned-drift"));
        const edge = new ContentOwnerEdge(
            orphanOwnership.tenant,
            orphanOwnership.actor,
            "unowned-drift",
            stored.ref
        );
        orphanOwnership.database.transaction(() =>
            orphanOwnership.retention.retain(orphanOwnership.database, edge, at(10))
        );
        orphanOwnership.database.run("DELETE FROM content_owner_edges", []);
        expectExactError(
            () => collectAll(orphanOwnership.database, orphanOwnership.retention, at(20)),
            "codec.invalid",
            "Content relation is malformed"
        );

        let now = at(10);
        const missingBlob = harness(() => now);
        const binding = bindingFor("unowned-blob", "unowned-blob-envelope", at(30));
        const lease = await missingBlob.access.acquire(binding, encode("unowned-blob"));
        expect(lease).toBeDefined();
        now = at(20);
        await lease?.close();
        missingBlob.database.run("DELETE FROM content_blobs", []);
        expectExactError(
            () => collectAll(missingBlob.database, missingBlob.retention, at(21)),
            "codec.invalid",
            "Content relation is malformed"
        );
    });

    test("reports exact malformed relation column diagnostics", { tags: "p1" }, async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        await access.acquire(
            bindingFor("relation-column", "relation-column-envelope", at(30)),
            encode("relation-column")
        );
        database.mutateRows = (statement, rows) =>
            statement.includes("FROM content_relations")
                ? rows.map((row) => ({ ...row, unowned_since: 1.5 }))
                : rows;
        expectExactError(
            () => collectAll(database, retention, at(20)),
            "codec.invalid",
            "Expected nullable non-negative integer column: unowned_since"
        );

        const invalidRef = harness();
        const stored = await invalidRef.store.put(encode("relation-ref"));
        const edge = new ContentOwnerEdge(
            invalidRef.tenant,
            invalidRef.actor,
            "relation-ref",
            stored.ref
        );
        invalidRef.database.transaction(() => {
            invalidRef.retention.retain(invalidRef.database, edge, at(10));
            invalidRef.retention.release(invalidRef.database, edge, at(20));
        });
        invalidRef.database.run("UPDATE content_relations SET ref = 'bogus'", []);
        expectExactError(
            () => collectAll(invalidRef.database, invalidRef.retention, at(30)),
            "codec.invalid",
            "Stored content relation is malformed"
        );
    });

    test("reports exact lease corruption diagnostics", { tags: "p1" }, async () => {
        const garbageRecord = harness();
        await garbageRecord.access.acquire(
            bindingFor("lease-record", "lease-record-envelope", at(30)),
            encode("lease-record")
        );
        garbageRecord.database.run("UPDATE content_transient_leases SET record = ?", [
            Uint8Array.of(1, 2, 3)
        ]);
        expectErrorMatching(
            () => collectAll(garbageRecord.database, garbageRecord.retention, at(20)),
            "codec.invalid",
            /^Invalid canonical JSON: /
        );

        const closedColumn = harness();
        await closedColumn.access.acquire(
            bindingFor("lease-closed", "lease-closed-envelope", at(30)),
            encode("lease-closed")
        );
        closedColumn.database.run(
            "UPDATE content_transient_leases SET closed_at = acquired_at",
            []
        );
        expectExactError(
            () => collectAll(closedColumn.database, closedColumn.retention, at(20)),
            "codec.invalid",
            "Stored content retention state is malformed"
        );

        const missingRelation = harness();
        await missingRelation.access.acquire(
            bindingFor("lease-relation", "lease-relation-envelope", at(30)),
            encode("lease-relation")
        );
        missingRelation.database.run("DELETE FROM content_relations", []);
        expectExactError(
            () => collectAll(missingRelation.database, missingRelation.retention, at(20)),
            "codec.invalid",
            "Stored content retention state is malformed"
        );
    });

    test("reports the exact malformed owner-edge record diagnostic", { tags: "p1" }, async () => {
        const context = harness();
        const stored = await context.store.put(encode("edge-record"));
        const edge = new ContentOwnerEdge(context.tenant, context.actor, "edge-record", stored.ref);
        context.database.transaction(() =>
            context.retention.retain(context.database, edge, at(10))
        );
        context.database.run("UPDATE content_owner_edges SET record = ?", [Uint8Array.of(9, 9)]);
        expectErrorMatching(
            () => collectAll(context.database, context.retention, at(20)),
            "codec.invalid",
            /^Invalid canonical JSON: /
        );
    });

    test("accepts zero-timestamp retention boundaries", { tags: "p2" }, async () => {
        const context = harness();
        const stored = await context.store.put(encode("zero-boundary"));
        const edge = new ContentOwnerEdge(
            context.tenant,
            context.actor,
            "zero-boundary",
            stored.ref
        );
        context.database.transaction(() => {
            context.retention.retain(context.database, edge, at(0));
            context.retention.release(context.database, edge, at(0));
        });
        const candidates: ContentCollectionCandidate[] = [];
        const refs = context.database.transaction(() =>
            context.retention.collect(
                context.database,
                {
                    allowsCollection(_transaction, candidate): boolean {
                        candidates.push(candidate);
                        return false;
                    }
                },
                at(5)
            )
        );
        expect(refs).toEqual([]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.unownedSince).toEqual(at(0));
        expect(candidates[0]?.observedAt).toEqual(at(5));
        expect(unownedSince(context.database, stored.ref)).toBe(0);
    });
});

describe("SQLite content retention collection gating", () => {
    test(
        "consults policy only for unprotected content and deletes exactly the approved rows",
        { tags: "p0" },
        async () => {
            const { database, store, tenant, actor, retention, access } = harness();
            const owned = await store.put(encode("gate-owned"));
            const ownedEdge = new ContentOwnerEdge(tenant, actor, "gate-owned", owned.ref);
            database.transaction(() => retention.retain(database, ownedEdge, at(5)));
            const leasedBinding = bindingFor("gate-leased", "gate-leased-envelope", at(50));
            await access.acquire(leasedBinding, encode("gate-leased"));
            const transientBinding = bindingFor(
                "gate-transient",
                "gate-transient-envelope",
                at(25)
            );
            await access.acquire(transientBinding, encode("gate-transient"));

            const candidates: ContentCollectionCandidate[] = [];
            const refs = database.transaction(() =>
                retention.collect(
                    database,
                    {
                        allowsCollection(_transaction, candidate): boolean {
                            candidates.push(candidate);
                            return true;
                        }
                    },
                    at(30)
                )
            );

            expect(refs).toEqual([transientBinding.ref]);
            expect(candidates).toHaveLength(1);
            const candidate = candidates[0];
            expect(candidate?.tenant.equals(tenant)).toBe(true);
            expect(candidate?.actor.equals(actor)).toBe(true);
            expect(candidate?.stat.ref.equals(transientBinding.ref)).toBe(true);
            expect(candidate?.stat.size).toBe(encode("gate-transient").byteLength);
            expect(candidate?.stat.hint).toBeUndefined();
            expect(candidate?.unownedSince).toEqual(at(25));
            expect(candidate?.observedAt).toEqual(at(30));

            expect(column(database, "SELECT ref FROM content_blobs ORDER BY ref", "ref")).toEqual(
                [owned.ref.value, leasedBinding.ref.value].sort()
            );
            expect(
                column(database, "SELECT ref FROM content_relations ORDER BY ref", "ref")
            ).toEqual([owned.ref.value, leasedBinding.ref.value].sort());
            expect(
                column(database, "SELECT lease_key FROM content_transient_leases", "lease_key")
            ).toEqual([leasedBinding.envelopeDigest.value]);
        }
    );

    test(
        "skips relations that lose protection after the collection snapshot",
        { tags: "p0" },
        async () => {
            const { database, store, tenant, actor, retention } = harness();
            const first = await store.put(encode("snapshot-alpha"));
            const second = await store.put(encode("snapshot-beta"));
            const [trigger, target] =
                first.ref.value < second.ref.value ? [first, second] : [second, first];
            const triggerEdge = new ContentOwnerEdge(tenant, actor, "snapshot-trigger", trigger.ref);
            const targetEdge = new ContentOwnerEdge(tenant, actor, "snapshot-target", target.ref);
            database.transaction(() => {
                retention.retain(database, triggerEdge, at(10));
                retention.retain(database, targetEdge, at(10));
                retention.release(database, triggerEdge, at(20));
            });

            const candidates: ContentCollectionCandidate[] = [];
            const refs = database.transaction(() =>
                retention.collect(
                    database,
                    {
                        allowsCollection(transaction, candidate): boolean {
                            candidates.push(candidate);
                            if (candidate.stat.ref.equals(trigger.ref)) {
                                retention.release(transaction, targetEdge, at(25));
                            }
                            return true;
                        }
                    },
                    at(30)
                )
            );

            expect(refs).toEqual([trigger.ref]);
            expect(candidates).toHaveLength(1);
            expect(candidates[0]?.unownedSince).toEqual(at(20));
            expect(unownedSince(database, target.ref)).toBe(25);
            await expect(store.stat(target.ref)).resolves.toBeDefined();
            await expect(store.stat(trigger.ref)).resolves.toBeUndefined();
        }
    );

    test(
        "rechecks boundary advancement before deleting an approved candidate",
        { tags: "p0" },
        async () => {
            const { database, store, tenant, actor, retention, access } = harness();
            const trigger = await store.put(encode("recheck-trigger"));
            const victim = await store.put(encode("recheck-victim"));
            const victimBinding = bindingFor("recheck-victim", "recheck-victim-envelope", at(22));
            const triggerEdge = new ContentOwnerEdge(tenant, actor, "recheck-trigger", trigger.ref);
            const victimEdge = new ContentOwnerEdge(tenant, actor, "recheck-victim", victim.ref);
            database.transaction(() => {
                retention.retain(database, triggerEdge, at(10));
                retention.retain(database, victimEdge, at(10));
                retention.release(database, triggerEdge, at(20));
                retention.release(database, victimEdge, at(20));
            });

            const candidates: ContentCollectionCandidate[] = [];
            const refs = database.transaction(() =>
                retention.collect(
                    database,
                    {
                        allowsCollection(transaction, candidate): boolean {
                            candidates.push(candidate);
                            if (candidate.stat.ref.equals(trigger.ref)) {
                                access.acquireInTransaction(transaction, victimBinding, at(21));
                            }
                            return true;
                        }
                    },
                    at(25)
                )
            );

            expect(refs).toEqual([trigger.ref]);
            expect(candidates).toHaveLength(2);
            expect(unownedSince(database, victim.ref)).toBe(22);
            await expect(store.stat(victim.ref)).resolves.toBeDefined();
            await expect(store.stat(trigger.ref)).resolves.toBeUndefined();
        }
    );
});

describe("SQLite content retention boundaries", () => {
    test(
        "persists the exact unowned boundary through acquisition and close",
        { tags: "p1" },
        async () => {
            let now = at(10);
            const { database, access } = harness(() => now);
            const binding = bindingFor("boundary-close", "boundary-close-envelope", at(30));
            const lease = await access.acquire(binding, encode("boundary-close"));
            expect(lease).toBeDefined();
            expect(unownedSince(database, binding.ref)).toBe(10);
            now = at(20);
            await lease?.close();
            expect(unownedSince(database, binding.ref)).toBe(20);
        }
    );

    test("clamps reacquisition to the persisted unowned maximum", { tags: "p1" }, async () => {
        let now = at(10);
        const { database, access } = harness(() => now);
        const first = bindingFor("boundary-clamp", "boundary-clamp-one", at(30));
        const lease = await access.acquire(first, encode("boundary-clamp"));
        now = at(20);
        await lease?.close();
        expect(unownedSince(database, first.ref)).toBe(20);

        database.transaction(() =>
            access.acquireInTransaction(
                database,
                bindingFor("boundary-clamp", "boundary-clamp-two", at(40)),
                at(25)
            )
        );
        expect(unownedSince(database, first.ref)).toBe(25);

        database.transaction(() =>
            access.acquireInTransaction(
                database,
                bindingFor("boundary-clamp", "boundary-clamp-three", at(50)),
                at(22)
            )
        );
        expect(unownedSince(database, first.ref)).toBe(25);
    });

    test(
        "advances the replaced content boundary when a lease is reacquired with a new ref",
        { tags: "p1" },
        async () => {
            let now = at(10);
            const { database, access } = harness(() => now);
            const oldBinding = bindingFor("boundary-replaced-old", "boundary-replaced", at(30));
            await access.acquire(oldBinding, encode("boundary-replaced-old"));
            expect(unownedSince(database, oldBinding.ref)).toBe(10);

            now = at(40);
            const newBinding = bindingFor("boundary-replaced-new", "boundary-replaced", at(60));
            const replacement = await access.acquire(newBinding, encode("boundary-replaced-new"));
            expect(replacement).toBeDefined();
            expect(unownedSince(database, oldBinding.ref)).toBe(30);
            expect(unownedSince(database, newBinding.ref)).toBe(40);
        }
    );
});

describe("SQLite transient lease contract", () => {
    test("rejects foreign lease bindings with the exact messages", { tags: "p0" }, async () => {
        const { access } = harness();
        const binding = bindingFor("foreign-binding", "foreign-binding-envelope", at(30));
        await expectExactRejection(
            access.acquire({ ...binding, tenant: new TenantId("tenant-b") }, encode("foreign-binding")),
            "protocol.invalid-state",
            "Transient content binding belongs to a different Tenant"
        );
        await expectExactRejection(
            access.acquire(
                { ...binding, actor: new ActorRef("workspace", new ActorId("actor-b")) },
                encode("foreign-binding")
            ),
            "protocol.invalid-state",
            "Transient content binding belongs to a different Actor"
        );
    });

    test(
        "rejects binding digests that do not match the reference or bytes",
        { tags: "p0" },
        async () => {
            const { store, access } = harness();
            const bytes = encode("digest-pair");
            const good = bindingFor("digest-pair", "digest-pair-envelope", at(30));

            await expectExactRejection(
                access.acquire(good, encode("digest-wrong")),
                "codec.invalid",
                "Transient content binding does not match bytes"
            );
            await expect(store.stat(good.ref)).resolves.toBeUndefined();

            const lease = await access.acquire(good, bytes);
            expect(lease).toBeDefined();
            await expectExactRejection(
                access.acquire(good, encode("digest-wrong")),
                "codec.invalid",
                "Transient content binding does not match bytes"
            );
            await expect(access.acquire(good, bytes)).resolves.toBeDefined();
        }
    );

    test(
        "rejects replaced lease generations differing by a single boundary",
        { tags: "p0" },
        async () => {
            let now = at(10);
            const { database, access } = harness(() => now);

            const acquiredBinding = bindingFor("generation-acquired", "generation-acquired-envelope", at(60));
            const staleAcquired = await access.acquire(acquiredBinding, encode("generation-acquired"));
            expect(staleAcquired).toBeDefined();
            now = at(20);
            await staleAcquired?.close();
            now = at(30);
            const replacement = await access.acquire(acquiredBinding);
            expect(replacement?.read()).toEqual(encode("generation-acquired"));
            expectExactError(
                () => staleAcquired?.read(),
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );

            now = at(10);
            const expiresBinding = bindingFor("generation-expires", "generation-expires-envelope", at(30));
            const staleExpires = await access.acquire(expiresBinding, encode("generation-expires"));
            expect(staleExpires).toBeDefined();
            now = at(15);
            await staleExpires?.close();
            database.transaction(() =>
                access.acquireInTransaction(database, { ...expiresBinding, expiresAt: at(50) }, at(10))
            );
            expectExactError(
                () => staleExpires?.read(),
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );
        }
    );

    test(
        "reports exact owner, lease, and missing-content collision messages",
        { tags: "p0" },
        async () => {
            const { database, store, tenant, actor, retention, access } = harness();
            const missing = ContentRef.fromDigest(Digest.sha256(encode("collision-missing")));
            const missingEdge = new ContentOwnerEdge(tenant, actor, "record:missing", missing);
            expectExactError(
                () => database.transaction(() => retention.retain(database, missingEdge, at(10))),
                "content.not-found",
                `Content not found: ${missing.value}`
            );

            const first = await store.put(encode("collision-first"));
            const second = await store.put(encode("collision-second"));
            const firstEdge = new ContentOwnerEdge(tenant, actor, "record:slot", first.ref);
            const secondEdge = new ContentOwnerEdge(tenant, actor, "record:slot", second.ref);
            database.transaction(() => retention.retain(database, firstEdge, at(10)));
            expectExactError(
                () => database.transaction(() => retention.retain(database, secondEdge, at(11))),
                "protocol.invalid-state",
                "Content owner key is already retained: record:slot"
            );

            const binding = bindingFor("collision-lease", "collision-lease-envelope", at(30));
            await access.acquire(binding, encode("collision-lease"));
            const conflictingDigest = Digest.sha256(encode("collision-other"));
            await expectExactRejection(
                access.acquire(
                    {
                        ...binding,
                        ref: ContentRef.fromDigest(conflictingDigest),
                        digest: conflictingDigest
                    },
                    encode("collision-other")
                ),
                "protocol.invalid-state",
                "Active transient lease key is bound to different content"
            );
        }
    );

    test("binds retention storage to the exact actor kind", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        expectExactError(
            () => store.retention(owner.tenant, new ActorRef("run", owner.actor.id)),
            "protocol.invalid-state",
            "SQLite content storage is bound to a different Actor or Tenant"
        );
    });

    test("reports the exact missing transient lease row", { tags: "p1" }, async () => {
        const { database, access } = harness();
        const binding = bindingFor("missing-lease", "missing-lease-envelope", at(30));
        const lease = await access.acquire(binding, encode("missing-lease"));
        expect(lease).toBeDefined();
        database.run("DELETE FROM content_transient_leases", []);
        expectExactError(
            () => lease?.read(),
            "codec.invalid",
            "Transient content lease is missing"
        );
    });
});

describe("SQLite content retention fault injection", () => {
    test("reports missing related content during collection", { tags: "p1" }, async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("fault-related"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "fault-related", stored.ref);
        database.transaction(() => {
            retention.retain(database, edge, at(10));
            retention.release(database, edge, at(20));
        });
        hideBlobReadsFrom(database, 2);
        expectExactError(
            () => collectAll(database, retention, at(30)),
            "codec.invalid",
            "Related content is missing"
        );
    });

    test("reports missing leased content on read", { tags: "p1" }, async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("fault-read", "fault-read-envelope", at(30));
        const lease = await access.acquire(binding, encode("fault-read"));
        expect(lease).toBeDefined();
        hideBlobReadsFrom(database, 4);
        expectExactError(() => lease?.read(), "codec.invalid", "Leased content is missing");
    });

    test("reports unverifiable leased content storage", { tags: "p1" }, async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("fault-store", "fault-store-envelope", at(30));
        let hidden = false;
        database.afterRun = (statement) => {
            if (statement.includes("INSERT OR IGNORE INTO content_blobs")) hidden = true;
        };
        database.mutateRows = (statement, rows) =>
            hidden && statement.includes("FROM content_blobs WHERE ref") ? [] : rows;
        await expectExactRejection(
            access.acquire(binding, encode("fault-store")),
            "codec.invalid",
            "Leased content was not stored"
        );
    });

    test("reports the missing authenticated relation on release", { tags: "p1" }, async () => {
        const database = new InterceptingSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("fault-release"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "fault-release", stored.ref);
        database.transaction(() => retention.retain(database, edge, at(10)));
        let hidden = false;
        database.afterRun = (statement) => {
            if (statement.includes("DELETE FROM content_owner_edges")) hidden = true;
        };
        database.mutateRows = (statement, rows) =>
            hidden && statement.includes("FROM content_relations WHERE ref") ? [] : rows;
        expectExactError(
            () => database.transaction(() => retention.release(database, edge, at(20))),
            "codec.invalid",
            "Authenticated content relation is missing"
        );
    });
});
