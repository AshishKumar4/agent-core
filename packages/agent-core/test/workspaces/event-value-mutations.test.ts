import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { EventKind, FacetPackageId } from "../../src/facets";
import { CorrelationId, EventId } from "../../src/interaction-references";
import { Event, type EventInit } from "../../src/workspaces/event";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import { content, eventFixture, principal, scope } from "./fixtures";

type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return (
        value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object"
    );
}

function eventPayload(event: Event): JsonObject {
    const envelope = decodeCanonicalJson(Event.encode(event));
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("Event envelope must contain an object payload");
    }
    return envelope["payload"];
}

function eventBytes(payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind: Event.codec.kind,
        payload,
        version: { major: Event.codec.version.major, minor: Event.codec.version.minor }
    });
}

function baseEventInit(suffix: string): EventInit {
    const payload = content(`mutation-event-${suffix}`);
    return {
        id: new EventId(`event-${suffix}`),
        scope,
        source: { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind("task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        idempotencyKey: `event-key-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        provenance: new EventProvenance({ principal, verification: EventVerification.verified() }),
        trust: "authenticated",
        visibility: "workspace",
        initiator: principal
    };
}

describe("event codec", () => {
    test("names each malformed Event payload field exactly", { tags: "p2" }, () => {
        const payload = eventPayload(eventFixture("codec-label"));
        const cases: readonly {
            readonly field: string;
            readonly message: string;
            readonly value: JsonValue;
        }[] = [
            { field: "content", message: "Event content must be an object", value: 5 },
            { field: "initiator", message: "Event initiator must be an object", value: 5 },
            { field: "id", message: "Event ID must be a string", value: 5 },
            { field: "category", message: "Event category must be a string", value: 5 },
            {
                field: "idempotencyKey",
                message: "Event idempotency key must be a string",
                value: 5
            },
            { field: "correlation", message: "Event correlation must be a string", value: 5 },
            {
                field: "source",
                message: "Event source Facet must be a string",
                value: { facet: 5, kind: "facet" }
            },
            {
                field: "source",
                message: "Event source Actor must be an object",
                value: { actor: 5, kind: "actor" }
            },
            { field: "source", message: "Event source kind is invalid", value: { kind: "bogus" } },
            { field: "visibility", message: "Event visibility is invalid", value: "bogus" }
        ];
        for (const entry of cases) {
            expect(() =>
                Event.decode(eventBytes({ ...payload, [entry.field]: entry.value }))
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.event record: ${entry.message}`
                })
            );
        }
    });

    test("round-trips private visibility through the codec", { tags: "p1" }, () => {
        const event = new Event({ ...baseEventInit("private"), visibility: "private" });
        const decoded = Event.decode(Event.encode(event));
        expect(decoded.visibility).toBe("private");
        expect(Event.encode(decoded)).toStrictEqual(Event.encode(event));
    });

    test("round-trips an external event without initiator or principal", { tags: "p1" }, () => {
        const base = baseEventInit("anonymous");
        const event = new Event({
            id: base.id,
            scope: base.scope,
            source: base.source,
            kind: base.kind,
            payload: base.payload,
            payloadDigest: base.payloadDigest,
            idempotencyKey: base.idempotencyKey,
            correlation: base.correlation,
            provenance: new EventProvenance({ verification: EventVerification.verified() }),
            trust: "external",
            visibility: "workspace"
        });
        const decoded = Event.decode(Event.encode(event));
        expect(decoded.initiator).toBeUndefined();
        expect(decoded.provenance.principal).toBeUndefined();
        expect(Event.encode(decoded)).toStrictEqual(Event.encode(event));
    });
});

describe("event construction", () => {
    test(
        "keeps an initiator without a provenance principal on external events",
        { tags: "p0" },
        () => {
            const event = new Event({
                ...baseEventInit("external-initiator"),
                provenance: new EventProvenance({ verification: EventVerification.verified() }),
                trust: "external"
            });
            expect(event.trust).toBe("external");
            expect(event.initiator).toBe(principal);
            expect(event.provenance.principal).toBeUndefined();
            const decoded = Event.decode(Event.encode(event));
            expect(decoded.initiator?.equals(principal)).toBe(true);
            expect(decoded.provenance.principal).toBeUndefined();
        }
    );

    test(
        "accepts an idempotency key of exactly 512 characters and rejects 513",
        { tags: "p1" },
        () => {
            const event = new Event({
                ...baseEventInit("key-512"),
                idempotencyKey: "k".repeat(512)
            });
            expect(event.idempotencyKey).toHaveLength(512);
            expect(Event.decode(Event.encode(event)).idempotencyKey).toHaveLength(512);
            expect(
                () => new Event({ ...baseEventInit("key-513"), idempotencyKey: "k".repeat(513) })
            ).toThrow(
                new TypeError(
                    "Event idempotency key must be a canonical string of at most 512 characters"
                )
            );
        }
    );
});

describe("event provenance", () => {
    const validPayload: JsonObject = {
        channel: null,
        claims: {},
        group: null,
        principal: null,
        verification: "verified"
    };

    test("validates provenance channel and group text exactly", { tags: "p2" }, () => {
        for (const channel of ["", " padded "]) {
            expect(
                () => new EventProvenance({ channel, verification: EventVerification.verified() })
            ).toThrow(new TypeError("Provenance channel must be a nonblank canonical string"));
        }
        for (const group of ["", " padded "]) {
            expect(
                () => new EventProvenance({ group, verification: EventVerification.verified() })
            ).toThrow(new TypeError("Provenance group must be a nonblank canonical string"));
        }
        const provenance = new EventProvenance({
            channel: "channel-1",
            group: "group-1",
            verification: EventVerification.host()
        });
        expect(provenance.channel).toBe("channel-1");
        expect(provenance.group).toBe("group-1");
    });

    test(
        "rejects malformed provenance payloads with the exact payload error",
        { tags: "p2" },
        () => {
            const malformed: readonly JsonValue[] = [
                null,
                [],
                5,
                "verified",
                {},
                { channel: null, claims: {}, group: null, principal: null },
                { ...validPayload, extra: true }
            ];
            for (const payload of malformed) {
                expect(() => EventProvenance.fromData(payload)).toThrow(
                    new TypeError("Event provenance payload is malformed")
                );
            }
        }
    );

    test("rejects malformed provenance field values with exact subjects", { tags: "p2" }, () => {
        const tampers: readonly JsonObject[] = [
            { verification: "bogus" },
            { verification: null },
            { verification: 5 },
            { channel: 5 },
            { channel: true },
            { group: 5 },
            { group: true }
        ];
        for (const tamper of tampers) {
            expect(() => EventProvenance.fromData({ ...validPayload, ...tamper })).toThrow(
                new TypeError("Event provenance fields are malformed")
            );
        }
        expect(() => EventProvenance.fromData({ ...validPayload, principal: 5 })).toThrow(
            new TypeError("Provenance Principal must be an object")
        );
    });

    test("decodes host verification, principal, channel, and group values", { tags: "p1" }, () => {
        const provenance = EventProvenance.fromData({
            channel: "chan-1",
            claims: { audit: true },
            group: "group-1",
            principal: { principal: principal.principalId.value, tenant: principal.tenantId.value },
            verification: "host"
        });
        expect(provenance.verification.kind).toBe("host");
        expect(provenance.principal?.equals(principal)).toBe(true);
        expect(provenance.channel).toBe("chan-1");
        expect(provenance.group).toBe("group-1");
        expect(provenance.claims).toStrictEqual({ audit: true });
    });
});
