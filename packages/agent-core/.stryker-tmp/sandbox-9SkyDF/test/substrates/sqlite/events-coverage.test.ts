// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { MemoryActorStore, type SynchronousResultGuard } from "../../../src/actors";
import { Revision } from "../../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../../src/errors";
import { SurfaceId } from "../../../src/facets";
import { TenantId } from "../../../src/identity";
import { SqliteWorkspaceEventRecords } from "../../../src/substrates/sqlite/events/records";
import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite/sqlite";
import {
    ContentRetentionReference,
    type CompactableWorkspaceRecordKind,
    Event,
    EventCursor,
    EventId,
    MemoryWorkspaceRecords,
    RouteDelivery,
    RouteProjection,
    RouteProjectionId,
    RouteReservation,
    RouteReservationId,
    Subscription,
    SubscriptionId,
    View,
    ViewDelta,
    ViewReplayProtocol,
    WorkspacePersistence,
    type StoredWorkspacePointer,
    type StoredWorkspaceRecord,
    type StoredWorkspaceUnique,
    type WorkspaceRecordKind,
    type WorkspaceRecordStorage
} from "../../../src/workspaces";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";
import {
    DeterministicJsonPatchEngine,
    authenticatedProjectionFixture,
    content,
    deliveryFixture,
    eventFixture,
    eventRetention,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    retentionFixture,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "../../workspaces/fixtures";

interface HarnessOptions {
    readonly verify?: (reference: ContentRetentionReference) => boolean;
    readonly released?: ContentRetentionReference[];
}

interface StorageHarness {
    readonly persistence: WorkspacePersistence<WorkspaceRecordStorage>;
    transaction<Result>(
        operation: (storage: WorkspaceRecordStorage) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    restart(): void;
    dispose(): void;
}

type HarnessFactory = (options?: HarnessOptions) => StorageHarness;

const encoder = new TextEncoder();

const factories: readonly [string, HarnessFactory][] = [
    ["memory", createMemoryHarness],
    ["SQLite", createSqliteHarness]
];

describe("workspace storage parity", () => {
    test("memory and SQLite expose the same complete record/index/pointer trace", () => {
        const memoryStorage = createMemoryHarness();
        const sqliteStorage = createSqliteHarness();
        const memoryPersistence = createMemoryHarness();
        const sqlitePersistence = createSqliteHarness();
        try {
            const memoryTrace = runStorageTrace(memoryStorage);
            expect(runStorageTrace(sqliteStorage)).toEqual(memoryTrace);
            expect(memoryTrace.errors).toEqual({
                invalidLengths: Array.from({ length: 14 }, () => "codec.invalid"),
                invalidBytes: "codec.invalid",
                duplicateRecord: "protocol.duplicate",
                duplicateUnique: "protocol.duplicate",
                pointerConflict: "protocol.revision-conflict",
                invalidPointerNamespace: "protocol.invalid-state",
                malformedPointerRecord: "codec.invalid",
                invalidInitialRevision: "protocol.revision-conflict",
                invalidRevisionAdvance: "protocol.revision-conflict"
            });
            expect(runPersistenceTrace(sqlitePersistence, "trace")).toEqual(
                runPersistenceTrace(memoryPersistence, "trace")
            );
        } finally {
            memoryStorage.dispose();
            sqliteStorage.dispose();
            memoryPersistence.dispose();
            sqlitePersistence.dispose();
        }
    });

    test.each(factories)("%s rolls back every Event write boundary", (_name, create) => {
        for (const boundary of [1, 2, 3]) {
            const harness = create();
            const event = eventFixture(`event-boundary-${boundary}`);
            expect(() =>
                harness.transaction((storage) => {
                    const faulting = new FaultingStorage(storage, boundary);
                    newPersistence().appendEvent(faulting, event, eventRetention(event));
                })
            ).toThrow(`storage fault ${boundary}`);
            harness.transaction((storage) => {
                expect(storage.listRecords("contentRetention")).toEqual([]);
                expect(storage.listRecords("event")).toEqual([]);
                expect(
                    storage.findUnique("event.idempotency", event.idempotencyKey)
                ).toBeUndefined();
            });
            harness.dispose();
        }
    });

    test.each(factories)("%s rolls back every View delta write boundary", (_name, create) => {
        for (const boundary of [1, 2, 3]) {
            const harness = create();
            const initial = viewFixture(0, `delta-boundary-${boundary}`);
            const delta = viewDeltaFixture(initial);
            harness.transaction((storage) =>
                harness.persistence.saveView(storage, initial, undefined, [])
            );
            expect(() =>
                harness.transaction((storage) => {
                    const faulting = new FaultingStorage(storage, boundary);
                    newPersistence().appendViewDelta(
                        faulting,
                        delta,
                        new DeterministicJsonPatchEngine(),
                        [],
                        []
                    );
                })
            ).toThrow(`storage fault ${boundary}`);
            harness.transaction((storage) => {
                expect(harness.persistence.currentView(storage, initial.surface.value)).toEqual(
                    initial
                );
                expect(storage.findRecord("view", `${initial.surface.value}@1`)).toBeUndefined();
                expect(storage.listRecords("viewDelta")).toEqual([]);
            });
            harness.dispose();
        }
    });

    test.each(factories)(
        "%s reconciles a committed write after an unknown acknowledgement and restart",
        (_name, create) => {
            const harness = create();
            const event = eventFixture("unknown-ack-storage");
            harness.transaction((storage) => {
                harness.persistence.appendEvent(storage, event, eventRetention(event));
            });
            harness.restart();

            expect(() =>
                harness.transaction((storage) => {
                    harness.persistence.appendEvent(
                        storage,
                        event,
                        eventRetention(event, "unknown-ack-retry-retention")
                    );
                })
            ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
            harness.transaction((storage) => {
                expect(
                    harness.persistence.findEventByIdentity(storage, event.idempotencyKey)?.id
                ).toEqual(event.id);
                expect(storage.listRecords("event")).toHaveLength(1);
            });
            harness.dispose();
        }
    );
});

describe.each(factories)("%s persistence corruption coverage", (_name, create) => {
    test("covers orphan listing, sort callbacks, multi-delta ordering, and every CAS operand", () => {
        const harness = create();
        harness.transaction((storage) => {
            const orphan = subscriptionFixture(`orphan-${_name}`);
            storage.insertRecord(
                stored("subscription", `${orphan.id.value}@0`, Subscription.codec.encode(orphan))
            );
            expect(harness.persistence.listSubscriptions(storage)).toEqual([]);

            const later = subscriptionFixture(`z-list-${_name}`);
            const earlier = subscriptionFixture(`a-list-${_name}`);
            harness.persistence.saveSubscription(storage, later, undefined);
            harness.persistence.saveSubscription(storage, earlier, undefined);
            expect(
                harness.persistence.listSubscriptions(storage).map((value) => value.id.value)
            ).toEqual([earlier.id.value, later.id.value].sort());

            const nonzero = subscriptionFixture(`nonzero-${_name}`, { revision: new Revision(1) });
            expect(() => harness.persistence.saveSubscription(storage, nonzero, undefined)).toThrow(
                expect.objectContaining({ code: "protocol.revision-conflict" })
            );
            const missingUpdate = subscriptionFixture(`missing-update-${_name}`, {
                revision: new Revision(1)
            });
            expect(() =>
                harness.persistence.saveSubscription(storage, missingUpdate, Revision.initial())
            ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));

            const missingView = viewFixture(1, `missing-update-${_name}`);
            expect(() =>
                harness.persistence.saveView(storage, missingView, Revision.initial(), [])
            ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
            const nonzeroView = viewFixture(1, `nonzero-${_name}`);
            expect(() => harness.persistence.saveView(storage, nonzeroView, undefined, [])).toThrow(
                expect.objectContaining({ code: "protocol.revision-conflict" })
            );

            const initial = viewFixture(0, `ordered-deltas-${_name}`);
            const revisionOne = new View({ ...initial, revision: new Revision(1) });
            harness.persistence.saveView(storage, initial, undefined, []);
            harness.persistence.saveView(storage, revisionOne, initial.revision, []);
            const deltaTwo = viewDeltaFixture(revisionOne, 2);
            const revisionTwo = harness.persistence.appendViewDelta(
                storage,
                deltaTwo,
                new DeterministicJsonPatchEngine(),
                [],
                []
            );
            const deltaThree = viewDeltaFixture(revisionTwo, 3);
            harness.persistence.appendViewDelta(
                storage,
                deltaThree,
                new DeterministicJsonPatchEngine(),
                [],
                []
            );
            expect(
                harness.persistence
                    .listViewDeltas(storage, initial.surface.value, Revision.initial())
                    .map((delta) => delta.revision.value)
            ).toEqual([2, 3]);
        });
        harness.dispose();
    });

    test("rejects every missing authoritative index and pointer target", () => {
        const harness = create();
        harness.transaction((storage) => {
            storage.insertUnique({
                namespace: "event.idempotency",
                key: "missing-event",
                recordKey: "missing-event-record"
            });
            storage.insertUnique({
                namespace: "route.dedupe:missing-subscription",
                key: "missing-route",
                recordKey: "missing-reservation-record"
            });
            storage.insertUnique({
                namespace: "route.projection",
                key: "missing-reservation",
                recordKey: "missing-projection-record"
            });
            storage.insertUnique({
                namespace: "route.delivery",
                key: "missing-delivery",
                recordKey: "missing-delivery-record"
            });
            storage.compareAndSetPointer(
                {
                    namespace: "subscription.current",
                    key: "missing-subscription",
                    recordKey: "missing-subscription@0"
                },
                undefined
            );
            storage.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "missing-surface",
                    recordKey: "missing-surface@0"
                },
                undefined
            );

            expectCodecInvalid(() =>
                harness.persistence.findEventByIdentity(storage, "missing-event")
            );
            expectCodecInvalid(() =>
                harness.persistence.findReservationByDedupe(
                    storage,
                    new SubscriptionId("missing-subscription"),
                    "missing-route"
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findProjectionByReservation(
                    storage,
                    new RouteReservationId("missing-reservation")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findDelivery(
                    storage,
                    new RouteReservationId("missing-delivery")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.currentSubscription(
                    storage,
                    new SubscriptionId("missing-subscription")
                )
            );
            expectCodecInvalid(() => harness.persistence.currentView(storage, "missing-surface"));
        });
        harness.dispose();
    });

    test("rejects every secondary index and pointer that names an unrelated valid record", () => {
        const harness = create();
        harness.transaction((storage) => {
            const event = eventFixture("corrupt-index");
            const subscription = subscriptionFixture("corrupt-index");
            const reservation = reservationFixture("corrupt-index");
            const projection = projectionFixture(reservation);
            const delivery = deliveryFixture(reservation);
            const view = viewFixture(0, "corrupt-index");
            storage.insertRecord(stored("event", event.id.value, Event.codec.encode(event)));
            storage.insertRecord(
                stored(
                    "subscription",
                    `${subscription.id.value}@0`,
                    Subscription.codec.encode(subscription)
                )
            );
            storage.insertRecord(
                stored(
                    "routeReservation",
                    reservation.id.value,
                    RouteReservation.codec.encode(reservation)
                )
            );
            storage.insertRecord(
                stored(
                    "routeProjection",
                    projection.id.value,
                    RouteProjection.codec.encode(projection)
                )
            );
            storage.insertRecord(
                stored(
                    "routeDelivery",
                    delivery.reservation.value,
                    RouteDelivery.codec.encode(delivery)
                )
            );
            storage.insertRecord(
                stored("view", `${view.surface.value}@0`, View.codec.encode(view))
            );

            storage.insertUnique({
                namespace: "event.idempotency",
                key: "queried-event-key",
                recordKey: event.id.value
            });
            storage.insertUnique({
                namespace: "route.dedupe:queried-subscription",
                key: "queried-dedupe",
                recordKey: reservation.id.value
            });
            storage.insertUnique({
                namespace: "route.projection",
                key: "queried-reservation",
                recordKey: projection.id.value
            });
            storage.insertUnique({
                namespace: "route.delivery",
                key: "queried-delivery",
                recordKey: delivery.reservation.value
            });
            storage.compareAndSetPointer(
                {
                    namespace: "subscription.current",
                    key: "queried-subscription",
                    recordKey: `${subscription.id.value}@0`
                },
                undefined
            );
            storage.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "queried-surface",
                    recordKey: `${view.surface.value}@0`
                },
                undefined
            );

            expectCodecInvalid(() =>
                harness.persistence.findEventByIdentity(storage, "queried-event-key")
            );
            expectCodecInvalid(() =>
                harness.persistence.findReservationByDedupe(
                    storage,
                    new SubscriptionId("queried-subscription"),
                    "queried-dedupe"
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findProjectionByReservation(
                    storage,
                    new RouteReservationId("queried-reservation")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findDelivery(
                    storage,
                    new RouteReservationId("queried-delivery")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.currentSubscription(
                    storage,
                    new SubscriptionId("queried-subscription")
                )
            );
            expectCodecInvalid(() => harness.persistence.currentView(storage, "queried-surface"));
        });
        harness.dispose();
    });

    test("rejects codec identity mismatches for every durable workspace record", () => {
        const harness = create();
        harness.transaction((storage) => {
            const event = eventFixture("codec-identity");
            const subscription = subscriptionFixture("codec-identity");
            const reservation = reservationFixture("codec-identity");
            const projection = projectionFixture(reservation);
            const delivery = deliveryFixture(reservation);
            const view = viewFixture(0, "codec-identity");
            const delta = viewDeltaFixture(view);
            storage.insertRecord(stored("event", "wrong-event-id", Event.codec.encode(event)));
            storage.insertRecord(
                stored(
                    "subscription",
                    "wrong-subscription-id@0",
                    Subscription.codec.encode(subscription)
                )
            );
            storage.insertRecord(
                stored(
                    "routeReservation",
                    "wrong-reservation-id",
                    RouteReservation.codec.encode(reservation)
                )
            );
            storage.insertRecord(
                stored(
                    "routeProjection",
                    "wrong-projection-id",
                    RouteProjection.codec.encode(projection)
                )
            );
            storage.insertRecord(
                stored("routeDelivery", "wrong-delivery-id", RouteDelivery.codec.encode(delivery))
            );
            storage.insertRecord(stored("view", "wrong-view-id@0", View.codec.encode(view)));
            storage.insertRecord(
                stored("viewDelta", "wrong-delta-id", ViewDelta.codec.encode(delta))
            );
            storage.compareAndSetPointer(
                {
                    namespace: "subscription.current",
                    key: subscription.id.value,
                    recordKey: "wrong-subscription-id@0"
                },
                undefined
            );
            storage.insertUnique({
                namespace: "route.delivery",
                key: delivery.reservation.value,
                recordKey: "wrong-delivery-id"
            });
            storage.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: view.surface.value,
                    recordKey: "wrong-view-id@0"
                },
                undefined
            );

            expectCodecInvalid(() =>
                harness.persistence.findEvent(storage, new EventId("wrong-event-id"))
            );
            expectCodecInvalid(() =>
                harness.persistence.currentSubscription(storage, subscription.id)
            );
            expectCodecInvalid(() =>
                harness.persistence.findReservation(
                    storage,
                    new RouteReservationId("wrong-reservation-id")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findProjection(
                    storage,
                    new RouteProjectionId("wrong-projection-id")
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.findDelivery(storage, delivery.reservation)
            );
            expectCodecInvalid(() => harness.persistence.currentView(storage, view.surface.value));
            expectCodecInvalid(() =>
                harness.persistence.listViewDeltas(storage, view.surface.value, Revision.initial())
            );
        });
        harness.dispose();
    });

    test("rejects a mismatched ContentRetention codec identity during compaction", () => {
        const harness = create();
        harness.transaction((storage) => {
            const initial = viewFixture(0, "retention-codec-identity");
            harness.persistence.saveView(storage, initial, undefined, []);
            harness.persistence.appendViewDelta(
                storage,
                viewDeltaFixture(initial),
                new DeterministicJsonPatchEngine(),
                [],
                []
            );
            const retained = content("retention-codec-identity");
            const reference = retentionFixture({
                id: "actual-retention-id",
                recordKind: "view",
                recordId: `${initial.surface.value}@0`,
                content: retained
            });
            storage.insertRecord(
                stored(
                    "contentRetention",
                    "wrong-retention-id",
                    ContentRetentionReference.codec.encode(reference)
                )
            );
            expectCodecInvalid(() =>
                harness.persistence.compactView(storage, initial.surface.value, new Revision(1))
            );
        });
        harness.dispose();
    });
});

describe("memory workspace record coverage", () => {
    test("snapshots are detached, restartable, and schema-versioned", () => {
        const bytes = Uint8Array.of(1, 2, 3);
        const records = new MemoryWorkspaceRecords();
        records.insertRecord(stored("event", "b", bytes));
        records.insertRecord(stored("event", "a", Uint8Array.of(4)));
        records.insertUnique({ namespace: "unique", key: "key", recordKey: "a" });
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "surface",
                recordKey: "surface@0"
            },
            undefined
        );
        bytes[0] = 9;

        const found = records.findRecord("event", "b")!;
        found.bytes[0] = 8;
        const listed = records.listRecords("event");
        listed[0]!.bytes[0] = 7;
        const unique = records.findUnique("unique", "key")! as { recordKey: string };
        unique.recordKey = "changed";
        const pointer = records.findPointer("view.current", "surface")! as { recordKey: string };
        pointer.recordKey = "changed";

        expect(records.findRecord("event", "b")?.bytes).toEqual(Uint8Array.of(1, 2, 3));
        expect(records.listRecords("event").map((record) => record.id)).toEqual(["a", "b"]);
        expect(records.findUnique("unique", "key")?.recordKey).toBe("a");
        expect(records.findPointer("view.current", "surface")?.recordKey).toBe("surface@0");
        expect(records.clone().snapshot()).toEqual(records.snapshot());
        expect(
            () =>
                new MemoryWorkspaceRecords({
                    ...records.snapshot(),
                    version: 2
                } as never)
        ).toThrow(/version is unsupported/);
    });

    test("covers duplicate, conflict, empty, compacted delete, and missing-map paths", () => {
        const records = new MemoryWorkspaceRecords();
        expect(records.findRecord("event", "missing")).toBeUndefined();
        expect(records.findUnique("missing", "key")).toBeUndefined();
        expect(records.findPointer("missing", "key")).toBeUndefined();
        expect(records.listRecords("event")).toEqual([]);
        records.deleteCompactedRecords("view", ["missing"]);
        records.insertRecord(stored("view", "a", Uint8Array.of(1)));
        records.insertRecord(stored("view", "b", Uint8Array.of(2)));
        expect(() => records.insertRecord(stored("view", "a", Uint8Array.of(3)))).toThrow(
            expect.objectContaining({ code: "protocol.duplicate" })
        );
        records.deleteCompactedRecords("view", ["a"]);
        expect(records.listRecords("view").map((record) => record.id)).toEqual(["b"]);
        records.deleteCompactedRecords("view", ["b"]);
        expect(records.listRecords("view")).toEqual([]);

        records.insertUnique({ namespace: "unique", key: "key", recordKey: "a" });
        expect(() =>
            records.insertUnique({ namespace: "unique", key: "key", recordKey: "b" })
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "missing",
                    recordKey: "missing@1"
                },
                "missing@0"
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "surface",
                recordKey: "surface@0"
            },
            undefined
        );
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "surface",
                    recordKey: "surface@1"
                },
                "wrong@0"
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "surface",
                recordKey: "surface@1"
            },
            "surface@0"
        );
        expect(records.findPointer("view.current", "surface")?.recordKey).toBe("surface@1");
    });
});

describe("SQLite workspace record coverage", () => {
    test("covers all record kinds, detached bytes, compacted deletes, and absent indexes", () => {
        const database = new TestSqlite();
        const records = new SqliteWorkspaceEventRecords(database);
        const kinds: readonly WorkspaceRecordKind[] = [
            "event",
            "subscription",
            "routeReservation",
            "routeProjection",
            "routeDelivery",
            "view",
            "viewDelta",
            "contentRetention"
        ];
        for (const [index, kind] of kinds.entries()) {
            const bytes = Uint8Array.of(index);
            records.insertRecord(stored(kind, "b", bytes));
            records.insertRecord(stored(kind, "a", Uint8Array.of(index + 1)));
            bytes[0] = 255;
            const found = records.findRecord(kind, "b")!;
            found.bytes[0] = 254;
            expect(records.findRecord(kind, "b")?.bytes[0]).toBe(index);
            expect(records.listRecords(kind).map((record) => record.id)).toEqual(["a", "b"]);
        }
        const compactable: readonly CompactableWorkspaceRecordKind[] = [
            "view",
            "viewDelta",
            "contentRetention"
        ];
        for (const kind of compactable) {
            records.deleteCompactedRecords(kind, ["a", "missing"]);
            expect(records.listRecords(kind).map((record) => record.id)).toEqual(["b"]);
        }
        expect(records.listRecords("event").map((record) => record.id)).toEqual(["a", "b"]);
        expect(records.findRecord("event", "missing")).toBeUndefined();
        expect(records.findUnique("missing", "key")).toBeUndefined();
        expect(records.findPointer("missing", "key")).toBeUndefined();
    });

    test("covers pointer insert, update, conflicts, and insert/update race postconditions", () => {
        const database = new TestSqlite();
        const records = new SqliteWorkspaceEventRecords(database);
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "missing",
                    recordKey: "missing@1"
                },
                "missing@0"
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "key",
                recordKey: "key@0"
            },
            undefined
        );
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "key",
                    recordKey: "key@1"
                },
                "wrong@0"
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "key",
                recordKey: "key@1"
            },
            "key@0"
        );
        expect(records.findPointer("view.current", "key")?.recordKey).toBe("key@1");

        database.run(
            `CREATE TRIGGER ignore_pointer_insert BEFORE INSERT ON workspace_event_pointers
             WHEN NEW.key = 'ignored-insert' BEGIN SELECT RAISE(IGNORE); END`,
            []
        );
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "ignored-insert",
                    recordKey: "ignored-insert@0"
                },
                undefined
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
        database.run(
            `CREATE TRIGGER ignore_pointer_update BEFORE UPDATE ON workspace_event_pointers
             WHEN OLD.key = 'key' BEGIN SELECT RAISE(IGNORE); END`,
            []
        );
        expect(() =>
            records.compareAndSetPointer(
                {
                    namespace: "view.current",
                    key: "key",
                    recordKey: "key@2"
                },
                "key@1"
            )
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
    });

    test("maps record and unique constraint races to exact duplicate codes", () => {
        const database = new TestSqlite();
        const records = new SqliteWorkspaceEventRecords(database);
        database.run(
            `CREATE TRIGGER reject_record_insert BEFORE INSERT ON workspace_event_records
             WHEN NEW.id = 'constraint' BEGIN SELECT RAISE(ABORT, 'constraint'); END`,
            []
        );
        expect(
            capturedAgentCoreErrorCode(() =>
                records.insertRecord(stored("view", "constraint", Uint8Array.of(1)))
            )
        ).toBe("protocol.duplicate");
        database.run(
            `CREATE TRIGGER reject_unique_insert BEFORE INSERT ON workspace_event_uniques
             WHEN NEW.key = 'constraint' BEGIN SELECT RAISE(ABORT, 'constraint'); END`,
            []
        );
        expect(
            capturedAgentCoreErrorCode(() =>
                records.insertUnique({
                    namespace: "unique",
                    key: "constraint",
                    recordKey: "record"
                })
            )
        ).toBe("protocol.duplicate");
    });

    test("rejects missing and incompatible schemas", () => {
        expect(() => new SqliteWorkspaceEventRecords(new MissingSchemaSqlite())).toThrow(
            /Missing SQLite schema/
        );
        const incompatible = new TestSqlite();
        incompatible.run(
            "CREATE TABLE workspace_event_records (kind TEXT, id TEXT, bytes BLOB) STRICT",
            []
        );
        expect(() => new SqliteWorkspaceEventRecords(incompatible)).toThrow(
            /schema is incompatible/
        );
    });

    test("rejects malformed SQLite record, unique, and pointer rows", () => {
        const database = new RowMutatingSqlite();
        const records = new SqliteWorkspaceEventRecords(database);
        records.insertRecord(stored("event", "event", Uint8Array.of(1)));
        records.insertUnique({ namespace: "unique", key: "key", recordKey: "event" });
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "surface",
                recordKey: "surface@0"
            },
            undefined
        );

        database.mutate = (statement, row) =>
            statement.includes("workspace_event_records") ? { ...row, kind: "unknown" } : row;
        expect(() => records.findRecord("event", "event")).toThrow(/kind is invalid/);
        database.mutate = (statement, row) =>
            statement.includes("workspace_event_records") ? { ...row, id: 1 } : row;
        expect(() => records.findRecord("event", "event")).toThrow(/Expected text column: id/);
        database.mutate = (statement, row) =>
            statement.includes("workspace_event_records") ? { ...row, bytes: "not-bytes" } : row;
        expect(() => records.findRecord("event", "event")).toThrow(/Expected byte column: bytes/);
        database.mutate = (statement, row) =>
            statement.includes("workspace_event_uniques") ? { ...row, namespace: 1 } : row;
        expect(() => records.findUnique("unique", "key")).toThrow(
            /Expected text column: namespace/
        );
        database.mutate = (statement, row) =>
            statement.includes("workspace_event_pointers") ? { ...row, record_id: 1 } : row;
        expect(() => records.findPointer("view.current", "surface")).toThrow(
            /Expected text column: record_id/
        );
    });

    test("survives a detached file-backed close and reopen", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-storage-coverage-"));
        const path = join(directory, "workspace.sqlite");
        let database: FileSqlite | undefined;
        try {
            database = new FileSqlite(path);
            let records = new SqliteWorkspaceEventRecords(database);
            const bytes = Uint8Array.of(1, 2, 3);
            database.transaction(() => {
                records.insertRecord(stored("event", "persisted", bytes));
                records.insertUnique({ namespace: "unique", key: "key", recordKey: "persisted" });
                records.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "surface",
                        recordKey: "surface@0"
                    },
                    undefined
                );
            });
            bytes[0] = 9;
            database.close();

            database = new FileSqlite(path);
            records = new SqliteWorkspaceEventRecords(database);
            expect(records.findRecord("event", "persisted")?.bytes).toEqual(Uint8Array.of(1, 2, 3));
            expect(records.findUnique("unique", "key")?.recordKey).toBe("persisted");
            expect(records.findPointer("view.current", "surface")?.recordKey).toBe("surface@0");
        } finally {
            database?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe.each(factories)("%s View replay and retention coverage", (_name, create) => {
    test("replays restart/unknown-ack, current, ahead, and absent-surface paths", () => {
        const harness = create();
        const patches = new DeterministicJsonPatchEngine();
        const protocol = new ViewReplayProtocol(harness.persistence, patches, sourceActor, tenant);
        const initial = viewFixture(0, "replay-all");
        expect(() =>
            harness.transaction((storage) =>
                protocol.replay(storage, initial.surface, Revision.initial())
            )
        ).toThrow(/no durable View/);
        harness.transaction((storage) => protocol.publishSnapshot(storage, initial, []));
        const delta = viewDeltaFixture(initial, 1);
        harness.transaction((storage) => protocol.publish(storage, delta, [], []));
        harness.restart();

        const replayed = harness.transaction((storage) =>
            protocol.replay(storage, initial.surface, Revision.initial())
        );
        expect(replayed.kind).toBe("deltas");
        if (replayed.kind === "deltas") expect(replayed.deltas).toEqual([delta]);
        const current = harness.transaction((storage) =>
            protocol.replay(storage, initial.surface, delta.revision)
        );
        expect(current).toMatchObject({ kind: "deltas", deltas: [] });
        expect(() =>
            harness.transaction((storage) =>
                protocol.replay(storage, initial.surface, new Revision(2))
            )
        ).toThrow(/ahead/);
        expect(() =>
            harness.transaction((storage) => protocol.publish(storage, delta, [], []))
        ).toThrow(/base revision is stale/);
        harness.dispose();
    });

    test("falls back for missing bases, delta gaps, final revision gaps, and final byte mismatches", () => {
        const scenarios = [
            "missing-base",
            "delta-gap",
            "revision-gap",
            "length-mismatch",
            "byte-mismatch"
        ];
        for (const scenario of scenarios) {
            const harness = create();
            const protocol = new ViewReplayProtocol(
                harness.persistence,
                new DeterministicJsonPatchEngine(),
                sourceActor,
                tenant
            );
            const initial = viewFixture(0, `fallback-${scenario}`);
            harness.transaction((storage) => protocol.publishSnapshot(storage, initial, []));
            harness.transaction((storage) =>
                configureReplayFallback(scenario, storage, harness.persistence, initial)
            );
            expect(
                harness.transaction((storage) =>
                    protocol.replay(storage, initial.surface, Revision.initial())
                ).kind
            ).toBe("snapshot");
            harness.dispose();
        }
    });

    test("validates compaction floors and releases exact obsolete View and delta retentions", () => {
        const released: ContentRetentionReference[] = [];
        const harness = create({ released });
        const protocol = new ViewReplayProtocol(
            harness.persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const surface = new SurfaceId(`surface-compaction-${_name.toLowerCase()}`);
        expect(() =>
            harness.transaction((storage) => protocol.compact(storage, surface, Revision.initial()))
        ).toThrow(/floor is unavailable/);

        const oldContent = content(`old-content-${_name}`);
        const nextContent = content(`next-content-${_name}`);
        const base = viewFixture(0, `compaction-${_name}`);
        const initial = new View({ ...base, surface, body: { attachment: oldContent.ref.value } });
        const retention0 = retentionFixture({
            id: `retention-view-0-${_name}`,
            recordKind: "view",
            recordId: `${surface.value}@0`,
            content: oldContent
        });
        harness.transaction((storage) => protocol.publishSnapshot(storage, initial, [retention0]));
        expect(() =>
            harness.transaction((storage) => protocol.compact(storage, surface, new Revision(1)))
        ).toThrow(/floor is unavailable/);
        harness.transaction((storage) => protocol.compact(storage, surface, Revision.initial()));

        const delta = new ViewDelta({
            surface,
            baseRevision: Revision.initial(),
            revision: new Revision(1),
            patch: [{ op: "replace", path: "/body/attachment", value: nextContent.ref.value }],
            cursor: new EventCursor(`cursor-compaction-${_name}`)
        });
        const retention1 = retentionFixture({
            id: `retention-view-1-${_name}`,
            recordKind: "view",
            recordId: `${surface.value}@1`,
            content: nextContent
        });
        const deltaRetention = retentionFixture({
            id: `retention-delta-1-${_name}`,
            recordKind: "viewDelta",
            recordId: `${surface.value}@1`,
            content: nextContent
        });
        harness.transaction((storage) =>
            protocol.publish(storage, delta, [retention1], [deltaRetention])
        );
        harness.transaction((storage) => protocol.compact(storage, surface, new Revision(1)));
        expect(released.map((reference) => reference.id.value).sort()).toEqual(
            [retention0.id.value, deltaRetention.id.value].sort()
        );
        harness.transaction((storage) => {
            expect(storage.listRecords("contentRetention").map((record) => record.id)).toEqual([
                retention1.id.value
            ]);
            expect(protocol.replay(storage, surface, Revision.initial()).kind).toBe("snapshot");
        });

        harness.transaction((storage) => {
            const ahead = new View({ ...initial, revision: new Revision(3) });
            storage.insertRecord(stored("view", `${surface.value}@3`, View.codec.encode(ahead)));
            expect(() => protocol.compact(storage, surface, new Revision(3))).toThrow(
                /floor is unavailable/
            );
        });
        harness.dispose();
    });

    test("[C13-ADV-MISSING-CROSS-TENANT-BINDING] rejects retention verification, owner, tenant, binding, and exact-coverage failures", () => {
        const unverified = create({ verify: () => false });
        const event = eventFixture(`unverified-${_name}`);
        expect(() =>
            unverified.transaction((storage) =>
                unverified.persistence.appendEvent(storage, event, eventRetention(event))
            )
        ).toThrow(/proof is not durable/);
        unverified.dispose();

        for (const violation of ["actor", "tenant", "kind", "record", "content"] as const) {
            const harness = create();
            const candidate = eventFixture(`retention-${violation}-${_name}`);
            let reference = eventRetention(candidate);
            if (violation === "actor") {
                reference = new ContentRetentionReference({
                    ...reference.init,
                    actor: targetActor
                });
            } else if (violation === "tenant") {
                reference = new ContentRetentionReference({
                    ...reference.init,
                    tenant: new TenantId("tenant-other")
                });
            } else if (violation === "kind") {
                reference = reservationRetention(reservationFixture(`wrong-kind-${_name}`));
            } else if (violation === "record") {
                reference = new ContentRetentionReference({
                    ...reference.init,
                    record: retentionFixture({
                        id: "different-record-helper",
                        recordKind: "event",
                        recordId: "different-record",
                        content: { ref: candidate.payload, digest: candidate.payloadDigest }
                    }).record
                });
            } else {
                const other = content(`other-content-${_name}`);
                reference = retentionFixture({
                    id: `wrong-content-${_name}`,
                    recordKind: "event",
                    recordId: candidate.id.value,
                    content: other
                });
            }
            expect(() =>
                harness.transaction((storage) =>
                    harness.persistence.appendEvent(storage, candidate, reference)
                )
            ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
            harness.dispose();
        }

        const missing = create();
        const retained = content(`missing-view-content-${_name}`);
        const base = viewFixture(0, `missing-view-${_name}`);
        const view = new View({
            ...base,
            body: { ref: retained.ref.value, invalid: "not-a-content-ref" }
        });
        const protocol = new ViewReplayProtocol(
            missing.persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        expect(() =>
            missing.transaction((storage) => protocol.publishSnapshot(storage, view, []))
        ).toThrow(/does not cover every ContentRef exactly/);
        const extraView = viewFixture(0, `extra-view-${_name}`);
        const extra = retentionFixture({
            id: `extra-retention-${_name}`,
            recordKind: "view",
            recordId: `${extraView.surface.value}@0`,
            content: retained
        });
        expect(() =>
            missing.transaction((storage) => protocol.publishSnapshot(storage, extraView, [extra]))
        ).toThrow(/does not cover every ContentRef exactly/);
        missing.dispose();
    });

    test("requires exact View and delta retention ownership across every field", () => {
        const retained = content(`owner-content-${_name}`);
        for (const violation of ["actor", "tenant", "kind", "record"] as const) {
            const harness = create();
            const protocol = new ViewReplayProtocol(
                harness.persistence,
                new DeterministicJsonPatchEngine(),
                sourceActor,
                tenant
            );
            const base = viewFixture(0, `owner-${violation}-${_name}`);
            const view = new View({ ...base, body: { ref: retained.ref.value } });
            let reference = retentionFixture({
                id: `owner-${violation}-${_name}`,
                recordKind: "view",
                recordId: `${view.surface.value}@0`,
                content: retained
            });
            if (violation === "actor") {
                reference = new ContentRetentionReference({
                    ...reference.init,
                    actor: targetActor
                });
            } else if (violation === "tenant") {
                reference = new ContentRetentionReference({
                    ...reference.init,
                    tenant: new TenantId("tenant-other")
                });
            } else if (violation === "kind") {
                reference = retentionFixture({
                    id: `owner-kind-${_name}`,
                    recordKind: "viewDelta",
                    recordId: `${view.surface.value}@0`,
                    content: retained
                });
            } else {
                reference = retentionFixture({
                    id: `owner-record-${_name}`,
                    recordKind: "view",
                    recordId: `${view.surface.value}@9`,
                    content: retained
                });
            }
            expect(() =>
                harness.transaction((storage) =>
                    protocol.publishSnapshot(storage, view, [reference])
                )
            ).toThrow(/belongs to another Actor, tenant, or View revision/);
            harness.dispose();
        }

        const harness = create();
        const protocol = new ViewReplayProtocol(
            harness.persistence,
            new DeterministicJsonPatchEngine(),
            sourceActor,
            tenant
        );
        const initial = viewFixture(0, `delta-exact-${_name}`);
        harness.transaction((storage) => protocol.publishSnapshot(storage, initial, []));
        const deltaContent = content(`delta-exact-content-${_name}`);
        const delta = new ViewDelta({
            surface: initial.surface,
            baseRevision: initial.revision,
            revision: initial.revision.next(),
            patch: [{ op: "replace", path: "/body/count", value: deltaContent.ref.value }],
            cursor: new EventCursor(`cursor-delta-exact-${_name}`)
        });
        const viewRetention = retentionFixture({
            id: `delta-exact-view-${_name}`,
            recordKind: "view",
            recordId: `${initial.surface.value}@1`,
            content: deltaContent
        });
        const deltaRetention = retentionFixture({
            id: `delta-exact-delta-${_name}`,
            recordKind: "viewDelta",
            recordId: `${initial.surface.value}@1`,
            content: deltaContent
        });
        expect(() =>
            harness.transaction((storage) => protocol.publish(storage, delta, [], [deltaRetention]))
        ).toThrow(/View content retention/);
        expect(() =>
            harness.transaction((storage) => protocol.publish(storage, delta, [viewRetention], []))
        ).toThrow(/ViewDelta content retention/);
        expect(
            harness.transaction((storage) =>
                protocol.publish(storage, delta, [viewRetention], [deltaRetention])
            ).body
        ).toEqual({ count: deltaContent.ref.value, nested: { enabled: true } });
        harness.dispose();
    });
});

describe("stored codec corruption coverage", () => {
    test("rejects malformed metadata, bytes, and wrong decoded record classes", () => {
        const event = eventFixture("malformed-storage");
        const records = new MemoryWorkspaceRecords();
        records.insertRecord(stored("event", event.id.value, Event.codec.encode(event)));
        const persistence = newPersistence();

        for (const malformed of [
            { kind: "subscription" },
            { id: "different-id" },
            { bytes: "not-bytes" }
        ]) {
            const corrupt = new ReadCorruptingStorage(
                records,
                (record) =>
                    ({
                        ...record,
                        ...malformed
                    }) as StoredWorkspaceRecord
            );
            expectCodecInvalid(() => persistence.findEvent(corrupt, event.id));
        }

        const malformedBytes = new MemoryWorkspaceRecords();
        malformedBytes.insertRecord(stored("event", event.id.value, encoder.encode("not-json")));
        expectCodecInvalid(() => newPersistence().findEvent(malformedBytes, event.id));

        const typeFailure = vi.spyOn(Event.codec, "decode").mockImplementation(() => {
            throw new TypeError("synthetic codec type failure");
        });
        expectCodecInvalid(() => persistence.findEvent(records, event.id));
        typeFailure.mockRestore();

        const wrongClass = vi
            .spyOn(Event.codec, "decode")
            .mockReturnValue(subscriptionFixture("wrong-codec-class") as unknown as Event);
        expectCodecInvalid(() => persistence.findEvent(records, event.id));
        wrongClass.mockRestore();
    });

    test("rejects wrong decoded classes for every non-Event durable record kind", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = newPersistence();
        const event = eventFixture("wrong-class-value");
        const subscription = subscriptionFixture("wrong-class-subscription");
        const reservation = reservationFixture("wrong-class-reservation");
        const projection = projectionFixture(reservation);
        const delivery = deliveryFixture(reservation);
        const view = viewFixture(0, "wrong-class-view");
        const delta = viewDeltaFixture(view);
        records.insertRecord(
            stored(
                "subscription",
                `${subscription.id.value}@0`,
                Subscription.codec.encode(subscription)
            )
        );
        records.compareAndSetPointer(
            {
                namespace: "subscription.current",
                key: subscription.id.value,
                recordKey: `${subscription.id.value}@0`
            },
            undefined
        );
        records.insertRecord(
            stored(
                "routeReservation",
                reservation.id.value,
                RouteReservation.codec.encode(reservation)
            )
        );
        records.insertRecord(
            stored("routeProjection", projection.id.value, RouteProjection.codec.encode(projection))
        );
        records.insertRecord(
            stored(
                "routeDelivery",
                delivery.reservation.value,
                RouteDelivery.codec.encode(delivery)
            )
        );
        records.insertUnique({
            namespace: "route.delivery",
            key: delivery.reservation.value,
            recordKey: delivery.reservation.value
        });
        records.insertRecord(stored("view", `${view.surface.value}@0`, View.codec.encode(view)));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: view.surface.value,
                recordKey: `${view.surface.value}@0`
            },
            undefined
        );
        records.insertRecord(
            stored("viewDelta", `${delta.surface.value}@1`, ViewDelta.codec.encode(delta))
        );

        const cases: readonly [object, () => unknown][] = [
            [Subscription.codec, () => persistence.currentSubscription(records, subscription.id)],
            [RouteReservation.codec, () => persistence.findReservation(records, reservation.id)],
            [RouteProjection.codec, () => persistence.findProjection(records, projection.id)],
            [RouteDelivery.codec, () => persistence.findDelivery(records, delivery.reservation)],
            [View.codec, () => persistence.currentView(records, view.surface.value)],
            [
                ViewDelta.codec,
                () => persistence.listViewDeltas(records, view.surface.value, Revision.initial())
            ]
        ];
        for (const [codec, operation] of cases) {
            const decode = vi
                .spyOn(codec as { decode(bytes: Uint8Array): unknown }, "decode")
                .mockReturnValue(event);
            expectCodecInvalid(operation);
            decode.mockRestore();
        }

        const retained = content("wrong-class-retention");
        const reference = retentionFixture({
            id: "wrong-class-retention",
            recordKind: "view",
            recordId: `${view.surface.value}@0`,
            content: retained
        });
        records.insertRecord(
            stored(
                "contentRetention",
                reference.id.value,
                ContentRetentionReference.codec.encode(reference)
            )
        );
        const next = new View({ ...view, revision: new Revision(1) });
        records.insertRecord(stored("view", `${view.surface.value}@1`, View.codec.encode(next)));
        records.compareAndSetPointer(
            {
                namespace: "view.current",
                key: view.surface.value,
                recordKey: `${view.surface.value}@1`
            },
            `${view.surface.value}@0`
        );
        const retentionDecode = vi
            .spyOn(ContentRetentionReference.codec, "decode")
            .mockReturnValue(event as unknown as ContentRetentionReference);
        expectCodecInvalid(() =>
            persistence.compactView(records, view.surface.value, new Revision(1))
        );
        retentionDecode.mockRestore();
    });
});

function createMemoryHarness(options: HarnessOptions = {}): StorageHarness {
    interface State {
        readonly records: MemoryWorkspaceRecords;
    }
    const clone = (state: State): State => ({ records: cloneMemoryRecords(state.records) });
    let store = new MemoryActorStore<State>({ records: new MemoryWorkspaceRecords() }, clone);
    const persistence = createPersistence(options);
    return {
        persistence,
        transaction<Result>(
            operation: (storage: WorkspaceRecordStorage) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return store.transaction((state) => operation(state.records), ...guard);
        },
        restart(): void {
            store = MemoryActorStore.restore(store.snapshot(), clone);
        },
        dispose(): void {}
    };
}

function cloneMemoryRecords(records: MemoryWorkspaceRecords): MemoryWorkspaceRecords {
    const snapshot = records.snapshot();
    const clone = new MemoryWorkspaceRecords({ ...snapshot, pointers: [] });
    for (const pointer of snapshot.pointers) {
        const separator = pointer.recordKey.lastIndexOf("@");
        const prefix = pointer.recordKey.slice(0, separator);
        const revision = Number(pointer.recordKey.slice(separator + 1));
        let expected: string | undefined;
        for (let value = 0; value <= revision; value += 1) {
            const recordKey = `${prefix}@${value}`;
            clone.compareAndSetPointer({ ...pointer, recordKey }, expected);
            expected = recordKey;
        }
    }
    return clone;
}

function createSqliteHarness(options: HarnessOptions = {}): StorageHarness {
    const database = new TestSqlite();
    let records = new SqliteWorkspaceEventRecords(database);
    const persistence = createPersistence(options);
    return {
        persistence,
        transaction<Result>(
            operation: (storage: WorkspaceRecordStorage) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return database.transaction(() => operation(records), ...guard);
        },
        restart(): void {
            records = new SqliteWorkspaceEventRecords(database);
        },
        dispose(): void {}
    };
}

function createPersistence(options: HarnessOptions): WorkspacePersistence<WorkspaceRecordStorage> {
    return new WorkspacePersistence(
        (storage) => storage,
        {
            verify: (_storage, reference) => options.verify?.(reference) ?? true,
            release: (_storage, reference) => options.released?.push(reference),
            discard: () => {}
        },
        sourceActor,
        tenant
    );
}

function newPersistence(): WorkspacePersistence<WorkspaceRecordStorage> {
    return new WorkspacePersistence(
        (storage) => storage,
        { verify: () => true, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );
}

function runStorageTrace(harness: StorageHarness) {
    const kinds: readonly WorkspaceRecordKind[] = [
        "event",
        "subscription",
        "routeReservation",
        "routeProjection",
        "routeDelivery",
        "view",
        "viewDelta",
        "contentRetention"
    ];
    const empty = harness.transaction((storage) => ({
        records: kinds.map((kind) => storage.findRecord(kind, "missing") === undefined),
        lists: kinds.map((kind) => storage.listRecords(kind).length),
        unique: storage.findUnique("missing", "missing") === undefined,
        pointer: storage.findPointer("missing", "missing") === undefined
    }));
    harness.transaction((storage) => {
        for (const [index, kind] of kinds.entries()) {
            storage.insertRecord(stored(kind, "b", Uint8Array.of(index)));
            storage.insertRecord(stored(kind, "a", Uint8Array.of(index + 1)));
        }
        storage.insertUnique({ namespace: "unique", key: "key", recordKey: "event" });
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: "trace",
                recordKey: "trace@0"
            },
            undefined
        );
    });
    const invalidLengths = [
        () =>
            harness.transaction((storage) =>
                storage.insertRecord(stored("view", "", Uint8Array.of(1)))
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertRecord(stored("view", "x".repeat(2049), Uint8Array.of(1)))
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "",
                    key: "key",
                    recordKey: "record"
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "x".repeat(513),
                    key: "key",
                    recordKey: "record"
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "unique",
                    key: "",
                    recordKey: "record"
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "unique",
                    key: "x".repeat(2049),
                    recordKey: "record"
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "unique",
                    key: "invalid-record-empty",
                    recordKey: ""
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.insertUnique({
                    namespace: "unique",
                    key: "invalid-record-long",
                    recordKey: "x".repeat(2049)
                })
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "",
                        key: "surface",
                        recordKey: "surface@0"
                    },
                    undefined
                )
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "x".repeat(513),
                        key: "surface",
                        recordKey: "surface@0"
                    },
                    undefined
                )
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "",
                        recordKey: "surface@0"
                    },
                    undefined
                )
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "x".repeat(2049),
                        recordKey: "surface@0"
                    },
                    undefined
                )
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "empty-record",
                        recordKey: ""
                    },
                    undefined
                )
            ),
        () =>
            harness.transaction((storage) =>
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "long-record",
                        recordKey: "x".repeat(2049)
                    },
                    undefined
                )
            )
    ].map(capturedAgentCoreErrorCode);
    const errors = {
        invalidLengths,
        invalidBytes: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.insertRecord({
                    kind: "view",
                    id: "invalid-bytes",
                    bytes: "invalid" as never
                });
            })
        ),
        duplicateRecord: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.insertRecord(stored("event", "a", Uint8Array.of(9)));
            })
        ),
        duplicateUnique: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.insertUnique({ namespace: "unique", key: "key", recordKey: "other" });
            })
        ),
        pointerConflict: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "trace",
                        recordKey: "trace@1"
                    },
                    "wrong@0"
                );
            })
        ),
        invalidPointerNamespace: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.compareAndSetPointer(
                    {
                        namespace: "invalid.current",
                        key: "surface",
                        recordKey: "surface@0"
                    },
                    undefined
                );
            })
        ),
        malformedPointerRecord: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "malformed",
                        recordKey: "malformed"
                    },
                    undefined
                );
            })
        ),
        invalidInitialRevision: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "initial-revision",
                        recordKey: "initial-revision@1"
                    },
                    undefined
                );
            })
        ),
        invalidRevisionAdvance: capturedAgentCoreErrorCode(() =>
            harness.transaction((storage) => {
                storage.compareAndSetPointer(
                    {
                        namespace: "view.current",
                        key: "trace",
                        recordKey: "trace@2"
                    },
                    "trace@0"
                );
            })
        )
    };
    harness.transaction((storage) => {
        for (const kind of ["view", "viewDelta", "contentRetention"] as const) {
            storage.deleteCompactedRecords(kind, ["a", "missing"]);
        }
    });
    return harness.transaction((storage) => ({
        empty,
        errors,
        records: kinds.map((kind) =>
            storage.listRecords(kind).map((record) => [record.kind, record.id, [...record.bytes]])
        ),
        unique: storage.findUnique("unique", "key"),
        pointer: storage.findPointer("view.current", "trace")
    }));
}

function runPersistenceTrace(harness: StorageHarness, suffix: string): unknown {
    const event = eventFixture(`${suffix}-event`);
    const subscription = subscriptionFixture(`${suffix}-subscription`);
    const revised = subscription.revise({
        source: subscription.source,
        target: subscription.target,
        mapping: subscription.mapping,
        dedupe: "payload",
        authority: subscription.authority
    });
    const reservation = reservationFixture(`${suffix}-reservation`, { target: sourceActor });
    const otherReservation = reservationFixture(`${suffix}-other-reservation`, {
        target: sourceActor
    });
    const projection = projectionFixture(reservation);
    const delivery = deliveryFixture(reservation);
    const initial = viewFixture(0, `${suffix}-view`);
    const delta = viewDeltaFixture(initial, 4);
    const before = harness.transaction((storage) => ({
        event: harness.persistence.findEvent(storage, event.id),
        eventIndex: harness.persistence.findEventByIdentity(storage, event.idempotencyKey),
        subscriptions: harness.persistence.listSubscriptions(storage),
        reservation: harness.persistence.findReservation(storage, reservation.id),
        reservationIndex: harness.persistence.findReservationByDedupe(
            storage,
            reservation.subscription,
            reservation.dedupeKey
        ),
        projection: harness.persistence.findProjection(storage, projection.id),
        projectionIndex: harness.persistence.findProjectionByReservation(storage, reservation.id),
        delivery: harness.persistence.findDelivery(storage, reservation.id),
        view: harness.persistence.currentView(storage, initial.surface.value)
    }));
    harness.transaction((storage) => {
        harness.persistence.appendEvent(storage, event, eventRetention(event));
        harness.persistence.saveSubscription(storage, subscription, undefined);
        harness.persistence.saveSubscription(storage, revised, subscription.revision);
        harness.persistence.appendReservation(
            storage,
            reservation,
            reservationRetention(reservation)
        );
        harness.persistence.appendReservation(
            storage,
            otherReservation,
            reservationRetention(otherReservation)
        );
        harness.persistence.appendProjection(
            storage,
            authenticatedProjectionFixture(reservation),
            projectionRetention(projection, sourceActor)
        );
        harness.persistence.appendDelivery(storage, delivery);
        harness.persistence.saveView(storage, initial, undefined, []);
        harness.persistence.appendViewDelta(
            storage,
            delta,
            new DeterministicJsonPatchEngine(),
            [],
            []
        );
    });
    harness.restart();
    return harness.transaction((storage) => ({
        before,
        event: harness.persistence.findEvent(storage, event.id)?.id.value,
        eventIndex: harness.persistence.findEventByIdentity(storage, event.idempotencyKey)?.id
            .value,
        subscriptions: harness.persistence
            .listSubscriptions(storage)
            .map((value) => `${value.id.value}@${value.revision.value}`),
        reservations: harness.persistence.listReservations(storage).map((value) => value.id.value),
        forEvent: harness.persistence
            .listReservationsForEvent(storage, reservation.event)
            .map((value) => value.id.value),
        reservationIndex: harness.persistence.findReservationByDedupe(
            storage,
            reservation.subscription,
            reservation.dedupeKey
        )?.id.value,
        projection: harness.persistence.findProjection(storage, projection.id)?.id.value,
        projectionIndex: harness.persistence.findProjectionByReservation(storage, reservation.id)
            ?.id.value,
        delivery: harness.persistence.findDelivery(storage, reservation.id)?.state.kind,
        view: harness.persistence.findView(storage, initial.surface.value, Revision.initial())
            ?.revision.value,
        current: harness.persistence.currentView(storage, initial.surface.value)?.revision.value,
        deltas: harness.persistence
            .listViewDeltas(storage, initial.surface.value, Revision.initial())
            .map((value) => value.revision.value)
    }));
}

function configureReplayFallback(
    scenario: string,
    storage: WorkspaceRecordStorage,
    persistence: WorkspacePersistence<WorkspaceRecordStorage>,
    initial: View
): void {
    if (scenario === "missing-base") {
        persistence.appendViewDelta(
            storage,
            viewDeltaFixture(initial),
            new DeterministicJsonPatchEngine(),
            [],
            []
        );
        storage.deleteCompactedRecords("view", [`${initial.surface.value}@0`]);
        return;
    }
    if (scenario === "delta-gap") {
        const current = new View({ ...initial, revision: new Revision(2) });
        const gap = new ViewDelta({
            surface: initial.surface,
            baseRevision: new Revision(1),
            revision: new Revision(2),
            patch: [{ op: "replace", path: "/body/count", value: 2 }],
            cursor: new EventCursor("cursor-gap")
        });
        storage.insertRecord(
            stored("view", `${initial.surface.value}@2`, View.codec.encode(current))
        );
        storage.insertRecord(
            stored("viewDelta", `${initial.surface.value}@2`, ViewDelta.codec.encode(gap))
        );
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: initial.surface.value,
                recordKey: `${initial.surface.value}@1`
            },
            `${initial.surface.value}@0`
        );
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: initial.surface.value,
                recordKey: `${initial.surface.value}@2`
            },
            `${initial.surface.value}@1`
        );
        return;
    }
    const first = viewDeltaFixture(initial, 1);
    storage.insertRecord(
        stored("viewDelta", `${initial.surface.value}@1`, ViewDelta.codec.encode(first))
    );
    if (scenario === "revision-gap") {
        const current = new View({ ...initial, revision: new Revision(2), body: { count: 2 } });
        storage.insertRecord(
            stored("view", `${initial.surface.value}@2`, View.codec.encode(current))
        );
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: initial.surface.value,
                recordKey: `${initial.surface.value}@1`
            },
            `${initial.surface.value}@0`
        );
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: initial.surface.value,
                recordKey: `${initial.surface.value}@2`
            },
            `${initial.surface.value}@1`
        );
        return;
    }
    storage.deleteCompactedRecords("viewDelta", [`${initial.surface.value}@1`]);
    const count = scenario === "length-mismatch" ? 100 : 9;
    const mismatched = viewDeltaFixture(initial, count);
    storage.insertRecord(
        stored("viewDelta", `${initial.surface.value}@1`, ViewDelta.codec.encode(mismatched))
    );
    const current = new View({ ...initial, revision: new Revision(1), body: { count: 1 } });
    storage.insertRecord(stored("view", `${initial.surface.value}@1`, View.codec.encode(current)));
    storage.compareAndSetPointer(
        {
            namespace: "view.current",
            key: initial.surface.value,
            recordKey: `${initial.surface.value}@1`
        },
        `${initial.surface.value}@0`
    );
}

function stored(kind: WorkspaceRecordKind, id: string, bytes: Uint8Array): StoredWorkspaceRecord {
    return { kind, id, bytes };
}

function capturedAgentCoreErrorCode(operation: () => void): AgentCoreErrorCode {
    try {
        operation();
    } catch (error) {
        if (error instanceof AgentCoreError) return error.code;
        throw error;
    }
    throw new TypeError("Expected an AgentCoreError");
}

function expectCodecInvalid(operation: () => unknown): void {
    expect(operation).toThrow(expect.objectContaining({ code: "codec.invalid" }));
}

class StorageDecorator implements WorkspaceRecordStorage {
    public constructor(protected readonly storage: WorkspaceRecordStorage) {}

    public findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined {
        return this.storage.findRecord(kind, id);
    }

    public listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[] {
        return this.storage.listRecords(kind);
    }

    public insertRecord(record: StoredWorkspaceRecord): void {
        this.storage.insertRecord(record);
    }

    public deleteCompactedRecords(
        kind: CompactableWorkspaceRecordKind,
        ids: readonly string[]
    ): void {
        this.storage.deleteCompactedRecords(kind, ids);
    }

    public findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined {
        return this.storage.findUnique(namespace, key);
    }

    public insertUnique(unique: StoredWorkspaceUnique): void {
        this.storage.insertUnique(unique);
    }

    public findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined {
        return this.storage.findPointer(namespace, key);
    }

    public compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void {
        this.storage.compareAndSetPointer(pointer, expectedRecordKey);
    }
}

class FaultingStorage extends StorageDecorator {
    #writes = 0;

    public constructor(
        storage: WorkspaceRecordStorage,
        private readonly failAt: number
    ) {
        super(storage);
    }

    public override insertRecord(record: StoredWorkspaceRecord): void {
        this.beforeWrite();
        super.insertRecord(record);
    }

    public override deleteCompactedRecords(
        kind: CompactableWorkspaceRecordKind,
        ids: readonly string[]
    ): void {
        this.beforeWrite();
        super.deleteCompactedRecords(kind, ids);
    }

    public override insertUnique(unique: StoredWorkspaceUnique): void {
        this.beforeWrite();
        super.insertUnique(unique);
    }

    public override compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void {
        this.beforeWrite();
        super.compareAndSetPointer(pointer, expectedRecordKey);
    }

    private beforeWrite(): void {
        this.#writes += 1;
        if (this.#writes === this.failAt) throw new TypeError(`storage fault ${this.failAt}`);
    }
}

class ReadCorruptingStorage extends StorageDecorator {
    public constructor(
        storage: WorkspaceRecordStorage,
        private readonly corrupt: (record: StoredWorkspaceRecord) => StoredWorkspaceRecord
    ) {
        super(storage);
    }

    public override findRecord(
        kind: WorkspaceRecordKind,
        id: string
    ): StoredWorkspaceRecord | undefined {
        const record = super.findRecord(kind, id);
        return record === undefined ? undefined : this.corrupt(record);
    }
}

class MissingSchemaSqlite extends TestSqlite {
    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (!statement.startsWith("CREATE TABLE")) super.run(statement, bindings);
    }
}

class RowMutatingSqlite extends TestSqlite {
    public mutate: ((statement: string, row: SqliteRow) => SqliteRow) | undefined;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return super.all(statement, bindings).map((row) => this.mutate?.(statement, row) ?? row);
    }
}
