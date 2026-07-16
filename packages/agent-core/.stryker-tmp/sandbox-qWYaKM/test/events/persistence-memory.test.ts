// @ts-nocheck
import { MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { expect, test } from "vitest";
import { Event, MemoryWorkspaceRecords, WorkspacePersistence } from "../../src/workspaces";
import { eventFixture, sourceActor, tenant } from "../workspaces/fixtures";
import {
    workspacePersistenceContract,
    type WorkspacePersistenceHarness
} from "./persistence-contract";

interface MemoryWorkspaceState {
    readonly records: MemoryWorkspaceRecords;
}

workspacePersistenceContract("memory", createMemoryHarness);

test("memory composite indexes keep NUL-containing tuples distinct", () => {
    const records = new MemoryWorkspaceRecords();
    records.insertUnique({ namespace: "route:A", key: "B\u0000C", recordKey: "first" });
    records.insertUnique({ namespace: "route:A\u0000B", key: "C", recordKey: "second" });

    expect(records.findUnique("route:A", "B\u0000C")?.recordKey).toBe("first");
    expect(records.findUnique("route:A\u0000B", "C")?.recordKey).toBe("second");
});

test("rejects a secondary index pointing to an unrelated valid Event", () => {
    const records = new MemoryWorkspaceRecords();
    const event = eventFixture("wrong-index-owner");
    records.insertRecord({ kind: "event", id: event.id.value, bytes: Event.codec.encode(event) });
    records.insertUnique({
        namespace: "event.idempotency",
        key: "queried-key",
        recordKey: event.id.value
    });
    const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        { verify: () => true, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );

    expect(() => persistence.findEventByIdentity(records, "queried-key")).toThrow(
        expect.objectContaining({ code: "codec.invalid" })
    );
});

function createMemoryHarness(): WorkspacePersistenceHarness<MemoryWorkspaceState> {
    const clone = (state: MemoryWorkspaceState): MemoryWorkspaceState => ({
        records: state.records.clone()
    });
    let store = new MemoryActorStore<MemoryWorkspaceState>(
        { records: new MemoryWorkspaceRecords() },
        clone
    );
    return {
        persistence: new WorkspacePersistence(
            (state) => state.records,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        ),
        transaction<Result>(
            operation: (transaction: MemoryWorkspaceState) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return store.transaction(operation, ...guard);
        },
        restart(): void {
            store = MemoryActorStore.restore(store.snapshot(), clone);
        },
        dispose(): void {}
    };
}
