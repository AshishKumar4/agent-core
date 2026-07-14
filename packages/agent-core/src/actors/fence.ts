import { RecordCodec, hasExactJsonKeys, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { ActorId } from "./id";
import { ActorFence, ActorRef, type ActorKind } from "./types";

class ActorRecoveryStateCodec extends RecordCodec<ActorRecoveryState> {
    public constructor() {
        super("actor.recovery-state", { major: 1, minor: 0 });
    }

    protected encodePayload(state: ActorRecoveryState): JsonValue {
        return {
            actor: { kind: state.actor.kind, id: state.actor.id.value },
            epoch: state.epoch,
            recoveries: state.recoveries
        };
    }

    protected decodePayload(payload: JsonValue): ActorRecoveryState {
        if (!isActorRecoveryStatePayload(payload)) {
            throw malformedRecoveryState();
        }

        try {
            return new ActorRecoveryState(
                new ActorRef(payload.actor.kind, new ActorId(payload.actor.id)),
                payload.epoch,
                payload.recoveries
            );
        } catch {
            throw malformedRecoveryState();
        }
    }
}

interface ActorRecoveryStatePayload {
    readonly actor: { readonly kind: ActorKind; readonly id: string };
    readonly epoch: number;
    readonly recoveries: number;
}

export class ActorRecoveryState {
    public static readonly codec: RecordCodec<ActorRecoveryState> = new ActorRecoveryStateCodec();

    public constructor(
        public readonly actor: ActorRef,
        public readonly epoch: number,
        public readonly recoveries: number
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Actor recovery epoch must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(recoveries) || recoveries < 1) {
            throw new TypeError("Actor recovery count must be a positive safe integer");
        }
        Object.freeze(this);
    }

    public static initial(actor: ActorRef): ActorRecoveryState {
        return new ActorRecoveryState(actor, 0, 1);
    }

    public static encode(state: ActorRecoveryState): Uint8Array {
        return ActorRecoveryState.codec.encode(state);
    }

    public static decode(bytes: Uint8Array): ActorRecoveryState {
        return ActorRecoveryState.codec.decode(bytes);
    }

    public get fence(): ActorFence {
        return new ActorFence(this.actor, this.epoch);
    }

    public recover(): ActorRecoveryState {
        return new ActorRecoveryState(
            this.actor,
            increment(this.epoch, "Actor fence epoch"),
            increment(this.recoveries, "Actor recovery count")
        );
    }

    public advance(): ActorRecoveryState {
        return new ActorRecoveryState(
            this.actor,
            increment(this.epoch, "Actor fence epoch"),
            this.recoveries
        );
    }
}

function isActorRecoveryStatePayload(
    payload: JsonValue
): payload is JsonValue & ActorRecoveryStatePayload {
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
        return false;
    }

    const object = payload as { readonly [key: string]: JsonValue };
    const actor = object["actor"];
    const epoch = object["epoch"];
    const recoveries = object["recoveries"];
    return (
        hasExactJsonKeys(object, ["actor", "epoch", "recoveries"]) &&
        isActor(actor) &&
        typeof epoch === "number" &&
        Number.isSafeInteger(epoch) &&
        epoch >= 0 &&
        typeof recoveries === "number" &&
        Number.isSafeInteger(recoveries) &&
        recoveries >= 1
    );
}

function isActor(
    value: JsonValue | undefined
): value is JsonValue & ActorRecoveryStatePayload["actor"] {
    if (value === null || Array.isArray(value) || typeof value !== "object") return false;
    const object = value as { readonly [key: string]: JsonValue };
    return (
        hasExactJsonKeys(object, ["kind", "id"]) &&
        isActorKind(object["kind"]) &&
        typeof object["id"] === "string"
    );
}

function isActorKind(value: JsonValue | undefined): value is ActorKind {
    return (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    );
}

function malformedRecoveryState(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Actor recovery state payload is malformed");
}

function increment(value: number, name: string): number {
    if (value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("actor.closed", `${name} is exhausted`);
    }
    return value + 1;
}
