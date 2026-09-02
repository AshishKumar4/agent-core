import { describe, expect, test } from "vitest";
import {
    InvalidationWatermark,
    MemoryInvalidationWatermarkStore,
    ScopeEpoch,
    watermarkKey
} from "../../../src/authority";
import { Revision, type JsonValue } from "../../../src/core";
import { ScopeRef, WorkspaceId } from "../../../src/identity";
import {
    MemoryWorkspaceRecords,
    View,
    ViewDelta,
    ViewReplayProtocol,
    WorkspacePersistence
} from "../../../src/workspaces";
import { EventCursor } from "../../../src/workspaces";
import { SurfaceEpoch } from "../../../src/workspaces";
import { expectAgentCoreError } from "../../protocol/error-assertion";
import { StressRandom } from "./stress-support";
import {
    DeterministicJsonPatchEngine,
    authenticatedProjectionFixture,
    deliveryFixture,
    eventFixture,
    eventRetention,
    principal,
    projectionRetention,
    registerSurface,
    reservationFixture,
    reservationRetention,
    sourceActor,
    tenant,
    targetActor,
    viewFixture
} from "../../workspaces/fixtures";

const STRESS_TIMEOUT = 90_000;
const ROUTED_EVENTS = 1_500;
const REPLAYED_FRACTION = 3;
const PUBLISHED_DELTAS = 1_200;
const COMPACTION_INTERVAL = 100;
const REPLAY_INTERVAL = 10;
const WATERMARK_JOINS = 1_500;
const WATERMARK_SCOPES = 12;
const WATERMARK_EPOCH_SPREAD = 8;

const retentionPort = {
    verify: () => true,
    retain: () => {},
    release: () => {},
    discard: () => {}
};

function sourcePersistence(): WorkspacePersistence<MemoryWorkspaceRecords> {
    return new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        retentionPort,
        sourceActor,
        tenant
    );
}

function targetPersistence(): WorkspacePersistence<MemoryWorkspaceRecords> {
    return new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        retentionPort,
        targetActor,
        tenant
    );
}

function deltaFor(view: View, count: number): ViewDelta {
    return new ViewDelta({
        surface: view.surface,
        epoch: view.epoch,
        baseRevision: view.revision,
        revision: view.revision.next(),
        patch: [{ op: "replace", path: "/body/count", value: count }],
        cursor: new EventCursor(`cursor-${view.revision.value + 1}`)
    });
}

/** The cursor `viewFixture` and `deltaFor` give the View at one revision of this stream. */
function cursorAt(revision: Revision): EventCursor {
    return new EventCursor(`cursor-${revision.value}`);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function bodyCount(view: View): number {
    if (!isJsonObject(view.body)) throw new TypeError("Expected a View body object");
    const count = view.body["count"];
    if (!isJsonNumber(count)) throw new TypeError("Expected a numeric View count");
    return count;
}

function isJsonNumber(value: JsonValue | undefined): value is number {
    return typeof value === "number";
}

describe("event routing and view replay at volume", () => {
    test(
        "delivers every routed event exactly once while replays are rejected as duplicates",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        () => {
            const records = new MemoryWorkspaceRecords();
            const source = sourcePersistence();
            const target = targetPersistence();
            let replayRejections = 0;

            for (let index = 0; index < ROUTED_EVENTS; index += 1) {
                const suffix = `volume-${index}`;
                const event = eventFixture(suffix);
                const reservation = reservationFixture(suffix);
                source.appendEvent(records, event, eventRetention(event));
                source.appendReservation(records, reservation, reservationRetention(reservation));
                const authenticated = authenticatedProjectionFixture(reservation);
                const projection = target.appendProjection(
                    records,
                    authenticated,
                    projectionRetention(authenticated.envelope.projection)
                );
                target.appendDelivery(records, deliveryFixture(reservation));

                if (index % REPLAYED_FRACTION !== 0) continue;
                replayRejections += 1;
                expectAgentCoreError(
                    () => source.appendEvent(records, event, eventRetention(event)),
                    "protocol.duplicate"
                );
                expectAgentCoreError(
                    () =>
                        source.appendReservation(
                            records,
                            reservation,
                            reservationRetention(reservation)
                        ),
                    "protocol.duplicate"
                );
                expectAgentCoreError(
                    () =>
                        target.appendProjection(
                            records,
                            authenticated,
                            projectionRetention(projection)
                        ),
                    "protocol.duplicate"
                );
                expectAgentCoreError(
                    () => target.appendDelivery(records, deliveryFixture(reservation)),
                    "protocol.duplicate"
                );
            }

            const reservations = source.listReservations(records);
            expect(reservations).toHaveLength(ROUTED_EVENTS);
            expect(replayRejections).toBe(Math.ceil(ROUTED_EVENTS / REPLAYED_FRACTION));
            expect(new Set(reservations.map((route) => route.id.value)).size).toBe(ROUTED_EVENTS);

            for (const reservation of reservations) {
                const event = source.findEvent(records, reservation.event);
                expect(event?.id.value).toBe(reservation.event.value);
                expect(
                    source.findEventByIdentity(records, event?.idempotencyKey ?? "")?.id.value
                ).toBe(reservation.event.value);
                expect(
                    source.findReservationByDedupe(
                        records,
                        reservation.subscription,
                        reservation.dedupeKey
                    )?.id.value
                ).toBe(reservation.id.value);
                expect(
                    target.findProjectionByReservation(records, reservation.id)?.reservation.value
                ).toBe(reservation.id.value);
                expect(target.findDelivery(records, reservation.id)?.state.kind).toBe("delivered");
            }
            expect(records.listRecords("routeDelivery")).toHaveLength(ROUTED_EVENTS);
            expect(records.listRecords("event")).toHaveLength(ROUTED_EVENTS);
        }
    );

    test(
        "converges every view replay against the durable view under interleaved compaction",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = sourcePersistence();
            const protocol = new ViewReplayProtocol(
                persistence,
                new DeterministicJsonPatchEngine(),
                sourceActor,
                tenant
            );
            const random = new StressRandom("view-replay-volume");
            const initial = viewFixture(0, "volume");
            registerSurface(persistence, records, initial.surface);
            protocol.publishSnapshot(records, initial, []);
            let view = initial;
            let floor = Revision.initial();
            const floors: number[] = [floor.value];

            for (let count = 1; count <= PUBLISHED_DELTAS; count += 1) {
                const published = protocol.publish(records, deltaFor(view, count), [], []);
                expect(published.revision.value).toBe(view.revision.value + 1);
                expect(bodyCount(published)).toBe(count);
                view = published;

                const current = persistence.currentView(
                    records,
                    view.surface.value,
                    SurfaceEpoch.first()
                );
                expect(current?.revision.value).toBe(view.revision.value);

                if (count % REPLAY_INTERVAL === 0) {
                    // Replaying from any retained base must rebuild the exact durable View.
                    const base = new Revision(
                        floor.value + random.integer(view.revision.value - floor.value)
                    );
                    const replayed = protocol.replay(
                        records,
                        view.surface,
                        SurfaceEpoch.first(),
                        cursorAt(base)
                    );
                    expect(replayed.kind).toBe("deltas");
                    if (replayed.kind !== "deltas") throw new TypeError("Expected durable deltas");
                    expect(replayed.deltas.map((delta) => delta.revision.value)).toEqual(
                        Array.from(
                            { length: view.revision.value - base.value },
                            (_value, offset) => base.value + offset + 1
                        )
                    );
                    expect(View.codec.encode(replayed.view)).toEqual(View.codec.encode(view));
                }

                if (count % COMPACTION_INTERVAL !== 0) continue;
                const compactedAway = floor;
                floor = new Revision(view.revision.value - 1);
                protocol.compact(records, view.surface, SurfaceEpoch.first(), floor);
                floors.push(floor.value);

                expect(
                    persistence.findView(
                        records,
                        view.surface.value,
                        SurfaceEpoch.first(),
                        compactedAway
                    )
                ).toBeUndefined();
                expect(
                    persistence.findView(records, view.surface.value, SurfaceEpoch.first(), floor)
                        ?.revision.value
                ).toBe(floor.value);
                // Compaction released the position, so resuming from it is refused.
                expectAgentCoreError(
                    () =>
                        protocol.replay(
                            records,
                            view.surface,
                            SurfaceEpoch.first(),
                            cursorAt(compactedAway)
                        ),
                    "protocol.invalid-state"
                );
                expect(
                    persistence
                        .listViewDeltas(
                            records,
                            view.surface.value,
                            SurfaceEpoch.first(),
                            Revision.initial()
                        )
                        .map((delta) => delta.revision.value)
                ).toEqual([view.revision.value]);
            }

            expect(view.revision.value).toBe(PUBLISHED_DELTAS);
            expect(bodyCount(view)).toBe(PUBLISHED_DELTAS);
            expect(floors).toEqual([...floors].sort((left, right) => left - right));
            expect(new Set(floors).size).toBe(floors.length);
            expectAgentCoreError(
                () =>
                    protocol.replay(
                        records,
                        view.surface,
                        SurfaceEpoch.first(),
                        cursorAt(new Revision(view.revision.value + 1))
                    ),
                "protocol.invalid-state"
            );
        }
    );

    test(
        "keeps invalidation watermarks monotone under out-of-order epoch joins",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        () => {
            const store = new MemoryInvalidationWatermarkStore(tenant, sourceActor);
            const empty = InvalidationWatermark.empty(tenant, sourceActor, principal);
            store.save(empty);
            const key = watermarkKey(empty);
            const scopes = Array.from({ length: WATERMARK_SCOPES }, (_value, index) =>
                ScopeRef.workspace(tenant, new WorkspaceId(`watermark-scope-${index}`))
            );
            const highest = new Map<string, number>();
            let previous = empty;
            let advances = 0;

            for (let join = 0; join < WATERMARK_JOINS; join += 1) {
                const scope = scopes[join % WATERMARK_SCOPES];
                if (scope === undefined) throw new TypeError("Expected a watermark scope");
                // A deterministic sawtooth so late joins repeatedly arrive out of order.
                const epoch =
                    1 + ((join * 7) % WATERMARK_EPOCH_SPREAD) + Math.floor(join / WATERMARK_SCOPES);
                const scopeKey = `watermark-scope-${join % WATERMARK_SCOPES}`;
                const known = highest.get(scopeKey) ?? 0;
                const joined = store.join(key, [new ScopeEpoch(scope, epoch)]);

                expect(joined.dominates(previous)).toBe(true);
                if (epoch > known) {
                    highest.set(scopeKey, epoch);
                    advances += 1;
                    expect(joined.revision.value).toBe(previous.revision.value + 1);
                } else {
                    expect(joined.revision.value).toBe(previous.revision.value);
                }
                expect(joined.epoch(scope)).toBe(highest.get(scopeKey));
                previous = joined;
            }

            const loaded = store.load(key);
            expect(loaded?.revision.value).toBe(advances);
            expect(loaded?.delivered).toHaveLength(WATERMARK_SCOPES);
            for (const [index, scope] of scopes.entries()) {
                expect(loaded?.epoch(scope)).toBe(highest.get(`watermark-scope-${index}`));
            }
            expectAgentCoreError(() => store.save(empty), "protocol.revision-conflict");
        }
    );
});
