import { ContentRef, RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import {
    advanceRevision,
    requireExact,
    requireInstance,
    requireObject,
    requireOptionalString,
    requireSafeInteger,
    requireString
} from "./data";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId } from "./id";

export type EnvironmentSnapshotStateName = "creating" | "ready" | "failed";

export abstract class EnvironmentSnapshotState {
    public static get creating(): EnvironmentSnapshotState {
        return creatingSnapshotState;
    }
    public static get ready(): EnvironmentSnapshotState {
        return readySnapshotState;
    }
    public static get failed(): EnvironmentSnapshotState {
        return failedSnapshotState;
    }

    public abstract readonly name: EnvironmentSnapshotStateName;
    public ready(): EnvironmentSnapshotState {
        return this.invalid("complete");
    }
    public fail(): EnvironmentSnapshotState {
        return this.invalid("fail");
    }

    protected invalid(operation: string): never {
        throw new AgentCoreError(
            "environment.invalid-session",
            `Cannot ${operation} an Environment snapshot in ${this.name} state`
        );
    }
}

class CreatingSnapshotState extends EnvironmentSnapshotState {
    public readonly name = "creating";
    public override ready(): EnvironmentSnapshotState {
        return EnvironmentSnapshotState.ready;
    }
    public override fail(): EnvironmentSnapshotState {
        return EnvironmentSnapshotState.failed;
    }
}
class ReadySnapshotState extends EnvironmentSnapshotState {
    public readonly name = "ready";
    public override ready(): EnvironmentSnapshotState {
        return this;
    }
}
class FailedSnapshotState extends EnvironmentSnapshotState {
    public readonly name = "failed";
    public override fail(): EnvironmentSnapshotState {
        return this;
    }
}

const creatingSnapshotState = freezeState(new CreatingSnapshotState());
const readySnapshotState = freezeState(new ReadySnapshotState());
const failedSnapshotState = freezeState(new FailedSnapshotState());

class EnvironmentSnapshotCodecV1 extends RecordCodec<EnvironmentSnapshot> {
    public constructor() {
        super("environment.snapshot", { major: 1, minor: 0 });
    }

    protected encodePayload(snapshot: EnvironmentSnapshot): JsonValue {
        return {
            id: snapshot.id.value,
            environmentId: snapshot.environmentId.value,
            sessionId: snapshot.sessionId.value,
            environmentRevision: snapshot.environmentRevision.value,
            generation: snapshot.generation,
            sessionEpoch: snapshot.sessionEpoch,
            state: snapshot.state.name,
            content: snapshot.content?.value ?? null,
            recordRevision: snapshot.recordRevision.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): EnvironmentSnapshot {
        const object = requireObject(payload, "Environment snapshot");
        requireExact(
            object,
            [
                "content",
                "environmentId",
                "environmentRevision",
                "generation",
                "id",
                "recordRevision",
                "sessionEpoch",
                "sessionId",
                "state"
            ],
            "Environment snapshot"
        );
        const content = requireOptionalString(object["content"], "Environment snapshot content");
        return new EnvironmentSnapshot(
            new EnvironmentSnapshotId(requireString(object["id"], "Environment snapshot ID")),
            new EnvironmentId(requireString(object["environmentId"], "Environment ID")),
            new EnvironmentSessionId(requireString(object["sessionId"], "Environment session ID")),
            new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")),
            requireSafeInteger(object["generation"], "Environment generation"),
            requireSafeInteger(object["sessionEpoch"], "Environment session epoch"),
            decodeSnapshotState(requireString(object["state"], "Environment snapshot state")),
            content === undefined ? undefined : new ContentRef(content),
            new Revision(
                requireSafeInteger(object["recordRevision"], "Environment snapshot record revision")
            )
        );
    }
}

export class EnvironmentSnapshot {
    public static readonly codec: RecordCodec<EnvironmentSnapshot> =
        new EnvironmentSnapshotCodecV1();

    public constructor(
        public readonly id: EnvironmentSnapshotId,
        public readonly environmentId: EnvironmentId,
        public readonly sessionId: EnvironmentSessionId,
        public readonly environmentRevision: Revision,
        public readonly generation: number,
        public readonly sessionEpoch: number,
        public readonly state: EnvironmentSnapshotState,
        public readonly content: ContentRef | undefined,
        public readonly recordRevision: Revision
    ) {
        requireInstance(id, EnvironmentSnapshotId, "Environment snapshot ID");
        requireInstance(environmentId, EnvironmentId, "Environment ID");
        requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
        requireInstance(environmentRevision, Revision, "Environment revision");
        requireInstance(state, EnvironmentSnapshotState, "Environment snapshot state");
        if (content !== undefined) {
            requireInstance(content, ContentRef, "Environment snapshot content");
        }
        requireInstance(recordRevision, Revision, "Environment snapshot record revision");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError(
                "Environment snapshot generation must be a non-negative safe integer"
            );
        }
        if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) {
            throw new TypeError(
                "Environment snapshot session epoch must be a non-negative safe integer"
            );
        }
        if ((state.name === "ready") !== (content !== undefined)) {
            throw new TypeError("Only a ready Environment snapshot has content");
        }
        Object.freeze(this);
    }

    public static encode(snapshot: EnvironmentSnapshot): Uint8Array {
        return EnvironmentSnapshot.codec.encode(snapshot);
    }

    public static decode(bytes: Uint8Array): EnvironmentSnapshot {
        return EnvironmentSnapshot.codec.decode(bytes);
    }

    public ready(content: ContentRef): EnvironmentSnapshot {
        return this.transition(this.state.ready(), content);
    }

    public fail(): EnvironmentSnapshot {
        return this.transition(this.state.fail(), undefined);
    }

    private transition(
        state: EnvironmentSnapshotState,
        content: ContentRef | undefined
    ): EnvironmentSnapshot {
        if (state === this.state) return this;
        return new EnvironmentSnapshot(
            this.id,
            this.environmentId,
            this.sessionId,
            this.environmentRevision,
            this.generation,
            this.sessionEpoch,
            state,
            content,
            advanceRevision(this.recordRevision, "Environment snapshot record revision")
        );
    }
}

function decodeSnapshotState(value: string): EnvironmentSnapshotState {
    switch (value) {
        case "creating":
            return EnvironmentSnapshotState.creating;
        case "ready":
            return EnvironmentSnapshotState.ready;
        case "failed":
            return EnvironmentSnapshotState.failed;
        default:
            throw new TypeError("Environment snapshot state is invalid");
    }
}

function freezeState<State>(state: State): State {
    Object.freeze(state);
    return state;
}
