// @ts-nocheck
import { ContentRef, Revision, type JsonValue } from "../core";
import {
    SlateBackend,
    type EffectDispatch,
    type SlateCommitInput,
    type SlateDeployInput,
    type SlateForkInput,
    type SlatePublishInput,
    type SlateRollbackInput,
    type SlateUpdateInput
} from "../facets";
import { WorkspaceId } from "../identity";
import {
    SlateDeploymentId,
    SlateId,
    SlatePublicationId,
    SlateRuntime,
    SlateVersionId,
    type Slate
} from "../slates";

export type SlateRuntimePort = Pick<
    SlateRuntime,
    "update" | "commit" | "fork" | "publish" | "deploy" | "rollback"
>;

export class SlateRuntimeBackend extends SlateBackend {
    public constructor(private readonly runtime: SlateRuntimePort) {
        super();
    }

    public async update(input: SlateUpdateInput): Promise<JsonValue> {
        const slate = await this.runtime.update(
            new SlateId(input.slate),
            new ContentRef(input.source),
            optionalRevision(input.expectedRevision)
        );
        return slateData(slate);
    }

    public async commit(input: SlateCommitInput): Promise<JsonValue> {
        const version = await this.runtime.commit(
            new SlateId(input.slate),
            optionalRevision(input.expectedRevision)
        );
        return {
            versionId: version.id.value,
            slateId: version.slateId.value,
            source: version.source.value
        };
    }

    public async fork(input: SlateForkInput): Promise<JsonValue> {
        return slateData(
            await this.runtime.fork(
                new SlateVersionId(input.sourceVersion),
                new WorkspaceId(input.workspace)
            )
        );
    }

    public async publish(input: SlatePublishInput): Promise<JsonValue> {
        const publication = await this.runtime.publish(
            new SlateVersionId(input.version),
            new ContentRef(input.materialization)
        );
        return {
            publicationId: publication.id.value,
            slateId: publication.slateId.value,
            versionId: publication.versionId.value,
            materialization: publication.materialization.value
        };
    }

    public async deploy(input: SlateDeployInput, dispatch: EffectDispatch): Promise<JsonValue> {
        const outcome = await this.runtime.deploy(
            new SlatePublicationId(input.publication),
            input.target,
            dispatch.idempotencyKey
        );
        return outcome.outcome === "succeeded"
            ? {
                  outcome: outcome.outcome,
                  deploymentId: outcome.deployment.id.value,
                  receiptId: outcome.receiptId.value,
                  activated: outcome.activated
              }
            : {
                  outcome: outcome.outcome,
                  deploymentId: outcome.deploymentId.value,
                  receiptId: outcome.receiptId.value
              };
    }

    public async rollback(input: SlateRollbackInput): Promise<JsonValue> {
        return slateData(
            await this.runtime.rollback(
                new SlateId(input.slate),
                new SlateDeploymentId(input.deployment),
                input.expectedActiveDeployment === undefined
                    ? undefined
                    : new SlateDeploymentId(input.expectedActiveDeployment)
            )
        );
    }
}

function optionalRevision(value: number | undefined): Revision | undefined {
    return value === undefined ? undefined : new Revision(value);
}

function slateData(slate: Slate): JsonValue {
    return {
        slateId: slate.id.value,
        workspaceId: slate.workspaceId.value,
        source: slate.source.value,
        revision: slate.revision.value,
        headVersionId: slate.headVersionId?.value ?? null,
        activeDeploymentId: slate.activeDeploymentId?.value ?? null
    };
}
