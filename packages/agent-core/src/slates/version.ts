import { ContentRef, RecordCodec, type JsonValue } from "../core";
import { WorkspaceId } from "../identity";
import {
    contentRef,
    requireExactObject,
    nullableString,
    slateId,
    versionId,
    workspaceId
} from "./codec";
import { SlateId, SlateVersionId } from "./id";

export interface SlateVersionInit {
    readonly id: SlateVersionId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly source: ContentRef;
    readonly parentVersionId?: SlateVersionId;
}

class SlateVersionCodecV1 extends RecordCodec<SlateVersion> {
    public constructor() {
        super("slate.version", { major: 1, minor: 0 });
    }

    protected encodePayload(version: SlateVersion): JsonValue {
        return version.toData();
    }

    protected decodePayload(payload: JsonValue): SlateVersion {
        return SlateVersion.fromData(payload);
    }
}

export class SlateVersion {
    public static readonly codec: RecordCodec<SlateVersion> = new SlateVersionCodecV1();

    public constructor(
        public readonly id: SlateVersionId,
        public readonly workspaceId: WorkspaceId,
        public readonly slateId: SlateId,
        public readonly source: ContentRef,
        public readonly parentVersionId?: SlateVersionId
    ) {
        if (
            !(id instanceof SlateVersionId) ||
            !(workspaceId instanceof WorkspaceId) ||
            !(slateId instanceof SlateId) ||
            !(source instanceof ContentRef) ||
            (parentVersionId !== undefined && !(parentVersionId instanceof SlateVersionId))
        ) {
            throw new TypeError("Slate version is malformed");
        }
        if (parentVersionId?.equals(id) === true) {
            throw new TypeError("Slate version cannot be its own parent");
        }
        Object.freeze(this);
    }

    public static encode(version: SlateVersion): Uint8Array {
        return SlateVersion.codec.encode(version);
    }

    public static decode(bytes: Uint8Array): SlateVersion {
        return SlateVersion.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            id: this.id.value,
            parentVersionId: this.parentVersionId?.value ?? null,
            slateId: this.slateId.value,
            source: this.source.value,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlateVersion {
        const object = requireExactObject(
            payload,
            ["id", "parentVersionId", "slateId", "source", "workspaceId"],
            "Slate version payload"
        );
        const parent = nullableString(object["parentVersionId"], "Slate parent version ID");
        return new SlateVersion(
            versionId(object["id"]),
            workspaceId(object["workspaceId"]),
            slateId(object["slateId"]),
            contentRef(object["source"], "Slate version source"),
            parent === undefined ? undefined : versionId(parent)
        );
    }
}
