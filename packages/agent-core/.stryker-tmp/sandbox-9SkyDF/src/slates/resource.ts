// @ts-nocheck
import { ContentRef, RecordCodec, type JsonValue } from "../core";
import { WorkspaceId } from "../identity";
import { InvocationId } from "../interaction-references";
import { ReceiptId } from "../invocation-references";
import {
    contentRef,
    deploymentId,
    requireExactObject,
    invocationId,
    receiptId,
    requireText,
    resourceId,
    slateId,
    requireStringValue,
    workspaceId
} from "./codec";
import { SlateDeploymentId, SlateId, SlateResourceId } from "./id";

class SlateResourceCodecV1 extends RecordCodec<SlateResource> {
    public constructor() {
        super("slate.resource", { major: 1, minor: 0 });
    }

    protected encodePayload(resource: SlateResource): JsonValue {
        return resource.toData();
    }

    protected decodePayload(payload: JsonValue): SlateResource {
        return SlateResource.fromData(payload);
    }
}

export class SlateResource {
    public static readonly codec: RecordCodec<SlateResource> = new SlateResourceCodecV1();
    public readonly name: string;

    public constructor(
        public readonly id: SlateResourceId,
        public readonly workspaceId: WorkspaceId,
        public readonly slateId: SlateId,
        public readonly deploymentId: SlateDeploymentId,
        name: string,
        public readonly source: ContentRef,
        public readonly materialization: ContentRef,
        public readonly invocationId: InvocationId,
        public readonly receiptId: ReceiptId
    ) {
        if (
            !(id instanceof SlateResourceId) ||
            !(workspaceId instanceof WorkspaceId) ||
            !(slateId instanceof SlateId) ||
            !(deploymentId instanceof SlateDeploymentId) ||
            !(source instanceof ContentRef) ||
            !(materialization instanceof ContentRef) ||
            !(invocationId instanceof InvocationId) ||
            !(receiptId instanceof ReceiptId)
        ) {
            throw new TypeError("Slate resource is malformed");
        }
        this.name = requireText(name, "Slate resource name", 256);
        Object.freeze(this);
    }

    public static encode(resource: SlateResource): Uint8Array {
        return SlateResource.codec.encode(resource);
    }

    public static decode(bytes: Uint8Array): SlateResource {
        return SlateResource.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            deploymentId: this.deploymentId.value,
            id: this.id.value,
            invocationId: this.invocationId.value,
            materialization: this.materialization.value,
            name: this.name,
            receiptId: this.receiptId.value,
            slateId: this.slateId.value,
            source: this.source.value,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlateResource {
        const object = requireExactObject(
            payload,
            [
                "deploymentId",
                "id",
                "invocationId",
                "materialization",
                "name",
                "receiptId",
                "slateId",
                "source",
                "workspaceId"
            ],
            "Slate resource payload"
        );
        return new SlateResource(
            resourceId(object["id"]),
            workspaceId(object["workspaceId"]),
            slateId(object["slateId"]),
            deploymentId(object["deploymentId"]),
            requireStringValue(object["name"], "Slate resource name"),
            contentRef(object["source"], "Slate resource source"),
            contentRef(object["materialization"], "Slate resource materialization"),
            invocationId(object["invocationId"]),
            receiptId(object["receiptId"])
        );
    }
}
