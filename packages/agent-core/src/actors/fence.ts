import {
    CodecDeclaration,
    RecordCodec,
    hasExactJsonKeys,
    isJsonObject,
    type JsonValue,
    type RecordVersion,
    TextId
} from "../core";
import { AgentCoreError } from "../errors";
import { ActorId } from "./id";
import { ActorFence, ActorRef, type ActorKind } from "./types";

class ActorRecoveryStateCodec extends RecordCodec<ActorRecoveryState> {
    public constructor() {
        super(
            [ActorRecoveryState, CodecDeclaration, ActorRef, TextId, ActorId],
            "actor.recovery-state",
            {
                major: 1,
                minor: 1
            }
        );
    }

    protected encodePayload(state: ActorRecoveryState): JsonValue {
        return {
            actor: { kind: state.actor.kind, id: state.actor.id.value },
            declaration: state.declaration.toData(),
            epoch: state.epoch,
            recoveries: state.recoveries
        };
    }

    protected decodePayload(payload: JsonValue, version: RecordVersion): ActorRecoveryState {
        if (!isActorRecoveryStatePayload(payload, version)) {
            throw malformedRecoveryState();
        }

        try {
            return new ActorRecoveryState(
                new ActorRef(payload.actor.kind, new ActorId(payload.actor.id)),
                payload.epoch,
                payload.recoveries,
                declaredCodecs(payload, version)
            );
        } catch {
            throw malformedRecoveryState();
        }
    }
}

interface ActorRecoveryStatePayload {
    readonly actor: { readonly kind: ActorKind; readonly id: string };
    readonly declaration: JsonValue | undefined;
    readonly epoch: number;
    readonly recoveries: number;
}

export class ActorRecoveryState {
    public static get codec(): RecordCodec<ActorRecoveryState> {
        return actorRecoveryStateCodecInstance;
    }

    public constructor(
        public readonly actor: ActorRef,
        public readonly epoch: number,
        public readonly recoveries: number,
        public readonly declaration: CodecDeclaration = CodecDeclaration.empty
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Actor recovery epoch must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(recoveries) || recoveries < 1) {
            throw new TypeError("Actor recovery count must be a positive safe integer");
        }
        if (declaration.constructor !== CodecDeclaration) {
            throw new TypeError("Actor recovery state requires an exact CodecDeclaration");
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
            increment(this.recoveries, "Actor recovery count"),
            this.declaration
        );
    }

    public advance(): ActorRecoveryState {
        return new ActorRecoveryState(
            this.actor,
            increment(this.epoch, "Actor fence epoch"),
            this.recoveries,
            this.declaration
        );
    }

    /** Records the codec versions this Actor's records are written under (§8.3). */
    public declaring(declaration: CodecDeclaration): ActorRecoveryState {
        return new ActorRecoveryState(this.actor, this.epoch, this.recoveries, declaration);
    }
}

const actorRecoveryStateCodecInstance = new ActorRecoveryStateCodec();

function isActorRecoveryStatePayload(
    payload: JsonValue,
    version: RecordVersion
): payload is JsonValue & ActorRecoveryStatePayload {
    if (!isJsonObject(payload)) {
        return false;
    }

    const actor = payload["actor"];
    const epoch = payload["epoch"];
    const recoveries = payload["recoveries"];
    const fields =
        version.minor === 0
            ? (["actor", "epoch", "recoveries"] as const)
            : (["actor", "declaration", "epoch", "recoveries"] as const);
    return (
        hasExactJsonKeys(payload, fields) &&
        isActor(actor) &&
        isFenceEpoch(epoch) &&
        isRecoveryCount(recoveries)
    );
}

/**
 * Minor 0 predates the §8.3 record-set declaration and named no codec, so it upcasts to an
 * empty declaration: a set that declares nothing is readable by every reader.
 */
function declaredCodecs(
    payload: ActorRecoveryStatePayload,
    version: RecordVersion
): CodecDeclaration {
    return version.minor === 0
        ? CodecDeclaration.empty
        : CodecDeclaration.fromData(payload.declaration);
}

function isActor(
    value: JsonValue | undefined
): value is JsonValue & ActorRecoveryStatePayload["actor"] {
    if (!isJsonObject(value)) return false;
    return (
        hasExactJsonKeys(value, ["kind", "id"]) &&
        isActorKind(value["kind"]) &&
        isActorIdValue(value["id"])
    );
}

function isFenceEpoch(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecoveryCount(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isActorIdValue(value: JsonValue | undefined): value is string {
    return typeof value === "string";
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
