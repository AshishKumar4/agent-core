// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    ContentOwnerEdge,
    MemoryContentStore,
    type MemoryContentSnapshot
} from "../../src/content";
import { at, contentOwner, expectAgentCoreError } from "../content/retention-contract";

const bytes = new TextEncoder().encode("retained-across-restart");

describe("memory content retention behavior", () => {
    test("restores ownership after restart and rolls release plus collection back atomically", async () => {
        const owner = contentOwner();
        const first = new MemoryContentStore();
        const firstRetention = first.retention(owner.tenant, owner.actor);
        const stored = await first.put(bytes);
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "durable-owner", stored.ref);
        first.transaction((transaction) => firstRetention.retain(transaction, edge, at(10)));

        const restarted = MemoryContentStore.restore(first.snapshot());
        const retention = restarted.retention(owner.tenant, owner.actor);
        expect(() =>
            restarted.transaction((transaction) => {
                retention.release(transaction, edge, at(20));
                expect(
                    retention.collect(transaction, { allowsCollection: () => true }, at(20))
                ).toEqual([stored.ref]);
                throw new TypeError("crash before commit");
            })
        ).toThrow("crash before commit");

        await expect(restarted.get(stored.ref)).resolves.toEqual(bytes);
        const collected = restarted.transaction((transaction) => {
            retention.release(transaction, edge, at(30));
            return retention.collect(transaction, { allowsCollection: () => true }, at(30));
        });
        expect(collected).toEqual([stored.ref]);
        await expect(restarted.get(stored.ref)).rejects.toMatchObject({
            code: "content.not-found"
        });
    });

    test("rejects a snapshot that retains an owner edge after cached content bytes are lost", async () => {
        const owner = contentOwner();
        const store = new MemoryContentStore();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(bytes);
        const edge = new ContentOwnerEdge(
            owner.tenant,
            owner.actor,
            "lost-cache-owner",
            stored.ref
        );
        store.transaction((transaction) => retention.retain(transaction, edge, at(10)));
        const snapshot = store.snapshot();
        const withoutContent: MemoryContentSnapshot = { ...snapshot, content: [] };

        expectAgentCoreError(() => MemoryContentStore.restore(withoutContent), "codec.invalid");
    });
});
