// @ts-nocheck
import { describe, expect, test } from "vitest";
import { TurnId } from "../../src/agents";
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
import { EventPattern, FieldMove, PayloadMapping } from "../../src/facets";
import { Event } from "../../src/workspaces/event";
import { InboxEventReference } from "../../src/workspaces/inbox";
import {
    applyPayloadMapping,
    deriveEventTrust,
    eventMatches,
    routeDedupeKey
} from "../../src/workspaces/policy";
import { ContentRetentionReference } from "../../src/workspaces/retention";
import { RouteDelivery, RouteProjection, RouteReservation } from "../../src/workspaces/route";
import { Subscription } from "../../src/workspaces/subscription";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import { View, ViewDelta } from "../../src/workspaces/view";
import {
    deliveryFixture,
    eventFixture,
    eventRetention,
    inboxFixture,
    principal,
    projectionFixture,
    reservationFixture,
    subscriptionFixture,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

describe("workspace durable records", () => {
    const event = eventFixture("codec", { causation: eventFixture("cause").id });
    const subscription = subscriptionFixture("codec");
    const reservation = reservationFixture("codec");
    const projection = projectionFixture(reservation);
    const delivery = deliveryFixture(reservation, "rejected");
    const view = viewFixture(0, "codec");
    const delta = viewDeltaFixture(view);
    const inbox = inboxFixture("codec", 2, 4, new TurnId("turn-codec"));
    const retention = eventRetention(event, "retention-codec");
    const records = [
        ["Event", Event.codec, event],
        ["Subscription", Subscription.codec, subscription],
        ["RouteReservation", RouteReservation.codec, reservation],
        ["RouteProjection", RouteProjection.codec, projection],
        ["RouteDelivery", RouteDelivery.codec, delivery],
        ["View", View.codec, view],
        ["ViewDelta", ViewDelta.codec, delta],
        ["InboxEventReference", InboxEventReference.codec, inbox],
        ["ContentRetentionReference", ContentRetentionReference.codec, retention]
    ] as const;

    test.each(records)("round-trips %s through canonical codec bytes", (_name, codec, record) => {
        const recordCodec = codec as {
            encode(value: unknown): Uint8Array;
            decode(bytes: Uint8Array): unknown;
        };
        const encoded = recordCodec.encode(record);
        const decoded = recordCodec.decode(encoded);

        expect(recordCodec.encode(decoded)).toEqual(encoded);
        expect(Object.isFrozen(decoded)).toBe(true);
    });

    test.each(records)("rejects an unknown major for %s", (_name, codec, record) => {
        const recordCodec = codec as {
            encode(value: unknown): Uint8Array;
            decode(bytes: Uint8Array): unknown;
        };
        const envelope = JSON.parse(new TextDecoder().decode(recordCodec.encode(record))) as {
            version: { major: number; minor: number };
        };
        envelope.version.major += 1;

        expect(() =>
            recordCodec.decode(encodeCanonicalJson(envelope as unknown as JsonValue))
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });

    test("defensively copies and deeply freezes mutable record inputs", () => {
        const claims = { nested: { role: "operator" }, groups: ["alpha"] };
        const provenance = new EventProvenance({
            verification: EventVerification.verified(),
            principal,
            claims
        });
        claims.nested.role = "attacker";
        claims.groups.push("attacker");
        expect(provenance.claims).toEqual({ groups: ["alpha"], nested: { role: "operator" } });
        expect(Object.isFrozen(provenance.claims)).toBe(true);
        expect(Object.isFrozen((provenance.claims as { nested: object }).nested)).toBe(true);

        const sourceMoves = [new FieldMove("/value", { literal: { nested: [1] } })];
        const copiedSubscription = subscriptionFixture("immutable", {
            mapping: new PayloadMapping(sourceMoves)
        });
        sourceMoves.push(new FieldMove("/other", { literal: true }));
        expect(copiedSubscription.mapping.moves).toHaveLength(1);
        expect(Object.isFrozen(copiedSubscription.mapping.moves)).toBe(true);

        const mutableBody = { nested: { value: 1 } };
        const copiedView = new View({
            surface: view.surface,
            revision: view.revision,
            body: mutableBody,
            actions: view.actions,
            cursor: view.cursor
        });
        mutableBody.nested.value = 2;
        expect(copiedView.body).toEqual({ nested: { value: 1 } });
        expect(Object.isFrozen((copiedView.body as { nested: object }).nested)).toBe(true);

        const patch = [{ op: "replace", path: "/body", value: { nested: [1] } }];
        const copiedDelta = new ViewDelta({
            surface: view.surface,
            baseRevision: view.revision,
            revision: view.revision.next(),
            patch,
            cursor: view.cursor
        });
        patch[0]!.path = "/forged";
        expect(copiedDelta.patch[0]).toMatchObject({ path: "/body" });
        expect(Object.isFrozen((copiedDelta.patch[0] as { value: object }).value)).toBe(true);

        for (const record of [
            event,
            subscription,
            reservation,
            projection,
            delivery,
            view,
            delta,
            inbox,
            retention
        ]) {
            expect(Object.isFrozen(record)).toBe(true);
        }
        expect(Object.isFrozen(event.source)).toBe(true);
        expect(Object.isFrozen(event.provenance)).toBe(true);
        expect(Object.isFrozen(event.provenance.claims)).toBe(true);
        expect(Object.isFrozen(subscription.source)).toBe(true);
        expect(Object.isFrozen(subscription.mapping)).toBe(true);
        expect(Object.isFrozen(reservation.init)).toBe(true);
        expect(Object.isFrozen(reservation.tenants)).toBe(true);
        expect(Object.isFrozen(reservation.authority)).toBe(true);
        expect(Object.isFrozen(projection.init)).toBe(true);
        expect(Object.isFrozen(view.body)).toBe(true);
        expect(Object.isFrozen(view.actions)).toBe(true);
        expect(view.actions.every(Object.isFrozen)).toBe(true);
        expect(Object.isFrozen(delta.patch)).toBe(true);
        expect(
            delta.patch.every((value) => typeof value !== "object" || Object.isFrozen(value))
        ).toBe(true);
        expect(Object.isFrozen(inbox.init)).toBe(true);
        expect(Object.isFrozen(retention.init)).toBe(true);
    });
});

describe("event policy", () => {
    test("derives host trust only from the complete host-and-lease fact set", () => {
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: true,
                hostEmission: true
            })
        ).toEqual({ tier: "self", initiator: principal });
        expect(() =>
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: true,
                hostEmission: false
            })
        ).toThrow(/host emission under a valid Turn lease/);
        expect(() =>
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: false,
                hostEmission: true
            })
        ).toThrow(/host emission under a valid Turn lease/);
    });

    test("derives owner, authenticated, and external trust without elevation", () => {
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: true,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "owner", initiator: principal });
        expect(() =>
            deriveEventTrust({
                principalOwnsScope: true,
                validTurnLease: false,
                hostEmission: false
            })
        ).toThrow(/authenticated Principal/);
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "authenticated", initiator: principal });
        expect(
            deriveEventTrust({
                principalOwnsScope: false,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "external" });
    });

    test("matches exact and categorical kind/source patterns plus accepted trust", () => {
        const facetEvent = eventFixture("pattern", { kind: "task.created" });
        expect(eventMatches(subscriptionFixture("pattern").source, facetEvent)).toBe(true);
        expect(
            eventMatches(
                new EventPattern("task.created", ["authenticated"], "facet.test"),
                facetEvent
            )
        ).toBe(true);
        expect(eventMatches(new EventPattern("task.*", ["authenticated"]), facetEvent)).toBe(true);
        expect(eventMatches(new EventPattern("other.*", ["authenticated"]), facetEvent)).toBe(
            false
        );
        expect(eventMatches(new EventPattern("task.*", ["external"]), facetEvent)).toBe(false);

        const actorEvent = eventFixture("actor-pattern", { source: "actor" });
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "workspace-*"), actorEvent)
        ).toBe(true);
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "other-actor"), actorEvent)
        ).toBe(false);
    });

    test("maps root, arrays, escaped tokens, and literals without aliasing source data", () => {
        const source = { payload: { values: ["first", "second"] }, "a/b": { "~key": 3 } };
        const root = applyPayloadMapping(
            new PayloadMapping([new FieldMove("", { from: "/payload" })]),
            source
        );
        expect(root).toEqual({ values: ["first", "second"] });
        expect(root).not.toBe(source.payload);
        expect(Object.isFrozen(root)).toBe(true);

        const mapped = applyPayloadMapping(
            new PayloadMapping([
                new FieldMove("/items/0/name", { from: "/payload/values/0" }),
                new FieldMove("/items/1/name", { from: "/payload/values/1" }),
                new FieldMove("/escaped", { from: "/a~1b/~0key" }),
                new FieldMove("/literal", { literal: { ok: true } })
            ]),
            source
        );
        expect(mapped).toEqual({
            escaped: 3,
            items: [{ name: "first" }, { name: "second" }],
            literal: { ok: true }
        });
    });

    test("rejects missing source pointers and overlapping targets", () => {
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/missing" })]),
                {}
            )
        ).toThrow(/source pointer does not exist/);
        for (const moves of [
            [new FieldMove("/same", { literal: 1 }), new FieldMove("/same", { literal: 2 })],
            [new FieldMove("", { literal: {} }), new FieldMove("/child", { literal: 1 })],
            [
                new FieldMove("/parent", { literal: {} }),
                new FieldMove("/parent/child", { literal: 1 })
            ]
        ]) {
            expect(() => applyPayloadMapping(new PayloadMapping(moves), {})).toThrow(
                /duplicate or overlap/
            );
        }
    });

    test("rejects overlapping mapping targets when constructing a durable Subscription", () => {
        expect(() =>
            subscriptionFixture("overlap-install", {
                mapping: new PayloadMapping([
                    new FieldMove("/parent", { literal: {} }),
                    new FieldMove("/parent/child", { literal: true })
                ])
            })
        ).toThrow(/duplicate or overlap/);
    });

    test("treats prototype names as inert own JSON keys", () => {
        delete (Object.prototype as { polluted?: unknown }).polluted;
        try {
            const mapped = applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/__proto__/polluted", { literal: true }),
                    new FieldMove("/constructorValue", { from: "/constructor" })
                ]),
                JSON.parse('{"constructor":"source-value"}') as JsonValue
            ) as {
                readonly __proto__: { readonly polluted: boolean };
                readonly constructorValue: string;
            };

            expect.soft(({} as { polluted?: unknown }).polluted).toBeUndefined();
            expect.soft(Object.hasOwn(mapped, "__proto__")).toBe(true);
            if (Object.hasOwn(mapped, "__proto__")) {
                expect.soft(mapped.__proto__).toEqual({ polluted: true });
            }
            expect.soft(mapped.constructorValue).toBe("source-value");
        } finally {
            delete (Object.prototype as { polluted?: unknown }).polluted;
        }
    });

    test("derives all four stable dedupe policies", () => {
        const cause = eventFixture("dedupe-cause").id;
        const event = eventFixture("dedupe", { causation: cause });
        expect(routeDedupeKey("event", event)).toBe(`event:${event.id.value}`);
        expect(routeDedupeKey("causation", event)).toBe(`causation:${cause.value}`);
        expect(routeDedupeKey("payload", event)).toBe(
            `payload:sha256:${event.payloadDigest.value}`
        );
        expect(routeDedupeKey("none", event, "logical-delivery-7")).toBe("none:logical-delivery-7");
        expect(routeDedupeKey("none", event, "logical-delivery-7")).toBe(
            routeDedupeKey("none", event, "logical-delivery-7")
        );
        expect(() => routeDedupeKey("causation", eventFixture("cause-free"))).toThrow(
            /requires an Event cause/
        );
        for (const key of [undefined, "", " unstable "]) {
            expect(() => routeDedupeKey("none", event, key)).toThrow(/stable logical delivery key/);
        }
    });
});
