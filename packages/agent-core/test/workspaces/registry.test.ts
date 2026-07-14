import { expect, test } from "vitest";
import {
    ContentRetentionReference,
    ActionDescriptor,
    Event,
    EventProvenance,
    InboxEventReference,
    RouteDelivery,
    RouteProjection,
    RouteReservation,
    Subscription,
    View,
    ViewDelta
} from "../../src/workspaces";
import {
    deliveryFixture,
    eventFixture,
    eventRetention,
    inboxFixture,
    projectionFixture,
    reservationFixture,
    subscriptionFixture,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

test("[workspace.event-provenance] codec and ownership evidence", () => {
    const value = eventFixture("registry-provenance").provenance;
    expect(EventProvenance.encode(EventProvenance.decode(EventProvenance.encode(value)))).toEqual(
        EventProvenance.encode(value)
    );
});

test("[workspace.action-descriptor] codec and ownership evidence", () => {
    const value = viewFixture(0, "registry-action").actions[0]!;
    expect(
        ActionDescriptor.encode(ActionDescriptor.decode(ActionDescriptor.encode(value)))
    ).toEqual(ActionDescriptor.encode(value));
});

test("[workspace.event] codec and ownership evidence", () => {
    const value = eventFixture("registry");
    expect(Event.encode(Event.decode(Event.encode(value)))).toEqual(Event.encode(value));
});

test("[workspace.subscription] codec and ownership evidence", () => {
    const value = subscriptionFixture("registry");
    expect(Subscription.encode(Subscription.decode(Subscription.encode(value)))).toEqual(
        Subscription.encode(value)
    );
});

test("[workspace.route-reservation] codec and ownership evidence", () => {
    const value = reservationFixture("registry");
    expect(
        RouteReservation.encode(RouteReservation.decode(RouteReservation.encode(value)))
    ).toEqual(RouteReservation.encode(value));
});

test("[workspace.route-projection] codec and ownership evidence", () => {
    const value = projectionFixture(reservationFixture("registry"));
    expect(RouteProjection.encode(RouteProjection.decode(RouteProjection.encode(value)))).toEqual(
        RouteProjection.encode(value)
    );
});

test("[workspace.route-delivery] codec and ownership evidence", () => {
    const value = deliveryFixture(reservationFixture("registry"));
    expect(RouteDelivery.encode(RouteDelivery.decode(RouteDelivery.encode(value)))).toEqual(
        RouteDelivery.encode(value)
    );
});

test("[workspace.view] codec and ownership evidence", () => {
    const value = viewFixture(0, "registry");
    expect(View.encode(View.decode(View.encode(value)))).toEqual(View.encode(value));
});

test("[workspace.view-delta] codec and ownership evidence", () => {
    const value = viewDeltaFixture(viewFixture(0, "registry"));
    expect(ViewDelta.encode(ViewDelta.decode(ViewDelta.encode(value)))).toEqual(
        ViewDelta.encode(value)
    );
});

test("[workspace.content-retention-reference] codec and ownership evidence", () => {
    const value = eventRetention(eventFixture("registry"));
    expect(
        ContentRetentionReference.encode(
            ContentRetentionReference.decode(ContentRetentionReference.encode(value))
        )
    ).toEqual(ContentRetentionReference.encode(value));
});

test("[workspace.inbox-reference] codec and ownership evidence", () => {
    const value = inboxFixture("registry");
    expect(
        InboxEventReference.encode(InboxEventReference.decode(InboxEventReference.encode(value)))
    ).toEqual(InboxEventReference.encode(value));
});
