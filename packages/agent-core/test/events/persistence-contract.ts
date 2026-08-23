import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { Revision } from "../../src/core";
import type { ContributionAttribution } from "../../src/facets";
import {
    Event,
    EventId,
    RouteProjection,
    RouteProjectionId,
    RouteReservation,
    RouteReservationId,
    View,
    WorkspacePersistence,
    type EventInit,
    type Subscription
} from "../../src/workspaces";
import { attribution } from "../w3/slot-store-contract";
import {
    content,
    authenticatedProjectionFixture,
    deliveryFixture,
    DeterministicJsonPatchEngine,
    eventFixture,
    eventRetention,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    retentionFixture,
    sourceActor,
    subscriptionFixture,
    viewDeltaFixture,
    viewFixture
} from "../workspaces/fixtures";

export interface WorkspacePersistenceHarness<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    restart(): void;
    dispose(): void;
}

export function workspacePersistenceContract<Transaction>(
    name: string,
    create: () => WorkspacePersistenceHarness<Transaction>
): void {
    describe(`${name} workspace persistence`, () => {
        test(
            "binds retained content to the exact durable record atomically",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const event = eventFixture(`${name}-retention`);
                    const wrongRecord = retentionFixture({
                        id: `${name}-wrong-retention`,
                        recordKind: "event",
                        recordId: "another-event",
                        content: { ref: event.payload, digest: event.payloadDigest }
                    });
                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(transaction, event, wrongRecord);
                        })
                    ).toThrow(/does not bind/);
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.findEvent(transaction, event.id)
                        ).toBeUndefined();
                    });

                    const wrongContent = content(`${name}-wrong-content`);
                    const mismatchedContent = retentionFixture({
                        id: `${name}-wrong-content-retention`,
                        recordKind: "event",
                        recordId: event.id.value,
                        content: wrongContent
                    });
                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(transaction, event, mismatchedContent);
                        })
                    ).toThrow(/does not bind/);

                    harness.transaction((transaction) => {
                        harness.persistence.appendEvent(transaction, event, eventRetention(event));
                        expect(
                            harness.persistence.findEventByIdentity(
                                transaction,
                                event.idempotencyKey
                            )?.id
                        ).toEqual(event.id);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "rolls back partial unique reservations and preserves the original owner",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const original = eventFixture(`${name}-unique-original`);
                    harness.transaction((transaction) => {
                        harness.persistence.appendEvent(
                            transaction,
                            original,
                            eventRetention(original)
                        );
                    });
                    const conflictingInit: EventInit = {
                        id: new EventId(`${name}-unique-conflict`),
                        scope: original.scope,
                        source: original.source,
                        kind: original.kind,
                        payload: original.payload,
                        payloadDigest: original.payloadDigest,
                        idempotencyKey: original.idempotencyKey,
                        correlation: original.correlation,
                        provenance: original.provenance,
                        trust: original.trust,
                        visibility: original.visibility
                    };
                    const conflicting = new Event(
                        original.initiator === undefined
                            ? conflictingInit
                            : { ...conflictingInit, initiator: original.initiator }
                    );

                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(
                                transaction,
                                conflicting,
                                eventRetention(conflicting, `${name}-conflict-retention`)
                            );
                        })
                    ).toThrow();

                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.findEvent(transaction, conflicting.id)
                        ).toBeUndefined();
                        expect(
                            harness.persistence.findEventByIdentity(
                                transaction,
                                original.idempotencyKey
                            )?.id
                        ).toEqual(original.id);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test("enforces subscription and View compare-and-set revisions", { tags: "p0" }, () => {
            const harness = create();
            try {
                const initial = subscriptionFixture(`${name}-cas`);
                const revised = initial.revise({
                    source: initial.source,
                    target: initial.target,
                    mapping: initial.mapping,
                    dedupe: "payload",
                    authority: initial.authority
                });
                harness.transaction((transaction) => {
                    harness.persistence.saveSubscription(transaction, initial, undefined);
                    harness.persistence.saveSubscription(transaction, revised, initial.revision);
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(
                            transaction,
                            revised,
                            initial.revision
                        );
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));

                const view = viewFixture(0, `${name}-cas`);
                harness.transaction((transaction) => {
                    harness.persistence.saveView(transaction, view, undefined, []);
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveView(transaction, view, undefined, []);
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveView(
                            transaction,
                            new View({
                                surface: view.surface,
                                revision: new Revision(2),
                                body: view.body,
                                actions: view.actions,
                                cursor: view.cursor
                            }),
                            view.revision,
                            []
                        );
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));

                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.currentSubscription(transaction, initial.id)?.revision
                            .value
                    ).toBe(1);
                    expect(
                        harness.persistence.currentView(transaction, view.surface.value)?.revision
                            .value
                    ).toBe(0);
                });
            } finally {
                harness.dispose();
            }
        });

        test(
            "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] fixes attribution at creation and refuses every later revision that adds, drops, or rewrites it",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const contribution = attribution("workspace:fixed");
                    const contributed = subscriptionFixture(`${name}-attributed`, {
                        contribution
                    });
                    const direct = subscriptionFixture(`${name}-direct`);
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(transaction, contributed, undefined);
                        harness.persistence.saveSubscription(transaction, direct, undefined);
                    });

                    for (const candidate of [
                        revised(contributed, attribution("workspace:other")),
                        revised(contributed, undefined),
                        revised(direct, contribution)
                    ]) {
                        expect(() =>
                            harness.transaction((transaction) => {
                                harness.persistence.saveSubscription(
                                    transaction,
                                    candidate,
                                    Revision.initial()
                                );
                            })
                        ).toThrow(
                            expect.objectContaining({
                                code: "protocol.invalid-state",
                                message: "Subscription contribution attribution is immutable"
                            })
                        );
                    }

                    harness.transaction((transaction) => {
                        const stored = harness.persistence.currentSubscription(
                            transaction,
                            contributed.id
                        );
                        expect(stored?.revision.value).toBe(0);
                        expect(stored?.contribution?.equals(contribution)).toBe(true);
                        expect(
                            harness.persistence.currentSubscription(transaction, direct.id)
                                ?.contribution
                        ).toBeUndefined();
                    });

                    // The store refuses a changed pair rather than a later revision, and the
                    // fixed pair survives the substrate rather than the process that wrote it.
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(
                            transaction,
                            revised(contributed, contribution),
                            Revision.initial()
                        );
                    });
                    harness.restart();
                    harness.transaction((transaction) => {
                        const reopened = harness.persistence.currentSubscription(
                            transaction,
                            contributed.id
                        );
                        expect(reopened?.revision.value).toBe(1);
                        expect(reopened?.contribution?.equals(contribution)).toBe(true);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test("makes route projection and delivery decisions terminal", { tags: "p0" }, () => {
            const harness = create();
            try {
                const reservation = reservationFixture(`${name}-terminal`, { target: sourceActor });
                const projection = projectionFixture(reservation);
                const delivery = deliveryFixture(reservation);
                harness.transaction((transaction) => {
                    harness.persistence.appendReservation(
                        transaction,
                        reservation,
                        reservationRetention(reservation)
                    );
                    harness.persistence.appendProjection(
                        transaction,
                        authenticatedProjectionFixture(reservation),
                        projectionRetention(projection, sourceActor)
                    );
                    harness.persistence.appendDelivery(transaction, delivery);
                });

                const duplicateReservation = new RouteReservation({
                    ...reservation.init,
                    id: new RouteReservationId(`${name}-duplicate-reservation`),
                    projection: new RouteProjectionId(`${name}-duplicate-projection`)
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendReservation(
                            transaction,
                            duplicateReservation,
                            reservationRetention(duplicateReservation)
                        );
                    })
                ).toThrow();

                const duplicateProjection = new RouteProjection({
                    id: new RouteProjectionId(`${name}-second-projection`),
                    reservation: reservation.id,
                    content: projection.content,
                    digest: projection.digest
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        const duplicateRoute = new RouteReservation({
                            ...reservation.init,
                            projection: duplicateProjection.id
                        });
                        harness.persistence.appendProjection(
                            transaction,
                            authenticatedProjectionFixture(duplicateRoute),
                            projectionRetention(duplicateProjection)
                        );
                    })
                ).toThrow();
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendDelivery(
                            transaction,
                            deliveryFixture(reservation, "rejected")
                        );
                    })
                ).toThrow(/immutable|unique|constraint|already terminal/i);

                harness.transaction((transaction) => {
                    const stored = harness.persistence.findReservation(transaction, reservation.id);
                    expect(stored?.sourceActor.equals(sourceActor)).toBe(true);
                    expect(stored?.targetActor.equals(sourceActor)).toBe(true);
                    expect(
                        harness.persistence.findProjection(transaction, duplicateProjection.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findDelivery(transaction, reservation.id)?.state.kind
                    ).toBe("delivered");
                    expect(harness.persistence.listReservations(transaction)).toEqual([stored]);
                });
            } finally {
                harness.dispose();
            }
        });

        test("restores Events, routes, Views, and deltas after restart", { tags: "p1" }, () => {
            const harness = create();
            try {
                const event = eventFixture(`${name}-restart`);
                const reservation = reservationFixture(`${name}-restart`, { target: sourceActor });
                const projection = projectionFixture(reservation);
                const view = viewFixture(0, `${name}-restart`);
                const delta = viewDeltaFixture(view);
                const next = new View({
                    surface: view.surface,
                    revision: delta.revision,
                    body: { count: 1, nested: { enabled: true } },
                    actions: view.actions,
                    cursor: delta.cursor
                });
                harness.transaction((transaction) => {
                    harness.persistence.appendEvent(transaction, event, eventRetention(event));
                    harness.persistence.appendReservation(
                        transaction,
                        reservation,
                        reservationRetention(reservation)
                    );
                    harness.persistence.appendProjection(
                        transaction,
                        authenticatedProjectionFixture(reservation),
                        projectionRetention(projection, sourceActor)
                    );
                    harness.persistence.saveView(transaction, view, undefined, []);
                    expect(
                        harness.persistence.appendViewDelta(
                            transaction,
                            delta,
                            new DeterministicJsonPatchEngine(),
                            [],
                            []
                        ).body
                    ).toEqual(next.body);
                });
                harness.restart();

                harness.transaction((transaction) => {
                    expect(harness.persistence.findEvent(transaction, event.id)?.id).toEqual(
                        event.id
                    );
                    expect(
                        harness.persistence.findReservation(transaction, reservation.id)?.id
                    ).toEqual(reservation.id);
                    expect(
                        harness.persistence.findProjection(transaction, projection.id)?.id
                    ).toEqual(projection.id);
                    expect(
                        harness.persistence.findView(
                            transaction,
                            view.surface.value,
                            Revision.initial()
                        )?.body
                    ).toEqual(view.body);
                    expect(
                        harness.persistence.currentView(transaction, view.surface.value)?.body
                    ).toEqual(next.body);
                    expect(
                        harness.persistence
                            .listViewDeltas(transaction, view.surface.value, Revision.initial())
                            .map((item) => item.revision.value)
                    ).toEqual([1]);
                });
            } finally {
                harness.dispose();
            }
        });
    });
}

/** A later revision of one Subscription that changes only the attribution it carries. */
function revised(
    subscription: Subscription,
    contribution: ContributionAttribution | undefined
): Subscription {
    return subscription.revise({
        source: subscription.source,
        target: subscription.target,
        mapping: subscription.mapping,
        dedupe: subscription.dedupe,
        authority: subscription.authority,
        contribution
    });
}
