import { describe, expect, test } from "vitest";
import {
    ActorFence,
    ActorId,
    ActorRecoveryState,
    ActorRef,
    type ActorKind
} from "../../src/actors";
import { ActorId as CanonicalActorId } from "../../src/actors/id";
import { encodeCanonicalJson, type JsonValue, TextId } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

const actorId = new ActorId("actor-codec");
const actor = new ActorRef("run", actorId);
const ACTOR_KINDS: readonly ActorKind[] = ["tenant", "workspace", "run", "environment", "slate"];

class WrongActorId extends TextId {
    public constructor(value: string) {
        super(value, "Wrong Actor ID");
        Object.freeze(this);
    }
}

class DerivedActorId extends ActorId {}

test("ActorRef accepts only its closed kinds and exact ActorId instances", { tags: "p1" }, () => {
    expect(ActorId).toBe(CanonicalActorId);
    expect(Object.isFrozen(new ActorRef("tenant", new ActorId("valid-actor")))).toBe(true);
    expect(
        () =>
            // @ts-expect-error Runtime callers can supply an invalid Actor kind.
            new ActorRef("invalid", actorId)
    ).toThrow(TypeError);
    expect(
        () =>
            // @ts-expect-error Runtime callers can supply an ActorId lookalike.
            new ActorRef("run", { value: actorId.value })
    ).toThrow(TypeError);
    expect(() => new ActorRef("run", new WrongActorId(actorId.value))).toThrow(TypeError);
    expect(() => new ActorRef("run", new DerivedActorId(actorId.value))).toThrow(TypeError);
});

describe("ActorRecoveryState codec", () => {
    test(
        "[actor.recovery-state] round-trips recovery state through its versioned codec",
        { tags: "p0" },
        () => {
            const state = new ActorRecoveryState(actor, 7, 3);
            const encoded = ActorRecoveryState.encode(state);

            expect(encoded).toEqual(ActorRecoveryState.codec.encode(state));
            const decoded = ActorRecoveryState.decode(encoded);

            expect(decoded.actor.equals(actor)).toBe(true);
            expect(decoded.epoch).toBe(7);
            expect(decoded.recoveries).toBe(3);
        }
    );

    test("rejects malformed payloads with a typed codec error", { tags: "p1" }, () => {
        const malformed: readonly JsonValue[] = [
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

    test("rejects an unknown codec major", { tags: "p2" }, () => {
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

    test(
        "enforces safe integer state invariants in constructors and decoding",
        { tags: "p0" },
        () => {
            const invalid = [
                { epoch: -1, recoveries: 1 },
                { epoch: Number.MAX_SAFE_INTEGER + 1, recoveries: 1 },
                { epoch: 0, recoveries: 0 },
                { epoch: 0, recoveries: Number.MAX_SAFE_INTEGER + 1 }
            ];

            for (const values of invalid) {
                expect(
                    () => new ActorRecoveryState(actor, values.epoch, values.recoveries)
                ).toThrow(TypeError);
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
        }
    );

    test("fails before recovery counters or fences exceed safe integers", { tags: "p0" }, () => {
        const exhaustedEpoch = new ActorRecoveryState(actor, Number.MAX_SAFE_INTEGER, 1);
        const exhaustedRecoveries = new ActorRecoveryState(actor, 0, Number.MAX_SAFE_INTEGER);

        expectOperationalError(() => exhaustedEpoch.advance(), "actor.closed");
        expectOperationalError(() => exhaustedEpoch.recover(), "actor.closed");
        expectOperationalError(() => exhaustedRecoveries.recover(), "actor.closed");
        expect(() => new ActorFence(actor, -1)).toThrow(/non-negative safe integer/);
    });

    test("names the exhausted counter when a fence cannot advance", { tags: "p1" }, () => {
        const exhaustedEpoch = new ActorRecoveryState(actor, Number.MAX_SAFE_INTEGER, 1);
        const exhaustedRecoveries = new ActorRecoveryState(actor, 0, Number.MAX_SAFE_INTEGER);

        expectNamedFailure(
            () => exhaustedEpoch.advance(),
            "actor.closed",
            "Actor fence epoch is exhausted"
        );
        expectNamedFailure(
            () => exhaustedEpoch.recover(),
            "actor.closed",
            "Actor fence epoch is exhausted"
        );
        expectNamedFailure(
            () => exhaustedRecoveries.recover(),
            "actor.closed",
            "Actor recovery count is exhausted"
        );
    });

    test("round-trips recovery state for every Actor kind", { tags: "p0" }, () => {
        for (const kind of ACTOR_KINDS) {
            const ref = new ActorRef(kind, new ActorId(`actor-${kind}`));
            const decoded = ActorRecoveryState.decode(
                ActorRecoveryState.encode(new ActorRecoveryState(ref, 3, 2))
            );

            expect(decoded.actor.kind).toBe(kind);
            expect(decoded.actor.id.value).toBe(`actor-${kind}`);
            expect(decoded.epoch).toBe(3);
            expect(decoded.recoveries).toBe(2);
            expect(decoded.fence.matches(ref, 3)).toBe(true);
            expect(decoded.fence.matches(ref, 4)).toBe(false);
        }
    });

    test("rejects recovery payloads whose Actor record is not exact", { tags: "p0" }, () => {
        const hostile: readonly JsonValue[] = [
            null,
            [],
            "payload",
            { actor: { kind: "run", id: "actor-codec", extra: 1 }, epoch: 7, recoveries: 3 },
            { actor: { kind: "run" }, epoch: 7, recoveries: 3 },
            { actor: { id: "actor-codec" }, epoch: 7, recoveries: 3 },
            { actor: {}, epoch: 7, recoveries: 3 },
            { actor: { kind: "run", id: 5 }, epoch: 7, recoveries: 3 },
            { actor: { kind: "", id: "actor-codec" }, epoch: 7, recoveries: 3 },
            { actor: "run", epoch: 7, recoveries: 3 },
            { actor: { kind: "run", id: "actor-codec" }, epoch: 7 },
            { actor: { kind: "run", id: "actor-codec" }, epoch: -1, recoveries: 3 },
            { actor: { kind: "run", id: "actor-codec" }, epoch: 7, recoveries: 0 }
        ];

        for (const payload of hostile) {
            expectNamedFailure(
                () => ActorRecoveryState.codec.decode(envelope(payload)),
                "codec.invalid",
                "Actor recovery state payload is malformed"
            );
        }
    });
});

describe("Actor identity", () => {
    test("names Actor IDs in their own validation failures", { tags: "p1" }, () => {
        expect(() => new ActorId("")).toThrow("Actor ID must contain between 1 and 256 characters");
        expect(() => new ActorId("x".repeat(257))).toThrow(
            "Actor ID must contain between 1 and 256 characters"
        );
        expect(new ActorId("x".repeat(256)).value).toHaveLength(256);
    });

    test("requires exact ActorId instances and closed Actor kinds", { tags: "p1" }, () => {
        const message = "Actor reference requires a valid kind and exact Actor ID";
        const prototypeImpostor = {};
        Object.setPrototypeOf(prototypeImpostor, ActorId.prototype);
        const impostors = [
            actorId.value,
            null,
            undefined,
            { value: actorId.value },
            new WrongActorId(actorId.value),
            new DerivedActorId(actorId.value),
            prototypeImpostor
        ];

        for (const kind of ACTOR_KINDS) {
            const ref = new ActorRef(kind, new ActorId(`actor-${kind}`));
            expect(ref.kind).toBe(kind);
            expect(ref.equals(new ActorRef(kind, new ActorId(`actor-${kind}`)))).toBe(true);
        }
        for (const impostor of impostors) {
            expect(
                () =>
                    // @ts-expect-error Runtime callers can supply malformed Actor IDs.
                    new ActorRef("run", impostor)
            ).toThrow(message);
        }
        for (const kind of ["", "Run", "tenants", 5, null, undefined]) {
            expect(
                () =>
                    // @ts-expect-error Runtime callers can supply malformed Actor kinds.
                    new ActorRef(kind, actorId)
            ).toThrow(message);
        }
    });
});

function envelope(payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind: "actor.recovery-state",
        payload,
        version: { major: 1, minor: 0 }
    });
}

function expectOperationalError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        return;
    }
    throw new TypeError("Expected operation to fail");
}

function expectNamedFailure(
    action: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        return;
    }
    throw new TypeError(`Expected an operational failure: ${code} ${message}`);
}

function malformedError(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Actor recovery state payload is malformed");
}
