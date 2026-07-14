import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import {
    AuditRecordId,
    InvocationId,
    InvocationPlacementPin,
    OperationPin,
    PreparedInvocation,
    PreparedInvocationCodec,
    RouteReservationId
} from "../../src/invocations";
import { digest, operationPin, prepared, preparedReferenceCodecs, referenceCodec } from "./fixture";
import { ActorId, ActorRef } from "../../src/actors";

const codec = new PreparedInvocationCodec({
    lease: referenceCodec,
    authority: referenceCodec,
    domain: referenceCodec,
    pathEpochs: referenceCodec
});

describe("PreparedInvocation canonical identity", () => {
    test("round-trips canonical single and ordered batch records", () => {
        for (const record of [
            prepared("roundtrip-single", { b: 2, a: 1 }),
            prepared("roundtrip-batch", [{ index: 0 }, { index: 1 }])
        ]) {
            const decoded = codec.decode(codec.encode(record));
            expect(decoded.intentDigest.value).toBe(record.intentDigest.value);
            expect(decoded.itemCount).toBe(record.itemCount);
            expect(codec.encode(decoded)).toEqual(codec.encode(record));
        }
    });

    test("[C13-PREPARED-REPLAY-IDENTITY] distinguishes single, one-item batch, batch order, lease, authority, domain, seed, and pin", () => {
        const values = [
            prepared("shape-single", { value: 1 }),
            prepared("shape-batch", [{ value: 1 }]),
            prepared("order-a", [{ value: 1 }, { value: 2 }]),
            prepared("order-b", [{ value: 2 }, { value: 1 }]),
            preparedWith("external", { lease: "lease:a" }),
            preparedWith("external", { lease: "lease:b" }),
            preparedWith("external", { authority: "authority:b" }),
            preparedWith("external", { domain: "domain:b" }),
            preparedWith("external", { pathEpochs: "epochs:b" }),
            preparedWith("external", { seed: "seed:b" }),
            preparedWith("external", { pin: operationPin("different") })
        ];
        expect(new Set(values.map((value) => value.intentDigest.value)).size).toBe(values.length);
        expect(new Set(values.map((value) => value.item(0).idempotencyKey)).size).toBe(
            values.length
        );
    });

    test("[C13-ADV-EMPTY-BATCH] rejects an empty batch", () => {
        expect(() =>
            PreparedInvocation.create(
                {
                    id: new InvocationId("empty"),
                    operation: operationPin("empty"),
                    domain: "domain",
                    actor: new ActorRef("run", new ActorId("actor")),
                    authority: "authority",
                    pathEpochs: "epochs",
                    auditCause: new AuditRecordId("audit"),
                    idempotencySeed: "seed"
                },
                { kind: "batch", items: [] as unknown as readonly [JsonValue, ...JsonValue[]] },
                {
                    lease: referenceCodec,
                    authority: referenceCodec,
                    domain: referenceCodec,
                    pathEpochs: referenceCodec
                }
            )
        ).toThrow(/nonempty/);
    });

    test("rejects caller-selected placement that violates canonical preference", () => {
        expect(
            () =>
                new InvocationPlacementPin({
                    manifest: ["bundled", "provider"],
                    policy: ["bundled", "provider"],
                    substrate: ["bundled", "provider"],
                    trust: ["bundled", "provider"],
                    selected: "bundled"
                })
        ).toThrow(/canonical preference/);
        const pin = operationPin("approval-shape");
        expect(
            () =>
                new OperationPin(
                    pin.operation,
                    pin.target,
                    pin.packageId,
                    pin.version,
                    pin.manifestDigest,
                    pin.descriptorDigest,
                    pin.configurationDigest,
                    pin.runtimeDigest,
                    pin.activationGeneration,
                    pin.registration,
                    pin.impact,
                    "invalid" as unknown as boolean,
                    pin.placement
                )
        ).toThrow(/boolean/);
        expect(
            () =>
                new InvocationPlacementPin({
                    manifest: ["bundled"],
                    policy: ["bundled"],
                    substrate: ["bundled"],
                    trust: ["bundled"],
                    selected: "provider"
                })
        ).toThrow(/every admissible set/);
        expect(
            () =>
                new InvocationPlacementPin({
                    manifest: [],
                    policy: ["bundled"],
                    substrate: ["bundled"],
                    trust: ["bundled"],
                    selected: "bundled"
                })
        ).toThrow(/nonempty/);
        expect(
            () =>
                new InvocationPlacementPin({
                    manifest: ["bundled", "bundled"],
                    policy: ["bundled"],
                    substrate: ["bundled"],
                    trust: ["bundled"],
                    selected: "bundled"
                })
        ).toThrow(/unique/);
        expect(() =>
            InvocationPlacementPin.fromData({
                manifest: ["invalid"],
                policy: ["bundled"],
                selected: "bundled",
                substrate: ["bundled"],
                trust: ["bundled"]
            })
        ).toThrow(/Isolation mode/);
        const pinData = pin.toData() as { readonly [key: string]: JsonValue };
        expect(() => OperationPin.fromData({ ...pinData, impact: "invalid" })).toThrow(/impact/);
        expect(() => OperationPin.fromData({ ...pinData, approvalRequired: "no" })).toThrow(
            /boolean/
        );
    });

    test("[C13-PREPARED-ITEM-KEYS] rejects supplied key or digest substitution during decode", () => {
        const record = prepared("tamper", { secure: true });
        const envelope = asObject(decodeCanonicalJson(codec.encode(record)));
        const payload = asObject(envelope["payload"]!);
        const preparedPayload = asObject(payload["payload"]!);
        const item = asObject(preparedPayload["item"]!);

        const changedKey = {
            ...envelope,
            payload: {
                ...payload,
                payload: {
                    ...preparedPayload,
                    item: { ...item, idempotencyKey: "agent-core.item.v1:" + "0".repeat(64) }
                }
            }
        };
        expect(() => codec.decode(encodeCanonicalJson(changedKey))).toThrow(/identity/);

        const changedDigest = {
            ...envelope,
            payload: { ...payload, intentDigest: "0".repeat(64) }
        };
        expect(() => codec.decode(encodeCanonicalJson(changedDigest))).toThrow(/identity/);
    });

    test("[C13-ADV-CHANGED-ITEM-KEY] rejects a changed derived item key", () => {
        const record = prepared("changed-item-key", { secure: true });
        const envelope = asObject(decodeCanonicalJson(codec.encode(record)));
        const payload = asObject(envelope["payload"]!);
        const preparedPayload = asObject(payload["payload"]!);
        const item = asObject(preparedPayload["item"]!);

        expect(() =>
            codec.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: {
                        ...payload,
                        payload: {
                            ...preparedPayload,
                            item: {
                                ...item,
                                idempotencyKey: `agent-core.item.v1:${"f".repeat(64)}`
                            }
                        }
                    }
                })
            )
        ).toThrow(/identity/);
    });

    test("[C13-ADV-STRUCTURAL-INTENT-CHANGE] rejects changed prepared arguments under the original identity", () => {
        const record = prepared("structural-intent-change", { nested: { approved: true } });
        const envelope = asObject(decodeCanonicalJson(codec.encode(record)));
        const payload = asObject(envelope["payload"]!);
        const preparedPayload = asObject(payload["payload"]!);
        const item = asObject(preparedPayload["item"]!);

        expect(() =>
            codec.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: {
                        ...payload,
                        payload: {
                            ...preparedPayload,
                            item: {
                                ...item,
                                arguments: { nested: { approved: false } }
                            }
                        }
                    }
                })
            )
        ).toThrow(/identity/);
    });

    test("[C13-PREPARED-PAYLOAD-SHAPE] validates routed evidence, indexes, actors, and payload variants", () => {
        const init = {
            id: new InvocationId("routed"),
            operation: operationPin("routed"),
            domain: "domain:routed",
            actor: new ActorRef("run", new ActorId("actor:routed")),
            authority: "authority:routed",
            pathEpochs: "epochs:routed",
            auditCause: new AuditRecordId("audit:routed"),
            idempotencySeed: "seed:routed"
        };
        expect(() =>
            PreparedInvocation.create(
                {
                    ...init,
                    route: new RouteReservationId("route:routed")
                },
                { kind: "single", item: {} },
                preparedReferenceCodecs
            )
        ).toThrow(/present together/);
        const routed = PreparedInvocation.create(
            {
                ...init,
                route: new RouteReservationId("route:routed"),
                projectionDigest: digest("projection:routed")
            },
            { kind: "single", item: {} },
            preparedReferenceCodecs
        );
        expect(Object.isFrozen(routed.header.projectionDigest)).toBe(true);
        expect(codec.decode(codec.encode(routed)).header.route?.value).toBe("route:routed");
        expect(() => routed.item(-1)).toThrow();
        expect(() => routed.item(1)).toThrow();

        const envelope = asObject(decodeCanonicalJson(codec.encode(routed)));
        const payload = asObject(envelope["payload"]!);
        const header = asObject(payload["header"]!);
        const preparedPayload = asObject(payload["payload"]!);
        const changed = (nextHeader: JsonValue, nextPayload: JsonValue = preparedPayload) =>
            encodeCanonicalJson({
                ...envelope,
                payload: { ...payload, header: nextHeader, payload: nextPayload }
            });
        expect(() => codec.decode(changed({ ...header, route: 1 }))).toThrow();
        expect(() =>
            codec.decode(
                changed({
                    ...header,
                    actor: { id: "actor", kind: "unknown" }
                })
            )
        ).toThrow();
        expect(() => codec.decode(changed(header, { kind: "unknown" }))).toThrow();
        expect(() => codec.decode(changed(header, { items: [], kind: "batch" }))).toThrow();
    });
});

function preparedWith(
    id: string,
    changes: {
        readonly lease?: string;
        readonly authority?: string;
        readonly domain?: string;
        readonly pathEpochs?: string;
        readonly seed?: string;
        readonly pin?: ReturnType<typeof operationPin>;
    }
) {
    return PreparedInvocation.create(
        {
            id: new InvocationId(id),
            operation: changes.pin ?? operationPin(id),
            domain: changes.domain ?? `domain:${id}`,
            actor: new ActorRef("run", new ActorId(`actor:${id}`)),
            authority: changes.authority ?? `authority:${id}`,
            pathEpochs: changes.pathEpochs ?? `epochs:${id}`,
            ...(changes.lease === undefined ? {} : { lease: changes.lease }),
            auditCause: new AuditRecordId(`audit:${id}`),
            idempotencySeed: changes.seed ?? `seed:${id}`
        },
        { kind: "single", item: { value: id } },
        {
            lease: referenceCodec,
            authority: referenceCodec,
            domain: referenceCodec,
            pathEpochs: referenceCodec
        }
    );
}

function asObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}
