import { describe, expect, test } from "vitest";
import {
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import {
    AuditRecordId,
    InvocationError,
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
    test("round-trips canonical single and ordered batch records", { tags: "p1" }, () => {
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

    test(
        "[C13-PREPARED-REPLAY-IDENTITY] distinguishes single, one-item batch, batch order, lease, authority, domain, seed, and pin",
        { tags: "p0" },
        () => {
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
            expect(new Set(values.map((value) => value.intentDigest.value)).size).toBe(
                values.length
            );
            expect(new Set(values.map((value) => value.item(0).idempotencyKey)).size).toBe(
                values.length
            );
        }
    );

    test(
        "[C13-PREPARED-SHARED-HEADER] binds every item to one complete shared identity",
        { tags: "p0" },
        () => {
            const init = {
                id: new InvocationId("shared-header"),
                operation: operationPin("shared-header"),
                domain: "domain:shared-header",
                actor: new ActorRef("run", new ActorId("actor:shared-header")),
                authority: "authority:shared-header",
                pathEpochs: "epochs:shared-header",
                auditCause: new AuditRecordId("audit:shared-header"),
                idempotencySeed: "seed:shared-header"
            };
            const payload = {
                kind: "batch",
                items: [{ item: 0 }, { item: 1 }]
            } as const;
            const prepared = PreparedInvocation.create(init, payload, preparedReferenceCodecs);
            const changedAuthority = PreparedInvocation.create(
                { ...init, authority: "authority:substituted" },
                payload,
                preparedReferenceCodecs
            );

            for (let index = 0; index < prepared.itemCount; index += 1) {
                expect(prepared.item(index).idempotencyKey).not.toBe(
                    changedAuthority.item(index).idempotencyKey
                );
            }

            const envelope = asObject(decodeCanonicalJson(codec.encode(prepared)));
            const envelopePayload = envelope["payload"];
            if (envelopePayload === undefined) {
                throw new TypeError("Prepared invocation envelope has no payload");
            }
            const body = asObject(envelopePayload);
            const bodyPayload = body["payload"];
            if (bodyPayload === undefined) {
                throw new TypeError("Prepared invocation record has no payload");
            }
            const encodedPayload = asObject(bodyPayload);
            const items = encodedPayload["items"];
            if (!Array.isArray(items)) {
                throw new TypeError("Expected a two-item prepared batch");
            }
            const [first, secondValue, ...rest] = items;
            if (first === undefined || secondValue === undefined || rest.length !== 0) {
                throw new TypeError("Expected a two-item prepared batch");
            }
            const second = asObject(secondValue);
            expect(() =>
                codec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: {
                            ...body,
                            payload: {
                                ...encodedPayload,
                                items: [first, { ...second, authority: "authority:item" }]
                            }
                        }
                    })
                )
            ).toThrow(/Prepared item contains missing or unknown fields/);
        }
    );

    test("[C13-ADV-EMPTY-BATCH] rejects an empty batch", { tags: "p1" }, () => {
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
                { kind: "batch", items: candidateItems([]) },
                {
                    lease: referenceCodec,
                    authority: referenceCodec,
                    domain: referenceCodec,
                    pathEpochs: referenceCodec
                }
            )
        ).toThrow(/nonempty/);
    });

    test(
        "rejects caller-selected placement that violates canonical preference",
        { tags: "p1" },
        () => {
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
                        candidateFlag("invalid"),
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
            const pinData = asObject(pin.toData());
            expect(() => OperationPin.fromData({ ...pinData, impact: "invalid" })).toThrow(
                /impact/
            );
            expect(() => OperationPin.fromData({ ...pinData, approvalRequired: "no" })).toThrow(
                /boolean/
            );
        }
    );

    test(
        "[C13-PREPARED-ITEM-KEYS] rejects supplied key or digest substitution during decode",
        { tags: "p0" },
        () => {
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
        }
    );

    test("[C13-ADV-CHANGED-ITEM-KEY] rejects a changed derived item key", { tags: "p0" }, () => {
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

    test(
        "[C13-ADV-SUPPLIED-ITEM-KEY] refuses a supplied key that is a legitimate derivation of the same intent",
        { tags: "p0" },
        () => {
            // Two items whose arguments are byte-identical must still hold distinct keys:
            // the position is part of the derivation, and if it were not, a key could be
            // moved between them and no comparison against the record would notice.
            const record = prepared("supplied-item-key", [{ same: 1 }, { same: 1 }]);
            const first = record.item(0).idempotencyKey;
            const second = record.item(1).idempotencyKey;
            expect(first).not.toBe(second);

            const envelope = asObject(decodeCanonicalJson(codec.encode(record)));
            const payload = asObject(envelope["payload"]!);
            const preparedPayload = asObject(payload["payload"]!);
            const items = preparedPayload["items"];
            if (!Array.isArray(items)) throw new TypeError("Expected an encoded batch");
            expect(() =>
                codec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: {
                            ...payload,
                            payload: {
                                ...preparedPayload,
                                items: items.map((value, index) => ({
                                    ...asObject(value),
                                    idempotencyKey: index === 0 ? second : first
                                }))
                            }
                        }
                    })
                )
            ).toThrow(/identity/);

            // The caller's only channel is arguments, so an argument that names itself the
            // key moves the derivation instead of becoming it.
            const claimed = `agent-core.item.v1:${"a".repeat(64)}`;
            const forged = prepared("supplied-item-key-argument", { idempotencyKey: claimed });
            expect(forged.item(0).idempotencyKey).not.toBe(claimed);
        }
    );

    test(
        "[C13-ADV-REORDERED-INTENT] separates argument key order, which cannot change an intent, from item order, which cannot be replayed under one",
        { tags: "p0" },
        () => {
            // Serialization order is not intent: a host re-encoding the same arguments in
            // another key order must not be able to manufacture a second prepared identity.
            const ordered = prepared("reordered-intent", { alpha: 1, beta: 2 });
            const reversed = prepared("reordered-intent", { beta: 2, alpha: 1 });
            expect(reversed.intentDigest.value).toBe(ordered.intentDigest.value);
            expect(reversed.item(0).idempotencyKey).toBe(ordered.item(0).idempotencyKey);

            // Item order is intent, so the reordered batch is a different request and cannot
            // be presented under the original one's identity.
            const batch = prepared("reordered-batch", [{ step: "read" }, { step: "write" }]);
            const swapped = prepared("reordered-batch", [{ step: "write" }, { step: "read" }]);
            expect(swapped.intentDigest.value).not.toBe(batch.intentDigest.value);

            const envelope = asObject(decodeCanonicalJson(codec.encode(batch)));
            const payload = asObject(envelope["payload"]!);
            const preparedPayload = asObject(payload["payload"]!);
            const items = preparedPayload["items"];
            if (!Array.isArray(items)) throw new TypeError("Expected an encoded batch");
            expect(() =>
                codec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: {
                            ...payload,
                            payload: { ...preparedPayload, items: [...items].reverse() }
                        }
                    })
                )
            ).toThrow(/identity/);
        }
    );

    test(
        "[C13-ADV-STRUCTURAL-INTENT-CHANGE] rejects changed prepared arguments under the original identity",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "[C13-PREPARED-PAYLOAD-SHAPE] validates routed evidence, indexes, actors, and payload variants",
        { tags: "p1" },
        () => {
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
        }
    );

    test(
        "pins the canonical intent digest and derived item keys of a stable record",
        { tags: "p0" },
        () => {
            const single = prepared("golden", { value: 1 });
            expect(single.intentDigest.value).toBe(
                "f300d90c1e645b1a9ca09768439a6d32cdab85d18476ecef17b0faa768bddf0d"
            );
            expect(single.item(0).idempotencyKey).toBe(
                "agent-core.item.v1:f0e21c7d96a65424b47bd57a37e4360c1dfbef81edee961ad86bc10c77f46a26"
            );
            const batch = prepared("golden-batch", [{ a: 1 }, { b: 2 }]);
            expect(batch.intentDigest.value).toBe(
                "6963f4407389c0b937c84e3a5e3cabd243e1bc4a32a3a29f96740677c8a89b6a"
            );
            expect(batch.item(0).idempotencyKey).toBe(
                "agent-core.item.v1:ae1ce4c77b799f751e2a552622cdf433dca98d629b05222be78d5906c4e42f79"
            );
            expect(batch.item(1).idempotencyKey).toBe(
                "agent-core.item.v1:288db365dbb866c4465942d5e71d9df5d84823759e9b9ad8875bc4b0fbf8db16"
            );
        }
    );

    test(
        "derives distinct identities for a single item and its one-item batch under the same header",
        { tags: "p1" },
        () => {
            const single = prepared("shape-parity", { value: 1 });
            const batch = prepared("shape-parity", [{ value: 1 }]);
            expect(single.item(0).idempotencyKey).not.toBe(batch.item(0).idempotencyKey);
            expect(single.intentDigest.value).not.toBe(batch.intentDigest.value);
        }
    );

    test(
        "freezes prepared invocations and rejects derived identifier classes",
        { tags: "p1" },
        () => {
            const record = prepared("frozen");
            expect(Object.isFrozen(record)).toBe(true);
            expect(Object.isFrozen(record.payload)).toBe(true);

            class DerivedAuditRecordId extends AuditRecordId {}
            class DerivedRouteReservationId extends RouteReservationId {}
            const init = {
                id: new InvocationId("derived-prepared"),
                operation: operationPin("derived-prepared"),
                domain: "domain:derived-prepared",
                actor: new ActorRef("run", new ActorId("actor:derived-prepared")),
                authority: "authority:derived-prepared",
                pathEpochs: "epochs:derived-prepared",
                auditCause: new AuditRecordId("audit:derived-prepared"),
                idempotencySeed: "seed:derived-prepared"
            };
            expect(() =>
                PreparedInvocation.create(
                    { ...init, auditCause: new DerivedAuditRecordId("audit:derived") },
                    { kind: "single", item: {} },
                    preparedReferenceCodecs
                )
            ).toThrow(/exact context classes/);
            expect(() =>
                PreparedInvocation.create(
                    {
                        ...init,
                        route: new DerivedRouteReservationId("route:derived"),
                        projectionDigest: digest("projection:derived")
                    },
                    { kind: "single", item: {} },
                    preparedReferenceCodecs
                )
            ).toThrow(/exact context classes/);
        }
    );

    test("reports precise item index failures", { tags: "p2" }, () => {
        const batch = prepared("index-errors", [{ a: 1 }, { b: 2 }]);
        expectIndexError(() => batch.item(-1), /non-negative safe integer/);
        expectIndexError(() => batch.item(0.5), /non-negative safe integer/);
        expectIndexError(() => batch.item(2), /out of range/);
        const single = prepared("index-errors-single");
        expectIndexError(() => single.item(1), /out of range/);
    });

    test(
        "rejects malformed route evidence, actor kinds, and payload kinds with precise decode errors",
        { tags: "p1" },
        () => {
            const routed = PreparedInvocation.create(
                {
                    id: new InvocationId("wire-routed"),
                    operation: operationPin("wire-routed"),
                    domain: "domain:wire-routed",
                    actor: new ActorRef("run", new ActorId("actor:wire-routed")),
                    authority: "authority:wire-routed",
                    pathEpochs: "epochs:wire-routed",
                    route: new RouteReservationId("route:wire-routed"),
                    projectionDigest: digest("projection:wire-routed"),
                    auditCause: new AuditRecordId("audit:wire-routed"),
                    idempotencySeed: "seed:wire-routed"
                },
                { kind: "single", item: {} },
                preparedReferenceCodecs
            );
            const envelope = asObject(decodeCanonicalJson(codec.encode(routed)));
            const payload = asObject(envelope["payload"] ?? null);
            const header = asObject(payload["header"] ?? null);
            const changed = (nextHeader: JsonValue, nextPayload?: JsonValue): Uint8Array => {
                const body = { ...payload, header: nextHeader };
                return encodeCanonicalJson({
                    ...envelope,
                    payload: nextPayload === undefined ? body : { ...body, payload: nextPayload }
                });
            };
            expect(() => codec.decode(changed({ ...header, route: null }))).toThrow(
                /route evidence is malformed/
            );
            expect(() => codec.decode(changed({ ...header, projectionDigest: null }))).toThrow(
                /route evidence is malformed/
            );
            expect(() => codec.decode(changed({ ...header, route: 1 }))).toThrow(
                /route must be a string or null/
            );
            expect(() => codec.decode(changed({ ...header, projectionDigest: 1 }))).toThrow(
                /projectionDigest must be a string or null/
            );
            expect(() =>
                codec.decode(changed({ ...header, actor: { id: "actor", kind: "unknown" } }))
            ).toThrow(/Actor kind is invalid/);
            expect(() => codec.decode(changed(header, { kind: "unknown" }))).toThrow(
                /payload kind is invalid/
            );
        }
    );

    test("round-trips every declared actor kind", { tags: "p1" }, () => {
        for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
            const record = PreparedInvocation.create(
                {
                    id: new InvocationId(`actor-${kind}`),
                    operation: operationPin(`actor-${kind}`),
                    domain: `domain:actor-${kind}`,
                    actor: new ActorRef(kind, new ActorId(`actor:${kind}`)),
                    authority: `authority:actor-${kind}`,
                    pathEpochs: `epochs:actor-${kind}`,
                    auditCause: new AuditRecordId(`audit:actor-${kind}`),
                    idempotencySeed: `seed:actor-${kind}`
                },
                { kind: "single", item: { value: kind } },
                preparedReferenceCodecs
            );
            expect(codec.decode(codec.encode(record)).header.actor.kind).toBe(kind);
        }
    });
});

function expectIndexError(operation: () => void, message: RegExp): void {
    let thrown: unknown;
    try {
        operation();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvocationError);
    expect(thrown).toMatchObject({
        failure: "state.invalid-transition",
        message: expect.stringMatching(message)
    });
}

/**
 * Offers items where a batch payload declares a nonempty list. Rejecting an empty batch is
 * the behavior under test, so the empty list has to be reachable.
 */
function candidateItems(items: readonly JsonValue[]): readonly [JsonValue, ...JsonValue[]] {
    // SAFETY: the list is a candidate, not a proven nonempty batch. It reaches
    // PreparedInvocation.create only so `requireNonemptyPayload` can reject it.
    return items as readonly [JsonValue, ...JsonValue[]];
}

/**
 * Offers a value where OperationPin declares its approval flag. Rejecting a non-boolean is
 * the behavior under test, so it has to be reachable.
 */
function candidateFlag(value: boolean | string): boolean {
    // SAFETY: the value is a candidate, not a proven flag. It reaches the constructor only
    // so the boolean check can reject it.
    return value as boolean;
}

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
    const header = {
        id: new InvocationId(id),
        operation: changes.pin ?? operationPin(id),
        domain: changes.domain ?? `domain:${id}`,
        actor: new ActorRef("run", new ActorId(`actor:${id}`)),
        authority: changes.authority ?? `authority:${id}`,
        pathEpochs: changes.pathEpochs ?? `epochs:${id}`,
        auditCause: new AuditRecordId(`audit:${id}`),
        idempotencySeed: changes.seed ?? `seed:${id}`
    };
    return PreparedInvocation.create(
        changes.lease === undefined ? header : { ...header, lease: changes.lease },
        { kind: "single", item: { value: id } },
        {
            lease: referenceCodec,
            authority: referenceCodec,
            domain: referenceCodec,
            pathEpochs: referenceCodec
        }
    );
}

function asObject(value: JsonValue): JsonObject {
    if (!isJsonObject(value)) throw new TypeError("Expected object");
    return value;
}
