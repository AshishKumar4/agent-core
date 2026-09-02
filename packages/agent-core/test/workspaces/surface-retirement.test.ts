import { describe, expect, test } from "vitest";
import {
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { SurfaceDescriptor, SurfaceId, SurfaceRegistration } from "../../src/facets";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import { ContentRetentionId, EventCursor, RetainedRecordRef } from "../../src/workspaces/id";
import { ContentRetentionReference, RetainedRecordKind } from "../../src/workspaces/retention";
import {
    SurfaceEpoch,
    surfaceRevisionKey,
    surfaceStreamKey
} from "../../src/workspaces/surface-epoch";
import {
    TERMINAL_VIEW_PATCH,
    View,
    ViewDelta,
    terminalViewDocument,
    viewDeltaRecordKey,
    viewDocument,
    viewRecordKey
} from "../../src/workspaces/view";
import { ViewReplayProtocol } from "../../src/workspaces/view-replay";
import { attribution } from "../w3/slot-store-contract";
import {
    DeterministicJsonPatchEngine,
    content,
    sourceActor,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

interface Harness {
    readonly records: MemoryWorkspaceRecords;
    readonly persistence: WorkspacePersistence<MemoryWorkspaceRecords>;
    readonly protocol: ViewReplayProtocol<MemoryWorkspaceRecords>;
    readonly released: string[];
}

function harness(): Harness {
    const released: string[] = [];
    const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        {
            verify: () => true,
            retain: () => {},
            release: (_transaction, reference) => released.push(reference.id.value),
            discard: () => {}
        },
        sourceActor,
        tenant
    );
    return {
        records: new MemoryWorkspaceRecords(),
        persistence,
        protocol: new ViewReplayProtocol(
            persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        ),
        released
    };
}

function registration(
    contributor: string,
    surface: SurfaceId,
    version: string
): SurfaceRegistration {
    return new SurfaceRegistration(
        new SurfaceDescriptor(surface, `${surface.value} board`),
        attribution(contributor, version)
    );
}

/** Renders `steps` further revisions on top of the published initial View. */
function render(state: Harness, view: View, steps: number): View {
    let current = view;
    for (let step = 0; step < steps; step += 1) {
        current = state.protocol.publish(
            state.records,
            viewDeltaFixture(current, current.revision.value + 1),
            [],
            []
        );
    }
    return current;
}

describe("Surface retirement and re-registration", () => {
    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] nothing revives a retired epoch and nothing deletes its terminal View",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "revival");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            const head = render(state, first, 2);
            state.persistence.retireSurfaceRegistration(state.records, surface);

            const terminal = state.persistence.currentView(
                state.records,
                surface.value,
                SurfaceEpoch.first()
            );
            expect(terminal?.terminal).toBe(true);
            expect(terminal?.revision.value).toBe(head.revision.value + 1);
            const terminalBytes = View.encode(terminal!);

            // Every public path that could move the retired stream forward refuses.
            expect(() =>
                state.protocol.publishSnapshot(
                    state.records,
                    new View({ ...first, revision: Revision.initial() }),
                    []
                )
            ).toThrow(/is terminal at revision 3/);
            expect(() =>
                state.protocol.publish(state.records, viewDeltaFixture(terminal!), [], [])
            ).toThrow(/is terminal at revision 3/);
            expect(() =>
                state.persistence.retireSurfaceRegistration(state.records, surface)
            ).toThrow(/requires a current registration/);

            // Re-registering and rendering the next epoch leaves the retired one untouched.
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            const second = new View({
                ...first,
                epoch: SurfaceEpoch.first().next(),
                revision: Revision.initial()
            });
            state.protocol.publishSnapshot(state.records, second, []);
            render(state, second, 3);
            state.protocol.compact(state.records, surface, second.epoch, new Revision(2));

            expect(
                View.encode(
                    state.persistence.findView(
                        state.records,
                        surface.value,
                        SurfaceEpoch.first(),
                        terminal!.revision
                    )!
                )
            ).toEqual(terminalBytes);
            expect(
                state.persistence.currentView(state.records, surface.value, SurfaceEpoch.first())
                    ?.terminal
            ).toBe(true);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] a Surface registered but never rendered retires without a stream and keeps its epoch free",
        { tags: "p0" },
        () => {
            const state = harness();
            const surface = new SurfaceId("surface-unrendered");
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.persistence.retireSurfaceRegistration(state.records, surface);

            expect(state.records.listRecords("view")).toEqual([]);
            expect(state.records.listRecords("viewDelta")).toEqual([]);
            expect(state.persistence.currentSurfaceEpoch(state.records, surface.value).value).toBe(
                1
            );

            // The next registration opens the epoch the unrendered one never used.
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            const view = new View({ ...viewFixture(0, "unrendered"), surface });
            state.protocol.publishSnapshot(state.records, view, []);
            expect(
                state.persistence.currentView(state.records, surface.value, SurfaceEpoch.first())
                    ?.revision.value
            ).toBe(0);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] the terminal delta states the exact RFC 6902 change and consumes no Event",
        { tags: "p0" },
        () => {
            const state = harness();
            const initial = viewFixture(0, "terminal-patch");
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", initial.surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, initial, []);
            const head = render(state, initial, 1);
            state.persistence.retireSurfaceRegistration(state.records, initial.surface);

            const deltas = state.persistence.listViewDeltas(
                state.records,
                initial.surface.value,
                SurfaceEpoch.first(),
                head.revision
            );
            expect(deltas).toHaveLength(1);
            const terminalDelta = deltas[0]!;
            expect(terminalDelta.patch).toEqual([{ op: "add", path: "/terminal", value: true }]);
            expect(terminalDelta.cursor.value).toBe(head.cursor.value);
            expect(terminalDelta.epoch.equals(head.epoch)).toBe(true);

            // Applying the durable patch with a real engine rebuilds the durable document.
            const engine = new DeterministicJsonPatchEngine();
            expect(engine.apply(viewDocument(head), TERMINAL_VIEW_PATCH)).toEqual(
                terminalViewDocument(head)
            );
            const terminal = state.persistence.currentView(
                state.records,
                initial.surface.value,
                SurfaceEpoch.first()
            );
            expect(viewDocument(terminal!)).toEqual(terminalViewDocument(head));
            expect(terminal?.body).toEqual(head.body);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] retirement carries the base revision's retention evidence onto the terminal View",
        { tags: "p0" },
        () => {
            const state = harness();
            const attachment = content("terminal-retained");
            const base = viewFixture(0, "terminal-retention");
            const view = new View({ ...base, body: { attachment: attachment.ref.value } });
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", view.surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, view, [
                new ContentRetentionReference({
                    id: new ContentRetentionId("retention-terminal-base"),
                    tenant,
                    actor: sourceActor,
                    recordKind: RetainedRecordKind.view(),
                    record: new RetainedRecordRef(viewRecordKey(view)),
                    content: attachment.ref,
                    digest: attachment.digest
                })
            ]);
            state.persistence.retireSurfaceRegistration(state.records, view.surface);

            const terminal = state.persistence.currentView(
                state.records,
                view.surface.value,
                SurfaceEpoch.first()
            );
            const carried = state.persistence.listRetentionsFor(
                state.records,
                RetainedRecordKind.view(),
                viewRecordKey(terminal!)
            );
            expect(carried.map((reference) => reference.content.value)).toEqual([
                attachment.ref.value
            ]);

            // Compacting the base revision away leaves the terminal View's content retained.
            state.protocol.compact(
                state.records,
                view.surface,
                SurfaceEpoch.first(),
                new Revision(1)
            );
            expect(state.released).toEqual(["retention-terminal-base"]);
            expect(
                state.persistence
                    .listRetentionsFor(
                        state.records,
                        RetainedRecordKind.view(),
                        viewRecordKey(terminal!)
                    )
                    .map((reference) => reference.content.value)
            ).toEqual([attachment.ref.value]);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] resume for a retired epoch returns its terminal revision through the live reader",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "resume");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            render(state, first, 1);
            state.persistence.retireSurfaceRegistration(state.records, surface);
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            const live = new View({
                ...first,
                epoch: SurfaceEpoch.first().next(),
                revision: Revision.initial()
            });
            state.protocol.publishSnapshot(state.records, live, []);

            const retired = state.protocol.replay(
                state.records,
                surface,
                SurfaceEpoch.first(),
                first.cursor
            );
            expect(retired.view.revision.value).toBe(2);
            expect(retired.view.terminal).toBe(true);
            expect(retired.view.epoch.value).toBe(1);
            const resumed = state.protocol.replay(state.records, surface, live.epoch, live.cursor);
            expect(resumed.view.revision.value).toBe(0);
            expect(resumed.view.terminal).toBeUndefined();
            expect(resumed.view.epoch.value).toBe(2);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] a delta chain that does not rebuild the current View falls back to a snapshot within its own epoch",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "divergent");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            const applied = viewDeltaFixture(first, 1);
            const current = state.protocol.publish(state.records, applied, [], []);
            state.persistence.retireSurfaceRegistration(state.records, surface);
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            const live = new View({
                ...first,
                epoch: SurfaceEpoch.first().next(),
                revision: Revision.initial()
            });
            state.protocol.publishSnapshot(state.records, live, []);
            const liveCurrent = state.protocol.publish(
                state.records,
                viewDeltaFixture(live, 5),
                [],
                []
            );

            const diverged = viewDeltaFixture(first, 9);
            const snapshot = state.records.snapshot();
            const tampered = new MemoryWorkspaceRecords({
                ...snapshot,
                records: snapshot.records.map((record) =>
                    record.kind === "viewDelta" && record.id === viewDeltaRecordKey(applied)
                        ? { ...record, bytes: ViewDelta.encode(diverged) }
                        : record
                )
            });

            const fallback = state.protocol.replay(
                tampered,
                surface,
                SurfaceEpoch.first(),
                first.cursor
            );
            expect(fallback.kind).toBe("snapshot");
            expect(fallback.view.revision.value).toBe(current.revision.value + 1);
            expect(fallback.view.terminal).toBe(true);
            const liveReplay = state.protocol.replay(tampered, surface, live.epoch, live.cursor);
            expect(liveReplay.kind).toBe("deltas");
            expect(View.encode(liveReplay.view)).toEqual(View.encode(liveCurrent));
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] compaction is epoch-scoped and refuses to delete terminal evidence",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "compact-epoch");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            render(state, first, 2);
            state.persistence.retireSurfaceRegistration(state.records, surface);
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            const live = new View({
                ...first,
                epoch: SurfaceEpoch.first().next(),
                revision: Revision.initial()
            });
            state.protocol.publishSnapshot(state.records, live, []);
            render(state, live, 3);

            state.protocol.compact(state.records, surface, live.epoch, new Revision(3));

            // The revision key is its own canonical tuple, so a stream key is not a prefix of
            // it. Membership is the honest test of which revisions survived.
            const retiredRevision = (revision: number): string =>
                surfaceRevisionKey(surface.value, SurfaceEpoch.first(), new Revision(revision));
            const retiredKeys = [0, 1, 2, 3].map(retiredRevision);
            expect(
                state.records
                    .listRecords("view")
                    .map((record) => record.id)
                    .filter((id) => retiredKeys.includes(id))
            ).toEqual(retiredKeys);
            const retiredDeltaKeys = [1, 2, 3].map(retiredRevision);
            expect(
                state.records
                    .listRecords("viewDelta")
                    .map((record) => record.id)
                    .filter((id) => retiredDeltaKeys.includes(id))
            ).toEqual(retiredDeltaKeys);

            // A store that presents a revision past the terminal one cannot compact it away.
            const terminalKey = surfaceRevisionKey(
                surface.value,
                SurfaceEpoch.first(),
                new Revision(3)
            );
            const ahead = new View({ ...first, revision: new Revision(4) });
            const snapshot = state.records.snapshot();
            const forged = new MemoryWorkspaceRecords({
                ...snapshot,
                records: [
                    ...snapshot.records,
                    {
                        kind: "view" as const,
                        id: viewRecordKey(ahead),
                        bytes: View.encode(ahead)
                    }
                ],
                pointers: snapshot.pointers.map((pointer) =>
                    pointer.namespace === "view.current" && pointer.recordKey === terminalKey
                        ? { ...pointer, recordKey: viewRecordKey(ahead) }
                        : pointer
                )
            });
            expect(() =>
                state.protocol.compact(forged, surface, SurfaceEpoch.first(), new Revision(4))
            ).toThrow(/keeps its terminal View at revision 3/);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] no stream opens or advances without a current registration for its exact Surface",
        { tags: "p0" },
        () => {
            const state = harness();
            const view = viewFixture(0, "unregistered");
            const surface = view.surface;
            const absent = expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Surface ${surface.value} has no current registration`
            });

            expect(() => state.protocol.publishSnapshot(state.records, view, [])).toThrow(absent);
            expect(state.records.listRecords("view")).toEqual([]);

            // A registration of another Surface is not this Surface's authority.
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:other", new SurfaceId("surface-other"), "1.0.0")
            );
            expect(() => state.protocol.publishSnapshot(state.records, view, [])).toThrow(absent);

            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, view, []);
            const head = render(state, view, 1);

            // A store whose registration pointer is gone while its stream is still live
            // refuses the next revision, delta and snapshot alike.
            const snapshot = state.records.snapshot();
            const unregistered = new MemoryWorkspaceRecords({
                ...snapshot,
                pointers: snapshot.pointers.filter(
                    (pointer) => pointer.namespace !== "surface.registration"
                )
            });
            expect(() =>
                state.protocol.publish(unregistered, viewDeltaFixture(head), [], [])
            ).toThrow(absent);
            expect(() =>
                state.persistence.saveView(
                    unregistered,
                    new View({ ...head, revision: head.revision.next() }),
                    head.revision,
                    []
                )
            ).toThrow(absent);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] retirement alone does not open the next epoch, and reinstallation does",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "reinstall");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            const head = render(state, first, 1);
            state.persistence.retireSurfaceRegistration(state.records, surface);
            const absent = expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Surface ${surface.value} has no current registration`
            });
            const second = new View({
                ...first,
                epoch: SurfaceEpoch.first().next(),
                revision: Revision.initial()
            });

            // Retirement raised the epoch, so the next stream is admissible by revision. The
            // registration is what it still lacks.
            expect(state.persistence.currentSurfaceEpoch(state.records, surface.value).value).toBe(
                2
            );
            expect(() => state.protocol.publishSnapshot(state.records, second, [])).toThrow(absent);
            expect(
                state.persistence.currentView(state.records, surface.value, second.epoch)
            ).toBeUndefined();

            // The retired epoch refuses an ordinary snapshot and an ordinary delta as
            // terminal. That fact is about the stream and outlives the registration.
            const terminal = expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Surface ${surface.value} epoch 1 is terminal at revision 2`
            });
            expect(() =>
                state.protocol.publishSnapshot(
                    state.records,
                    new View({ ...first, revision: Revision.initial() }),
                    []
                )
            ).toThrow(terminal);
            expect(() =>
                state.protocol.publish(state.records, viewDeltaFixture(head, 4), [], [])
            ).toThrow(terminal);

            // Reinstallation admits epoch 2, and retirement's own terminal write lands for
            // that generation too, because it runs before the pointer goes.
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:second", surface, "2.0.0")
            );
            state.protocol.publishSnapshot(state.records, second, []);
            expect(
                state.persistence.currentView(state.records, surface.value, second.epoch)?.revision
                    .value
            ).toBe(0);
            state.persistence.retireSurfaceRegistration(state.records, surface);
            expect(
                state.persistence.currentView(state.records, surface.value, second.epoch)?.terminal
            ).toBe(true);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] a cursor retirement repeated resolves to the lower revision, so the terminal delta still replays",
        { tags: "p0" },
        () => {
            const state = harness();
            const first = viewFixture(0, "repeated-cursor");
            const surface = first.surface;
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:first", surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, first, []);
            const head = render(state, first, 1);
            state.persistence.retireSurfaceRegistration(state.records, surface);

            // The terminal delta consumes no Event, so it repeats the head's cursor and one
            // position names revisions 1 and 2.
            expect(
                state.persistence.findCursorRevision(
                    state.records,
                    surface.value,
                    SurfaceEpoch.first(),
                    head.cursor
                )?.value
            ).toBe(head.revision.value);
            const resumed = state.protocol.replay(
                state.records,
                surface,
                SurfaceEpoch.first(),
                head.cursor
            );
            expect(resumed.kind).toBe("deltas");
            if (resumed.kind !== "deltas") throw new TypeError("Expected durable View deltas");
            expect(resumed.deltas.map((delta) => delta.revision.value)).toEqual([2]);
            expect(resumed.view.terminal).toBe(true);
        }
    );
});

describe("View and ViewDelta codecs", () => {
    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] round-trip at the bumped majors and refuse every other terminal or epoch shape",
        { tags: "p0" },
        () => {
            const epoch = new SurfaceEpoch(4);
            const base = new View({ ...viewFixture(0, "codec"), epoch });
            const terminal = new View({ ...base, terminal: true });
            expect(View.decode(View.encode(terminal)).terminal).toBe(true);
            expect(View.decode(View.encode(terminal)).epoch.equals(epoch)).toBe(true);
            expect(View.decode(View.encode(base)).terminal).toBeUndefined();
            expect(View.encode(View.decode(View.encode(terminal)))).toEqual(View.encode(terminal));

            const delta = viewDeltaFixture(base);
            expect(ViewDelta.decode(ViewDelta.encode(delta)).epoch.equals(epoch)).toBe(true);
            expect(ViewDelta.encode(ViewDelta.decode(ViewDelta.encode(delta)))).toEqual(
                ViewDelta.encode(delta)
            );

            const viewPayload = payloadOf(View.encode(terminal));
            const deltaPayload = payloadOf(ViewDelta.encode(delta));
            expect(() => View.decode(record(View.codec.kind, viewPayload, 2))).toThrow(
                expect.objectContaining({ code: "codec.unknown-major" })
            );
            expect(() => ViewDelta.decode(record(ViewDelta.codec.kind, deltaPayload, 1))).toThrow(
                expect.objectContaining({ code: "codec.unknown-major" })
            );
            expect(() =>
                View.decode(record(View.codec.kind, { ...viewPayload, terminal: false }, 3))
            ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
            expect(() =>
                View.decode(record(View.codec.kind, { ...viewPayload, terminal: null }, 3))
            ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
            expect(() =>
                ViewDelta.decode(
                    record(ViewDelta.codec.kind, { ...deltaPayload, terminal: true }, 2)
                )
            ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
            for (const value of [0, -1, 1.5, "1", null] as const) {
                expect(() =>
                    View.decode(record(View.codec.kind, { ...viewPayload, epoch: value }, 3))
                ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
            }
            expect(() => new SurfaceEpoch(0)).toThrow(TypeError);
            expect(SurfaceEpoch.first().next().equals(new SurfaceEpoch(2))).toBe(true);
            expect(SurfaceEpoch.first().equals(new SurfaceEpoch(2))).toBe(false);
            expect(new SurfaceEpoch(7).text).toBe("7");
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] a patch cannot change the Surface or the epoch of the stream it belongs to",
        { tags: "p0" },
        () => {
            const state = harness();
            const initial = viewFixture(0, "identity-patch");
            state.persistence.putSurfaceRegistration(
                state.records,
                registration("workspace:identity", initial.surface, "1.0.0")
            );
            state.protocol.publishSnapshot(state.records, initial, []);

            // `surface` and `epoch` are absent from the patched document, so naming either is
            // an unknown field rather than a change.
            for (const field of ["surface", "epoch"] as const) {
                const smuggled = new ViewDelta({
                    surface: initial.surface,
                    epoch: initial.epoch,
                    baseRevision: initial.revision,
                    revision: initial.revision.next(),
                    patch: [{ op: "add", path: `/${field}`, value: "smuggled" }],
                    cursor: new EventCursor("cursor-identity-patch")
                });
                expect(() => state.protocol.publish(state.records, smuggled, [], [])).toThrow(
                    /missing or unknown fields/
                );
            }
            const foreign = new ViewDelta({
                surface: initial.surface,
                epoch: initial.epoch.next(),
                baseRevision: initial.revision,
                revision: initial.revision.next(),
                patch: [],
                cursor: initial.cursor
            });
            expect(() => state.protocol.publish(state.records, foreign, [], [])).toThrow(
                expect.objectContaining({ code: "protocol.revision-conflict" })
            );
            expect(
                state.persistence.currentView(state.records, initial.surface.value, initial.epoch)
                    ?.revision.value
            ).toBe(0);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] keys a stream and a revision injectively over unconstrained Surface text",
        { tags: "p0" },
        () => {
            // A SurfaceId is unconstrained text, so a delimiter join is not injective. Each
            // pair below is a distinct (surface, epoch, revision) triple that a joined key
            // would map onto one string, letting two streams answer each other's reads. The
            // canonical tuple keeps all six apart.
            const distinct = new Set([
                surfaceRevisionKey("board", SurfaceEpoch.first(), new Revision(12)),
                surfaceRevisionKey("board@1", SurfaceEpoch.first(), new Revision(2)),
                surfaceRevisionKey("board", new SurfaceEpoch(12), new Revision(1)),
                surfaceRevisionKey('board","x', SurfaceEpoch.first(), new Revision(12)),
                surfaceRevisionKey("board", new SurfaceEpoch(1), new Revision(120)),
                surfaceRevisionKey("board1", SurfaceEpoch.first(), new Revision(2))
            ]);
            expect(distinct.size).toBe(6);

            // The revision key is its own tuple rather than the stream key plus a separator,
            // so a stream key can never be a prefix another key completes.
            const stream = surfaceStreamKey("board", SurfaceEpoch.first());
            expect(
                surfaceRevisionKey("board", SurfaceEpoch.first(), new Revision(0)).startsWith(
                    stream
                )
            ).toBe(false);
            expect(
                new Set([
                    stream,
                    surfaceStreamKey("board@1", SurfaceEpoch.first()),
                    surfaceStreamKey("board", new SurfaceEpoch(12)),
                    surfaceStreamKey("board1", SurfaceEpoch.first())
                ]).size
            ).toBe(4);
        }
    );
});

function payloadOf(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope)) throw new TypeError("Record envelope must be an object");
    const payload = envelope["payload"];
    if (!isJsonObject(payload)) throw new TypeError("Record payload must be an object");
    return payload;
}

function record(kind: string, payload: JsonValue, major: number): Uint8Array {
    return encodeCanonicalJson({ kind, payload, version: { major, minor: 0 } });
}
