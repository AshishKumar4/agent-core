// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorFence, ActorId, ActorRecoveryState, ActorRef } from "../../src/actors";
import { ActorId as CanonicalActorId } from "../../src/actors/id";
import { encodeCanonicalJson, type JsonValue, TextId } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

const actorId = new ActorId("actor-codec");
const actor = new ActorRef("run", actorId);

class WrongActorId extends TextId {
    public constructor(value: string) {
        super(value, "Wrong Actor ID");
        Object.freeze(this);
    }
}

class DerivedActorId extends ActorId {}

test("ActorRef accepts only its closed kinds and exact ActorId instances", () => {
    expect(ActorId).toBe(CanonicalActorId);
    expect(Object.isFrozen(new ActorRef("tenant", new ActorId("valid-actor")))).toBe(true);
    expect(() => Reflect.construct(ActorRef, ["invalid", actorId])).toThrow(TypeError);
    expect(() => Reflect.construct(ActorRef, ["run", { value: actorId.value }])).toThrow(TypeError);
    expect(() => Reflect.construct(ActorRef, ["run", new WrongActorId(actorId.value)])).toThrow(
        TypeError
    );
    expect(() => Reflect.construct(ActorRef, ["run", new DerivedActorId(actorId.value)])).toThrow(
        TypeError
    );
});

describe("ActorRecoveryState codec", () => {
    test("[actor.recovery-state] round-trips recovery state through its versioned codec", () => {
        const state = new ActorRecoveryState(actor, 7, 3);
        const encoded = ActorRecoveryState.encode(state);

        expect(encoded).toEqual(ActorRecoveryState.codec.encode(state));
        const decoded = ActorRecoveryState.decode(encoded);

        expect(decoded.actor.equals(actor)).toBe(true);
        expect(decoded.epoch).toBe(7);
        expect(decoded.recoveries).toBe(3);
    });

    test("rejects malformed payloads with a typed codec error", () => {
        const malformed = [
            null,
            {},
            { actor: { kind: "run", id: "actor-codec" }, epoch: "7", recoveries: 3 },
            { actor: { kind: "invalid", id: "actor-codec" }, epoch: 7, recoveries: 3 },
            { actor: { kind: "run", id: "" }, epoch: 7, recoveries: 3 },
            { actor: null, epoch: 7, recoveries: 3 },
            { actor: [], epoch: 7, recoveries: 3 },
            { actor: { kind: "run", id: "actor-codec" }, epoch: 7, recoveries: 3, unknown: true }
        ];

        for (const payload of malformed) {
            expect(() => ActorRecoveryState.codec.decode(envelope(payload))).toThrow(
                malformedError()
            );
        }
    });

    test("rejects an unknown codec major", () => {
        const encoded = encodeCanonicalJson({
            kind: "actor.recovery-state",
            payload: { actor: { kind: actor.kind, id: actor.id.value }, epoch: 7, recoveries: 3 },
            version: { major: 2, minor: 0 }
        });

        expect(() => ActorRecoveryState.codec.decode(encoded)).toThrow(
            new AgentCoreError(
                "codec.unknown-major",
                "Unsupported actor.recovery-state codec major 2"
            )
        );
    });

    test("enforces safe integer state invariants in constructors and decoding", () => {
        const invalid = [
            { epoch: -1, recoveries: 1 },
            { epoch: Number.MAX_SAFE_INTEGER + 1, recoveries: 1 },
            { epoch: 0, recoveries: 0 },
            { epoch: 0, recoveries: Number.MAX_SAFE_INTEGER + 1 }
        ];

        for (const values of invalid) {
            expect(() => new ActorRecoveryState(actor, values.epoch, values.recoveries)).toThrow(
                TypeError
            );
            expect(() =>
                ActorRecoveryState.codec.decode(
                    envelope({
                        actor: { kind: actor.kind, id: actor.id.value },
                        epoch: values.epoch,
                        recoveries: values.recoveries
                    })
                )
            ).toThrow(malformedError());
        }
    });

    test("fails before recovery counters or fences exceed safe integers", () => {
        const exhaustedEpoch = new ActorRecoveryState(actor, Number.MAX_SAFE_INTEGER, 1);
        const exhaustedRecoveries = new ActorRecoveryState(actor, 0, Number.MAX_SAFE_INTEGER);

        expectOperationalError(() => exhaustedEpoch.advance(), "actor.closed");
        expectOperationalError(() => exhaustedEpoch.recover(), "actor.closed");
        expectOperationalError(() => exhaustedRecoveries.recover(), "actor.closed");
        expect(() => new ActorFence(actor, -1)).toThrow(/non-negative safe integer/);
    });
});

function envelope(payload: unknown): Uint8Array {
    return encodeCanonicalJson({
        kind: "actor.recovery-state",
        payload: payload as JsonValue,
        version: { major: 1, minor: 0 }
    });
}

function expectOperationalError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

function malformedError(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Actor recovery state payload is malformed");
}
