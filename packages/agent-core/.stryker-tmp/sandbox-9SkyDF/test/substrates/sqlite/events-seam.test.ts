// @ts-nocheck
import { expect, test } from "vitest";
import { SqliteWorkspaceEventRecords } from "../../../src/substrates/sqlite/events/records";
import { MemoryWorkspaceRecords, type WorkspaceRecordStorage } from "../../../src/workspaces";
import { TestSqlite } from "../../helpers/sqlite";

test(
    "[workspace-record-storage] memory and SQLite satisfy the shared storage contract",
    verifyWorkspaceStorage
);

test(
    "[workspace.event] [workspace.subscription] [workspace.route-reservation] [workspace.route-projection] [workspace.route-delivery] [workspace.view] [workspace.view-delta] [workspace.content-retention-reference] durable records use the shared memory and SQLite storage contract",
    verifyWorkspaceStorage
);

function verifyWorkspaceStorage(): void {
    const stores: readonly WorkspaceRecordStorage[] = [
        new MemoryWorkspaceRecords(),
        new SqliteWorkspaceEventRecords(new TestSqlite())
    ];
    for (const [index, store] of stores.entries()) {
        const id = `event-${index}`;
        store.insertRecord({ kind: "event", id, bytes: Uint8Array.of(index) });
        expect(store.findRecord("event", id)).toEqual({
            kind: "event",
            id,
            bytes: Uint8Array.of(index)
        });
        expect(store.listRecords("event").map((record) => record.id)).toEqual([id]);
        store.insertUnique({ namespace: "event.idempotency", key: id, recordKey: id });
        expect(store.findUnique("event.idempotency", id)?.recordKey).toBe(id);
        expect(() =>
            store.insertUnique({
                namespace: "event.idempotency",
                key: id,
                recordKey: "other"
            })
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        store.insertRecord({ kind: "view", id: `surface-${index}@0`, bytes: Uint8Array.of(0) });
        store.compareAndSetPointer(
            {
                namespace: "view.current",
                key: `surface-${index}`,
                recordKey: `surface-${index}@0`
            },
            undefined
        );
        store.insertRecord({ kind: "view", id: `surface-${index}@1`, bytes: Uint8Array.of(1) });
        store.compareAndSetPointer(
            {
                namespace: "view.current",
                key: `surface-${index}`,
                recordKey: `surface-${index}@1`
            },
            `surface-${index}@0`
        );
        expect(store.findPointer("view.current", `surface-${index}`)?.recordKey).toBe(
            `surface-${index}@1`
        );
        store.deleteCompactedRecords("view", [`surface-${index}@0`]);
        expect(store.findRecord("view", `surface-${index}@0`)).toBeUndefined();
    }
}
