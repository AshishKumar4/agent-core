import { describe, expect, test } from "vitest";
import { ContentRef, Digest, Revision } from "../../src/core";
import { SurfaceId } from "../../src/facets";
import { EventCursor } from "../../src/workspaces/id";
import { View, ViewDelta } from "../../src/workspaces/view";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import { ViewReplayProtocol } from "../../src/workspaces/view-replay";
import { viewDocument } from "../../src/workspaces/view";
import {
    DeterministicJsonPatchEngine,
    sourceActor,
    tenant,
    viewDeltaFixture,
    viewFixture,
    retentionFixture
} from "./fixtures";

describe("ViewReplayProtocol", () => {
    test("[C13-VIEW-DELTA-REPLAY] delegates RFC 6902 and durably replays deltas", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const engine = new DeterministicJsonPatchEngine();
        const protocol = new ViewReplayProtocol(persistence, engine, sourceActor, tenant);
        const initial = viewFixture(0, "replay");
        const delta = viewDeltaFixture(initial, 9);
        protocol.publishSnapshot(records, initial, []);

        const next = protocol.publish(records, delta, [], []);

        expect(engine.calls).toHaveLength(1);
        expect(engine.calls[0]).toEqual({ document: viewDocument(initial), patch: delta.patch });
        expect(next).toMatchObject({ revision: delta.revision, cursor: delta.cursor });
        expect(next.body).toEqual({ count: 9, nested: { enabled: true } });
        expect(persistence.currentView(records, initial.surface.value)?.body).toEqual(next.body);
        expect(
            persistence.listViewDeltas(records, initial.surface.value, Revision.initial())
        ).toEqual([delta]);

        const restartedRecords = new MemoryWorkspaceRecords(records.snapshot());
        const restartedPersistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const restartedEngine = new DeterministicJsonPatchEngine();
        const restarted = new ViewReplayProtocol(
            restartedPersistence,
            restartedEngine,
            sourceActor,
            tenant
        );
        const replay = restarted.replay(restartedRecords, initial.surface, Revision.initial());

        expect(replay.kind).toBe("deltas");
        if (replay.kind !== "deltas") throw new TypeError("Expected durable View deltas");
        expect(replay.base).toEqual(Revision.initial());
        expect(replay.deltas).toEqual([delta]);
        expect(replay.view.body).toEqual(next.body);
        expect(restartedEngine.calls).toHaveLength(1);
    });

    test("returns an empty delta replay at current revision without invoking the engine", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const engine = new DeterministicJsonPatchEngine();
        const protocol = new ViewReplayProtocol(persistence, engine, sourceActor, tenant);
        const current = viewFixture(0, "current");
        protocol.publishSnapshot(records, current, []);

        expect(protocol.replay(records, current.surface, current.revision)).toEqual({
            kind: "deltas",
            base: current.revision,
            deltas: [],
            view: current
        });
        expect(engine.calls).toEqual([]);
    });

    test("falls back to the durable snapshot when the requested base is unavailable", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const initial = viewFixture(0, "snapshot-fallback");
        protocol.publishSnapshot(records, initial, []);
        const current = protocol.publish(records, viewDeltaFixture(initial), [], []);
        const snapshot = records.snapshot();
        const withoutBase = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.filter(
                (record) => !(record.kind === "view" && record.id === `${initial.surface.value}@0`)
            )
        });

        expect(protocol.replay(withoutBase, initial.surface, Revision.initial())).toEqual({
            kind: "snapshot",
            view: current
        });
    });

    test("does not persist a delta when the injected engine rejects it", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            {
                apply(): never {
                    throw new TypeError("patch rejected");
                }
            },
            sourceActor,
            tenant
        );
        const initial = viewFixture(0, "rejected-patch");
        const delta = viewDeltaFixture(initial);
        protocol.publishSnapshot(records, initial, []);

        expect(() => protocol.publish(records, delta, [], [])).toThrow(/patch rejected/);
        expect(persistence.currentView(records, initial.surface.value)).toEqual(initial);
        expect(
            persistence.listViewDeltas(records, initial.surface.value, Revision.initial())
        ).toEqual([]);
    });

    test("rejects stale publishes and replay revisions ahead of durable state", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const initial = viewFixture(0, "stale");
        const delta = viewDeltaFixture(initial);
        protocol.publishSnapshot(records, initial, []);
        protocol.publish(records, delta, [], []);

        expect(() => protocol.publish(records, delta, [], [])).toThrow(/base revision is stale/);
        expect(() => protocol.replay(records, initial.surface, new Revision(2))).toThrow(
            /ahead of the current View/
        );
    });

    test("requires exact durable retention for every View ContentRef", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const digest = Digest.sha256(new TextEncoder().encode("view-content"));
        const ref = ContentRef.fromDigest(digest);
        const base = viewFixture(0, "retained");
        const view = new View({
            ...base,
            body: { attachment: ref.value }
        });
        expect(() => protocol.publishSnapshot(records, view, [])).toThrow(/does not cover/);
        const retention = retentionFixture({
            actor: sourceActor,
            id: "retention-view",
            recordKind: "view",
            recordId: `${view.surface.value}@0`,
            content: { ref, digest }
        });
        expect(() => protocol.publishSnapshot(records, view, [retention])).not.toThrow();
    });

    test("retains ContentRefs present only in durable ViewDelta operations", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const initial = viewFixture(0, "delta-retained");
        protocol.publishSnapshot(records, initial, []);
        const digest = Digest.sha256(new TextEncoder().encode("delta-only"));
        const ref = ContentRef.fromDigest(digest);
        const delta = new ViewDelta({
            surface: initial.surface,
            baseRevision: initial.revision,
            revision: initial.revision.next(),
            patch: [
                {
                    op: "replace",
                    path: "/body/count",
                    value: 1,
                    metadata: ref.value
                }
            ],
            cursor: new EventCursor("cursor-delta-retained")
        });
        expect(() => protocol.publish(records, delta, [], [])).toThrow(
            /ViewDelta content retention/
        );
        const retention = retentionFixture({
            actor: sourceActor,
            id: "retention-delta-only",
            recordKind: "viewDelta",
            recordId: `${delta.surface.value}@1`,
            content: { ref, digest }
        });
        expect(() => protocol.publish(records, delta, [], [retention])).not.toThrow();
    });

    test("compacts old snapshots and deltas while preserving bounded replay", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            { verify: () => true, release: () => {}, discard: () => {} },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        let view = viewFixture(0, "compact");
        protocol.publishSnapshot(records, view, []);
        for (let count = 1; count <= 3; count += 1) {
            view = protocol.publish(records, viewDeltaFixture(view, count), [], []);
        }
        protocol.compact(records, view.surface, new Revision(2));

        expect(
            persistence.findView(records, view.surface.value, Revision.initial())
        ).toBeUndefined();
        expect(protocol.replay(records, view.surface, Revision.initial()).kind).toBe("snapshot");
        const fromFloor = protocol.replay(records, view.surface, new Revision(2));
        expect(fromFloor.kind).toBe("deltas");
        if (fromFloor.kind === "deltas") {
            expect(fromFloor.deltas.map((delta) => delta.revision.value)).toEqual([3]);
        }
    });

    test("compaction is Surface-exact and releases obsolete retention references", () => {
        const records = new MemoryWorkspaceRecords();
        const released: string[] = [];
        const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            {
                verify: () => true,
                release: (_transaction, reference) => released.push(reference.id.value),
                discard: () => {}
            },
            sourceActor,
            tenant
        );
        const protocol = new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const digest = Digest.sha256(new TextEncoder().encode("compacted-content"));
        const ref = ContentRef.fromDigest(digest);
        const base = viewFixture(0, "surface-prefix-base");
        const initial = new View({
            ...base,
            surface: new SurfaceId("a"),
            body: { count: 0, nested: { enabled: true }, ref: ref.value }
        });
        const other = new View({ ...base, surface: new SurfaceId("a@b") });
        const retention0 = retentionFixture({
            actor: sourceActor,
            id: "retention-compact-view-0",
            recordKind: "view",
            recordId: "a@0",
            content: { ref, digest }
        });
        protocol.publishSnapshot(records, initial, [retention0]);
        protocol.publishSnapshot(records, other, []);
        const delta = viewDeltaFixture(initial, 1);
        const retention1 = retentionFixture({
            actor: sourceActor,
            id: "retention-compact-view-1",
            recordKind: "view",
            recordId: "a@1",
            content: { ref, digest }
        });
        protocol.publish(records, delta, [retention1], []);
        protocol.compact(records, initial.surface, new Revision(1));

        expect(persistence.currentView(records, other.surface.value)).toEqual(other);
        expect(released).toEqual([retention0.id.value]);
        expect(records.listRecords("contentRetention").map((record) => record.id)).toEqual([
            retention1.id.value
        ]);
    });
});
