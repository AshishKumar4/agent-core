import { ContentRef, Digest, RecordCodec, Revision, type JsonValue, TextId } from "../core";
import { AgentCoreError } from "../errors";
import { WorkspaceId } from "../identity";
import {
    contentRef,
    deploymentId,
    requireExactObject,
    nullableString,
    publicationId,
    revision,
    slateId,
    versionId,
    workspaceId
} from "./codec";
import { SlateDeploymentId, SlateId, SlatePublicationId, SlateVersionId } from "./id";

export interface SlateForkRef {
    readonly slateId: SlateId;
    readonly versionId: SlateVersionId;
}

export interface SlateInit {
    readonly id: SlateId;
    readonly workspaceId: WorkspaceId;
    readonly source: ContentRef;
    readonly headVersionId?: SlateVersionId;
    readonly latestPublicationId?: SlatePublicationId;
    readonly activeDeploymentId?: SlateDeploymentId;
    readonly forkedFrom?: SlateForkRef;
    readonly revision: Revision;
}

class SlateCodecV1 extends RecordCodec<Slate> {
    public constructor() {
        super(
            [
                Slate,
                Revision,
                TextId,
                ContentRef,
                Digest,
                SlateVersionId,
                SlateId,
                WorkspaceId,
                SlatePublicationId,
                SlateDeploymentId
            ],
            "slate",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(slate: Slate): JsonValue {
        return slate.toData();
    }

    protected decodePayload(payload: JsonValue): Slate {
        return Slate.fromData(payload);
    }
}

export class Slate {
    public static get codec(): RecordCodec<Slate> {
        return slateCodecInstance;
    }
    public readonly id: SlateId;
    public readonly workspaceId: WorkspaceId;
    public readonly source: ContentRef;
    public readonly headVersionId: SlateVersionId | undefined;
    public readonly latestPublicationId: SlatePublicationId | undefined;
    public readonly activeDeploymentId: SlateDeploymentId | undefined;
    public readonly forkedFrom: SlateForkRef | undefined;
    public readonly revision: Revision;

    public constructor(init: SlateInit) {
        if (
            !(init.id instanceof SlateId) ||
            !(init.workspaceId instanceof WorkspaceId) ||
            !(init.source instanceof ContentRef) ||
            !(init.revision instanceof Revision)
        ) {
            throw new TypeError("Slate identity, ownership, source, and revision are required");
        }
        if (init.headVersionId !== undefined && !(init.headVersionId instanceof SlateVersionId)) {
            throw new TypeError("Slate head version ID is invalid");
        }
        if (
            init.activeDeploymentId !== undefined &&
            !(init.activeDeploymentId instanceof SlateDeploymentId)
        ) {
            throw new TypeError("Slate active deployment ID is invalid");
        }
        if (
            init.latestPublicationId !== undefined &&
            !(init.latestPublicationId instanceof SlatePublicationId)
        ) {
            throw new TypeError("Slate latest publication ID is invalid");
        }
        if (
            init.forkedFrom !== undefined &&
            (!(init.forkedFrom.slateId instanceof SlateId) ||
                !(init.forkedFrom.versionId instanceof SlateVersionId) ||
                init.forkedFrom.slateId.equals(init.id))
        ) {
            throw new TypeError("Slate fork reference is invalid");
        }
        this.id = init.id;
        this.workspaceId = init.workspaceId;
        this.source = init.source;
        this.headVersionId = init.headVersionId;
        this.latestPublicationId = init.latestPublicationId;
        this.activeDeploymentId = init.activeDeploymentId;
        this.forkedFrom =
            init.forkedFrom === undefined
                ? undefined
                : Object.freeze({
                      slateId: init.forkedFrom.slateId,
                      versionId: init.forkedFrom.versionId
                  });
        this.revision = new Revision(init.revision.value);
        Object.freeze(this);
    }

    public static initial(id: SlateId, workspaceId_: WorkspaceId, source: ContentRef): Slate {
        return new Slate({ id, workspaceId: workspaceId_, source, revision: Revision.initial() });
    }

    public update(source: ContentRef): Slate {
        if (this.source.equals(source)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Slate update must change its source"
            );
        }
        return this.revise({ source });
    }

    public commit(version: SlateVersionId): Slate {
        if (this.headVersionId?.equals(version) === true) {
            throw new AgentCoreError(
                "protocol.duplicate",
                "Slate version is already the current head"
            );
        }
        return this.revise({ headVersionId: version });
    }

    public publish(publication: SlatePublicationId): Slate {
        if (this.latestPublicationId?.equals(publication) === true) {
            throw new AgentCoreError("protocol.duplicate", "Slate publication is already current");
        }
        return this.revise({ latestPublicationId: publication });
    }

    public selectDeployment(deployment: SlateDeploymentId | undefined): Slate {
        if (deployment === undefined && this.activeDeploymentId === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Slate has no active deployment to clear"
            );
        }
        if (deployment !== undefined && this.activeDeploymentId?.equals(deployment) === true) {
            throw new AgentCoreError("protocol.duplicate", "Slate deployment is already active");
        }
        return this.revise({ activeDeploymentId: deployment });
    }

    public static encode(slate: Slate): Uint8Array {
        return Slate.codec.encode(slate);
    }

    public static decode(bytes: Uint8Array): Slate {
        return Slate.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            activeDeploymentId: this.activeDeploymentId?.value ?? null,
            forkedFrom:
                this.forkedFrom === undefined
                    ? null
                    : {
                          slateId: this.forkedFrom.slateId.value,
                          versionId: this.forkedFrom.versionId.value
                      },
            headVersionId: this.headVersionId?.value ?? null,
            id: this.id.value,
            latestPublicationId: this.latestPublicationId?.value ?? null,
            revision: this.revision.value,
            source: this.source.value,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): Slate {
        const object = requireExactObject(
            payload,
            [
                "activeDeploymentId",
                "forkedFrom",
                "headVersionId",
                "id",
                "latestPublicationId",
                "revision",
                "source",
                "workspaceId"
            ],
            "Slate payload"
        );
        const fork = object["forkedFrom"];
        const decodedFork =
            fork === null
                ? undefined
                : requireExactObject(fork, ["slateId", "versionId"], "Slate fork reference");
        const head = nullableString(object["headVersionId"], "Slate head version ID");
        const latestPublication = nullableString(
            object["latestPublicationId"],
            "Slate latest publication ID"
        );
        const active = nullableString(object["activeDeploymentId"], "Slate active deployment ID");
        let slate: SlateInit = {
            id: slateId(object["id"]),
            workspaceId: workspaceId(object["workspaceId"]),
            source: contentRef(object["source"], "Slate source"),
            revision: revision(object["revision"])
        };
        if (head !== undefined) slate = { ...slate, headVersionId: versionId(head) };
        if (latestPublication !== undefined) {
            slate = { ...slate, latestPublicationId: publicationId(latestPublication) };
        }
        if (active !== undefined) slate = { ...slate, activeDeploymentId: deploymentId(active) };
        if (decodedFork !== undefined) {
            slate = {
                ...slate,
                forkedFrom: {
                    slateId: slateId(decodedFork["slateId"]),
                    versionId: versionId(decodedFork["versionId"])
                }
            };
        }
        return new Slate(slate);
    }

    private revise(changes: {
        readonly source?: ContentRef;
        readonly headVersionId?: SlateVersionId;
        readonly latestPublicationId?: SlatePublicationId;
        readonly activeDeploymentId?: SlateDeploymentId | undefined;
    }): Slate {
        const hasActive = Object.prototype.hasOwnProperty.call(changes, "activeDeploymentId");
        const headVersionId = changes.headVersionId ?? this.headVersionId;
        const latestPublicationId = changes.latestPublicationId ?? this.latestPublicationId;
        const activeDeploymentId = hasActive ? changes.activeDeploymentId : this.activeDeploymentId;
        let revised: SlateInit = {
            id: this.id,
            workspaceId: this.workspaceId,
            source: changes.source ?? this.source,
            revision: nextSlateRevision(this.revision)
        };
        if (headVersionId !== undefined) revised = { ...revised, headVersionId };
        if (latestPublicationId !== undefined) revised = { ...revised, latestPublicationId };
        if (activeDeploymentId !== undefined) revised = { ...revised, activeDeploymentId };
        if (this.forkedFrom !== undefined) revised = { ...revised, forkedFrom: this.forkedFrom };
        return new Slate(revised);
    }
}

const slateCodecInstance = new SlateCodecV1();

function nextSlateRevision(revision_: Revision): Revision {
    if (revision_.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.invalid-state", "Slate revision is exhausted");
    }
    return revision_.next();
}
