import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../src/core";
import { EventPattern, FieldMove, PayloadMapping } from "../../src/facets";
import {
    applyPayloadMapping,
    deriveEventTrust,
    eventMatches,
    routeDedupeKey,
    trustAccepted,
    validatePayloadMapping
} from "../../src/workspaces/policy";
import { eventFixture, principal } from "./fixtures";

type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function mappingOf(...moves: readonly FieldMove[]): PayloadMapping {
    return new PayloadMapping(moves);
}

function expectSubscriptionInvalid(action: () => unknown, message: string): void {
    expect(action).toThrow(
        expect.objectContaining({ code: "subscription.invalid", message, name: "AgentCoreError" })
    );
}

describe("event trust derivation", () => {
    test("derives every trust tier with exact initiator presence", { tags: "p0" }, () => {
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                hostEmission: true,
                principalOwnsScope: false,
                validTurnLease: true
            })
        ).toStrictEqual({ initiator: principal, tier: "self" });
        const anonymousSelf = deriveEventTrust({
            hostEmission: true,
            principalOwnsScope: false,
            validTurnLease: true
        });
        expect(anonymousSelf).toStrictEqual({ tier: "self" });
        expect(Object.keys(anonymousSelf)).toStrictEqual(["tier"]);
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                hostEmission: false,
                principalOwnsScope: true,
                validTurnLease: false
            })
        ).toStrictEqual({ initiator: principal, tier: "owner" });
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                hostEmission: false,
                principalOwnsScope: false,
                validTurnLease: false
            })
        ).toStrictEqual({ initiator: principal, tier: "authenticated" });
        const external = deriveEventTrust({
            hostEmission: false,
            principalOwnsScope: false,
            validTurnLease: false
        });
        expect(external).toStrictEqual({ tier: "external" });
        expect(Object.keys(external)).toStrictEqual(["tier"]);
    });

    test("denies partial self facts and ownerless owner claims exactly", { tags: "p0" }, () => {
        const selfDenied = expect.objectContaining({
            code: "authority.denied",
            message: "Self trust requires a host emission under a valid Turn lease"
        });
        expect(() =>
            deriveEventTrust({ hostEmission: false, principalOwnsScope: false, validTurnLease: true })
        ).toThrow(selfDenied);
        expect(() =>
            deriveEventTrust({ hostEmission: true, principalOwnsScope: false, validTurnLease: false })
        ).toThrow(selfDenied);
        expect(() =>
            deriveEventTrust({ hostEmission: false, principalOwnsScope: true, validTurnLease: false })
        ).toThrow(
            expect.objectContaining({
                code: "authority.denied",
                message: "Owner trust requires an authenticated Principal"
            })
        );
    });
});

describe("event pattern matching", () => {
    const event = eventFixture("pattern");

    test("matches kinds by wildcard prefix or full literal only", { tags: "p0" }, () => {
        const cases: readonly (readonly [string, boolean])[] = [
            ["task.*", true],
            ["ta*", true],
            ["task.created", true],
            ["task.created*", true],
            ["task", false],
            ["task.createdd", false],
            ["tx*", false]
        ];
        for (const [kind, expected] of cases) {
            expect(eventMatches(new EventPattern(kind, ["authenticated"]), event)).toBe(expected);
        }
    });

    test("filters on source pattern and accepted trust tiers", { tags: "p0" }, () => {
        expect(eventMatches(new EventPattern("task.*", ["authenticated"], "facet.*"), event)).toBe(
            true
        );
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "facet.test"), event)
        ).toBe(true);
        expect(eventMatches(new EventPattern("task.*", ["authenticated"], "other.*"), event)).toBe(
            false
        );
        expect(eventMatches(new EventPattern("task.*", ["owner", "self"]), event)).toBe(false);
        const actorEvent = eventFixture("pattern-actor", { source: "actor" });
        expect(
            eventMatches(
                new EventPattern("task.*", ["authenticated"], "workspace-source"),
                actorEvent
            )
        ).toBe(true);
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "facet.*"), actorEvent)
        ).toBe(false);
    });

    test("accepts trust tiers by exact membership", { tags: "p0" }, () => {
        expect(trustAccepted(["owner", "self"], "self")).toBe(true);
        expect(trustAccepted(["owner", "self"], "authenticated")).toBe(false);
    });
});

describe("route dedupe keys", () => {
    test("routes each dedupe policy to its exact key", { tags: "p0" }, () => {
        const cause = eventFixture("dedupe-cause");
        const event = eventFixture("dedupe", { causation: cause.id });
        expect(routeDedupeKey("event", event)).toBe("event:event-dedupe");
        expect(routeDedupeKey("causation", event)).toBe("causation:event-dedupe-cause");
        expect(routeDedupeKey("payload", event)).toBe(
            `payload:sha256:${event.payloadDigest.value}`
        );
        expect(routeDedupeKey("none", event, "stable-key")).toBe("none:stable-key");
    });

    test("rejects unroutable dedupe requests with exact subscription errors", { tags: "p0" }, () => {
        const event = eventFixture("dedupe-invalid");
        expectSubscriptionInvalid(
            () => routeDedupeKey("causation", event),
            "Causation dedupe requires an Event cause"
        );
        for (const key of [undefined, "", " padded "]) {
            expectSubscriptionInvalid(
                () => routeDedupeKey("none", event, key),
                "No-dedupe routing requires a stable logical delivery key"
            );
        }
    });
});

describe("payload mapping", () => {
    test("accepts disjoint targets and rejects duplicates and overlap both ways", { tags: "p1" }, () => {
        const disjoint = mappingOf(new FieldMove("/a", { from: "" }), new FieldMove("/b", { from: "" }));
        expect(() => validatePayloadMapping(disjoint)).not.toThrow();
        expect(applyPayloadMapping(disjoint, { v: 1 })).toStrictEqual({ a: { v: 1 }, b: { v: 1 } });
        const overlaps: readonly (readonly [string, string])[] = [
            ["/a", "/a"],
            ["/a", "/a/b"],
            ["/a/b", "/a"]
        ];
        for (const [first, second] of overlaps) {
            expect(() =>
                validatePayloadMapping(
                    mappingOf(new FieldMove(first, { literal: 1 }), new FieldMove(second, { literal: 2 }))
                )
            ).toThrow(new TypeError("Mapping targets must not duplicate or overlap"));
        }
    });

    test("creates arrays only for canonical index tokens", { tags: "p1" }, () => {
        expect(
            applyPayloadMapping(mappingOf(new FieldMove("/list/0/name", { literal: "x" })), {})
        ).toStrictEqual({ list: [{ name: "x" }] });
        expect(applyPayloadMapping(mappingOf(new FieldMove("/m/0/0", { literal: 3 })), {})).toStrictEqual(
            { m: [[3]] }
        );
        expect(applyPayloadMapping(mappingOf(new FieldMove("/list/-", { literal: 7 })), {})).toStrictEqual(
            { list: [7] }
        );
        expect(applyPayloadMapping(mappingOf(new FieldMove("/a/01", { literal: 1 })), {})).toStrictEqual(
            { a: { "01": 1 } }
        );
        expect(applyPayloadMapping(mappingOf(new FieldMove("/a/1x", { literal: 1 })), {})).toStrictEqual(
            { a: { "1x": 1 } }
        );
        expect(
            applyPayloadMapping(
                mappingOf(new FieldMove("/list/0", { literal: 5 }), new FieldMove("/list/1/x", { literal: 1 })),
                {}
            )
        ).toStrictEqual({ list: [5, { x: 1 }] });
    });

    test("rejects sparse array writes with the exact error", { tags: "p1" }, () => {
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/a/12", { literal: 1 })), {}),
            "Mapping cannot create sparse arrays"
        );
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/a/2/b", { literal: 1 })), {}),
            "Mapping cannot create sparse arrays"
        );
    });

    test("rejects traversal through scalar and null values in both container branches", { tags: "p1" }, () => {
        const scalars: readonly JsonValue[] = [5, null];
        for (const scalar of scalars) {
            expectSubscriptionInvalid(
                () =>
                    applyPayloadMapping(
                        mappingOf(
                            new FieldMove("/list/-", { literal: scalar }),
                            new FieldMove("/list/0/x", { literal: 1 })
                        ),
                        {}
                    ),
                "Mapping target traverses a scalar value"
            );
            expectSubscriptionInvalid(
                () =>
                    applyPayloadMapping(
                        mappingOf(
                            new FieldMove("/list/-/k", { literal: scalar }),
                            new FieldMove("/list/0/k/z", { literal: 1 })
                        ),
                        {}
                    ),
                "Mapping target traverses a scalar value"
            );
        }
    });

    test("reads pointers with strict bounds and container typing", { tags: "p1" }, () => {
        const source: JsonValue = { "a/b": 1, "~": 2, arr: [10], nul: null, s: "hello" };
        expect(
            applyPayloadMapping(
                mappingOf(
                    new FieldMove("/x", { from: "/a~1b" }),
                    new FieldMove("/y", { from: "/~0" }),
                    new FieldMove("/z", { from: "/arr/0" })
                ),
                source
            )
        ).toStrictEqual({ x: 1, y: 2, z: 10 });
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/x", { from: "/arr/1" })), source),
            "Mapping source pointer does not exist: /arr/1"
        );
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/x", { from: "/nul/b" })), source),
            "Mapping source pointer does not exist: /nul/b"
        );
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/x", { from: "/s/0" })), source),
            "Mapping source pointer does not exist: /s/0"
        );
        expectSubscriptionInvalid(
            () => applyPayloadMapping(mappingOf(new FieldMove("/x", { from: "/missing" })), source),
            "Mapping source pointer does not exist: /missing"
        );
    });

    test("defines __proto__ as an own data key without prototype pollution", { tags: "p1" }, () => {
        const result = applyPayloadMapping(
            mappingOf(new FieldMove("/__proto__/x", { literal: 1 })),
            {}
        );
        if (!isJsonObject(result)) throw new TypeError("Mapping result must be an object");
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.hasOwn(result, "__proto__")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toStrictEqual({ x: 1 });
        const probe: { readonly x?: number } = {};
        expect(probe.x).toBeUndefined();
        expect(Object.hasOwn({}, "x")).toBe(false);
    });
});
