import { describe, expect, test } from "vitest";
import { ACTOR_STATE_SNAPSHOT } from "../../src/actors";
import { Revision } from "../../src/core";
import { EventId, RouteReservationId, SubscriptionId } from "../../src/interaction-references";
import { Event } from "../../src/workspaces/event";
import { MemoryWorkspaceRecords, type MemoryWorkspaceSnapshot } from "../../src/workspaces/memory";
import {
    WorkspacePersistence,
    validateStoredWorkspaceRecord,
    validateWorkspacePointer,
    validateWorkspacePointerAdvance,
    validateWorkspaceUnique,
    type CompactableWorkspaceRecordKind,
    type StoredWorkspacePointer,
    type StoredWorkspaceRecord,
    type StoredWorkspaceUnique,
    type WorkspaceRecordKind,
    type WorkspaceRecordStorage
} from "../../src/workspaces/persistence";
import { RetainedRecordKind, type ContentRetentionPort } from "../../src/workspaces/retention";
import { RouteReservation } from "../../src/workspaces/route";
import { View } from "../../src/workspaces/view";
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
} from "./fixtures";

const durableRetention: ContentRetentionPort<WorkspaceRecordStorage> = {
    verify: () => true,
    release: () => {},
    discard: () => {}
};

function persistenceWith(
    actor = sourceActor,
    retention: ContentRetentionPort<WorkspaceRecordStorage> = durableRetention
): WorkspacePersistence<WorkspaceRecordStorage> {
    return new WorkspacePersistence(
        (storage: WorkspaceRecordStorage) => storage,
        retention,
        actor,
        tenant
    );
}

function eventVariant(
    source: Event,
    overrides: { readonly id?: EventId; readonly idempotencyKey?: string }
): Event {
    return new Event({
        id: overrides.id ?? source.id,
        scope: source.scope,
        source: source.source,
        kind: source.kind,
        payload: source.payload,
        payloadDigest: source.payloadDigest,
        idempotencyKey: overrides.idempotencyKey ?? source.idempotencyKey,
        correlation: source.correlation,
        ...(source.causation === undefined ? {} : { causation: source.causation }),
        provenance: source.provenance,
        trust: source.trust,
        visibility: source.visibility,
        ...(source.initiator === undefined ? {} : { initiator: source.initiator })
    });
}

class DelegatingStorage implements WorkspaceRecordStorage {
    public constructor(protected readonly inner: MemoryWorkspaceRecords) {}

    public findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined {
        return this.inner.findRecord(kind, id);
    }

    public listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[] {
        return this.inner.listRecords(kind);
    }

    public insertRecord(record: StoredWorkspaceRecord): void {
        this.inner.insertRecord(record);
    }

    public deleteCompactedRecords(
        kind: CompactableWorkspaceRecordKind,
        ids: readonly string[]
    ): void {
        this.inner.deleteCompactedRecords(kind, ids);
    }

    public findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined {
        return this.inner.findUnique(namespace, key);
    }

    public insertUnique(unique: StoredWorkspaceUnique): void {
        this.inner.insertUnique(unique);
    }

    public findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined {
        return this.inner.findPointer(namespace, key);
    }

    public compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void {
        this.inner.compareAndSetPointer(pointer, expectedRecordKey);
    }
}

class ReversedListingStorage extends DelegatingStorage {
    public override listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[] {
        return [...this.inner.listRecords(kind)].reverse();
    }
}

class RecordTamperingStorage extends DelegatingStorage {
    public constructor(
        inner: MemoryWorkspaceRecords,
        private readonly tamper: (record: StoredWorkspaceRecord) => StoredWorkspaceRecord
    ) {
        super(inner);
    }

    public override findRecord(
        kind: WorkspaceRecordKind,
        id: string
    ): StoredWorkspaceRecord | undefined {
        const record = this.inner.findRecord(kind, id);
        return record === undefined ? undefined : this.tamper(record);
    }
}

class ThrowingSliceBytes extends Uint8Array {
    public override slice(): never {
        throw new RangeError("Storage bytes refuse to be copied");
    }
}

function rebuilt(
    records: MemoryWorkspaceRecords,
    changes: Partial<Omit<MemoryWorkspaceSnapshot, "version">>
): MemoryWorkspaceRecords {
    return new MemoryWorkspaceRecords({ ...records.snapshot(), ...changes });
}

describe("memory workspace records", () => {
    test("rejects snapshots that carry duplicate pointers", { tags: "p0" }, () => {
        const pointer = { namespace: "view.current", key: "surface", recordKey: "surface@0" };
        expect(
            () =>
                new MemoryWorkspaceRecords({
                    version: 1,
                    records: [],
                    uniques: [],
                    pointers: [pointer, { ...pointer, recordKey: "surface@1" }]
                })
        ).toThrow(
            expect.objectContaining({
                name: "TypeError",
                message: "Memory workspace snapshot contains duplicate pointers"
            })
        );
    });

    test("rejects re-inserting an existing record as append-only", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const record = { kind: "event", id: "event-a", bytes: Uint8Array.of(1) } as const;
        records.insertRecord(record);
        expect(() => records.insertRecord(record)).toThrow(
            expect.objectContaining({
                code: "protocol.duplicate",
                message: "Workspace records are append-only"
            })
        );
    });

    test("actor state snapshots mirror the public snapshot", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        records.insertRecord({ kind: "view", id: "surface@0", bytes: Uint8Array.of(2) });
        records.insertUnique({ namespace: "ns", key: "key", recordKey: "surface@0" });
        records.compareAndSetPointer(
            { namespace: "view.current", key: "surface", recordKey: "surface@0" },
            undefined
        );
        const snapshot = records[ACTOR_STATE_SNAPSHOT]();
        expect(snapshot).toEqual(records.snapshot());
        expect(snapshot.records).toHaveLength(1);
        expect(snapshot.uniques).toHaveLength(1);
        expect(snapshot.pointers).toHaveLength(1);
    });
});

describe("event persistence", () => {
    test(
        "rejects a conflicting event with an exact duplicate-identity error",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith();
            const event = eventFixture("dup-a");
            persistence.appendEvent(records, event, eventRetention(event));
            const conflict = eventVariant(eventFixture("dup-b"), {
                idempotencyKey: event.idempotencyKey
            });
            expect(() =>
                persistence.appendEvent(records, conflict, eventRetention(conflict))
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Event idempotency identity is already reserved"
                })
            );
            expect(persistence.findEventByIdentity(records, event.idempotencyKey)).toEqual(event);
        }
    );

    test("rejects re-appending an event record id as immutable", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const event = eventFixture("imm-a");
        persistence.appendEvent(records, event, eventRetention(event));
        const sameId = eventVariant(eventFixture("imm-b"), { id: event.id });
        expect(() =>
            persistence.appendEvent(records, sameId, eventRetention(sameId, "retention-imm-b"))
        ).toThrow(
            expect.objectContaining({
                code: "protocol.duplicate",
                message: "event records are immutable"
            })
        );
    });

    test("fails closed when the idempotency index disagrees with its event", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const event = eventFixture("idx");
        persistence.appendEvent(records, event, eventRetention(event));
        const snapshot = records.snapshot();
        const tampered = new MemoryWorkspaceRecords({
            ...snapshot,
            uniques: snapshot.uniques.map((unique) =>
                unique.namespace === "event.idempotency"
                    ? { ...unique, key: "tampered-key" }
                    : unique
            )
        });
        expect(() => persistence.findEventByIdentity(tampered, "tampered-key")).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Event idempotency index does not match its Event"
            })
        );
    });

    test("rejects appends whose retention proof is not durable", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith(sourceActor, {
            verify: () => false,
            release: () => {},
            discard: () => {}
        });
        const event = eventFixture("nondurable");
        expect(() => persistence.appendEvent(records, event, eventRetention(event))).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Content retention proof is not durable"
            })
        );
    });
});

describe("subscription persistence", () => {
    test("enforces revision compare-and-set with exact conflicts", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const initialConflict = expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "New Subscription requires revision zero and no current record"
        });
        const casConflict = expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "Subscription revision compare-and-set failed"
        });
        expect(() =>
            persistence.saveSubscription(
                records,
                subscriptionFixture("cas", { revision: new Revision(1) }),
                undefined
            )
        ).toThrow(initialConflict);
        expect(() =>
            persistence.saveSubscription(records, subscriptionFixture("other"), Revision.initial())
        ).toThrow(casConflict);
        persistence.saveSubscription(records, subscriptionFixture("cas"), undefined);
        expect(() =>
            persistence.saveSubscription(records, subscriptionFixture("cas"), undefined)
        ).toThrow(initialConflict);
        persistence.saveSubscription(
            records,
            subscriptionFixture("cas", { revision: new Revision(1) }),
            Revision.initial()
        );
        expect(() =>
            persistence.saveSubscription(
                records,
                subscriptionFixture("cas", { revision: new Revision(2) }),
                Revision.initial()
            )
        ).toThrow(casConflict);
        expect(
            persistence.currentSubscription(records, new SubscriptionId("subscription-cas"))
                ?.revision.value
        ).toBe(1);
    });

    test("lists only current revisions, deduplicated and sorted by id", { tags: "p1" }, () => {
        const storage = new ReversedListingStorage(new MemoryWorkspaceRecords());
        const persistence = persistenceWith();
        persistence.saveSubscription(storage, subscriptionFixture("aa"), undefined);
        persistence.saveSubscription(
            storage,
            subscriptionFixture("aa", { revision: new Revision(1) }),
            Revision.initial()
        );
        persistence.saveSubscription(storage, subscriptionFixture("bb"), undefined);
        const listed = persistence.listSubscriptions(storage);
        expect(
            listed.map((subscription) => [subscription.id.value, subscription.revision.value])
        ).toEqual([
            ["subscription-aa", 1],
            ["subscription-bb", 0]
        ]);
    });

    test("fails closed when the current pointer names another subscription", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        persistence.saveSubscription(records, subscriptionFixture("sa"), undefined);
        persistence.saveSubscription(records, subscriptionFixture("sb"), undefined);
        const snapshot = records.snapshot();
        const tampered = new MemoryWorkspaceRecords({
            ...snapshot,
            pointers: snapshot.pointers.map((pointer) =>
                pointer.key === "subscription-sa"
                    ? { ...pointer, recordKey: "subscription-sb@0" }
                    : pointer
            )
        });
        expect(() =>
            persistence.currentSubscription(tampered, new SubscriptionId("subscription-sa"))
        ).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Subscription pointer does not match its Subscription"
            })
        );
    });
});

describe("reservation persistence", () => {
    test(
        "rejects a conflicting dedupe identity with the exact duplicate error",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith();
            const reservation = reservationFixture("dupres");
            persistence.appendReservation(records, reservation, reservationRetention(reservation));
            const rival = new RouteReservation({
                ...reservation.init,
                id: new RouteReservationId("reservation-dupres-rival")
            });
            expect(() =>
                persistence.appendReservation(records, rival, reservationRetention(rival))
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Route dedupe identity is already reserved"
                })
            );
        }
    );

    test("fails closed when the reciprocal dedupe index is missing", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const reservation = reservationFixture("ri");
        persistence.appendReservation(records, reservation, reservationRetention(reservation));
        const missingIndex = rebuilt(records, { uniques: [] });
        const corrupt = expect.objectContaining({
            code: "codec.invalid",
            message: "RouteReservation is missing its reciprocal dedupe index"
        });
        expect(() => persistence.findReservation(missingIndex, reservation.id)).toThrow(corrupt);
        expect(() => persistence.listReservations(missingIndex)).toThrow(corrupt);
    });

    test(
        "fails closed when the dedupe index disagrees with its reservation",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith();
            const first = reservationFixture("dda");
            const second = reservationFixture("ddb");
            persistence.appendReservation(records, first, reservationRetention(first));
            persistence.appendReservation(records, second, reservationRetention(second));
            const snapshot = records.snapshot();
            const mismatch = expect.objectContaining({
                code: "codec.invalid",
                message: "Route dedupe index does not match its reservation"
            });
            const crossWired = new MemoryWorkspaceRecords({
                ...snapshot,
                uniques: snapshot.uniques.map((unique) =>
                    unique.namespace === "route.dedupe:subscription-dda"
                        ? { ...unique, recordKey: "reservation-ddb" }
                        : unique
                )
            });
            expect(() =>
                persistence.findReservationByDedupe(
                    crossWired,
                    new SubscriptionId("subscription-dda"),
                    "event:event-dda"
                )
            ).toThrow(mismatch);
            const wrongKey = new MemoryWorkspaceRecords({
                ...snapshot,
                uniques: [
                    ...snapshot.uniques,
                    {
                        namespace: "route.dedupe:subscription-dda",
                        key: "other-key",
                        recordKey: "reservation-dda"
                    }
                ]
            });
            expect(() =>
                persistence.findReservationByDedupe(
                    wrongKey,
                    new SubscriptionId("subscription-dda"),
                    "other-key"
                )
            ).toThrow(mismatch);
        }
    );

    test("lists reservations sorted by id regardless of storage order", { tags: "p1" }, () => {
        const storage = new ReversedListingStorage(new MemoryWorkspaceRecords());
        const persistence = persistenceWith();
        const first = reservationFixture("ra");
        const second = reservationFixture("rb");
        persistence.appendReservation(storage, first, reservationRetention(first));
        persistence.appendReservation(storage, second, reservationRetention(second));
        expect(persistence.listReservations(storage).map((route) => route.id.value)).toEqual([
            "reservation-ra",
            "reservation-rb"
        ]);
    });
});

describe("projection and delivery persistence", () => {
    test("denies projections addressed to another target actor", { tags: "p0" }, () => {
        const reservation = reservationFixture("auth");
        const authenticated = authenticatedProjectionFixture(reservation);
        const retention = projectionRetention(projectionFixture(reservation));
        expect(() =>
            persistenceWith().appendProjection(
                new MemoryWorkspaceRecords(),
                authenticated,
                retention
            )
        ).toThrow(
            expect.objectContaining({
                code: "authority.denied",
                message: "Authenticated projection belongs to another target Actor"
            })
        );
        const records = new MemoryWorkspaceRecords();
        const projection = persistenceWith(targetActor).appendProjection(
            records,
            authenticated,
            retention
        );
        expect(projection.reservation.value).toBe("reservation-auth");
        expect(() =>
            persistenceWith(targetActor).appendProjection(
                records,
                authenticated,
                projectionRetention(projectionFixture(reservation), targetActor, "retention-auth-2")
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.duplicate",
                message: "Route projection identity is already reserved"
            })
        );
    });

    test(
        "fails closed when the projection index disagrees with its reservation",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith(targetActor);
            for (const suffix of ["pa", "pb"]) {
                const reservation = reservationFixture(suffix);
                persistence.appendProjection(
                    records,
                    authenticatedProjectionFixture(reservation),
                    projectionRetention(projectionFixture(reservation))
                );
            }
            const snapshot = records.snapshot();
            const tampered = new MemoryWorkspaceRecords({
                ...snapshot,
                uniques: snapshot.uniques.map((unique) =>
                    unique.namespace === "route.projection" && unique.key === "reservation-pa"
                        ? { ...unique, recordKey: "projection-pb" }
                        : unique
                )
            });
            expect(() =>
                persistence.findProjectionByReservation(
                    tampered,
                    new RouteReservationId("reservation-pa")
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Projection index does not match its reservation"
                })
            );
        }
    );

    test(
        "[C13-ROUTE-DELIVERY-ONCE] writes at most one terminal delivery only after admission",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith(targetActor);
            const reservation = reservationFixture("dl");
            expect(() => persistence.appendDelivery(records, deliveryFixture(reservation))).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Terminal delivery requires the target-local authenticated projection"
                })
            );
            persistence.appendProjection(
                records,
                authenticatedProjectionFixture(reservation),
                projectionRetention(projectionFixture(reservation))
            );
            expect(persistence.findDelivery(records, reservation.id)).toBeUndefined();
            const delivery = deliveryFixture(reservation);
            persistence.appendDelivery(records, delivery);
            expect(() => persistence.appendDelivery(records, deliveryFixture(reservation))).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Route delivery is already terminal"
                })
            );
            expect(persistence.findDelivery(records, reservation.id)).toEqual(delivery);
        }
    );

    test(
        "fails closed when the delivery index disagrees with its reservation",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = persistenceWith(targetActor);
            for (const suffix of ["da", "db"]) {
                const reservation = reservationFixture(suffix);
                persistence.appendProjection(
                    records,
                    authenticatedProjectionFixture(reservation),
                    projectionRetention(projectionFixture(reservation))
                );
                persistence.appendDelivery(records, deliveryFixture(reservation));
            }
            const snapshot = records.snapshot();
            const tampered = new MemoryWorkspaceRecords({
                ...snapshot,
                uniques: snapshot.uniques.map((unique) =>
                    unique.namespace === "route.delivery" && unique.key === "reservation-da"
                        ? { ...unique, recordKey: "reservation-db" }
                        : unique
                )
            });
            expect(() =>
                persistence.findDelivery(tampered, new RouteReservationId("reservation-da"))
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Delivery index does not match its reservation"
                })
            );
        }
    );
});

describe("view persistence", () => {
    test("enforces view revision compare-and-set with exact conflicts", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const initialConflict = expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "Initial View requires revision zero and no current View"
        });
        const casConflict = expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "View revision compare-and-set failed"
        });
        expect(() => persistence.saveView(records, viewFixture(1, "vc"), undefined, [])).toThrow(
            initialConflict
        );
        expect(() =>
            persistence.saveView(records, viewFixture(0, "vc"), Revision.initial(), [])
        ).toThrow(casConflict);
        persistence.saveView(records, viewFixture(0, "vc"), undefined, []);
        expect(() => persistence.saveView(records, viewFixture(0, "vc"), undefined, [])).toThrow(
            initialConflict
        );
        expect(() =>
            persistence.saveView(records, viewFixture(5, "vc"), Revision.initial(), [])
        ).toThrow(casConflict);
        expect(() =>
            persistence.saveView(records, viewFixture(1, "vc"), new Revision(3), [])
        ).toThrow(casConflict);
        persistence.saveView(records, viewFixture(1, "vc"), Revision.initial(), []);
        expect(persistence.currentView(records, "surface-vc")?.revision.value).toBe(1);
    });

    test("rejects view deltas without a matching current view", { tags: "p0" }, () => {
        const persistence = persistenceWith();
        expect(() =>
            persistence.appendViewDelta(
                new MemoryWorkspaceRecords(),
                viewDeltaFixture(viewFixture(0, "stale")),
                new DeterministicJsonPatchEngine(),
                [],
                []
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "View delta base revision is stale"
            })
        );
    });

    test("fails closed when the view pointer names another surface", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        persistence.saveView(records, viewFixture(0, "va"), undefined, []);
        persistence.saveView(records, viewFixture(0, "vb"), undefined, []);
        const snapshot = records.snapshot();
        const tampered = new MemoryWorkspaceRecords({
            ...snapshot,
            pointers: snapshot.pointers.map((pointer) =>
                pointer.key === "surface-va" ? { ...pointer, recordKey: "surface-vb@0" } : pointer
            )
        });
        expect(() => persistence.currentView(tampered, "surface-va")).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "View pointer does not match its Surface"
            })
        );
    });

    test("requires retentions to cover the view ContentRefs exactly", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const required = content("required-ref");
        const supplied = content("supplied-ref");
        const base = viewFixture(0, "cover");
        const view = new View({ ...base, body: { attachment: required.ref.value } });
        const retention = retentionFixture({
            id: "retention-cover",
            recordKind: "view",
            recordId: "surface-cover@0",
            content: supplied
        });
        expect(() => persistence.saveView(records, view, undefined, [retention])).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "View content retention does not cover every ContentRef exactly"
            })
        );
    });

    test("collects ContentRefs across null, scalar, and array body values", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const view = new View({
            ...viewFixture(0, "nulls"),
            body: { note: null, flag: true, size: 3, tags: [null, "plain"] }
        });
        persistence.saveView(records, view, undefined, []);
        expect(persistence.currentView(records, "surface-nulls")).toEqual(view);
    });

    test(
        "lists deltas strictly after the revision, surface-exact and ascending",
        { tags: "p1" },
        () => {
            const storage = new ReversedListingStorage(new MemoryWorkspaceRecords());
            const persistence = persistenceWith();
            const engine = new DeterministicJsonPatchEngine();
            let surface = viewFixture(0, "lvd-s");
            persistence.saveView(storage, surface, undefined, []);
            for (let step = 0; step < 3; step += 1) {
                surface = persistence.appendViewDelta(
                    storage,
                    viewDeltaFixture(surface),
                    engine,
                    [],
                    []
                );
            }
            let other = viewFixture(0, "lvd-o");
            persistence.saveView(storage, other, undefined, []);
            for (let step = 0; step < 2; step += 1) {
                other = persistence.appendViewDelta(
                    storage,
                    viewDeltaFixture(other),
                    engine,
                    [],
                    []
                );
            }
            const deltas = persistence.listViewDeltas(storage, "surface-lvd-s", new Revision(1));
            expect(deltas.map((delta) => `${delta.surface.value}@${delta.revision.value}`)).toEqual(
                ["surface-lvd-s@2", "surface-lvd-s@3"]
            );
        }
    );

    test("compacts surface-exact records and requires an available floor", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const engine = new DeterministicJsonPatchEngine();
        let compacted = viewFixture(0, "ca");
        persistence.saveView(records, compacted, undefined, []);
        for (let step = 0; step < 2; step += 1) {
            compacted = persistence.appendViewDelta(
                records,
                viewDeltaFixture(compacted),
                engine,
                [],
                []
            );
        }
        let untouched = viewFixture(0, "cb");
        persistence.saveView(records, untouched, undefined, []);
        untouched = persistence.appendViewDelta(
            records,
            viewDeltaFixture(untouched),
            engine,
            [],
            []
        );
        persistence.compactView(records, "surface-ca", new Revision(1));
        expect(records.listRecords("view").map((record) => record.id)).toEqual([
            "surface-ca@1",
            "surface-ca@2",
            "surface-cb@0",
            "surface-cb@1"
        ]);
        expect(records.listRecords("viewDelta").map((record) => record.id)).toEqual([
            "surface-ca@2",
            "surface-cb@1"
        ]);
        expect(() => persistence.compactView(records, "surface-ca", Revision.initial())).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "View compaction floor is unavailable"
            })
        );
    });

    test("refuses compaction when no current view pointer exists", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        persistence.saveView(records, viewFixture(0, "nocur"), undefined, []);
        const snapshot = records.snapshot();
        const withoutPointer = new MemoryWorkspaceRecords({
            ...snapshot,
            pointers: snapshot.pointers.filter((pointer) => pointer.namespace !== "view.current")
        });
        expect(() =>
            persistence.compactView(withoutPointer, "surface-nocur", Revision.initial())
        ).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "View compaction floor is unavailable"
            })
        );
    });

    test("skips retention scans when compaction releases nothing", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const event = eventFixture("lazy");
        persistence.appendEvent(records, event, eventRetention(event));
        persistence.saveView(records, viewFixture(0, "lazy"), undefined, []);
        const snapshot = records.snapshot();
        const corruptedRetention = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.map((record) =>
                record.kind === "contentRetention" ? { ...record, bytes: Uint8Array.of(0) } : record
            )
        });
        expect(() =>
            persistence.compactView(corruptedRetention, "surface-lazy", Revision.initial())
        ).not.toThrow();
        expect(persistence.currentView(corruptedRetention, "surface-lazy")).toEqual(
            viewFixture(0, "lazy")
        );
    });
});

describe("retention listing", () => {
    test("filters retentions by record kind and key exactly", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const viewRef = content("cross-view");
        const view = new View({ ...viewFixture(0, "lr"), body: { attachment: viewRef.ref.value } });
        persistence.saveView(records, view, undefined, [
            retentionFixture({
                id: "retention-lr-view",
                recordKind: "view",
                recordId: "surface-lr@0",
                content: viewRef
            })
        ]);
        const crossEvent = eventVariant(eventFixture("lr-cross"), {
            id: new EventId("surface-lr@0")
        });
        persistence.appendEvent(
            records,
            crossEvent,
            eventRetention(crossEvent, "retention-lr-event")
        );
        const otherEvent = eventFixture("lr-other");
        persistence.appendEvent(
            records,
            otherEvent,
            eventRetention(otherEvent, "retention-lr-other")
        );
        const listed = persistence.listRetentionsFor(
            records,
            RetainedRecordKind.event(),
            "surface-lr@0"
        );
        expect(listed.map((reference) => reference.id.value)).toEqual(["retention-lr-event"]);
    });
});

describe("stored record decoding", () => {
    test("fails closed when storage returns a mismatched kind or key", { tags: "p0" }, () => {
        const inner = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const event = eventFixture("tamper");
        persistence.appendEvent(inner, event, eventRetention(event));
        const malformed = expect.objectContaining({
            code: "codec.invalid",
            message: "Stored workspace record key or kind is malformed"
        });
        const kindTampering = new RecordTamperingStorage(inner, (record) => ({
            ...record,
            kind: "subscription"
        }));
        expect(() => persistence.findEvent(kindTampering, event.id)).toThrow(malformed);
        const idTampering = new RecordTamperingStorage(inner, (record) => ({
            ...record,
            id: `${record.id}-tampered`
        }));
        expect(() => persistence.findEvent(idTampering, event.id)).toThrow(malformed);
    });

    test("fails closed when stored bytes decode to another record identity", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const first = eventFixture("swap-a");
        const second = eventFixture("swap-b");
        persistence.appendEvent(records, first, eventRetention(first));
        persistence.appendEvent(records, second, eventRetention(second));
        const snapshot = records.snapshot();
        const donor = snapshot.records.find(
            (record) => record.kind === "event" && record.id === second.id.value
        );
        if (donor === undefined) throw new Error("Expected a donor event record");
        const swapped = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.map((record) =>
                record.kind === "event" && record.id === first.id.value
                    ? { ...record, bytes: donor.bytes.slice() }
                    : record
            )
        });
        expect(() => persistence.findEvent(swapped, first.id)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored workspace key does not match its codec identity"
            })
        );
    });

    test(
        "decodes a defensive copy and reports uncopyable bytes as malformed",
        { tags: "p0" },
        () => {
            const inner = new MemoryWorkspaceRecords();
            const persistence = persistenceWith();
            const event = eventFixture("refuse");
            persistence.appendEvent(inner, event, eventRetention(event));
            const refusing = new RecordTamperingStorage(inner, (record) => ({
                ...record,
                bytes: new ThrowingSliceBytes(record.bytes)
            }));
            expect(() => persistence.findEvent(refusing, event.id)).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Stored workspace record bytes are malformed"
                })
            );
        }
    );
});

describe("workspace validators", () => {
    test("rejects empty and oversized storage text with exact subjects", { tags: "p1" }, () => {
        const cases: readonly { readonly run: () => void; readonly message: string }[] = [
            {
                run: () =>
                    validateStoredWorkspaceRecord({
                        kind: "event",
                        id: "",
                        bytes: Uint8Array.of(1)
                    }),
                message: "Workspace record key length is invalid"
            },
            {
                run: () =>
                    validateStoredWorkspaceRecord({
                        kind: "event",
                        id: "i".repeat(2049),
                        bytes: Uint8Array.of(1)
                    }),
                message: "Workspace record key length is invalid"
            },
            {
                run: () => validateWorkspaceUnique({ namespace: "", key: "k", recordKey: "r" }),
                message: "Workspace unique namespace length is invalid"
            },
            {
                run: () =>
                    validateWorkspaceUnique({
                        namespace: "n".repeat(513),
                        key: "k",
                        recordKey: "r"
                    }),
                message: "Workspace unique namespace length is invalid"
            },
            {
                run: () =>
                    validateWorkspaceUnique({
                        namespace: "n",
                        key: "k".repeat(2049),
                        recordKey: "r"
                    }),
                message: "Workspace unique key length is invalid"
            },
            {
                run: () => validateWorkspaceUnique({ namespace: "n", key: "k", recordKey: "" }),
                message: "Workspace unique record key length is invalid"
            },
            {
                run: () => validateWorkspacePointer({ namespace: "", key: "k", recordKey: "r" }),
                message: "Workspace pointer namespace length is invalid"
            },
            {
                run: () => validateWorkspacePointer({ namespace: "n", key: "", recordKey: "r" }),
                message: "Workspace pointer key length is invalid"
            },
            {
                run: () => validateWorkspacePointer({ namespace: "n", key: "k", recordKey: "" }),
                message: "Workspace pointer record key length is invalid"
            }
        ];
        for (const { run, message } of cases) {
            expect(run).toThrow(expect.objectContaining({ code: "codec.invalid", message }));
        }
        expect(() =>
            validateWorkspaceUnique({
                namespace: "n".repeat(512),
                key: "k".repeat(2048),
                recordKey: "r".repeat(2048)
            })
        ).not.toThrow();
        expect(() =>
            validateStoredWorkspaceRecord({
                kind: "event",
                id: "i".repeat(2048),
                bytes: Uint8Array.of(1)
            })
        ).not.toThrow();
    });

    test("pointer advances move by exactly one revision", { tags: "p0" }, () => {
        const advanceConflict = expect.objectContaining({
            code: "protocol.revision-conflict",
            message: "Workspace pointer must advance by exactly one revision"
        });
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "s@2" },
                "s@0"
            )
        ).toThrow(advanceConflict);
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "subscription.current", key: "k", recordKey: "s@1" },
                undefined
            )
        ).toThrow(advanceConflict);
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "s@0" },
                undefined
            )
        ).not.toThrow();
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "s@1" },
                "s@0"
            )
        ).not.toThrow();
    });

    test("rejects malformed pointer record keys exactly", { tags: "p0" }, () => {
        const malformed = expect.objectContaining({
            code: "codec.invalid",
            message: "Workspace pointer record key is malformed"
        });
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "0" },
                undefined
            )
        ).toThrow(malformed);
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "s@x" },
                undefined
            )
        ).toThrow(malformed);
        expect(() =>
            validateWorkspacePointerAdvance(
                { namespace: "view.current", key: "k", recordKey: "@1" },
                "@0"
            )
        ).not.toThrow();
    });
});

describe("storage trust boundary kills", () => {
    test("compaction refuses kinds outside the compactable set", { tags: "p0" }, () => {
        const records = new MemoryWorkspaceRecords();
        records.insertRecord({ kind: "event", id: "event-keep", bytes: Uint8Array.of(1) });
        expect(() => records.deleteCompactedRecords("event" as never, ["event-keep"])).toThrow(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.invalid-state",
                message: "Record kind is not compactable"
            })
        );
        expect(records.findRecord("event", "event-keep")).toBeDefined();
    });

    test("insertRecord reports non-buffer bytes as codec corruption", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        expect(() =>
            records.insertRecord({ kind: "event", id: "event-bad", bytes: "nope" } as never)
        ).toThrow(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Workspace record bytes are malformed"
            })
        );
    });

    test("pointer record keys must carry a parseable revision", { tags: "p1" }, () => {
        for (const recordKey of ["surface-unrevisioned", "surface@-1"]) {
            const records = new MemoryWorkspaceRecords();
            expect(() =>
                records.compareAndSetPointer(
                    { namespace: "view.current", key: "surface", recordKey },
                    undefined
                )
            ).toThrow(expect.objectContaining({ name: "AgentCoreError", code: "codec.invalid" }));
        }
    });

    test("a View revision CAS on an empty Surface is a revision conflict", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        // The absent-current check has to answer for itself: the pointer advance rule
        // rejects the same call one step later with the same revision-conflict code, so a
        // test that reads only the code passes while this guard is disabled.
        expect(() =>
            persistence.saveView(records, viewFixture(1, "cas-absent"), Revision.initial(), [])
        ).toThrow(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.revision-conflict",
                message: "View revision compare-and-set failed"
            })
        );
        expect(records.findRecord("view", "surface-cas-absent@1")).toBeUndefined();
    });

    test("stores View bodies containing null values", { tags: "p1" }, () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = persistenceWith();
        const base = viewFixture(0, "null-body");
        const view = new View({
            surface: base.surface,
            revision: base.revision,
            body: { gap: null, nested: { hole: null }, values: [null, 1] },
            actions: base.actions,
            cursor: base.cursor
        });
        persistence.saveView(records, view, undefined, []);
        expect(persistence.currentView(records, view.surface.value)?.body).toEqual({
            gap: null,
            nested: { hole: null },
            values: [null, 1]
        });
    });
});
