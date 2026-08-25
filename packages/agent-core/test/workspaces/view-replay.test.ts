import { describe, expect, test } from "vitest";
import { ContentRef, Digest, Revision } from "../../src/core";
import { SurfaceId } from "../../src/facets";
import { EventCursor } from "../../src/workspaces/id";
import { View, ViewDelta, ViewMark } from "../../src/workspaces/view";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import { ViewReplayProtocol } from "../../src/workspaces/view-replay";
import { viewDocument } from "../../src/workspaces/view";
import { SurfaceEpoch, surfaceRevisionKey } from "../../src/workspaces/surface-epoch";
import { viewDeltaRecordKey, viewRecordKey } from "../../src/workspaces/view";
import {
    DeterministicJsonPatchEngine,
    registerSurface,
    sourceActor,
    tenant,
    viewDeltaFixture,
    viewFixture,
    retentionFixture
} from "./fixtures";

describe("ViewReplayProtocol", () => {
    test(
        "[C13-VIEW-DELTA-REPLAY] delegates RFC 6902 and durably replays deltas",
        { tags: "p1" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
                (value) => value,
                { verify: () => true, release: () => {}, discard: () => {} },
                sourceActor,
                tenant
            );
            const engine = new DeterministicJsonPatchEngine();
            const protocol = new ViewReplayProtocol(persistence, engine, sourceActor, tenant);
            const base = viewFixture(0, "replay");
            const intentDigest = Digest.sha256(new TextEncoder().encode("replay-decision"));
            const initial = new View({
                ...base,
                intentDigest,
                marks: [new ViewMark("/count", "external")]
            });
            const delta = viewDeltaFixture(initial, 9);
            registerSurface(persistence, records, initial.surface);
            protocol.publishSnapshot(records, initial, []);

            const next = protocol.publish(records, delta, [], []);

            expect(engine.calls).toHaveLength(1);
            expect(engine.calls[0]).toEqual({
                document: viewDocument(initial),
                patch: delta.patch
            });
            expect(next).toMatchObject({ revision: delta.revision, cursor: delta.cursor });
            expect(next.body).toEqual({ count: 9, nested: { enabled: true } });
            expect(
                persistence.currentView(records, initial.surface.value, SurfaceEpoch.first())?.body
            ).toEqual(next.body);
            expect(
                persistence.listViewDeltas(
                    records,
                    initial.surface.value,
                    SurfaceEpoch.first(),
                    Revision.initial()
                )
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
            const replay = restarted.replay(
                restartedRecords,
                initial.surface,
                SurfaceEpoch.first(),
                initial.cursor
            );

            expect(replay.kind).toBe("deltas");
            if (replay.kind !== "deltas") throw new TypeError("Expected durable View deltas");
            expect(replay.base).toEqual(Revision.initial());
            expect(replay.deltas).toEqual([delta]);
            expect(replay.view.body).toEqual(next.body);
            expect(replay.view.intentDigest?.equals(intentDigest)).toBe(true);
            expect(replay.view.marks).toEqual([new ViewMark("/count", "external")]);
            expect(restartedEngine.calls).toHaveLength(1);
        }
    );

    test(
        "returns an empty delta replay at current revision without invoking the engine",
        { tags: "p1" },
        () => {
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
            registerSurface(persistence, records, current.surface);
            protocol.publishSnapshot(records, current, []);

            expect(
                protocol.replay(records, current.surface, SurfaceEpoch.first(), current.cursor)
            ).toEqual({
                kind: "deltas",
                base: current.revision,
                deltas: [],
                view: current
            });
            expect(engine.calls).toEqual([]);
        }
    );

    test(
        "[C13-VIEW-DELTA-REPLAY] refuses a cursor this stream never carried and one another stream issued",
        { tags: "p0" },
        () => {
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
            const own = new View({
                ...viewFixture(0, "cursor-own"),
                cursor: new EventCursor("cursor-own-0")
            });
            const foreign = new View({
                ...viewFixture(0, "cursor-foreign"),
                cursor: new EventCursor("cursor-foreign-0")
            });
            registerSurface(persistence, records, own.surface);
            registerSurface(persistence, records, foreign.surface, "workspace:foreign");
            protocol.publishSnapshot(records, own, []);
            protocol.publishSnapshot(records, foreign, []);

            // A cursor no record of this stream carries has no position in it, whether it was
            // never issued or belongs to a Surface next door.
            for (const cursor of [new EventCursor("cursor-invented"), foreign.cursor]) {
                expect(() =>
                    protocol.replay(records, own.surface, SurfaceEpoch.first(), cursor)
                ).toThrow(
                    expect.objectContaining({
                        code: "protocol.invalid-state",
                        message: `Event cursor ${cursor.value} is not a position in Surface ${own.surface.value} epoch 1`
                    })
                );
            }
            // The refusal is about the stream, not the cursor: its own stream still answers.
            expect(
                protocol.replay(records, foreign.surface, SurfaceEpoch.first(), foreign.cursor).view
                    .surface.value
            ).toBe(foreign.surface.value);
        }
    );

    test(
        "falls back to the durable snapshot when the requested base is unavailable",
        { tags: "p1" },
        () => {
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
            registerSurface(persistence, records, initial.surface);
            protocol.publishSnapshot(records, initial, []);
            const middle = protocol.publish(records, viewDeltaFixture(initial), [], []);
            const current = protocol.publish(records, viewDeltaFixture(middle), [], []);
            const snapshot = records.snapshot();
            const withoutBase = new MemoryWorkspaceRecords({
                ...snapshot,
                records: snapshot.records.filter(
                    (record) =>
                        !(
                            record.kind === "view" &&
                            record.id ===
                                surfaceRevisionKey(
                                    initial.surface.value,
                                    initial.epoch,
                                    middle.revision
                                )
                        )
                )
            });

            // The ViewDelta that produced the revision still carries its cursor, so the position
            // resolves while the snapshot it named is gone, and replay answers with a snapshot.
            expect(
                protocol.replay(withoutBase, initial.surface, SurfaceEpoch.first(), middle.cursor)
            ).toEqual({
                kind: "snapshot",
                view: current
            });
        }
    );

    test("does not persist a delta when the injected engine rejects it", { tags: "p1" }, () => {
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
        registerSurface(persistence, records, initial.surface);
        protocol.publishSnapshot(records, initial, []);

        expect(() => protocol.publish(records, delta, [], [])).toThrow(/patch rejected/);
        expect(
            persistence.currentView(records, initial.surface.value, SurfaceEpoch.first())
        ).toEqual(initial);
        expect(
            persistence.listViewDeltas(
                records,
                initial.surface.value,
                SurfaceEpoch.first(),
                Revision.initial()
            )
        ).toEqual([]);
    });

    test(
        "rejects stale publishes and replay revisions ahead of durable state",
        { tags: "p1" },
        () => {
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
            registerSurface(persistence, records, initial.surface);
            protocol.publishSnapshot(records, initial, []);
            protocol.publish(records, delta, [], []);

            expect(() => protocol.publish(records, delta, [], [])).toThrow(
                /base revision is stale/
            );

            // A stored record above the stream pointer is a store that disagrees with itself, so
            // the position it names is refused rather than answered from the older View.
            const ahead = viewDeltaFixture(new View({ ...initial, revision: new Revision(2) }), 3);
            records.insertRecord({
                kind: "viewDelta",
                id: viewDeltaRecordKey(ahead),
                bytes: ViewDelta.encode(ahead)
            });
            expect(() =>
                protocol.replay(records, initial.surface, SurfaceEpoch.first(), ahead.cursor)
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Resumed position is ahead of the current View"
                })
            );
        }
    );

    test("requires exact durable retention for every View ContentRef", { tags: "p0" }, () => {
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
        registerSurface(persistence, records, view.surface);
        expect(() => protocol.publishSnapshot(records, view, [])).toThrow(/does not cover/);
        const retention = retentionFixture({
            actor: sourceActor,
            id: "retention-view",
            recordKind: "view",
            recordId: viewRecordKey(view),
            content: { ref, digest }
        });
        expect(() => protocol.publishSnapshot(records, view, [retention])).not.toThrow();
    });

    test("retains ContentRefs present only in durable ViewDelta operations", { tags: "p0" }, () => {
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
        registerSurface(persistence, records, initial.surface);
        protocol.publishSnapshot(records, initial, []);
        const digest = Digest.sha256(new TextEncoder().encode("delta-only"));
        const ref = ContentRef.fromDigest(digest);
        const delta = new ViewDelta({
            surface: initial.surface,
            epoch: initial.epoch,
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
            recordId: viewDeltaRecordKey(delta),
            content: { ref, digest }
        });
        expect(() => protocol.publish(records, delta, [], [retention])).not.toThrow();
    });

    test(
        "compacts old snapshots and deltas while preserving bounded replay",
        { tags: "p0" },
        () => {
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
            const opened = viewFixture(0, "compact");
            registerSurface(persistence, records, opened.surface);
            protocol.publishSnapshot(records, opened, []);
            const first = protocol.publish(records, viewDeltaFixture(opened, 1), [], []);
            const floor = protocol.publish(records, viewDeltaFixture(first, 2), [], []);
            const head = protocol.publish(records, viewDeltaFixture(floor, 3), [], []);
            protocol.compact(records, head.surface, SurfaceEpoch.first(), floor.revision);

            expect(
                persistence.findView(
                    records,
                    head.surface.value,
                    SurfaceEpoch.first(),
                    Revision.initial()
                )
            ).toBeUndefined();
            // Compaction released the opening position, so resuming from it is refused rather
            // than silently rebased onto the current View.
            expect(() =>
                protocol.replay(records, head.surface, SurfaceEpoch.first(), opened.cursor)
            ).toThrow(/is not a position in Surface/);
            const fromFloor = protocol.replay(
                records,
                head.surface,
                SurfaceEpoch.first(),
                floor.cursor
            );
            expect(fromFloor.kind).toBe("deltas");
            if (fromFloor.kind === "deltas") {
                expect(fromFloor.deltas.map((delta) => delta.revision.value)).toEqual([3]);
            }
        }
    );

    test(
        "compaction is Surface-exact and releases obsolete retention references",
        { tags: "p0" },
        () => {
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
                recordId: viewRecordKey(initial),
                content: { ref, digest }
            });
            registerSurface(persistence, records, initial.surface);
            registerSurface(persistence, records, other.surface, "workspace:other-surface");
            protocol.publishSnapshot(records, initial, [retention0]);
            protocol.publishSnapshot(records, other, []);
            const delta = viewDeltaFixture(initial, 1);
            const retention1 = retentionFixture({
                actor: sourceActor,
                id: "retention-compact-view-1",
                recordKind: "view",
                recordId: viewDeltaRecordKey(delta),
                content: { ref, digest }
            });
            protocol.publish(records, delta, [retention1], []);
            protocol.compact(records, initial.surface, SurfaceEpoch.first(), new Revision(1));

            expect(
                persistence.currentView(records, other.surface.value, SurfaceEpoch.first())
            ).toEqual(other);
            expect(released).toEqual([retention0.id.value]);
            expect(records.listRecords("contentRetention").map((record) => record.id)).toEqual([
                retention1.id.value
            ]);
        }
    );
});

describe("replay divergence detection", () => {
    test("falls back to the durable snapshot when replay bytes diverge", { tags: "p1" }, () => {
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
        const initial = viewFixture(0, "diverged");
        const delta = viewDeltaFixture(initial, 9);
        registerSurface(persistence, records, initial.surface);
        protocol.publishSnapshot(records, initial, []);
        protocol.publish(records, delta, [], []);

        const divergent = new View({
            surface: initial.surface,
            epoch: initial.epoch,
            revision: delta.revision,
            body: { count: 7, nested: { enabled: true } },
            actions: initial.actions,
            cursor: delta.cursor
        });
        const snapshot = records.snapshot();
        const currentId = surfaceRevisionKey(initial.surface.value, initial.epoch, delta.revision);
        const stored = snapshot.records.find(
            (record) => record.kind === "view" && record.id === currentId
        );
        const divergentBytes = View.codec.encode(divergent);
        expect(stored).toBeDefined();
        expect(divergentBytes.byteLength).toBe(stored?.bytes.byteLength);
        const tampered = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.map((record) =>
                record.kind === "view" && record.id === currentId
                    ? { ...record, bytes: divergentBytes }
                    : record
            )
        });

        const replay = protocol.replay(
            tampered,
            initial.surface,
            SurfaceEpoch.first(),
            initial.cursor
        );
        expect(replay.kind).toBe("snapshot");
        expect(replay.view.body).toEqual({ count: 7, nested: { enabled: true } });
    });
});
