import { describe, expect, test, vi } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId } from "../../src/agents";
import { TransientContentLease } from "../../src/content";
import {
    ContentRef,
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { AuditRecordId, WriteRecordId } from "../../src/invocations";
import {
    CommandAuthentication,
    CommandAuthenticator,
    commandAuthenticationMatches
} from "../../src/protocol/authentication";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    commandCallersEqual,
    type CommandCaller,
    type LeaseToken
} from "../../src/protocol/envelope";
import {
    CommandPayloadMalformedError,
    PayloadLeaseBinding,
    PreparedCommandPayload,
    inspectPreparedCommandPayload,
    issueLeasedCommandPayload,
    issueMalformedCommandPayload
} from "../../src/protocol/payload";
import * as protocol from "../../src/protocol";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import { WriteRecord, WriteRecordCodec, type WriteRecordInit } from "../../src/protocol/write";
import { expectAgentCoreError } from "./error-assertion";

const actor = new ActorRef("run", new ActorId("codec-actor"));
const tenant = new TenantId("codec-tenant");
const principal = new PrincipalId("codec-principal");
const principalRef = new PrincipalRef(tenant, principal);
const principalCaller: CommandCaller = { kind: "principal", principal: principalRef };
const digest = Digest.sha256(new TextEncoder().encode("codec-payload"));
const ref = ContentRef.fromDigest(digest);

describe("CommandEnvelope codec", () => {
    test(
        "[C13-PROTOCOL-EXACT-ENVELOPE] [command-envelope] round-trips absent optional fields and every Actor caller kind",
        { tags: "p1" },
        () => {
            const minimal = new CommandEnvelope({
                command: "codec.minimal",
                caller: principalCaller,
                idempotencyKey: "minimal",
                payload: ref,
                payloadDigest: digest
            });
            const encoded = CommandEnvelope.encode(minimal);
            expect(encoded).toEqual(CommandEnvelopeCodec.encode(minimal));
            expect(CommandEnvelope.decode(encoded)).toMatchObject({
                expectedRevision: undefined,
                lease: undefined,
                callerCause: undefined
            });

            for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
                const envelope = envelopeFixture({
                    kind: "actor",
                    actor: new ActorRef(kind, new ActorId(`codec-${kind}`))
                });
                const decoded = CommandEnvelopeCodec.decode(CommandEnvelopeCodec.encode(envelope));
                expect(decoded.caller).toEqual(envelope.caller);
            }
        }
    );

    test.each([
        [
            "non-object payload",
            (record: MutableRecord) => {
                record["payload"] = null;
            }
        ],
        [
            "missing field",
            (record: MutableRecord) => {
                delete payloadOf(record)["command"];
            }
        ],
        [
            "unknown field",
            (record: MutableRecord) => {
                payloadOf(record)["unknown"] = true;
            }
        ],
        [
            "non-string command",
            (record: MutableRecord) => {
                payloadOf(record)["command"] = 1;
            }
        ],
        [
            "non-object caller",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = null;
            }
        ],
        [
            "unknown caller",
            (record: MutableRecord) => {
                callerOf(record)["kind"] = "system";
            }
        ],
        [
            "missing principal",
            (record: MutableRecord) => {
                delete callerOf(record)["principal"];
            }
        ],
        [
            "extra principal field",
            (record: MutableRecord) => {
                callerOf(record)["extra"] = true;
            }
        ],
        [
            "non-string principal",
            (record: MutableRecord) => {
                callerOf(record)["principal"] = 1;
            }
        ],
        [
            "non-object actor",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: null };
            }
        ],
        [
            "incomplete actor",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: { kind: "run" } };
            }
        ],
        [
            "unknown actor field",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = {
                    kind: "actor",
                    actor: { kind: "run", id: "actor", extra: true }
                };
            }
        ],
        [
            "invalid actor kind",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = {
                    kind: "actor",
                    actor: { kind: "principal", id: "actor" }
                };
            }
        ],
        [
            "non-string actor id",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: { kind: "run", id: 1 } };
            }
        ],
        [
            "non-string idempotency key",
            (record: MutableRecord) => {
                payloadOf(record)["idempotencyKey"] = 1;
            }
        ],
        [
            "non-integer revision",
            (record: MutableRecord) => {
                payloadOf(record)["expectedRevision"] = 1.5;
            }
        ],
        [
            "negative revision",
            (record: MutableRecord) => {
                payloadOf(record)["expectedRevision"] = -1;
            }
        ],
        [
            "non-object lease",
            (record: MutableRecord) => {
                payloadOf(record)["lease"] = null;
            }
        ],
        [
            "incomplete lease",
            (record: MutableRecord) => {
                delete leaseOf(record)["holder"];
            }
        ],
        [
            "unknown lease field",
            (record: MutableRecord) => {
                leaseOf(record)["extra"] = true;
            }
        ],
        [
            "non-string lease turn",
            (record: MutableRecord) => {
                leaseOf(record)["turn"] = 1;
            }
        ],
        [
            "non-string lease holder",
            (record: MutableRecord) => {
                leaseOf(record)["holder"] = 1;
            }
        ],
        [
            "unsafe lease epoch",
            (record: MutableRecord) => {
                leaseOf(record)["epoch"] = Number.MAX_SAFE_INTEGER + 1;
            }
        ],
        [
            "non-string caller cause",
            (record: MutableRecord) => {
                payloadOf(record)["callerCause"] = 1;
            }
        ],
        [
            "non-string payload ref",
            (record: MutableRecord) => {
                payloadOf(record)["payload"] = 1;
            }
        ],
        [
            "non-string payload digest",
            (record: MutableRecord) => {
                payloadOf(record)["payloadDigest"] = 1;
            }
        ]
    ])("rejects a %s", { tags: "p1" }, (_case, mutate) => {
        expect(() => CommandEnvelopeCodec.decode(mutateEnvelope(mutate))).toThrow();
    });

    test.each([
        ["empty command", () => new CommandEnvelope({ ...envelopeInit(), command: "" })],
        [
            "long command",
            () => new CommandEnvelope({ ...envelopeInit(), command: "x".repeat(257) })
        ],
        ["empty key", () => new CommandEnvelope({ ...envelopeInit(), idempotencyKey: "" })],
        [
            "long key",
            () => new CommandEnvelope({ ...envelopeInit(), idempotencyKey: "x".repeat(513) })
        ]
    ])("rejects %s at construction", { tags: "p1" }, (_case, construct) => {
        expect(construct).toThrow(TypeError);
    });
});

describe("protocol callers and authentication", () => {
    test("compares only exact principal and Actor identities", { tags: "p0" }, () => {
        const matchingActor: CommandCaller = { kind: "actor", actor };
        expect(commandCallersEqual(principalCaller, principalCaller)).toBe(true);
        expect(commandCallersEqual(principalCaller, matchingActor)).toBe(false);
        expect(commandCallersEqual(matchingActor, principalCaller)).toBe(false);
        expect(commandCallersEqual(matchingActor, matchingActor)).toBe(true);
        expect(
            commandCallersEqual(matchingActor, {
                kind: "actor",
                actor: new ActorRef("workspace", actor.id)
            })
        ).toBe(false);
    });

    test("does not allow callers to issue transport authentication", { tags: "p0" }, () => {
        expectAgentCoreError(
            () => new CommandAuthentication(Symbol("forged"), digest, principalCaller, tenant),
            "protocol.invalid-envelope"
        );
    });

    test(
        "validates issued authentication before invoking token behavior",
        { tags: "p0" },
        async () => {
            const envelope = envelopeFixture(principalCaller);
            const envelopeDigest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));
            const authentication = await new CodecAuthenticator().authenticate(
                undefined,
                envelope,
                envelopeDigest
            );
            const throwingLookalike = {
                matches(): never {
                    throw new TypeError("lookalike method must not run");
                }
            };
            const proxy = new Proxy(
                {},
                {
                    get(): never {
                        throw new TypeError("proxy trap must not run");
                    }
                }
            );
            const subclassLookalike: object = Object.create(CommandAuthentication.prototype);

            expect(
                commandAuthenticationMatches(authentication, envelopeDigest, envelope, tenant)
            ).toBe(true);
            for (const forged of [{}, throwingLookalike, proxy, subclassLookalike]) {
                // @ts-expect-error Non-authentication objects must fail the issuance check.
                expect(commandAuthenticationMatches(forged, envelopeDigest, envelope, tenant)).toBe(
                    false
                );
            }
            class ForgedAuthentication extends CommandAuthentication {
                public constructor() {
                    super(Symbol("forged-subclass"), envelopeDigest, principalCaller, tenant);
                }
            }
            expectAgentCoreError(() => new ForgedAuthentication(), "protocol.invalid-envelope");
        }
    );

    test("admits only the configured caller family", { tags: "p0" }, () => {
        const actorCaller: CommandCaller = { kind: "actor", actor };
        expect(CommandCallerPolicy.principal().admits(principalCaller)).toBe(true);
        expect(CommandCallerPolicy.principal().admits(actorCaller)).toBe(false);
        expect(CommandCallerPolicy.actor("run").admits(principalCaller)).toBe(false);
        expect(CommandCallerPolicy.actor("run").admits(actorCaller)).toBe(true);
        expect(CommandCallerPolicy.actor("workspace").admits(actorCaller)).toBe(false);
    });

    test(
        "envelopes deeply detach and freeze authenticated caller and lease state",
        { tags: "p0" },
        () => {
            const mutable = { kind: "principal" as const, principal: principalRef };
            const mutableLease = {
                turn: new TurnId("mutable-turn"),
                holder: principalRef,
                epoch: 4
            };
            const envelope = new CommandEnvelope({
                ...envelopeInit(),
                caller: mutable,
                lease: mutableLease
            });
            const write = writeFixture({ caller: mutable });
            mutable.principal = new PrincipalRef(tenant, new PrincipalId("mutated-caller"));
            mutableLease.turn = new TurnId("mutated-turn");
            mutableLease.holder = new PrincipalRef(tenant, new PrincipalId("mutated-holder"));
            mutableLease.epoch = 99;

            expect(envelope.caller).toEqual(principalCaller);
            expect(envelope.caller).not.toBe(mutable);
            expect(envelope.lease).toMatchObject({
                turn: new TurnId("mutable-turn"),
                holder: principalRef,
                epoch: 4
            });
            expect(envelope.lease).not.toBe(mutableLease);
            expect(write.caller).toEqual(principalCaller);
            expect(Object.isFrozen(envelope)).toBe(true);
            expect(Object.isFrozen(envelope.caller)).toBe(true);
            expect(Object.isFrozen(envelope.lease)).toBe(true);
            expect(Object.isFrozen(write.caller)).toBe(true);
        }
    );

    test("requires exact plain runtime fields for callers and leases", { tags: "p1" }, () => {
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    caller: forgedCaller({ ...principalCaller, extra: true })
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    lease: forgedLease({ ...envelopeInit().lease, extra: true })
                })
        ).toThrow(TypeError);
        const accessorLease = Object.defineProperty(
            {
                holder: principalRef,
                epoch: 1
            },
            "turn",
            {
                enumerable: true,
                get: () => new TurnId("accessor-turn")
            }
        );
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    lease: forgedLease(accessorLease)
                })
        ).toThrow(TypeError);
    });

    test("rejects exact-shape callers with invalid identity values", { tags: "p1" }, () => {
        const invalidCaller = forgedCaller({
            kind: "principal",
            principal: { value: principal.value }
        });

        expect(() => new CommandEnvelope({ ...envelopeInit(), caller: invalidCaller })).toThrow(
            new TypeError("Command caller is invalid")
        );
    });

    test("rejects exact-shape leases with invalid values", { tags: "p1" }, () => {
        const validLease = envelopeInit().lease!;
        // SAFETY: each stand-in copies the field values of a real TurnId or PrincipalRef but is a
        // plain object, not an instance. The lease guard identifies its turn and holder by class,
        // so a structural copy is exactly the case it exists to reject.
        const structuralTurn = { value: validLease.turn.value } as TurnId;
        // SAFETY: as above — a plain object wearing PrincipalRef's field names.
        const structuralHolder = {
            tenantId: validLease.holder.tenantId,
            principalId: validLease.holder.principalId
        } as PrincipalRef;
        const invalidLeases = [
            { ...validLease, turn: structuralTurn },
            { ...validLease, holder: structuralHolder },
            { ...validLease, epoch: -1 },
            { ...validLease, epoch: 1.5 }
        ];

        for (const lease of invalidLeases) {
            expect(
                () =>
                    new CommandEnvelope({
                        ...envelopeInit(),
                        lease
                    })
            ).toThrow(
                new TypeError(
                    "Lease token requires a TurnId turn, PrincipalRef holder, and non-negative epoch"
                )
            );
        }
    });

    test("rejects non-plain caller and lease values", { tags: "p1" }, () => {
        const caller = forgedCaller(Object.assign(Object.create(null), principalCaller));
        const lease = forgedLease(Object.assign(Object.create(null), envelopeInit().lease));

        expect(() => new CommandEnvelope({ ...envelopeInit(), caller })).toThrow(
            new TypeError("Command caller must be a plain object with exact fields")
        );
        expect(() => new CommandEnvelope({ ...envelopeInit(), lease })).toThrow(
            new TypeError("Lease token must be a plain object with exact fields")
        );
    });

    test(
        "rejects non-enumerable and accessor caller fields without invoking accessors",
        { tags: "p1" },
        () => {
            const accessor = vi.fn(() => "principal");
            const hiddenKind = forgedCaller(
                Object.defineProperty({ principal: principalRef }, "kind", {
                    enumerable: false,
                    value: "principal"
                })
            );
            const accessorKind = forgedCaller(
                Object.defineProperty({ principal: principalRef }, "kind", {
                    enumerable: true,
                    get: accessor
                })
            );

            for (const caller of [hiddenKind, accessorKind]) {
                expect(() => new CommandEnvelope({ ...envelopeInit(), caller })).toThrow(
                    new TypeError("Command caller must contain enumerable data fields")
                );
            }
            expect(accessor).not.toHaveBeenCalled();
        }
    );
});

describe("payload preparation values", () => {
    test("defensively copies expiry and compares every binding field", { tags: "p1" }, () => {
        const expiresAt = new Date("2026-07-07T12:01:00.000Z");
        const binding = new PayloadLeaseBinding(tenant, actor, digest, ref, digest, expiresAt);
        expiresAt.setTime(0);
        expect(binding.expiresAt.toISOString()).toBe("2026-07-07T12:01:00.000Z");
        expect(binding.matches(tenant, actor, digest, ref, digest)).toBe(true);
        expect(binding.matches(new TenantId("other-tenant"), actor, digest, ref, digest)).toBe(
            false
        );
        expect(
            () => new PayloadLeaseBinding(tenant, actor, digest, ref, digest, new Date(NaN))
        ).toThrow("expiry must be valid");
    });

    test("issues nominal leased and malformed preparation variants", { tags: "p1" }, () => {
        const binding = new PayloadLeaseBinding(
            tenant,
            actor,
            digest,
            ref,
            digest,
            new Date("2026-07-07T12:01:00.000Z")
        );
        const lease = new CodecContentLease();
        const leased = issueLeasedCommandPayload(lease, binding);
        const malformed = issueMalformedCommandPayload("missing");
        expect(inspectPreparedCommandPayload(leased)).toMatchObject({ lease, binding });
        expect(inspectPreparedCommandPayload(malformed)).toMatchObject({
            malformedReason: "missing"
        });
        expect(protocol).not.toHaveProperty("PreparedCommandPayload");
        expect(Object.getOwnPropertyDescriptor(PreparedCommandPayload, "leased")).toBeUndefined();
    });

    test(
        "rejects forged prepared payloads without invoking attacker properties",
        { tags: "p0" },
        () => {
            const lookalike = new Proxy(
                {},
                {
                    get(): never {
                        throw new TypeError("prepared payload proxy trap must not run");
                    }
                }
            );
            // @ts-expect-error An unissued empty object must not acquire payload state.
            expect(inspectPreparedCommandPayload({})).toBeUndefined();
            // @ts-expect-error An unissued proxy must not acquire payload state.
            expect(inspectPreparedCommandPayload(lookalike)).toBeUndefined();
            expect(
                inspectPreparedCommandPayload(Object.create(PreparedCommandPayload.prototype))
            ).toBeUndefined();
            // SAFETY: this instance carries the prototype but never passed through the constructor,
            // so it has no entry in the module's state WeakMap. Reading a property must raise
            // protocol.invalid-state rather than return undefined.
            const stateless = Object.create(
                PreparedCommandPayload.prototype
            ) as PreparedCommandPayload;
            expectAgentCoreError(() => stateless.lease, "protocol.invalid-state");
            expectAgentCoreError(
                () => new PreparedCommandPayload(Symbol("wrong-issuer"), {}),
                "protocol.invalid-state"
            );
        }
    );
});

describe("WriteRecord codec and invariants", () => {
    test("rejects the incompatible baseline v1 record major", { tags: "p2" }, () => {
        const record = mutableRecord(
            WriteRecordCodec.encode(
                writeFixture({
                    outcome: "rejectedMalformed",
                    idempotencyKey: undefined
                })
            )
        );
        objectAt(record, "version")["major"] = 1;
        objectAt(record, "version")["minor"] = 0;
        delete payloadOf(record)["idempotencyKey"];
        delete payloadOf(record)["observation"];

        expectAgentCoreError(
            () => WriteRecordCodec.decode(encodeCanonicalJson(record)),
            "codec.unknown-major"
        );
    });

    test.each([
        [
            "non-object payload",
            (record: MutableRecord) => {
                record["payload"] = null;
            }
        ],
        [
            "non-object actor",
            (record: MutableRecord) => {
                payloadOf(record)["actor"] = null;
            }
        ],
        [
            "missing field",
            (record: MutableRecord) => {
                delete payloadOf(record)["id"];
            }
        ],
        [
            "unknown field",
            (record: MutableRecord) => {
                payloadOf(record)["unknown"] = true;
            }
        ],
        [
            "unknown actor field",
            (record: MutableRecord) => {
                actorOf(record)["extra"] = true;
            }
        ],
        [
            "invalid actor kind",
            (record: MutableRecord) => {
                actorOf(record)["kind"] = "principal";
            }
        ],
        [
            "non-string actor id",
            (record: MutableRecord) => {
                actorOf(record)["id"] = 1;
            }
        ],
        [
            "invalid caller",
            (record: MutableRecord) => {
                payloadOf(record)["caller"] = true;
            }
        ],
        [
            "non-string command",
            (record: MutableRecord) => {
                payloadOf(record)["command"] = 1;
            }
        ],
        [
            "non-string duplicate",
            (record: MutableRecord) => {
                payloadOf(record)["duplicateOf"] = 1;
            }
        ],
        [
            "non-string identity",
            (record: MutableRecord) => {
                payloadOf(record)["idempotencyKey"] = 1;
            }
        ],
        [
            "non-string observation",
            (record: MutableRecord) => {
                payloadOf(record)["observation"] = 1;
            }
        ],
        [
            "invalid timestamp",
            (record: MutableRecord) => {
                payloadOf(record)["at"] = "invalid";
            }
        ],
        [
            "invalid outcome",
            (record: MutableRecord) => {
                payloadOf(record)["outcome"] = "unknown";
            }
        ],
        [
            "non-string id",
            (record: MutableRecord) => {
                payloadOf(record)["id"] = 1;
            }
        ]
    ])("rejects a %s", { tags: "p1" }, (_case, mutate) => {
        const record = mutableRecord(WriteRecordCodec.encode(writeFixture()));
        mutate(record);
        expect(() => WriteRecordCodec.decode(encodeCanonicalJson(record))).toThrow();
    });

    test("[write-record] round-trips every Actor kind", { tags: "p1" }, () => {
        for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
            const record = writeFixture({
                actor: new ActorRef(kind, new ActorId(`write-${kind}`))
            });
            const encoded = WriteRecord.encode(record);
            expect(encoded).toEqual(WriteRecordCodec.encode(record));
            expect(WriteRecord.decode(encoded).actor.kind).toBe(kind);
        }
    });

    test.each([
        ["invalid time", () => writeFixture({ at: new Date(NaN) })],
        ["duplicate without original", () => writeFixture({ outcome: "duplicate" })],
        [
            "original on non-duplicate",
            () => writeFixture({ duplicateOf: new WriteRecordId("other") })
        ],
        ["missing decoded fields", () => writeFixture({ caller: undefined })],
        ["empty identity", () => writeFixture({ idempotencyKey: "" })],
        ["long identity", () => writeFixture({ idempotencyKey: "x".repeat(513) })],
        ["missing reserved identity", () => writeFixture({ idempotencyKey: undefined })],
        ["identity on unauthenticated", () => writeFixture({ outcome: "rejectedAuthentication" })],
        ["identity without command", () => writeFixture({ command: undefined })],
        [
            "observation on rejection",
            () =>
                writeFixture({
                    outcome: "rejectedAuthority",
                    observation: Uint8Array.of(1)
                })
        ]
    ])("rejects %s", { tags: "p1" }, (_case, construct) => {
        expect(construct).toThrow();
    });

    test("rejects a malformed write identity without its command", { tags: "p1" }, () => {
        const record = mutableRecord(
            WriteRecordCodec.encode(
                writeFixture({
                    outcome: "rejectedMalformed",
                    idempotencyKey: undefined
                })
            )
        );
        payloadOf(record)["command"] = null;
        payloadOf(record)["idempotencyKey"] = "malformed-identity";
        const decode = () => WriteRecordCodec.decode(encodeCanonicalJson(record));

        expectAgentCoreError(decode, "codec.invalid");
        expect(decode).toThrow("Write idempotency keys require decoded envelope fields");
    });
});

describe("envelope and write record boundaries", () => {
    test("accepts boundary-length names, keys, revisions, and epochs", { tags: "p0" }, () => {
        const boundary = new CommandEnvelope({
            ...envelopeInit(),
            command: "c".repeat(256),
            idempotencyKey: "k".repeat(512),
            expectedRevision: new Revision(0),
            lease: { turn: new TurnId("boundary-turn"), holder: principalRef, epoch: 0 }
        });
        const decoded = CommandEnvelopeCodec.decode(CommandEnvelopeCodec.encode(boundary));

        expect(decoded.command).toBe("c".repeat(256));
        expect(decoded.idempotencyKey).toBe("k".repeat(512));
        expect(decoded.expectedRevision?.value).toBe(0);
        expect(decoded.lease?.epoch).toBe(0);
        expect(writeFixture({ idempotencyKey: "k".repeat(512) }).idempotencyKey).toBe(
            "k".repeat(512)
        );
    });

    test("reports missing or unknown envelope fields exactly", { tags: "p1" }, () => {
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    delete callerOf(record)["principal"];
                })
            )
        ).toThrow("Command envelope contains missing or unknown fields");
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    leaseOf(record)["extra"] = true;
                })
            )
        ).toThrow("Command envelope contains missing or unknown fields");
    });

    test("rejects wrong-shaped and hidden caller or lease fields exactly", { tags: "p1" }, () => {
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    caller: forgedCaller({ kind: "principal", actor })
                })
        ).toThrow(new TypeError("Command caller must be a plain object with exact fields"));

        const accessor = vi.fn(() => principalRef);
        const accessorCaller = forgedCaller(
            Object.defineProperty({ kind: "principal" }, "principal", {
                enumerable: true,
                get: accessor
            })
        );
        expect(() => new CommandEnvelope({ ...envelopeInit(), caller: accessorCaller })).toThrow(
            new TypeError("Command caller must contain enumerable data fields")
        );
        expect(accessor).not.toHaveBeenCalled();

        const accessorLease = forgedLease(
            Object.defineProperty({ turn: new TurnId("hidden-lease-turn"), epoch: 1 }, "holder", {
                enumerable: true,
                get: () => principalRef
            })
        );
        expect(() => new CommandEnvelope({ ...envelopeInit(), lease: accessorLease })).toThrow(
            new TypeError("Lease token must contain enumerable data fields")
        );

        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    caller: forgedCaller({
                        kind: "actor",
                        actor: { kind: "run", id: "plain-actor" }
                    })
                })
        ).toThrow(new TypeError("Command caller is invalid"));
    });

    test("detaches exact actor callers into frozen references", { tags: "p0" }, () => {
        const source: CommandCaller = { kind: "actor", actor };
        const envelope = new CommandEnvelope({ ...envelopeInit(), caller: source });

        expect(envelope.caller).not.toBe(source);
        expect(envelope.caller.kind).toBe("actor");
        if (envelope.caller.kind !== "actor") throw new TypeError("Expected an actor caller");
        expect(envelope.caller.actor).toBeInstanceOf(ActorRef);
        expect(envelope.caller.actor.kind).toBe(actor.kind);
        expect(envelope.caller.actor.id.value).toBe(actor.id.value);
        expect(Object.isFrozen(envelope.caller)).toBe(true);
    });

    test("write records reject partial envelope omission exactly", { tags: "p1" }, () => {
        expect(() =>
            writeFixture({
                outcome: "rejectedAuthentication",
                caller: undefined,
                command: undefined,
                idempotencyKey: undefined
            })
        ).toThrow(new TypeError("Only malformed writes may omit decoded envelope fields"));
        expect(() =>
            WriteRecordCodec.decode(
                encodeCanonicalJson({
                    kind: "write-record",
                    version: { major: 2, minor: 0 },
                    payload: null
                })
            )
        ).toThrow("Write record payload must be an object");
    });

    test("envelope decoding rejects non-object containers exactly", { tags: "p1" }, () => {
        for (const value of [null, [], "caller", 1, true] as const) {
            expect(() =>
                CommandEnvelopeCodec.decode(
                    mutateEnvelope((record) => {
                        payloadOf(record)["caller"] = value;
                    })
                )
            ).toThrow("Command caller must be an object");
        }
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    callerOf(record)["principal"] = null;
                })
            )
        ).toThrow("Command caller principal must be an object");
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    leaseOf(record)["holder"] = [];
                })
            )
        ).toThrow("Lease holder must be an object");
        expect(() =>
            CommandEnvelopeCodec.decode(
                encodeCanonicalJson({
                    kind: "command-envelope",
                    version: { major: 1, minor: 0 },
                    payload: "envelope"
                })
            )
        ).toThrow("Command envelope payload must be an object");
    });

    test("envelope construction rejects null caller and lease containers", { tags: "p1" }, () => {
        expect(
            () => new CommandEnvelope({ ...envelopeInit(), caller: forgedCaller(null) })
        ).toThrow(new TypeError("Command caller must be a plain object with exact fields"));
        expect(() => new CommandEnvelope({ ...envelopeInit(), lease: forgedLease(null) })).toThrow(
            new TypeError("Lease token must be a plain object with exact fields")
        );
    });

    test("envelope decoding reports exact field type diagnostics", { tags: "p1" }, () => {
        const stringFields = ["command", "idempotencyKey", "payload", "payloadDigest"] as const;
        for (const field of stringFields) {
            expect(() =>
                CommandEnvelopeCodec.decode(
                    mutateEnvelope((record) => {
                        payloadOf(record)[field] = 1;
                    })
                )
            ).toThrow(`${field} must be a string`);
        }
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    payloadOf(record)["callerCause"] = 1;
                })
            )
        ).toThrow("callerCause must be a string");

        for (const revision of [1.5, -1, "3", true] as const) {
            expect(() =>
                CommandEnvelopeCodec.decode(
                    mutateEnvelope((record) => {
                        payloadOf(record)["expectedRevision"] = revision;
                    })
                )
            ).toThrow("expectedRevision must be a non-negative safe integer");
        }
        for (const epoch of [1.5, -1, "2"] as const) {
            expect(() =>
                CommandEnvelopeCodec.decode(
                    mutateEnvelope((record) => {
                        leaseOf(record)["epoch"] = epoch;
                    })
                )
            ).toThrow("epoch must be a non-negative safe integer");
        }
    });

    test("envelope decoding rejects unknown caller and Actor kinds exactly", { tags: "p1" }, () => {
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    callerOf(record)["kind"] = "system";
                })
            )
        ).toThrow("Command caller kind is invalid");
        expect(() =>
            CommandEnvelopeCodec.decode(
                mutateEnvelope((record) => {
                    payloadOf(record)["caller"] = {
                        kind: "actor",
                        actor: { kind: "principal", id: "codec-actor" }
                    };
                })
            )
        ).toThrow("Command caller actor kind is invalid");
    });

    test("write records report exact envelope-field diagnostics", { tags: "p1" }, () => {
        expect(() => writeFixture({ command: undefined })).toThrow(
            new TypeError("Only malformed writes may omit decoded envelope fields")
        );
        expect(() => writeFixture({ caller: undefined })).toThrow(
            new TypeError("Only malformed writes may omit decoded envelope fields")
        );
        expect(() => writeFixture({ outcome: "rejectedMalformed", caller: undefined })).toThrow(
            new TypeError("Write idempotency keys require decoded envelope fields")
        );
        expect(() => writeFixture({ outcome: "rejectedMalformed", command: undefined })).toThrow(
            new TypeError("Write idempotency keys require decoded envelope fields")
        );
    });

    test("write record decoding reports exact payload diagnostics", { tags: "p1" }, () => {
        expect(() =>
            WriteRecordCodec.decode(
                encodeCanonicalJson({
                    kind: "write-record",
                    version: { major: 2, minor: 0 },
                    payload: "record"
                })
            )
        ).toThrow("Write record payload must be an object");
        expect(() =>
            WriteRecordCodec.decode(
                mutateWriteRecord((record) => {
                    payloadOf(record)["id"] = 1;
                })
            )
        ).toThrow("id must be a string");
        expect(() =>
            WriteRecordCodec.decode(
                mutateWriteRecord((record) => {
                    actorOf(record)["kind"] = "principal";
                })
            )
        ).toThrow("Write record actor kind is invalid");
    });

    test("write records detach reply and observation bytes", { tags: "p1" }, () => {
        const reply = Uint8Array.of(1, 2, 3);
        const observation = Uint8Array.of(4, 5, 6);
        const record = writeFixture({ observation });
        const detached = new WriteRecord({
            id: new WriteRecordId("codec-detached"),
            actor,
            envelopeDigest: digest,
            caller: principalCaller,
            command: "codec.detached",
            idempotencyKey: "codec-detached-key",
            at: new Date("2026-07-07T12:00:00.000Z"),
            outcome: "committed",
            audit: new AuditRecordId("codec-detached-audit"),
            reply,
            observation
        });
        reply.fill(0);
        observation.fill(0);

        expect(detached.reply).toEqual(Uint8Array.of(1, 2, 3));
        expect(detached.observation).toEqual(Uint8Array.of(4, 5, 6));
        const exposedReply = detached.reply;
        exposedReply.fill(9);
        expect(detached.reply).toEqual(Uint8Array.of(1, 2, 3));
        const exposedObservation = detached.observation;
        exposedObservation?.fill(9);
        expect(detached.observation).toEqual(Uint8Array.of(4, 5, 6));
        expect(record.observation).toEqual(Uint8Array.of(4, 5, 6));
        expect(writeFixture().observation).toBeUndefined();
    });
});

test("prepared payload getters expose exactly the issued state", { tags: "p1" }, () => {
    const binding = new PayloadLeaseBinding(
        tenant,
        actor,
        digest,
        ref,
        digest,
        new Date("2026-07-07T12:01:00.000Z")
    );
    const lease = new CodecContentLease();
    const leased = issueLeasedCommandPayload(lease, binding);
    const malformed = issueMalformedCommandPayload("missing");

    expect(leased.lease).toBe(lease);
    expect(leased.binding).toBe(binding);
    expect(leased.malformedReason).toBeUndefined();
    expect(malformed.lease).toBeUndefined();
    expect(malformed.binding).toBeUndefined();
    expect(malformed.malformedReason).toBe("missing");
    expect(new CommandPayloadMalformedError().name).toBe("CommandPayloadMalformedError");

    for (const value of [undefined, null, 42, "prepared", Symbol("prepared"), () => undefined]) {
        // @ts-expect-error Invalid runtime inputs must not acquire an issued payload state.
        expect(inspectPreparedCommandPayload(value)).toBeUndefined();
    }
});

test("authentication matching rejects every non-issued value shape", { tags: "p1" }, async () => {
    const envelope = envelopeFixture(principalCaller);
    const envelopeDigest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));
    const authentication = await new CodecAuthenticator().authenticate(
        undefined,
        envelope,
        envelopeDigest
    );

    expect(commandAuthenticationMatches(authentication, envelopeDigest, envelope, tenant)).toBe(
        true
    );
    for (const forged of [undefined, null, 42, "authentication", () => undefined]) {
        // @ts-expect-error Arbitrary runtime values must fail the issuance check.
        expect(commandAuthenticationMatches(forged, envelopeDigest, envelope, tenant)).toBe(false);
    }
});

/** A decoded record this file owns outright, so its fields can be corrupted in place. */
type MutableRecord = { [key: string]: JsonValue };

/**
 * The forged* helpers below each type a deliberately invalid value as the contract it violates.
 * CommandEnvelope and WriteRecord validate these contracts at runtime because callers reach them
 * across a decoding boundary where types are only a claim, so proving a guard rejects a value
 * requires handing it one TypeScript would refuse. Every call site sits inside an expectation
 * that the rejection happens, and nothing reads the result.
 */
function forgedCaller<TActual>(caller: TActual): CommandCaller {
    // SAFETY: `caller` does not satisfy CommandCaller. The envelope must reject it for its kind,
    // its identity class, its prototype, or its property descriptors — the runtime guard under
    // test is the only thing that can, so the value has to arrive typed as the contract.
    return caller as TActual & CommandCaller;
}

function forgedLease<TActual>(lease: TActual): LeaseToken {
    // SAFETY: `lease` does not satisfy LeaseToken, for the same reason forgedCaller exists: the
    // envelope's lease guard is what these tests assert on, and it only runs on a typed lease.
    return lease as TActual & LeaseToken;
}

function forgedText<TActual>(value: TActual): string {
    // SAFETY: `value` is not a string. CommandEnvelope re-checks the runtime type of its name and
    // idempotency key because decoded envelopes carry no type evidence; this supplies the
    // non-string those checks exist for.
    return value as TActual & string;
}

class CodecAuthenticator extends CommandAuthenticator<undefined> {
    public constructor() {
        super(tenant);
    }

    protected authenticateTransport(): CommandCaller {
        return principalCaller;
    }
}

test("rejects non-string command names and idempotency keys", { tags: "p2" }, () => {
    expect(() => new CommandEnvelope({ ...envelopeInit(), command: forgedText(42) })).toThrow(
        new TypeError("Command name must contain between 1 and 256 characters")
    );
    expect(
        () => new CommandEnvelope({ ...envelopeInit(), idempotencyKey: forgedText(42) })
    ).toThrow(new TypeError("Command idempotency key must contain between 1 and 512 characters"));
});

test("rejects callers whose identity contradicts their declared kind", { tags: "p2" }, () => {
    expect(
        () =>
            new CommandEnvelope({
                ...envelopeInit(),
                caller: forgedCaller({ kind: "actor", actor: principalRef })
            })
    ).toThrow(new TypeError("Command caller is invalid"));
    expect(
        () =>
            new CommandEnvelope({
                ...envelopeInit(),
                caller: forgedCaller({ kind: "principal", principal: actor })
            })
    ).toThrow(new TypeError("Command caller is invalid"));
});

function envelopeInit(caller: CommandCaller = principalCaller) {
    return {
        command: "codec.command",
        caller,
        idempotencyKey: "codec-key",
        expectedRevision: new Revision(3),
        lease: { turn: new TurnId("codec-turn"), holder: principalRef, epoch: 2 },
        callerCause: new AuditRecordId("codec-cause"),
        payload: ref,
        payloadDigest: digest
    };
}

function envelopeFixture(caller: CommandCaller = principalCaller): CommandEnvelope {
    return new CommandEnvelope(envelopeInit(caller));
}

function mutateEnvelope(mutate: (record: MutableRecord) => void): Uint8Array {
    const record = mutableRecord(CommandEnvelopeCodec.encode(envelopeFixture()));
    mutate(record);
    return encodeCanonicalJson(record);
}

function mutateWriteRecord(mutate: (record: MutableRecord) => void): Uint8Array {
    const record = mutableRecord(WriteRecordCodec.encode(writeFixture()));
    mutate(record);
    return encodeCanonicalJson(record);
}

function writeFixture(
    overrides: Partial<{
        actor: ActorRef;
        caller: CommandCaller | undefined;
        command: string | undefined;
        idempotencyKey: string | undefined;
        at: Date;
        outcome:
            | "committed"
            | "rejectedMalformed"
            | "rejectedAuthentication"
            | "rejectedAuthority"
            | "duplicate";
        duplicateOf: WriteRecordId | undefined;
        observation: Uint8Array | undefined;
    }> = {}
): WriteRecord {
    const caller = "caller" in overrides ? overrides.caller : principalCaller;
    const command = "command" in overrides ? overrides.command : "codec.write";
    const idempotencyKey =
        "idempotencyKey" in overrides ? overrides.idempotencyKey : "codec-write-key";
    const required: WriteRecordInit = {
        id: new WriteRecordId("codec-write"),
        actor: overrides.actor ?? actor,
        envelopeDigest: digest,
        at: overrides.at ?? new Date("2026-07-07T12:00:00.000Z"),
        outcome: overrides.outcome ?? "committed",
        audit: new AuditRecordId("codec-write-audit"),
        reply: Uint8Array.of(1, 2, 3)
    };
    const called: WriteRecordInit = caller === undefined ? required : { ...required, caller };
    const commanded: WriteRecordInit = command === undefined ? called : { ...called, command };
    const keyed: WriteRecordInit =
        idempotencyKey === undefined ? commanded : { ...commanded, idempotencyKey };
    const duplicated: WriteRecordInit =
        overrides.duplicateOf === undefined
            ? keyed
            : { ...keyed, duplicateOf: overrides.duplicateOf };
    const observed: WriteRecordInit =
        overrides.observation === undefined
            ? duplicated
            : { ...duplicated, observation: overrides.observation };
    return new WriteRecord(observed);
}

function mutableRecord(bytes: Uint8Array): MutableRecord {
    return owned(structuredClone(decodeCanonicalJson(bytes)), "record");
}

function payloadOf(record: MutableRecord): MutableRecord {
    return objectAt(record, "payload");
}

function callerOf(record: MutableRecord): MutableRecord {
    return objectAt(payloadOf(record), "caller");
}

function actorOf(record: MutableRecord): MutableRecord {
    return objectAt(payloadOf(record), "actor");
}

function leaseOf(record: MutableRecord): MutableRecord {
    return objectAt(payloadOf(record), "lease");
}

function objectAt(object: MutableRecord, key: string): MutableRecord {
    return owned(object[key], key);
}

function owned(value: JsonValue | undefined, subject: string): MutableRecord {
    if (!isJsonObject(value)) throw new TypeError(`Expected an object at ${subject}`);
    // SAFETY: JsonObject marks its fields readonly because decoded records are shared. Every
    // value reaching here is reachable only from the structuredClone mutableRecord just made,
    // which no codec and no other test holds, so writing through it corrupts nothing but the
    // copy these tests exist to corrupt.
    return value as MutableRecord;
}

class CodecContentLease extends TransientContentLease {
    public read(): Uint8Array {
        return Uint8Array.of(1);
    }

    public matches(): boolean {
        return true;
    }

    public async close(): Promise<void> {}
}
