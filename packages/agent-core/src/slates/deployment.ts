import { ContentRef, RecordCodec, type JsonValue } from "../core";
import { WorkspaceId } from "../identity";
import { InvocationId } from "../interaction-references";
import { ReceiptId } from "../invocation-references";
import {
    contentRef,
    deploymentId,
    requireExactObject,
    invocationId,
    publicationId,
    receiptId,
    requireText,
    slateId,
    workspaceId
} from "./codec";
import { SlateDeploymentId, SlateId, SlatePublicationId } from "./id";

class SlateDeploymentCodecV1 extends RecordCodec<SlateDeployment> {
    public constructor() {
        super("slate.deployment", { major: 1, minor: 0 });
    }

    protected encodePayload(deployment: SlateDeployment): JsonValue {
        return deployment.toData();
    }

    protected decodePayload(payload: JsonValue): SlateDeployment {
        return SlateDeployment.fromData(payload);
    }
}

export class SlateDeployment {
    public static readonly codec: RecordCodec<SlateDeployment> = new SlateDeploymentCodecV1();
    public readonly target: string;

    public constructor(
        public readonly id: SlateDeploymentId,
        public readonly workspaceId: WorkspaceId,
        public readonly slateId: SlateId,
        public readonly publicationId: SlatePublicationId,
        target: string,
        public readonly materialization: ContentRef,
        public readonly invocationId: InvocationId,
        public readonly receiptId: ReceiptId
    ) {
        if (
            !(id instanceof SlateDeploymentId) ||
            !(workspaceId instanceof WorkspaceId) ||
            !(slateId instanceof SlateId) ||
            !(publicationId instanceof SlatePublicationId) ||
            !(materialization instanceof ContentRef) ||
            !(invocationId instanceof InvocationId) ||
            !(receiptId instanceof ReceiptId)
        ) {
            throw new TypeError("Slate deployment is malformed");
        }
        this.target = requireText(target, "Slate deployment target");
        Object.freeze(this);
    }

    public static encode(deployment: SlateDeployment): Uint8Array {
        return SlateDeployment.codec.encode(deployment);
    }

    public static decode(bytes: Uint8Array): SlateDeployment {
        return SlateDeployment.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            id: this.id.value,
            invocationId: this.invocationId.value,
            materialization: this.materialization.value,
            publicationId: this.publicationId.value,
            receiptId: this.receiptId.value,
            slateId: this.slateId.value,
            target: this.target,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlateDeployment {
        const object = requireExactObject(
            payload,
            [
                "id",
                "invocationId",
                "materialization",
                "publicationId",
                "receiptId",
                "slateId",
                "target",
                "workspaceId"
            ],
            "Slate deployment payload"
        );
        return new SlateDeployment(
            deploymentId(object["id"]),
            workspaceId(object["workspaceId"]),
            slateId(object["slateId"]),
            publicationId(object["publicationId"]),
            requireTextValue(object["target"]),
            contentRef(object["materialization"], "Slate deployment materialization"),
            invocationId(object["invocationId"]),
            receiptId(object["receiptId"])
        );
    }
}

function requireTextValue(value: JsonValue | undefined): string {
    if (typeof value !== "string") throw new TypeError("Slate deployment target must be a string");
    return value;
}
