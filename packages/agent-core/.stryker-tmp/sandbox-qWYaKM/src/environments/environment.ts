// @ts-nocheck
import { ContentRef, RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import {
    advanceRevision,
    increment,
    requireExact,
    requireInstance,
    requireObject,
    requireSafeInteger,
    requireString
} from "./data";
import { EnvironmentId, ProviderId } from "./id";
import { ProviderDescriptor } from "./provider";

class EnvironmentCodecV1 extends RecordCodec<Environment> {
    public constructor() {
        super("environment.head", { major: 1, minor: 0 });
    }

    protected encodePayload(environment: Environment): JsonValue {
        return {
            id: environment.id.value,
            activeRevision: environment.activeRevision.value,
            generation: environment.generation,
            recordRevision: environment.recordRevision.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Environment {
        const object = requireObject(payload, "Environment head");
        requireExact(
            object,
            ["activeRevision", "generation", "id", "recordRevision"],
            "Environment head"
        );
        return new Environment(
            new EnvironmentId(requireString(object["id"], "Environment ID")),
            new Revision(
                requireSafeInteger(object["activeRevision"], "Environment active revision")
            ),
            requireSafeInteger(object["generation"], "Environment generation"),
            new Revision(
                requireSafeInteger(object["recordRevision"], "Environment record revision")
            )
        );
    }
}

class EnvironmentRevisionCodecV1 extends RecordCodec<EnvironmentRevisionRecord> {
    public constructor() {
        super("environment.revision", { major: 1, minor: 0 });
    }

    protected encodePayload(record: EnvironmentRevisionRecord): JsonValue {
        return {
            environmentId: record.environmentId.value,
            revision: record.revision.value,
            generation: record.generation,
            provider: {
                id: record.provider.id.value,
                version: record.provider.version,
                configuration: record.provider.configuration.value
            }
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): EnvironmentRevisionRecord {
        const object = requireObject(payload, "Environment revision");
        requireExact(
            object,
            ["environmentId", "generation", "provider", "revision"],
            "Environment revision"
        );
        const provider = requireObject(object["provider"]!, "Environment provider");
        requireExact(provider, ["configuration", "id", "version"], "Environment provider");
        return new EnvironmentRevisionRecord(
            new EnvironmentId(requireString(object["environmentId"], "Environment ID")),
            new Revision(requireSafeInteger(object["revision"], "Environment revision")),
            requireSafeInteger(object["generation"], "Environment generation"),
            new ProviderDescriptor(
                new ProviderId(requireString(provider["id"], "Provider ID")),
                requireString(provider["version"], "Provider version"),
                new ContentRef(requireString(provider["configuration"], "Provider configuration"))
            )
        );
    }
}

export class Environment {
    public static readonly codec: RecordCodec<Environment> = new EnvironmentCodecV1();

    public constructor(
        public readonly id: EnvironmentId,
        public readonly activeRevision: Revision,
        public readonly generation: number,
        public readonly recordRevision: Revision
    ) {
        requireInstance(id, EnvironmentId, "Environment ID");
        requireInstance(activeRevision, Revision, "Environment active revision");
        requireInstance(recordRevision, Revision, "Environment record revision");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("Environment generation must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    public static encode(environment: Environment): Uint8Array {
        return Environment.codec.encode(environment);
    }

    public static decode(bytes: Uint8Array): Environment {
        return Environment.codec.decode(bytes);
    }

    public rotate(revision: EnvironmentRevisionRecord): Environment {
        const nextRevision = advanceRevision(this.activeRevision, "Environment revision");
        const nextGeneration = increment(this.generation, "Environment generation");
        if (
            !revision.environmentId.equals(this.id) ||
            !revision.revision.equals(nextRevision) ||
            revision.generation !== nextGeneration
        ) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Environment rotation must advance the exact revision and generation"
            );
        }
        return new Environment(
            this.id,
            revision.revision,
            revision.generation,
            advanceRevision(this.recordRevision, "Environment record revision")
        );
    }
}

export class EnvironmentRevisionRecord {
    public static readonly codec: RecordCodec<EnvironmentRevisionRecord> =
        new EnvironmentRevisionCodecV1();

    public constructor(
        public readonly environmentId: EnvironmentId,
        public readonly revision: Revision,
        public readonly generation: number,
        public readonly provider: ProviderDescriptor
    ) {
        requireInstance(environmentId, EnvironmentId, "Environment ID");
        requireInstance(revision, Revision, "Environment revision");
        requireInstance(provider, ProviderDescriptor, "Environment provider");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("Environment generation must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    public static encode(record: EnvironmentRevisionRecord): Uint8Array {
        return EnvironmentRevisionRecord.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): EnvironmentRevisionRecord {
        return EnvironmentRevisionRecord.codec.decode(bytes);
    }
}
