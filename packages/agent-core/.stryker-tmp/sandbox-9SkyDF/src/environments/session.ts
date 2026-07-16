// @ts-nocheck
import { RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import {
    advanceRevision,
    increment,
    requireExact,
    requireInstance,
    requireObject,
    requireOptionalString,
    requireSafeInteger,
    requireString
} from "./data";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId } from "./id";

export type EnvironmentSessionStateName =
    "reserved" | "opening" | "open" | "lost" | "failed" | "closing" | "closed";

export abstract class EnvironmentSessionState {
    public static get reserved(): EnvironmentSessionState {
        return reservedSessionState;
    }
    public static get opening(): EnvironmentSessionState {
        return openingSessionState;
    }
    public static get open(): EnvironmentSessionState {
        return openSessionState;
    }
    public static get lost(): EnvironmentSessionState {
        return lostSessionState;
    }
    public static get failed(): EnvironmentSessionState {
        return failedSessionState;
    }
    public static get closing(): EnvironmentSessionState {
        return closingSessionState;
    }
    public static get closed(): EnvironmentSessionState {
        return closedSessionState;
    }

    public abstract readonly name: EnvironmentSessionStateName;
    public beginOpen(): EnvironmentSessionState {
        return this.invalid("open");
    }
    public opened(): EnvironmentSessionState {
        return this.invalid("complete open");
    }
    public failOpen(): EnvironmentSessionState {
        return this.invalid("fail open");
    }
    public lost(): EnvironmentSessionState {
        return this.invalid("mark lost");
    }
    public beginClose(): EnvironmentSessionState {
        return this.invalid("close");
    }
    public closed(): EnvironmentSessionState {
        return this.invalid("complete close");
    }
    public assertUsable(): void {
        throw new AgentCoreError("environment.invalid-session", "Environment session is not open");
    }

    protected invalid(operation: string): never {
        throw new AgentCoreError(
            "environment.invalid-session",
            `Cannot ${operation} an Environment session in ${this.name} state`
        );
    }
}

class ReservedSessionState extends EnvironmentSessionState {
    public readonly name = "reserved";
    public override beginOpen(): EnvironmentSessionState {
        return EnvironmentSessionState.opening;
    }
    public override beginClose(): EnvironmentSessionState {
        return EnvironmentSessionState.closing;
    }
}
class OpeningSessionState extends EnvironmentSessionState {
    public readonly name = "opening";
    public override beginOpen(): EnvironmentSessionState {
        return this;
    }
    public override opened(): EnvironmentSessionState {
        return EnvironmentSessionState.open;
    }
    public override failOpen(): EnvironmentSessionState {
        return EnvironmentSessionState.failed;
    }
    public override beginClose(): EnvironmentSessionState {
        return EnvironmentSessionState.closing;
    }
}
class OpenSessionState extends EnvironmentSessionState {
    public readonly name = "open";
    public override beginOpen(): EnvironmentSessionState {
        return this;
    }
    public override opened(): EnvironmentSessionState {
        return this;
    }
    public override lost(): EnvironmentSessionState {
        return EnvironmentSessionState.lost;
    }
    public override beginClose(): EnvironmentSessionState {
        return EnvironmentSessionState.closing;
    }
    public override assertUsable(): void {}
}
class LostSessionState extends EnvironmentSessionState {
    public readonly name = "lost";
    public override lost(): EnvironmentSessionState {
        return this;
    }
    public override beginClose(): EnvironmentSessionState {
        return EnvironmentSessionState.closing;
    }
    public override assertUsable(): never {
        throw new AgentCoreError(
            "environment.stale-session",
            "Environment session provider resource was lost"
        );
    }
}
class FailedSessionState extends EnvironmentSessionState {
    public readonly name = "failed";
    public override failOpen(): EnvironmentSessionState {
        return this;
    }
    public override beginClose(): EnvironmentSessionState {
        return EnvironmentSessionState.closing;
    }
}
class ClosingSessionState extends EnvironmentSessionState {
    public readonly name = "closing";
    public override beginClose(): EnvironmentSessionState {
        return this;
    }
    public override closed(): EnvironmentSessionState {
        return EnvironmentSessionState.closed;
    }
}
class ClosedSessionState extends EnvironmentSessionState {
    public readonly name = "closed";
    public override beginClose(): EnvironmentSessionState {
        return this;
    }
    public override closed(): EnvironmentSessionState {
        return this;
    }
    public override assertUsable(): never {
        throw new AgentCoreError("environment.closed-session", "Environment session is closed");
    }
}

const reservedSessionState = freezeState(new ReservedSessionState());
const openingSessionState = freezeState(new OpeningSessionState());
const openSessionState = freezeState(new OpenSessionState());
const lostSessionState = freezeState(new LostSessionState());
const failedSessionState = freezeState(new FailedSessionState());
const closingSessionState = freezeState(new ClosingSessionState());
const closedSessionState = freezeState(new ClosedSessionState());

class EnvironmentSessionCodecV1 extends RecordCodec<EnvironmentSession> {
    public constructor() {
        super("environment.session", { major: 1, minor: 0 });
    }

    protected encodePayload(session: EnvironmentSession): JsonValue {
        return {
            id: session.id.value,
            environmentId: session.environmentId.value,
            environmentRevision: session.environmentRevision.value,
            generation: session.generation,
            epoch: session.epoch,
            state: session.state.name,
            restoreFrom: session.restoreFrom?.value ?? null,
            recordRevision: session.recordRevision.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): EnvironmentSession {
        const object = requireObject(payload, "Environment session");
        requireExact(
            object,
            [
                "environmentId",
                "environmentRevision",
                "epoch",
                "generation",
                "id",
                "recordRevision",
                "restoreFrom",
                "state"
            ],
            "Environment session"
        );
        const restoreFrom = requireOptionalString(object["restoreFrom"], "Environment snapshot ID");
        return new EnvironmentSession(
            new EnvironmentSessionId(requireString(object["id"], "Environment session ID")),
            new EnvironmentId(requireString(object["environmentId"], "Environment ID")),
            new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")),
            requireSafeInteger(object["generation"], "Environment generation"),
            requireSafeInteger(object["epoch"], "Environment session epoch"),
            decodeSessionState(requireString(object["state"], "Environment session state")),
            restoreFrom === undefined ? undefined : new EnvironmentSnapshotId(restoreFrom),
            new Revision(
                requireSafeInteger(object["recordRevision"], "Environment session record revision")
            )
        );
    }
}

export class EnvironmentSessionCapability {
    public constructor(
        public readonly environmentId: EnvironmentId,
        public readonly sessionId: EnvironmentSessionId,
        public readonly environmentRevision: Revision,
        public readonly epoch: number
    ) {
        requireInstance(environmentId, EnvironmentId, "Environment ID");
        requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
        requireInstance(environmentRevision, Revision, "Environment revision");
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError(
                "Environment session capability epoch must be a non-negative safe integer"
            );
        }
        Object.freeze(this);
    }
}

export class EnvironmentSession {
    public static readonly codec: RecordCodec<EnvironmentSession> = new EnvironmentSessionCodecV1();

    public constructor(
        public readonly id: EnvironmentSessionId,
        public readonly environmentId: EnvironmentId,
        public readonly environmentRevision: Revision,
        public readonly generation: number,
        public readonly epoch: number,
        public readonly state: EnvironmentSessionState,
        public readonly restoreFrom: EnvironmentSnapshotId | undefined,
        public readonly recordRevision: Revision
    ) {
        requireInstance(id, EnvironmentSessionId, "Environment session ID");
        requireInstance(environmentId, EnvironmentId, "Environment ID");
        requireInstance(environmentRevision, Revision, "Environment revision");
        requireInstance(state, EnvironmentSessionState, "Environment session state");
        if (restoreFrom !== undefined) {
            requireInstance(restoreFrom, EnvironmentSnapshotId, "Environment restore snapshot ID");
        }
        requireInstance(recordRevision, Revision, "Environment session record revision");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError(
                "Environment session generation must be a non-negative safe integer"
            );
        }
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Environment session epoch must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    public static encode(session: EnvironmentSession): Uint8Array {
        return EnvironmentSession.codec.encode(session);
    }

    public static decode(bytes: Uint8Array): EnvironmentSession {
        return EnvironmentSession.codec.decode(bytes);
    }

    public get capability(): EnvironmentSessionCapability {
        return new EnvironmentSessionCapability(
            this.environmentId,
            this.id,
            this.environmentRevision,
            this.epoch
        );
    }

    public beginOpen(): EnvironmentSession {
        return this.transition(this.state.beginOpen());
    }
    public opened(): EnvironmentSession {
        return this.transition(this.state.opened());
    }
    public failOpen(): EnvironmentSession {
        return this.transition(this.state.failOpen());
    }

    public lost(): EnvironmentSession {
        const state = this.state.lost();
        if (state === this.state) return this;
        return new EnvironmentSession(
            this.id,
            this.environmentId,
            this.environmentRevision,
            this.generation,
            increment(this.epoch, "Environment session epoch"),
            state,
            this.restoreFrom,
            advanceRevision(this.recordRevision, "Environment session record revision")
        );
    }

    public beginClose(): EnvironmentSession {
        const state = this.state.beginClose();
        if (state === this.state) return this;
        return new EnvironmentSession(
            this.id,
            this.environmentId,
            this.environmentRevision,
            this.generation,
            increment(this.epoch, "Environment session epoch"),
            state,
            this.restoreFrom,
            advanceRevision(this.recordRevision, "Environment session record revision")
        );
    }

    public closed(): EnvironmentSession {
        return this.transition(this.state.closed());
    }
    public assertUsable(): void {
        this.state.assertUsable();
    }

    private transition(state: EnvironmentSessionState): EnvironmentSession {
        if (state === this.state) return this;
        return new EnvironmentSession(
            this.id,
            this.environmentId,
            this.environmentRevision,
            this.generation,
            this.epoch,
            state,
            this.restoreFrom,
            advanceRevision(this.recordRevision, "Environment session record revision")
        );
    }
}

function decodeSessionState(value: string): EnvironmentSessionState {
    switch (value) {
        case "reserved":
            return EnvironmentSessionState.reserved;
        case "opening":
            return EnvironmentSessionState.opening;
        case "open":
            return EnvironmentSessionState.open;
        case "lost":
            return EnvironmentSessionState.lost;
        case "failed":
            return EnvironmentSessionState.failed;
        case "closing":
            return EnvironmentSessionState.closing;
        case "closed":
            return EnvironmentSessionState.closed;
        default:
            throw new TypeError("Environment session state is invalid");
    }
}

function freezeState<State>(state: State): State {
    Object.freeze(state);
    return state;
}
