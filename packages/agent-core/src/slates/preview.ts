import { ContentRef, RecordCodec, Revision, type JsonValue } from "../core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../environments";
import { WorkspaceId } from "../identity";
import {
    contentRef,
    environmentId,
    requireExactObject,
    exposureId,
    requireIntegerValue,
    nullableString,
    previewId,
    sessionId,
    slateId,
    versionId,
    workspaceId
} from "./codec";
import { SlateId, SlatePreviewId, SlateVersionId } from "./id";

class SlatePreviewCodecV1 extends RecordCodec<SlatePreview> {
    public constructor() {
        super("slate.preview", { major: 1, minor: 0 });
    }

    protected encodePayload(preview: SlatePreview): JsonValue {
        return preview.toData();
    }

    protected decodePayload(payload: JsonValue): SlatePreview {
        return SlatePreview.fromData(payload);
    }
}

export class SlatePreview {
    public static readonly codec: RecordCodec<SlatePreview> = new SlatePreviewCodecV1();

    public constructor(
        public readonly id: SlatePreviewId,
        public readonly workspaceId: WorkspaceId,
        public readonly slateId: SlateId,
        capability: EnvironmentSessionCapability,
        public readonly exposureId: PortExposureId,
        public readonly source: ContentRef,
        public readonly versionId?: SlateVersionId
    ) {
        if (
            !(id instanceof SlatePreviewId) ||
            !(workspaceId instanceof WorkspaceId) ||
            !(slateId instanceof SlateId) ||
            !(capability instanceof EnvironmentSessionCapability) ||
            !(capability.environmentId instanceof EnvironmentId) ||
            !(capability.sessionId instanceof EnvironmentSessionId) ||
            !(capability.environmentRevision instanceof Revision) ||
            !(exposureId instanceof PortExposureId) ||
            !(source instanceof ContentRef) ||
            (versionId !== undefined && !(versionId instanceof SlateVersionId))
        ) {
            throw new TypeError("Slate preview is malformed");
        }
        this.environmentId = capability.environmentId;
        this.sessionId = capability.sessionId;
        this.environmentRevision = new Revision(capability.environmentRevision.value);
        this.sessionEpoch = capability.epoch;
        Object.freeze(this);
    }

    public readonly environmentId: EnvironmentId;
    public readonly sessionId: EnvironmentSessionId;
    public readonly environmentRevision: Revision;
    public readonly sessionEpoch: number;

    public get capability(): EnvironmentSessionCapability {
        return new EnvironmentSessionCapability(
            this.environmentId,
            this.sessionId,
            this.environmentRevision,
            this.sessionEpoch
        );
    }

    public static encode(preview: SlatePreview): Uint8Array {
        return SlatePreview.codec.encode(preview);
    }

    public static decode(bytes: Uint8Array): SlatePreview {
        return SlatePreview.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            environmentId: this.environmentId.value,
            environmentRevision: this.environmentRevision.value,
            exposureId: this.exposureId.value,
            id: this.id.value,
            sessionEpoch: this.sessionEpoch,
            sessionId: this.sessionId.value,
            slateId: this.slateId.value,
            source: this.source.value,
            versionId: this.versionId?.value ?? null,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlatePreview {
        const object = requireExactObject(
            payload,
            [
                "environmentId",
                "environmentRevision",
                "exposureId",
                "id",
                "sessionEpoch",
                "sessionId",
                "slateId",
                "source",
                "versionId",
                "workspaceId"
            ],
            "Slate preview payload"
        );
        const version = nullableString(object["versionId"], "Slate preview version ID");
        return new SlatePreview(
            previewId(object["id"]),
            workspaceId(object["workspaceId"]),
            slateId(object["slateId"]),
            new EnvironmentSessionCapability(
                environmentId(object["environmentId"]),
                sessionId(object["sessionId"]),
                new Revision(
                    requireIntegerValue(
                        object["environmentRevision"],
                        "Slate preview environment revision"
                    )
                ),
                requireIntegerValue(object["sessionEpoch"], "Slate preview session epoch")
            ),
            exposureId(object["exposureId"]),
            contentRef(object["source"], "Slate preview source"),
            version === undefined ? undefined : versionId(version)
        );
    }
}
