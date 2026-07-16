// @ts-nocheck
import { expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    ContentOwnerEdge,
    MemoryContentStore,
    type ContentRetention,
    type ContentStore
} from "../../src/content";
import { TenantId } from "../../src/identity";
import { SqliteContentStore, type TransactionalSqlite } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const tenant = new TenantId("content-seam-tenant");
const actor = new ActorRef("workspace", new ActorId("content-seam-actor"));
const bytes = new TextEncoder().encode("shared content seam");

interface RetentionHarness {
    readonly store: ContentStore;
    readonly retention: ContentRetention<unknown>;
    transaction(operation: (transaction: unknown) => void): void;
}

test("[content-store] memory and SQLite satisfy one shared content contract", async () => {
    const stores: readonly ContentStore[] = [
        new MemoryContentStore(),
        new SqliteContentStore(new TestSqlite())
    ];
    for (const store of stores) {
        const stored = await store.put(bytes);
        expect(await store.get(stored.ref)).toEqual(bytes);
        expect((await store.stat(stored.ref))?.digest.equals(stored.digest)).toBe(true);
    }
});

test("[content-retention] memory and SQLite satisfy one shared ownership contract", async () => {
    const memoryStore = new MemoryContentStore();
    const database = new TestSqlite();
    const sqliteStore = new SqliteContentStore(database);
    const harnesses: readonly RetentionHarness[] = [
        {
            store: memoryStore,
            retention: memoryStore.retention(tenant, actor) as ContentRetention<unknown>,
            transaction: (operation) => memoryStore.transaction(operation)
        },
        {
            store: sqliteStore,
            retention: sqliteStore.retention(tenant, actor) as ContentRetention<unknown>,
            transaction: (operation) =>
                database.transaction(() => operation(database as TransactionalSqlite))
        }
    ];

    for (const [index, harness] of harnesses.entries()) {
        const stored = await harness.store.put(bytes);
        const edge = new ContentOwnerEdge(tenant, actor, `record:${index}`, stored.ref);
        harness.transaction((transaction) => {
            harness.retention.retain(transaction, edge, new Date(1));
            harness.retention.release(transaction, edge, new Date(2));
        });
        expect(await harness.store.get(stored.ref)).toEqual(bytes);
    }
});
