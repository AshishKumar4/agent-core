import { describe, expect, test } from "vitest";
import { TurnId } from "../../src/agents";
import {
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../src/core";
import { requireInteger } from "../../src/workspaces/codec";
import { codecCase } from "../helpers/codec-case";
import { malformed } from "../helpers/malformed";

function fieldOf(value: JsonValue, field: string): JsonValue {
    if (!isJsonObject(value)) throw new TypeError(`Expected an object holding ${field}`);
    const nested = value[field];
    if (nested === undefined) throw new TypeError(`Expected a ${field} field`);
    return nested;
}
import { ContributionAttribution, EventPattern, FieldMove, PayloadMapping } from "../../src/facets";
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
import { View, ViewDelta, ViewMark } from "../../src/workspaces/view";
import { attribution } from "../w3/slot-store-contract";
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
        ["Event", codecCase(Event.codec, event)],
        ["Subscription", codecCase(Subscription.codec, subscription)],
        ["RouteReservation", codecCase(RouteReservation.codec, reservation)],
        ["RouteProjection", codecCase(RouteProjection.codec, projection)],
        ["RouteDelivery", codecCase(RouteDelivery.codec, delivery)],
        ["View", codecCase(View.codec, view)],
        ["ViewMark", codecCase(ViewMark.codec, new ViewMark("/value", "external"))],
        ["ViewDelta", codecCase(ViewDelta.codec, delta)],
        ["InboxEventReference", codecCase(InboxEventReference.codec, inbox)],
        ["ContentRetentionReference", codecCase(ContentRetentionReference.codec, retention)]
    ] as const;

    test.each(records)(
        "round-trips %s through canonical codec bytes",
        { tags: "p1" },
        (_name, subject) => {
            const encoded = subject.encode();

            expect(subject.reencode(encoded)).toEqual(encoded);
            expect(subject.decodeIsFrozen(encoded)).toBe(true);
        }
    );

    test.each(records)("rejects an unknown major for %s", { tags: "p2" }, (_name, subject) => {
        const envelope = decodeCanonicalJson(subject.encode());
        if (!isJsonObject(envelope) || !isJsonObject(envelope["version"])) {
            throw new TypeError("Record envelope must carry an object version");
        }
        const version = envelope["version"];
        const future = encodeCanonicalJson({
            ...envelope,
            version: {
                ...version,
                major: requireInteger(version["major"], "Record codec major") + 1
            }
        });

        expect(() => subject.decode(future)).toThrow(
            expect.objectContaining({ code: "codec.unknown-major" })
        );
    });

    test("defensively copies and deeply freezes mutable record inputs", { tags: "p1" }, () => {
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
        expect(Object.isFrozen(fieldOf(provenance.claims, "nested"))).toBe(true);

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
            epoch: view.epoch,
            revision: view.revision,
            body: mutableBody,
            actions: view.actions,
            cursor: view.cursor
        });
        mutableBody.nested.value = 2;
        expect(copiedView.body).toEqual({ nested: { value: 1 } });
        expect(Object.isFrozen(fieldOf(copiedView.body, "nested"))).toBe(true);

        const patch = [{ op: "replace", path: "/body", value: { nested: [1] } }];
        const copiedDelta = new ViewDelta({
            surface: view.surface,
            epoch: view.epoch,
            baseRevision: view.revision,
            revision: view.revision.next(),
            patch,
            cursor: view.cursor
        });
        patch[0]!.path = "/forged";
        expect(copiedDelta.patch[0]).toMatchObject({ path: "/body" });
        expect(Object.isFrozen(fieldOf(copiedDelta.patch[0]!, "value"))).toBe(true);

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
            delta.patch.every(
                (value) => !(Array.isArray(value) || isJsonObject(value)) || Object.isFrozen(value)
            )
        ).toBe(true);
        expect(Object.isFrozen(inbox.init)).toBe(true);
        expect(Object.isFrozen(retention.init)).toBe(true);
    });
});

describe("event policy", () => {
    test(
        "derives host trust only from the complete host-and-lease fact set",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "derives owner, authenticated, and external trust without elevation",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "matches exact and categorical kind/source patterns plus accepted trust",
        { tags: "p1" },
        () => {
            const facetEvent = eventFixture("pattern", { kind: "task.created" });
            expect(eventMatches(subscriptionFixture("pattern").source, facetEvent)).toBe(true);
            expect(
                eventMatches(
                    new EventPattern("task.created", ["authenticated"], "facet.test"),
                    facetEvent
                )
            ).toBe(true);
            expect(eventMatches(new EventPattern("task.*", ["authenticated"]), facetEvent)).toBe(
                true
            );
            expect(eventMatches(new EventPattern("other.*", ["authenticated"]), facetEvent)).toBe(
                false
            );
            expect(eventMatches(new EventPattern("task.*", ["external"]), facetEvent)).toBe(false);

            const actorEvent = eventFixture("actor-pattern", { source: "actor" });
            expect(
                eventMatches(
                    new EventPattern("task.*", ["authenticated"], "workspace-*"),
                    actorEvent
                )
            ).toBe(true);
            expect(
                eventMatches(
                    new EventPattern("task.*", ["authenticated"], "other-actor"),
                    actorEvent
                )
            ).toBe(false);
        }
    );

    test(
        "maps root, arrays, escaped tokens, and literals without aliasing source data",
        { tags: "p1" },
        () => {
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
        }
    );

    test("rejects missing source pointers and overlapping targets", { tags: "p2" }, () => {
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

    test(
        "rejects overlapping mapping targets when constructing a durable Subscription",
        { tags: "p1" },
        () => {
            expect(() =>
                subscriptionFixture("overlap-install", {
                    mapping: new PayloadMapping([
                        new FieldMove("/parent", { literal: {} }),
                        new FieldMove("/parent/child", { literal: true })
                    ])
                })
            ).toThrow(/duplicate or overlap/);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] a Subscription admits retirement only as the presence marker",
        { tags: "p1" },
        () => {
            const live = subscriptionFixture("retirement-marker");
            expect(live.retired).toBeUndefined();

            for (const forged of [false, 0, "true"]) {
                expect(
                    () => new Subscription({ ...live, retired: malformed<true>(forged) })
                ).toThrow(new TypeError("Subscription retirement is declared by presence"));
            }
            expect(new Subscription({ ...live, retired: undefined }).retired).toBeUndefined();
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] a Subscription refuses attribution that is not the canonical record",
        { tags: "p0" },
        () => {
            const live = subscriptionFixture("attribution-shape");
            expect(
                () =>
                    new Subscription({
                        ...live,
                        contribution: malformed<ContributionAttribution>({
                            contributor: "workspace:forged",
                            package: { id: "workspace:forged", version: "1.0.0" }
                        })
                    })
            ).toThrow(new TypeError("Subscription contribution must carry canonical attribution"));
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] only a contributed Subscription retires, and retirement is a later revision",
        { tags: "p0" },
        () => {
            expect(() => subscriptionFixture("uncontributed").retire()).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Only a contributed Subscription is retired by withdrawal"
                })
            );

            const contributed = subscriptionFixture("contributed", {
                contribution: attribution("workspace:contributor")
            });
            const retired = contributed.retire();

            expect(retired.retired).toBe(true);
            expect(retired.revision.value).toBe(contributed.revision.value + 1);
            expect(retired.contribution?.contributor.value).toBe("workspace:contributor");
            expect(contributed.retired).toBeUndefined();
        }
    );

    test(
        "a revised Subscription keeps its identity while its authority and dedupe move",
        { tags: "p1" },
        () => {
            const original = subscriptionFixture("delegating");
            const delegated = original.revise({
                source: original.source,
                target: original.target,
                mapping: original.mapping,
                dedupe: "causation",
                authority: { kind: "delegated", binding: original.authority.binding }
            });

            expect(delegated.id.value).toBe(original.id.value);
            expect(delegated.revision.value).toBe(original.revision.value + 1);

            const restored = Subscription.decode(Subscription.encode(delegated));
            expect(restored.authority.kind).toBe("delegated");
            expect(restored.authority.binding.value).toBe(original.authority.binding.value);
            expect(restored.dedupe).toBe("causation");
            expect(restored.contribution).toBeUndefined();
        }
    );

    test("treats prototype names as inert own JSON keys", { tags: "p1" }, () => {
        Reflect.deleteProperty(Object.prototype, "polluted");
        try {
            const mapped = applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/__proto__/polluted", { literal: true }),
                    new FieldMove("/constructorValue", { from: "/constructor" })
                ]),
                { constructor: "source-value" }
            );
            if (!isJsonObject(mapped)) throw new TypeError("Mapping result must be an object");

            expect.soft(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
            expect.soft(Object.hasOwn(mapped, "__proto__")).toBe(true);
            if (Object.hasOwn(mapped, "__proto__")) {
                expect.soft(mapped["__proto__"]).toEqual({ polluted: true });
            }
            expect.soft(mapped["constructorValue"]).toBe("source-value");
        } finally {
            Reflect.deleteProperty(Object.prototype, "polluted");
        }
    });

    test("derives all four stable dedupe policies", { tags: "p0" }, () => {
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
