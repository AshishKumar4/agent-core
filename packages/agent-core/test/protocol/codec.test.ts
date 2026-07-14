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
    PayloadLeaseBinding,
    PreparedCommandPayload,
    inspectPreparedCommandPayload,
    issueLeasedCommandPayload,
    issueMalformedCommandPayload
} from "../../src/protocol/payload";
import * as protocol from "../../src/protocol";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import { WriteRecord, WriteRecordCodec } from "../../src/protocol/write";
import { expectAgentCoreError } from "./error-assertion";

const actor = new ActorRef("run", new ActorId("codec-actor"));
const tenant = new TenantId("codec-tenant");
const principal = new PrincipalId("codec-principal");
const principalRef = new PrincipalRef(tenant, principal);
const principalCaller: CommandCaller = { kind: "principal", principal: principalRef };
const digest = Digest.sha256(new TextEncoder().encode("codec-payload"));
const ref = ContentRef.fromDigest(digest);

describe("CommandEnvelope codec", () => {
    test("[C13-PROTOCOL-EXACT-ENVELOPE] [command-envelope] round-trips absent optional fields and every Actor caller kind", () => {
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
    });

    test.each([
        [
            "non-object payload",
            (record: MutableObject) => {
                record["payload"] = null;
            }
        ],
        [
            "missing field",
            (record: MutableObject) => {
                delete payloadOf(record)["command"];
            }
        ],
        [
            "unknown field",
            (record: MutableObject) => {
                payloadOf(record)["unknown"] = true;
            }
        ],
        [
            "non-string command",
            (record: MutableObject) => {
                payloadOf(record)["command"] = 1;
            }
        ],
        [
            "non-object caller",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = null;
            }
        ],
        [
            "unknown caller",
            (record: MutableObject) => {
                callerOf(record)["kind"] = "system";
            }
        ],
        [
            "missing principal",
            (record: MutableObject) => {
                delete callerOf(record)["principal"];
            }
        ],
        [
            "extra principal field",
            (record: MutableObject) => {
                callerOf(record)["extra"] = true;
            }
        ],
        [
            "non-string principal",
            (record: MutableObject) => {
                callerOf(record)["principal"] = 1;
            }
        ],
        [
            "non-object actor",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: null };
            }
        ],
        [
            "incomplete actor",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: { kind: "run" } };
            }
        ],
        [
            "unknown actor field",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = {
                    kind: "actor",
                    actor: { kind: "run", id: "actor", extra: true }
                };
            }
        ],
        [
            "invalid actor kind",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = {
                    kind: "actor",
                    actor: { kind: "principal", id: "actor" }
                };
            }
        ],
        [
            "non-string actor id",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = { kind: "actor", actor: { kind: "run", id: 1 } };
            }
        ],
        [
            "non-string idempotency key",
            (record: MutableObject) => {
                payloadOf(record)["idempotencyKey"] = 1;
            }
        ],
        [
            "non-integer revision",
            (record: MutableObject) => {
                payloadOf(record)["expectedRevision"] = 1.5;
            }
        ],
        [
            "negative revision",
            (record: MutableObject) => {
                payloadOf(record)["expectedRevision"] = -1;
            }
        ],
        [
            "non-object lease",
            (record: MutableObject) => {
                payloadOf(record)["lease"] = null;
            }
        ],
        [
            "incomplete lease",
            (record: MutableObject) => {
                delete leaseOf(record)["holder"];
            }
        ],
        [
            "unknown lease field",
            (record: MutableObject) => {
                leaseOf(record)["extra"] = true;
            }
        ],
        [
            "non-string lease turn",
            (record: MutableObject) => {
                leaseOf(record)["turn"] = 1;
            }
        ],
        [
            "non-string lease holder",
            (record: MutableObject) => {
                leaseOf(record)["holder"] = 1;
            }
        ],
        [
            "unsafe lease epoch",
            (record: MutableObject) => {
                leaseOf(record)["epoch"] = Number.MAX_SAFE_INTEGER + 1;
            }
        ],
        [
            "non-string caller cause",
            (record: MutableObject) => {
                payloadOf(record)["callerCause"] = 1;
            }
        ],
        [
            "non-string payload ref",
            (record: MutableObject) => {
                payloadOf(record)["payload"] = 1;
            }
        ],
        [
            "non-string payload digest",
            (record: MutableObject) => {
                payloadOf(record)["payloadDigest"] = 1;
            }
        ]
    ])("rejects a %s", (_case, mutate) => {
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
    ])("rejects %s at construction", (_case, construct) => {
        expect(construct).toThrow(TypeError);
    });
});

describe("protocol callers and authentication", () => {
    test("compares only exact principal and Actor identities", () => {
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

    test("does not allow callers to issue transport authentication", () => {
        expectAgentCoreError(
            () => new CommandAuthentication(Symbol("forged"), digest, principalCaller, tenant),
            "protocol.invalid-envelope"
        );
    });

    test("validates issued authentication before invoking token behavior", async () => {
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
        const subclassLookalike = Object.create(CommandAuthentication.prototype) as object;

        expect(commandAuthenticationMatches(authentication, envelopeDigest, envelope, tenant)).toBe(
            true
        );
        for (const forged of [{}, throwingLookalike, proxy, subclassLookalike]) {
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
    });

    test("admits only the configured caller family", () => {
        const actorCaller: CommandCaller = { kind: "actor", actor };
        expect(CommandCallerPolicy.principal().admits(principalCaller)).toBe(true);
        expect(CommandCallerPolicy.principal().admits(actorCaller)).toBe(false);
        expect(CommandCallerPolicy.actor("run").admits(principalCaller)).toBe(false);
        expect(CommandCallerPolicy.actor("run").admits(actorCaller)).toBe(true);
        expect(CommandCallerPolicy.actor("workspace").admits(actorCaller)).toBe(false);
    });

    test("envelopes deeply detach and freeze authenticated caller and lease state", () => {
        const mutable: { kind: "principal"; principal: PrincipalRef } = {
            kind: "principal",
            principal: principalRef
        };
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
    });

    test("requires exact plain runtime fields for callers and leases", () => {
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    caller: { ...principalCaller, extra: true } as CommandCaller
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CommandEnvelope({
                    ...envelopeInit(),
                    lease: {
                        ...envelopeInit().lease,
                        extra: true
                    } as LeaseToken
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
                    lease: accessorLease as LeaseToken
                })
        ).toThrow(TypeError);
    });

    test("rejects exact-shape callers with invalid identity values", () => {
        const invalidCaller = {
            kind: "principal",
            principal: { value: principal.value }
        } as unknown as CommandCaller;

        expect(() => new CommandEnvelope({ ...envelopeInit(), caller: invalidCaller })).toThrow(
            new TypeError("Command caller is invalid")
        );
    });

    test("rejects exact-shape leases with invalid values", () => {
        const validLease = envelopeInit().lease!;
        const invalidLeases = [
            { ...validLease, turn: { value: validLease.turn.value } as TurnId },
            {
                ...validLease,
                holder: {
                    tenantId: validLease.holder.tenantId,
                    principalId: validLease.holder.principalId
                } as PrincipalRef
            },
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
            ).toThrow(new TypeError("Lease token is invalid"));
        }
    });

    test("rejects non-plain caller and lease values", () => {
        const caller = Object.assign(Object.create(null), principalCaller) as CommandCaller;
        const lease = Object.assign(Object.create(null), envelopeInit().lease) as LeaseToken;

        expect(() => new CommandEnvelope({ ...envelopeInit(), caller })).toThrow(
            new TypeError("Command caller must be a plain object with exact fields")
        );
        expect(() => new CommandEnvelope({ ...envelopeInit(), lease })).toThrow(
            new TypeError("Lease token must be a plain object with exact fields")
        );
    });

    test("rejects non-enumerable and accessor caller fields without invoking accessors", () => {
        const accessor = vi.fn(() => "principal");
        const hiddenKind = Object.defineProperty({ principal: principalRef }, "kind", {
            enumerable: false,
            value: "principal"
        }) as CommandCaller;
        const accessorKind = Object.defineProperty({ principal: principalRef }, "kind", {
            enumerable: true,
            get: accessor
        }) as CommandCaller;

        for (const caller of [hiddenKind, accessorKind]) {
            expect(() => new CommandEnvelope({ ...envelopeInit(), caller })).toThrow(
                new TypeError("Command caller must contain enumerable data fields")
            );
        }
        expect(accessor).not.toHaveBeenCalled();
    });
});

describe("payload preparation values", () => {
    test("defensively copies expiry and compares every binding field", () => {
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

    test("issues nominal leased and malformed preparation variants", () => {
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
        expect(
            (PreparedCommandPayload as unknown as { readonly leased?: unknown }).leased
        ).toBeUndefined();
    });

    test("rejects forged prepared payloads without invoking attacker properties", () => {
        const lookalike = new Proxy(
            {},
            {
                get(): never {
                    throw new TypeError("prepared payload proxy trap must not run");
                }
            }
        );
        expect(inspectPreparedCommandPayload({})).toBeUndefined();
        expect(inspectPreparedCommandPayload(lookalike)).toBeUndefined();
        expect(
            inspectPreparedCommandPayload(Object.create(PreparedCommandPayload.prototype))
        ).toBeUndefined();
        const forged = Object.create(PreparedCommandPayload.prototype) as PreparedCommandPayload;
        expectAgentCoreError(() => forged.lease, "protocol.invalid-state");
        const constructor = PreparedCommandPayload as unknown as new (
            issuer: symbol,
            state: object
        ) => PreparedCommandPayload;
        expectAgentCoreError(() => new constructor(Symbol("forged"), {}), "protocol.invalid-state");
    });
});

describe("WriteRecord codec and invariants", () => {
    test("rejects the incompatible baseline v1 record major", () => {
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
            () => WriteRecordCodec.decode(encodeCanonicalJson(record as JsonValue)),
            "codec.unknown-major"
        );
    });

    test.each([
        [
            "non-object payload",
            (record: MutableObject) => {
                record["payload"] = null;
            }
        ],
        [
            "non-object actor",
            (record: MutableObject) => {
                payloadOf(record)["actor"] = null;
            }
        ],
        [
            "missing field",
            (record: MutableObject) => {
                delete payloadOf(record)["id"];
            }
        ],
        [
            "unknown field",
            (record: MutableObject) => {
                payloadOf(record)["unknown"] = true;
            }
        ],
        [
            "unknown actor field",
            (record: MutableObject) => {
                actorOf(record)["extra"] = true;
            }
        ],
        [
            "invalid actor kind",
            (record: MutableObject) => {
                actorOf(record)["kind"] = "principal";
            }
        ],
        [
            "non-string actor id",
            (record: MutableObject) => {
                actorOf(record)["id"] = 1;
            }
        ],
        [
            "invalid caller",
            (record: MutableObject) => {
                payloadOf(record)["caller"] = true;
            }
        ],
        [
            "non-string command",
            (record: MutableObject) => {
                payloadOf(record)["command"] = 1;
            }
        ],
        [
            "non-string duplicate",
            (record: MutableObject) => {
                payloadOf(record)["duplicateOf"] = 1;
            }
        ],
        [
            "non-string identity",
            (record: MutableObject) => {
                payloadOf(record)["idempotencyKey"] = 1;
            }
        ],
        [
            "non-string observation",
            (record: MutableObject) => {
                payloadOf(record)["observation"] = 1;
            }
        ],
        [
            "invalid timestamp",
            (record: MutableObject) => {
                payloadOf(record)["at"] = "invalid";
            }
        ],
        [
            "invalid outcome",
            (record: MutableObject) => {
                payloadOf(record)["outcome"] = "unknown";
            }
        ],
        [
            "non-string id",
            (record: MutableObject) => {
                payloadOf(record)["id"] = 1;
            }
        ]
    ])("rejects a %s", (_case, mutate) => {
        const record = mutableRecord(WriteRecordCodec.encode(writeFixture()));
        mutate(record);
        expect(() => WriteRecordCodec.decode(encodeCanonicalJson(record as JsonValue))).toThrow();
    });

    test("[write-record] round-trips every Actor kind", () => {
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
    ])("rejects %s", (_case, construct) => {
        expect(construct).toThrow();
    });

    test("rejects a malformed write identity without its command", () => {
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
        const decode = () => WriteRecordCodec.decode(encodeCanonicalJson(record as JsonValue));

        expectAgentCoreError(decode, "codec.invalid");
        expect(decode).toThrow("Write idempotency keys require decoded envelope fields");
    });
});

type MutableObject = Record<string, unknown>;

class CodecAuthenticator extends CommandAuthenticator<undefined> {
    public constructor() {
        super(tenant);
    }

    protected authenticateTransport(): CommandCaller {
        return principalCaller;
    }
}

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

function mutateEnvelope(mutate: (record: MutableObject) => void): Uint8Array {
    const record = mutableRecord(CommandEnvelopeCodec.encode(envelopeFixture()));
    mutate(record);
    return encodeCanonicalJson(record as JsonValue);
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
    return new WriteRecord({
        id: new WriteRecordId("codec-write"),
        actor: overrides.actor ?? actor,
        envelopeDigest: digest,
        ...(caller === undefined ? {} : { caller }),
        ...(command === undefined ? {} : { command }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        at: overrides.at ?? new Date("2026-07-07T12:00:00.000Z"),
        outcome: overrides.outcome ?? "committed",
        audit: new AuditRecordId("codec-write-audit"),
        ...(overrides.duplicateOf === undefined ? {} : { duplicateOf: overrides.duplicateOf }),
        reply: Uint8Array.of(1, 2, 3),
        ...(overrides.observation === undefined ? {} : { observation: overrides.observation })
    });
}

function mutableRecord(bytes: Uint8Array): MutableObject {
    return structuredClone(decodeCanonicalJson(bytes)) as MutableObject;
}

function payloadOf(record: MutableObject): MutableObject {
    return objectAt(record, "payload");
}

function callerOf(record: MutableObject): MutableObject {
    return objectAt(payloadOf(record), "caller");
}

function actorOf(record: MutableObject): MutableObject {
    return objectAt(payloadOf(record), "actor");
}

function leaseOf(record: MutableObject): MutableObject {
    return objectAt(payloadOf(record), "lease");
}

function objectAt(object: MutableObject, key: string): MutableObject {
    return object[key] as MutableObject;
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
