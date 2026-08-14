import { expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    ContentOwnerEdge,
    type MemoryContentRetentionState,
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

interface RetentionHarness<Transaction> {
    readonly store: ContentStore;
    readonly retention: ContentRetention<Transaction>;
    transaction(operation: (transaction: Transaction) => void): void;
}

async function verifyRetention<Transaction>(
    harness: RetentionHarness<Transaction>,
    ownerKey: string
): Promise<void> {
    const stored = await harness.store.put(bytes);
    const edge = new ContentOwnerEdge(tenant, actor, ownerKey, stored.ref);
    harness.transaction((transaction) => {
        harness.retention.retain(transaction, edge, new Date(1));
        harness.retention.release(transaction, edge, new Date(2));
    });
    expect(await harness.store.get(stored.ref)).toEqual(bytes);
}

test(
    "[content-store] memory and SQLite satisfy one shared content contract",
    { tags: "p1" },
    async () => {
        const stores: readonly ContentStore[] = [
            new MemoryContentStore(),
            new SqliteContentStore(new TestSqlite())
        ];
        for (const store of stores) {
            const stored = await store.put(bytes);
            expect(await store.get(stored.ref)).toEqual(bytes);
            expect((await store.stat(stored.ref))?.digest.equals(stored.digest)).toBe(true);
        }
    }
);

test(
    "[content-retention] memory and SQLite satisfy one shared ownership contract",
    { tags: "p1" },
    async () => {
        const memoryStore = new MemoryContentStore();
        const database = new TestSqlite();
        const sqliteStore = new SqliteContentStore(database);

        await verifyRetention<MemoryContentRetentionState>(
            {
                store: memoryStore,
                retention: memoryStore.retention(tenant, actor),
                transaction: (operation) => memoryStore.transaction(operation)
            },
            "record:memory"
        );
        await verifyRetention<TransactionalSqlite>(
            {
                store: sqliteStore,
                retention: sqliteStore.retention(tenant, actor),
                transaction: (operation) => database.transaction(() => operation(database))
            },
            "record:sqlite"
        );
    }
);
