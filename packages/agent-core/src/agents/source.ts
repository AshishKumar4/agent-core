import { ContentRef, Digest, RecordCodec, Revision, type JsonValue } from "../core";
import {
    digestFromData,
    CodecRecord,
    requireExactFields,
    requireObject,
    requireString,
    revisionData,
    revisionFromData
} from "./record-data";
import { AgentId, AgentPolicyId, AgentProfileId, ModelPolicyId } from "./id";
import { EnvironmentId } from "../environments";

interface RevisionRecordFields<Id> {
    readonly id: Id;
    readonly revision: Revision;
    readonly content: ContentRef;
    readonly digest: Digest;
}

abstract class RevisionRecord<Id> extends CodecRecord {
    public readonly id: Id;
    public readonly revision: Revision;
    public readonly content: ContentRef;
    public readonly digest: Digest;

    protected constructor(fields: RevisionRecordFields<Id>) {
        super();
        this.id = fields.id;
        this.revision = fields.revision;
        this.content = fields.content;
        this.digest = fields.digest;
    }

    protected baseData(id: string): JsonValue {
        return {
            content: this.content.value,
            digest: this.digest.value,
            id,
            revision: revisionData(this.revision)
        };
    }
}

export interface AgentRevisionRecordInit extends RevisionRecordFields<AgentId> {
    readonly profile: AgentProfileId;
    readonly policy: AgentPolicyId;
    readonly model: ModelPolicyId;
    readonly environment: EnvironmentId;
}

export class AgentRevisionRecord extends RevisionRecord<AgentId> {
    public static get codec(): RecordCodec<AgentRevisionRecord> {
        return AgentRevisionRecordCodec;
    }
    public readonly profile: AgentProfileId;
    public readonly policy: AgentPolicyId;
    public readonly model: ModelPolicyId;
    public readonly environment: EnvironmentId;

    public constructor(init: AgentRevisionRecordInit) {
        super(init);
        this.profile = init.profile;
        this.policy = init.policy;
        this.model = init.model;
        this.environment = init.environment;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            ...(this.baseData(this.id.value) as object),
            environment: this.environment.value,
            model: this.model.value,
            policy: this.policy.value,
            profile: this.profile.value
        } as JsonValue;
    }

    public static fromData(value: JsonValue): AgentRevisionRecord {
        const object = requireObject(value, "Agent revision");
        requireExactFields(
            object,
            ["content", "digest", "environment", "id", "model", "policy", "profile", "revision"],
            [],
            "Agent revision"
        );
        return new AgentRevisionRecord({
            id: new AgentId(requireString(object["id"], "Agent revision ID")),
            revision: revisionFromData(object["revision"], "Agent revision"),
            content: new ContentRef(requireString(object["content"], "Agent revision content")),
            digest: digestFromData(object["digest"], "Agent revision digest"),
            profile: new AgentProfileId(requireString(object["profile"], "Agent profile")),
            policy: new AgentPolicyId(requireString(object["policy"], "Agent policy")),
            model: new ModelPolicyId(requireString(object["model"], "Model policy")),
            environment: new EnvironmentId(
                requireString(object["environment"], "Environment source")
            )
        });
    }
}

export class AgentPolicyRevisionRecord extends RevisionRecord<AgentPolicyId> {
    public static get codec(): RecordCodec<AgentPolicyRevisionRecord> {
        return AgentPolicyRevisionRecordCodec;
    }
    public constructor(init: RevisionRecordFields<AgentPolicyId>) {
        super(init);
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return this.baseData(this.id.value);
    }

    public static fromData(value: JsonValue): AgentPolicyRevisionRecord {
        return new AgentPolicyRevisionRecord(policyFields(value));
    }
}

export class ModelPolicyRevisionRecord extends RevisionRecord<ModelPolicyId> {
    public static get codec(): RecordCodec<ModelPolicyRevisionRecord> {
        return ModelPolicyRevisionRecordCodec;
    }
    public constructor(init: RevisionRecordFields<ModelPolicyId>) {
        super(init);
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return this.baseData(this.id.value);
    }

    public static fromData(value: JsonValue): ModelPolicyRevisionRecord {
        const fields = sourceFields(value, "Model policy revision");
        return new ModelPolicyRevisionRecord({ ...fields, id: new ModelPolicyId(fields.id) });
    }
}

class SourceCodec<Value extends { toData(): JsonValue }> extends RecordCodec<Value> {
    public constructor(
        kind: string,
        private readonly decodeValue: (value: JsonValue) => Value
    ) {
        super(kind, { major: 1, minor: 0 });
    }

    protected encodePayload(value: Value): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): Value {
        return this.decodeValue(value);
    }
}

export const AgentRevisionRecordCodec: RecordCodec<AgentRevisionRecord> = new SourceCodec(
    "agent.revision",
    AgentRevisionRecord.fromData
);
export const AgentPolicyRevisionRecordCodec: RecordCodec<AgentPolicyRevisionRecord> =
    new SourceCodec("agent.policy-revision", AgentPolicyRevisionRecord.fromData);
export const ModelPolicyRevisionRecordCodec: RecordCodec<ModelPolicyRevisionRecord> =
    new SourceCodec("agent.model-revision", ModelPolicyRevisionRecord.fromData);
export abstract class RunSourceRevisionPort<Transaction, Snapshot> {
    public abstract verify(transaction: Transaction, snapshot: Snapshot): boolean;
    public abstract verifyPackageClosure(transaction: Transaction, snapshot: Snapshot): boolean;
}

function sourceFields(value: JsonValue, subject: string): RevisionRecordFields<string> {
    const object = requireObject(value, subject);
    requireExactFields(object, ["content", "digest", "id", "revision"], [], subject);
    return {
        id: requireString(object["id"], `${subject} ID`),
        revision: revisionFromData(object["revision"], subject),
        content: new ContentRef(requireString(object["content"], `${subject} content`)),
        digest: digestFromData(object["digest"], `${subject} digest`)
    };
}

function policyFields(value: JsonValue): RevisionRecordFields<AgentPolicyId> {
    const fields = sourceFields(value, "Agent policy revision");
    return { ...fields, id: new AgentPolicyId(fields.id) };
}
