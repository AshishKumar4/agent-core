import { ContentRef, RecordCodec, type JsonValue } from "../core";
import { WorkspaceId } from "../identity";
import {
    contentRef,
    requireExactObject,
    publicationId,
    slateId,
    versionId,
    workspaceId
} from "./codec";
import { SlateId, SlatePublicationId, SlateVersionId } from "./id";

class SlatePublicationCodecV1 extends RecordCodec<SlatePublication> {
    public constructor() {
        super("slate.publication", { major: 1, minor: 0 });
    }

    protected encodePayload(publication: SlatePublication): JsonValue {
        return publication.toData();
    }

    protected decodePayload(payload: JsonValue): SlatePublication {
        return SlatePublication.fromData(payload);
    }
}

export class SlatePublication {
    public static readonly codec: RecordCodec<SlatePublication> = new SlatePublicationCodecV1();

    public constructor(
        public readonly id: SlatePublicationId,
        public readonly workspaceId: WorkspaceId,
        public readonly slateId: SlateId,
        public readonly versionId: SlateVersionId,
        public readonly materialization: ContentRef
    ) {
        if (
            !(id instanceof SlatePublicationId) ||
            !(workspaceId instanceof WorkspaceId) ||
            !(slateId instanceof SlateId) ||
            !(versionId instanceof SlateVersionId) ||
            !(materialization instanceof ContentRef)
        ) {
            throw new TypeError("Slate publication is malformed");
        }
        Object.freeze(this);
    }

    public static encode(publication: SlatePublication): Uint8Array {
        return SlatePublication.codec.encode(publication);
    }

    public static decode(bytes: Uint8Array): SlatePublication {
        return SlatePublication.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            id: this.id.value,
            materialization: this.materialization.value,
            slateId: this.slateId.value,
            versionId: this.versionId.value,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlatePublication {
        const object = requireExactObject(
            payload,
            ["id", "materialization", "slateId", "versionId", "workspaceId"],
            "Slate publication payload"
        );
        return new SlatePublication(
            publicationId(object["id"]),
            workspaceId(object["workspaceId"]),
            slateId(object["slateId"]),
            versionId(object["versionId"]),
            contentRef(object["materialization"], "Slate publication materialization")
        );
    }
}
