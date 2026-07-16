// @ts-nocheck
import { RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
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
import { EnvironmentId, EnvironmentSessionId, PortExposureId } from "./id";

const MAX_PORT = 65_535;

export type PortExposureStateName = "exposing" | "exposed" | "failed" | "revoking" | "revoked";

export abstract class PortExposureState {
    public static get exposing(): PortExposureState {
        return exposingPortState;
    }
    public static get exposed(): PortExposureState {
        return exposedPortState;
    }
    public static get failed(): PortExposureState {
        return failedPortState;
    }
    public static get revoking(): PortExposureState {
        return revokingPortState;
    }
    public static get revoked(): PortExposureState {
        return revokedPortState;
    }

    public abstract readonly name: PortExposureStateName;
    public exposed(): PortExposureState {
        return this.invalid("complete exposure");
    }
    public fail(): PortExposureState {
        return this.invalid("fail exposure");
    }
    public beginRevoke(): PortExposureState {
        return this.invalid("revoke");
    }
    public revoked(): PortExposureState {
        return this.invalid("complete revocation");
    }

    protected invalid(operation: string): never {
        throw new AgentCoreError(
            "environment.invalid-session",
            `Cannot ${operation} in ${this.name} port exposure state`
        );
    }
}

class ExposingPortState extends PortExposureState {
    public readonly name = "exposing";
    public override exposed(): PortExposureState {
        return PortExposureState.exposed;
    }
    public override fail(): PortExposureState {
        return PortExposureState.failed;
    }
    public override beginRevoke(): PortExposureState {
        return PortExposureState.revoking;
    }
}
class ExposedPortState extends PortExposureState {
    public readonly name = "exposed";
    public override exposed(): PortExposureState {
        return this;
    }
    public override beginRevoke(): PortExposureState {
        return PortExposureState.revoking;
    }
}
class FailedPortState extends PortExposureState {
    public readonly name = "failed";
    public override fail(): PortExposureState {
        return this;
    }
    public override beginRevoke(): PortExposureState {
        return PortExposureState.revoking;
    }
}
class RevokingPortState extends PortExposureState {
    public readonly name = "revoking";
    public override beginRevoke(): PortExposureState {
        return this;
    }
    public override revoked(): PortExposureState {
        return PortExposureState.revoked;
    }
}
class RevokedPortState extends PortExposureState {
    public readonly name = "revoked";
    public override beginRevoke(): PortExposureState {
        return this;
    }
    public override revoked(): PortExposureState {
        return this;
    }
}

const exposingPortState = freezeState(new ExposingPortState());
const exposedPortState = freezeState(new ExposedPortState());
const failedPortState = freezeState(new FailedPortState());
const revokingPortState = freezeState(new RevokingPortState());
const revokedPortState = freezeState(new RevokedPortState());

class PortExposureCodecV1 extends RecordCodec<PortExposure> {
    public constructor() {
        super("environment.port-exposure", { major: 1, minor: 0 });
    }

    protected encodePayload(exposure: PortExposure): JsonValue {
        return {
            id: exposure.id.value,
            environmentId: exposure.environmentId.value,
            sessionId: exposure.sessionId.value,
            environmentRevision: exposure.environmentRevision.value,
            generation: exposure.generation,
            sessionEpoch: exposure.sessionEpoch,
            port: exposure.port,
            state: exposure.state.name,
            url: exposure.url ?? null,
            recordRevision: exposure.recordRevision.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): PortExposure {
        const object = requireObject(payload, "Port exposure");
        requireExact(
            object,
            [
                "environmentId",
                "environmentRevision",
                "generation",
                "id",
                "port",
                "recordRevision",
                "sessionEpoch",
                "sessionId",
                "state",
                "url"
            ],
            "Port exposure"
        );
        return new PortExposure(
            new PortExposureId(requireString(object["id"], "Port exposure ID")),
            new EnvironmentId(requireString(object["environmentId"], "Environment ID")),
            new EnvironmentSessionId(requireString(object["sessionId"], "Environment session ID")),
            new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")),
            requireSafeInteger(object["generation"], "Environment generation"),
            requireSafeInteger(object["sessionEpoch"], "Environment session epoch"),
            requireSafeInteger(object["port"], "Port exposure port"),
            decodePortState(requireString(object["state"], "Port exposure state")),
            requireOptionalString(object["url"], "Port exposure URL"),
            new Revision(
                requireSafeInteger(object["recordRevision"], "Port exposure record revision")
            )
        );
    }
}

export class PortExposure {
    public static readonly codec: RecordCodec<PortExposure> = new PortExposureCodecV1();

    public constructor(
        public readonly id: PortExposureId,
        public readonly environmentId: EnvironmentId,
        public readonly sessionId: EnvironmentSessionId,
        public readonly environmentRevision: Revision,
        public readonly generation: number,
        public readonly sessionEpoch: number,
        public readonly port: number,
        public readonly state: PortExposureState,
        public readonly url: string | undefined,
        public readonly recordRevision: Revision
    ) {
        requireInstance(id, PortExposureId, "Port exposure ID");
        requireInstance(environmentId, EnvironmentId, "Environment ID");
        requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
        requireInstance(environmentRevision, Revision, "Environment revision");
        requireInstance(state, PortExposureState, "Port exposure state");
        requireInstance(recordRevision, Revision, "Port exposure record revision");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("Port exposure generation must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) {
            throw new TypeError("Port exposure session epoch must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) {
            throw new TypeError("Port exposure port must be between 1 and 65535");
        }
        if (url !== undefined && typeof url !== "string") {
            throw new TypeError("Port exposure URL must be a string");
        }
        if (
            (state.name === "exposed" && url === undefined) ||
            (state.name !== "exposed" && state.name !== "revoking" && url !== undefined)
        ) {
            throw new TypeError("Only exposed or revoking ports may have a URL");
        }
        if (url !== undefined) validatePublicUrl(url);
        Object.freeze(this);
    }

    public static encode(exposure: PortExposure): Uint8Array {
        return PortExposure.codec.encode(exposure);
    }

    public static decode(bytes: Uint8Array): PortExposure {
        return PortExposure.codec.decode(bytes);
    }

    public exposed(url: string): PortExposure {
        const state = this.state.exposed();
        if (state === this.state) return this;
        try {
            validatePublicUrl(url);
        } catch (error) {
            if (error instanceof TypeError) {
                throw new AgentCoreError("operation.invalid-output", error.message);
            }
            throw error;
        }
        return this.transition(state, url);
    }
    public fail(): PortExposure {
        return this.transition(this.state.fail(), undefined);
    }
    public beginRevoke(): PortExposure {
        return this.transition(this.state.beginRevoke(), this.url);
    }
    public revoked(): PortExposure {
        return this.transition(this.state.revoked(), undefined);
    }

    private transition(state: PortExposureState, url: string | undefined): PortExposure {
        if (state === this.state) return this;
        return new PortExposure(
            this.id,
            this.environmentId,
            this.sessionId,
            this.environmentRevision,
            this.generation,
            this.sessionEpoch,
            this.port,
            state,
            url,
            advanceRevision(this.recordRevision, "Port exposure record revision")
        );
    }
}

function decodePortState(value: string): PortExposureState {
    switch (value) {
        case "exposing":
            return PortExposureState.exposing;
        case "exposed":
            return PortExposureState.exposed;
        case "failed":
            return PortExposureState.failed;
        case "revoking":
            return PortExposureState.revoking;
        case "revoked":
            return PortExposureState.revoked;
        default:
            throw new TypeError("Port exposure state is invalid");
    }
}

function validatePublicUrl(value: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError("Port exposure URL must be absolute");
    }
    if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
    ) {
        throw new TypeError("Port exposure URL must not contain credentials or bearer material");
    }
}

function freezeState<State>(state: State): State {
    Object.freeze(state);
    return state;
}
