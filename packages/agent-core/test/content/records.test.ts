import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { MediaHint } from "../../src/content/media";
import { ByteRange } from "../../src/content/range";
import {
    ContentOwnerEdge,
    requireCollectionTime,
    requireOperationTime
} from "../../src/content/retention";
import { ContentStat } from "../../src/content/stat";
import {
    TransientContentLeaseState,
    type TransientContentBinding
} from "../../src/content/transient";
import {
    ContentRef,
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { TenantId } from "../../src/identity";
import { expectAgentCoreDiagnostic } from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const digest = Digest.sha256(encode("record"));
const ref = ContentRef.fromDigest(digest);
const tenant = new TenantId("tenant-records");
const actor = new ActorRef("workspace", new ActorId("actor-records"));

type JsonObject = { readonly [key: string]: JsonValue };

interface CodecCase {
    readonly name: string;
    readonly bytes: Uint8Array;
    decode(bytes: Uint8Array): unknown;
}

function jsonObject(value: JsonValue): JsonObject {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected JSON object");
    }
    return value as JsonObject;
}

function envelope(bytes: Uint8Array): JsonObject {
    return jsonObject(decodeCanonicalJson(bytes));
}

function member(value: JsonObject, key: string): JsonObject {
    const nested = value[key];
    if (nested === undefined) {
        throw new TypeError(`Expected JSON member ${key}`);
    }
    return jsonObject(nested);
}

function withPayload(bytes: Uint8Array, payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({ ...envelope(bytes), payload });
}

function expectCodecInvalid(operation: () => unknown, code = "codec.invalid"): void {
    expect(operation).toThrowError(AgentCoreError);
    expect(operation).toThrow(expect.objectContaining({ code }));
}

describe("content record codecs", () => {
    const stat = new ContentStat(ref, digest, 6, new MediaHint("text/plain"));
    const edge = new ContentOwnerEdge(tenant, actor, "record:owner", ref);
    const lease = new TransientContentLeaseState(
        tenant,
        actor,
        Digest.sha256(encode("envelope")),
        ref,
        digest,
        new Date(10),
        new Date(30)
    );
    const codecs: readonly CodecCase[] = [
        { name: "content stat", bytes: ContentStat.encode(stat), decode: ContentStat.decode },
        {
            name: "owner edge",
            bytes: ContentOwnerEdge.encode(edge),
            decode: ContentOwnerEdge.decode
        },
        {
            name: "transient lease",
            bytes: TransientContentLeaseState.encode(lease),
            decode: TransientContentLeaseState.decode
        }
    ];

    test("[content.stat] [content.owner-edge] [content.transient-lease] round-trips actual fixtures with their RecordCodec kinds", () => {
        for (const codec of codecs) {
            const decoded = codec.decode(codec.bytes);
            const encoded =
                codec.name === "content stat"
                    ? ContentStat.encode(decoded as ContentStat)
                    : codec.name === "owner edge"
                      ? ContentOwnerEdge.encode(decoded as ContentOwnerEdge)
                      : TransientContentLeaseState.encode(decoded as TransientContentLeaseState);
            expect(encoded).toEqual(codec.bytes);
            expect(typeof envelope(encoded)["kind"]).toBe("string");
        }
    });

    for (const codec of codecs) {
        test(`${codec.name} rejects every malformed envelope and version class`, () => {
            const valid = envelope(codec.bytes);
            const malformed: readonly JsonValue[] = [
                null,
                [],
                "record",
                { ...valid, extra: true },
                { ...valid, kind: 1 },
                { ...valid, version: null },
                { ...valid, version: { major: 1 } },
                { ...valid, version: { major: 1, minor: 0, patch: 0 } },
                { ...valid, version: { major: "1", minor: 0 } },
                { ...valid, version: { major: -1, minor: 0 } },
                { ...valid, version: { major: 1.5, minor: 0 } },
                { ...valid, version: { major: 1, minor: "0" } },
                { ...valid, version: { major: 1, minor: -1 } },
                { ...valid, version: { major: 1, minor: 0.5 } }
            ];
            for (const value of malformed) {
                expectCodecInvalid(() => codec.decode(encodeCanonicalJson(value)));
            }
            expectCodecInvalid(() => codec.decode(Uint8Array.of(0xff)));
            expectCodecInvalid(() =>
                codec.decode(encodeCanonicalJson({ ...valid, kind: "other" }))
            );
            expectCodecInvalid(
                () =>
                    codec.decode(
                        encodeCanonicalJson({
                            ...valid,
                            version: { major: 2, minor: 0 }
                        })
                    ),
                "codec.unknown-major"
            );
            expectCodecInvalid(() =>
                codec.decode(
                    encodeCanonicalJson({
                        ...valid,
                        version: { major: 1, minor: 1 }
                    })
                )
            );
        });
    }

    test("content stat rejects every malformed field and invalid value", () => {
        const bytes = ContentStat.encode(stat);
        const payload = jsonObject(envelope(bytes)["payload"]!);
        const malformed: readonly JsonValue[] = [
            null,
            [],
            { ...payload, extra: true },
            { ...payload, digest: 1 },
            { ...payload, mediaType: true },
            { ...payload, ref: false },
            { ...payload, size: "6" },
            { ...payload, size: 1.5 }
        ];
        for (const value of malformed) {
            expectCodecInvalid(() => ContentStat.decode(withPayload(bytes, value)));
        }
        for (const value of [
            { ...payload, digest: "bad" },
            { ...payload, mediaType: " " },
            { ...payload, ref: "bad" },
            { ...payload, size: -1 },
            {
                ...payload,
                digest: Digest.sha256(encode("different")).value
            }
        ]) {
            expectCodecInvalid(() => ContentStat.decode(withPayload(bytes, value)));
        }

        const withoutHint = ContentStat.decode(withPayload(bytes, { ...payload, mediaType: null }));
        expect(withoutHint.hint).toBeUndefined();
    });

    test("owner edge rejects every malformed field and invalid value", () => {
        const bytes = ContentOwnerEdge.encode(edge);
        const payload = jsonObject(envelope(bytes)["payload"]!);
        const actorPayload = jsonObject(payload["actor"]!);
        const malformed: readonly JsonValue[] = [
            null,
            [],
            { ...payload, extra: true },
            { ...payload, actor: null },
            { ...payload, actor: { ...actorPayload, extra: true } },
            { ...payload, actor: { ...actorPayload, id: 1 } },
            { ...payload, actor: { ...actorPayload, kind: "unknown" } },
            { ...payload, ownerKey: 1 },
            { ...payload, ref: 1 },
            { ...payload, tenant: 1 }
        ];
        for (const value of malformed) {
            expectCodecInvalid(() => ContentOwnerEdge.decode(withPayload(bytes, value)));
        }
        for (const value of [
            { ...payload, actor: { ...actorPayload, id: "" } },
            { ...payload, ownerKey: "" },
            { ...payload, ownerKey: "x".repeat(513) },
            { ...payload, ref: "bad" },
            { ...payload, tenant: "" }
        ]) {
            expectCodecInvalid(() => ContentOwnerEdge.decode(withPayload(bytes, value)));
        }

        for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
            const decoded = ContentOwnerEdge.decode(
                withPayload(bytes, {
                    ...payload,
                    actor: { ...actorPayload, kind }
                })
            );
            expect(decoded.actor.kind).toBe(kind);
        }
    });

    test("transient lease rejects every malformed field and invalid value", () => {
        const bytes = TransientContentLeaseState.encode(lease);
        const payload = jsonObject(envelope(bytes)["payload"]!);
        const actorPayload = jsonObject(payload["actor"]!);
        const malformed: readonly JsonValue[] = [
            null,
            [],
            { ...payload, extra: true },
            { ...payload, actor: null },
            { ...payload, actor: { ...actorPayload, extra: true } },
            { ...payload, actor: { ...actorPayload, id: 1 } },
            { ...payload, actor: { ...actorPayload, kind: "unknown" } },
            { ...payload, acquiredAt: "10" },
            { ...payload, closedAt: false },
            { ...payload, digest: 1 },
            { ...payload, envelopeDigest: 1 },
            { ...payload, expiresAt: "30" },
            { ...payload, ref: 1 },
            { ...payload, tenant: 1 }
        ];
        for (const value of malformed) {
            expectCodecInvalid(() => TransientContentLeaseState.decode(withPayload(bytes, value)));
        }
        for (const value of [
            { ...payload, actor: { ...actorPayload, id: "" } },
            { ...payload, acquiredAt: Number.MAX_SAFE_INTEGER },
            { ...payload, closedAt: 9 },
            { ...payload, digest: "bad" },
            { ...payload, envelopeDigest: "bad" },
            { ...payload, expiresAt: 10 },
            { ...payload, ref: "bad" },
            { ...payload, tenant: "" },
            { ...payload, digest: Digest.sha256(encode("different")).value }
        ]) {
            expectCodecInvalid(() => TransientContentLeaseState.decode(withPayload(bytes, value)));
        }

        for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
            const decoded = TransientContentLeaseState.decode(
                withPayload(bytes, {
                    ...payload,
                    actor: { ...actorPayload, kind }
                })
            );
            expect(decoded.actor.kind).toBe(kind);
        }
    });
});

describe("content value contracts", () => {
    test("preserves programmer TypeError for invalid media, stat, owner, and time values", () => {
        expect(() => new MediaHint(" ")).toThrow(TypeError);
        expect(() => new MediaHint("x".repeat(256))).toThrow(TypeError);
        expect(() => new ContentStat(ref, digest, -1)).toThrow(TypeError);
        expect(() => new ContentStat(ref, digest, 1.5)).toThrow(TypeError);
        expect(() => new ContentStat(ref, Digest.sha256(encode("different")), 6)).toThrow(
            TypeError
        );
        expect(() => new ContentOwnerEdge(tenant, actor, " ", ref)).toThrow(TypeError);
        expect(() => new ContentOwnerEdge(tenant, actor, "x".repeat(513), ref)).toThrow(TypeError);
        for (const value of [
            new Date(-1),
            new Date(Number.NaN),
            new Date(Number.MAX_SAFE_INTEGER)
        ]) {
            expect(() => requireOperationTime(value)).toThrow(TypeError);
            expect(() => requireCollectionTime(value)).toThrow(TypeError);
        }
        expect(requireOperationTime(new Date(12))).not.toBe(requireOperationTime(new Date(12)));
    });

    test("models active, released, expired, and idempotently closed lease orders", () => {
        const state = new TransientContentLeaseState(
            tenant,
            actor,
            Digest.sha256(encode("lease-order")),
            ref,
            digest,
            new Date(10),
            new Date(30)
        );
        const binding: TransientContentBinding = {
            tenant,
            actor,
            envelopeDigest: state.envelopeDigest,
            ref,
            digest,
            expiresAt: new Date(30)
        };

        expect(state.closedAt).toBeUndefined();
        expect(state.inactiveAt).toBeUndefined();
        expect(state.isActive(new Date(29))).toBe(true);
        expect(state.isActive(new Date(30))).toBe(false);
        expect(state.matches(binding)).toBe(true);
        expect(state.matches({ ...binding, tenant: new TenantId("foreign") })).toBe(false);
        expect(
            state.matches({
                ...binding,
                actor: new ActorRef("workspace", new ActorId("foreign"))
            })
        ).toBe(false);
        expect(
            state.matches({
                ...binding,
                envelopeDigest: Digest.sha256(encode("foreign-envelope"))
            })
        ).toBe(false);
        const otherDigest = Digest.sha256(encode("different"));
        expect(state.matches({ ...binding, ref: ContentRef.fromDigest(otherDigest) })).toBe(false);
        expect(state.matches({ ...binding, digest: otherDigest })).toBe(false);
        expect(state.matches({ ...binding, expiresAt: new Date(31) })).toBe(false);

        const released = state.close(new Date(20));
        expect(released.closedAt).toEqual(new Date(20));
        expect(released.inactiveAt).toEqual(new Date(20));
        expect(released.isActive(new Date(19))).toBe(false);
        expect(released.close(new Date(25))).toBe(released);
        const releasedAfterExpiry = state.close(new Date(40));
        expect(releasedAfterExpiry.inactiveAt).toEqual(new Date(30));
        expect(() => state.close(new Date(9))).toThrow(TypeError);
        expect(() => state.isActive(new Date(-1))).toThrow(TypeError);
        expect(() => state.matches({ ...binding, expiresAt: new Date(-1) })).toThrow(TypeError);
    });
});

describe("content record diagnostics", () => {
    const statBytes = ContentStat.encode(new ContentStat(ref, digest, 6, new MediaHint("plain")));
    const ownerEdge = new ContentOwnerEdge(tenant, actor, "record:owner", ref);
    const edgeBytes = ContentOwnerEdge.encode(ownerEdge);
    const leaseBytes = TransientContentLeaseState.encode(
        new TransientContentLeaseState(
            tenant,
            actor,
            Digest.sha256(encode("diagnostic-envelope")),
            ref,
            digest,
            new Date(10),
            new Date(30)
        )
    );

    test("names the malformed-payload diagnostic for every rejected field", { tags: "p1" }, () => {
        const statPayload = member(envelope(statBytes), "payload");
        const edgePayload = member(envelope(edgeBytes), "payload");
        const edgeActor = member(edgePayload, "actor");
        const leasePayload = member(envelope(leaseBytes), "payload");
        const leaseActor = member(leasePayload, "actor");
        const cases: readonly {
            readonly decode: (bytes: Uint8Array) => unknown;
            readonly bytes: Uint8Array;
            readonly message: string;
            readonly payloads: readonly JsonValue[];
        }[] = [
            {
                decode: ContentStat.decode,
                bytes: statBytes,
                message: "Content stat payload is malformed",
                payloads: [
                    null,
                    { ...statPayload, digest: 1 },
                    { ...statPayload, ref: 1 },
                    { ...statPayload, size: "6" }
                ]
            },
            {
                decode: ContentOwnerEdge.decode,
                bytes: edgeBytes,
                message: "Content owner edge payload is malformed",
                payloads: [
                    null,
                    { ...edgePayload, actor: { ...edgeActor, id: 1 } },
                    { ...edgePayload, actor: { ...edgeActor, kind: "unknown" } },
                    { ...edgePayload, ownerKey: 1 },
                    { ...edgePayload, ref: 1 },
                    { ...edgePayload, tenant: 1 }
                ]
            },
            {
                decode: TransientContentLeaseState.decode,
                bytes: leaseBytes,
                message: "Transient content lease payload is malformed",
                payloads: [
                    null,
                    { ...leasePayload, actor: { ...leaseActor, id: 1 } },
                    { ...leasePayload, actor: { ...leaseActor, kind: "unknown" } },
                    { ...leasePayload, acquiredAt: "10" },
                    { ...leasePayload, closedAt: false },
                    { ...leasePayload, digest: 1 },
                    { ...leasePayload, envelopeDigest: 1 },
                    { ...leasePayload, expiresAt: "30" },
                    { ...leasePayload, ref: 1 },
                    { ...leasePayload, tenant: 1 }
                ]
            }
        ];

        for (const codec of cases) {
            for (const payload of codec.payloads) {
                expectAgentCoreDiagnostic(
                    () => codec.decode(withPayload(codec.bytes, payload)),
                    "codec.invalid",
                    codec.message
                );
            }
        }
    });

    test("admits owner keys and media types at their exact maximum", { tags: "p2" }, () => {
        const ownerKey = "x".repeat(512);
        const mediaType = "x".repeat(255);

        expect(new ContentOwnerEdge(tenant, actor, ownerKey, ref).ownerKey).toBe(ownerKey);
        expect(new MediaHint(mediaType).mediaType).toBe(mediaType);
        expect(() => new ContentOwnerEdge(tenant, actor, `${ownerKey}x`, ref)).toThrow(TypeError);
        expect(() => new MediaHint(`${mediaType}x`)).toThrow(TypeError);
    });

    test("separates owner edge identity on every field", { tags: "p1" }, () => {
        const otherDigest = Digest.sha256(encode("other-record"));
        const differing: readonly ContentOwnerEdge[] = [
            new ContentOwnerEdge(new TenantId("tenant-other"), actor, "record:owner", ref),
            new ContentOwnerEdge(
                tenant,
                new ActorRef("workspace", new ActorId("actor-other")),
                "record:owner",
                ref
            ),
            new ContentOwnerEdge(tenant, actor, "record:other", ref),
            new ContentOwnerEdge(tenant, actor, "record:owner", ContentRef.fromDigest(otherDigest))
        ];

        expect(ownerEdge.equals(new ContentOwnerEdge(tenant, actor, "record:owner", ref))).toBe(
            true
        );
        for (const other of differing) {
            expect(ownerEdge.equals(other)).toBe(false);
            expect(other.equals(ownerEdge)).toBe(false);
        }
    });

    test("names the out-of-bounds byte range diagnostic exactly", { tags: "p2" }, () => {
        const bytes = encode("abc");
        for (const range of [ByteRange.from(4), ByteRange.slice(2, 2), ByteRange.slice(0, 4)]) {
            expectAgentCoreDiagnostic(
                () => range.read(bytes),
                "content.invalid-range",
                "Byte range exceeds content bounds"
            );
        }
        expect(ByteRange.slice(0, 3).read(bytes)).toEqual(bytes);
    });
});
