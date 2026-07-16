import { ContentRef, Revision } from "../core";
import { EnvironmentSessionCapability, PortExposureId } from "../environments";
import { AgentCoreError } from "../errors";
import { WorkspaceId } from "../identity";
import { ReceiptId } from "../invocation-references";
import { SlateDeployment } from "./deployment";
import {
    SlateDeploymentId,
    SlateId,
    SlatePreviewId,
    SlatePublicationId,
    SlateResourceId,
    SlateVersionId
} from "./id";
import {
    freezeSlateInvocationRequest,
    freezeSlateMutationRequest,
    type SlateDeployFinalizeIntent,
    type SlateDeployInvocationIntent,
    type SlateMutationRequest,
    type SlatePreviewLinkIntent,
    type SlateResourceFinalizeIntent,
    type SlateResourceInvocationIntent
} from "./intent";
import { SlatePreview } from "./preview";
import {
    SlateProvider,
    type SlateProviderDeployment,
    type SlateProviderDeploymentRequest,
    type SlateProviderResource,
    type SlateProviderResourceRequest
} from "./provider";
import { SlatePublication } from "./publication";
import { SlateResource } from "./resource";
import {
    SlateEffectContext,
    SlateInvocationSeam,
    SlateMutationSeam,
    SlatePreviewValidationSeam,
    type SlateInvocationResult
} from "./seams";
import { Slate } from "./slate";
import { SlateDeploymentReservation, SlateResourceReservation, SlateStore } from "./store";
import { SlateVersion } from "./version";

export abstract class SlateIdSource {
    public abstract allocateSlateId(): SlateId;
    public abstract allocateVersionId(): SlateVersionId;
    public abstract allocatePublicationId(): SlatePublicationId;
    public abstract allocateDeploymentId(): SlateDeploymentId;
    public abstract allocateResourceId(): SlateResourceId;
    public abstract allocatePreviewId(): SlatePreviewId;
}

export class MemorySlateIdSource extends SlateIdSource {
    #next = 0;

    public constructor(private readonly prefix = "slate") {
        super();
        if (prefix.trim().length === 0) throw new TypeError("Slate ID prefix must not be blank");
    }

    public allocateSlateId(): SlateId {
        return new SlateId(this.value("slate"));
    }
    public allocateVersionId(): SlateVersionId {
        return new SlateVersionId(this.value("version"));
    }
    public allocatePublicationId(): SlatePublicationId {
        return new SlatePublicationId(this.value("publication"));
    }
    public allocateDeploymentId(): SlateDeploymentId {
        return new SlateDeploymentId(this.value("deployment"));
    }
    public allocateResourceId(): SlateResourceId {
        return new SlateResourceId(this.value("resource"));
    }
    public allocatePreviewId(): SlatePreviewId {
        return new SlatePreviewId(this.value("preview"));
    }

    private value(kind: string): string {
        const value = `${this.prefix}-${kind}-${this.#next}`;
        this.#next += 1;
        return value;
    }
}

export type SlateDeploymentOutcome =
    | {
          readonly outcome: "succeeded";
          readonly deployment: SlateDeployment;
          readonly receiptId: ReceiptId;
          readonly activated: boolean;
      }
    | {
          readonly outcome: "failed" | "indeterminate";
          readonly deploymentId: SlateDeploymentId;
          readonly receiptId: ReceiptId;
      };

export type SlateResourceOutcome =
    | {
          readonly outcome: "succeeded";
          readonly resource: SlateResource;
          readonly receiptId: ReceiptId;
      }
    | {
          readonly outcome: "failed" | "indeterminate";
          readonly resourceId: SlateResourceId;
          readonly receiptId: ReceiptId;
      };

export class SlateRuntime {
    public constructor(
        private readonly store: SlateStore,
        private readonly provider: SlateProvider,
        private readonly mutations: SlateMutationSeam,
        private readonly invocations: SlateInvocationSeam,
        private readonly previewValidation: SlatePreviewValidationSeam,
        private readonly ids: SlateIdSource
    ) {}

    public async create(workspaceId: WorkspaceId, source: ContentRef): Promise<Slate> {
        const request = freezeSlateMutationRequest({
            operation: "create",
            impact: "mutate",
            workspaceId,
            slateId: this.ids.allocateSlateId(),
            source
        });
        return this.mutate(request, (store) => {
            const slate = Slate.initial(request.slateId, request.workspaceId, request.source);
            if (!store.compareAndSetSlate(undefined, slate)) {
                throw new AgentCoreError(
                    "protocol.duplicate",
                    `Slate ${request.slateId.value} already exists`
                );
            }
            return slate;
        });
    }

    public async update(
        id: SlateId,
        source: ContentRef,
        expectedRevision?: Revision
    ): Promise<Slate> {
        const current = this.requireSlate(this.store, id);
        const request = freezeSlateMutationRequest({
            operation: "update",
            impact: "mutate",
            workspaceId: current.workspaceId,
            slateId: current.id,
            source,
            expectedRevision: expectedRevision ?? current.revision
        });
        return this.mutate(request, (store) => {
            const slate = this.requireExpectedSlate(
                store,
                request.slateId,
                request.expectedRevision
            );
            const next = slate.update(request.source);
            if (!store.compareAndSetSlate(request.expectedRevision, next)) {
                throw revisionConflict(request.slateId);
            }
            return next;
        });
    }

    public async commit(id: SlateId, expectedRevision?: Revision): Promise<SlateVersion> {
        const current = this.requireSlate(this.store, id);
        const request = freezeSlateMutationRequest({
            operation: "commit",
            impact: "mutate",
            workspaceId: current.workspaceId,
            slateId: current.id,
            versionId: this.ids.allocateVersionId(),
            source: current.source,
            parentVersionId: current.headVersionId,
            expectedRevision: expectedRevision ?? current.revision
        });
        return this.mutate(request, (store) => {
            const slate = this.requireExpectedSlate(
                store,
                request.slateId,
                request.expectedRevision
            );
            if (
                !slate.source.equals(request.source) ||
                !sameOptionalVersion(slate.headVersionId, request.parentVersionId)
            ) {
                throw revisionConflict(request.slateId);
            }
            const version = new SlateVersion(
                request.versionId,
                request.workspaceId,
                request.slateId,
                request.source,
                request.parentVersionId
            );
            store.addVersion(version);
            if (
                !store.compareAndSetSlate(request.expectedRevision, slate.commit(request.versionId))
            ) {
                throw revisionConflict(request.slateId);
            }
            return version;
        });
    }

    public async fork(sourceVersionId: SlateVersionId, workspaceId: WorkspaceId): Promise<Slate> {
        const version = this.requireVersion(this.store, sourceVersionId);
        const sourceSlate = this.requireSlate(this.store, version.slateId);
        if (!version.workspaceId.equals(workspaceId)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Slate forks must remain in the source Workspace"
            );
        }
        const request = freezeSlateMutationRequest({
            operation: "fork",
            impact: "mutate",
            workspaceId,
            slateId: this.ids.allocateSlateId(),
            sourceSlateId: version.slateId,
            sourceVersionId: version.id,
            source: version.source,
            expectedSourceRevision: sourceSlate.revision
        });
        return this.mutate(request, (store) => {
            const exactSource = this.requireExpectedSlate(
                store,
                request.sourceSlateId,
                request.expectedSourceRevision
            );
            const exactVersion = this.requireVersion(store, request.sourceVersionId);
            if (
                !exactSource.workspaceId.equals(request.workspaceId) ||
                !exactVersion.workspaceId.equals(request.workspaceId) ||
                !exactVersion.slateId.equals(request.sourceSlateId) ||
                !exactVersion.source.equals(request.source)
            ) {
                throw revisionConflict(request.slateId);
            }
            const fork = new Slate({
                id: request.slateId,
                workspaceId: request.workspaceId,
                source: request.source,
                forkedFrom: {
                    slateId: request.sourceSlateId,
                    versionId: request.sourceVersionId
                },
                revision: Revision.initial()
            });
            if (!store.compareAndSetSlate(undefined, fork)) {
                throw new AgentCoreError(
                    "protocol.duplicate",
                    `Slate ${request.slateId.value} already exists`
                );
            }
            return fork;
        });
    }

    public async publish(
        versionId: SlateVersionId,
        materialization: ContentRef
    ): Promise<SlatePublication> {
        const version = this.requireVersion(this.store, versionId);
        const slate = this.requireSlate(this.store, version.slateId);
        const request = freezeSlateMutationRequest({
            operation: "publish",
            impact: "mutate",
            workspaceId: version.workspaceId,
            slateId: version.slateId,
            publicationId: this.ids.allocatePublicationId(),
            versionId: version.id,
            source: version.source,
            materialization,
            expectedRevision: slate.revision
        });
        return this.mutate(request, (store) => {
            const current = this.requireExpectedSlate(
                store,
                request.slateId,
                request.expectedRevision
            );
            const exactVersion = this.requireVersion(store, request.versionId);
            if (
                !exactVersion.source.equals(request.source) ||
                !exactVersion.workspaceId.equals(request.workspaceId)
            ) {
                throw revisionConflict(request.slateId);
            }
            const publication = new SlatePublication(
                request.publicationId,
                request.workspaceId,
                request.slateId,
                request.versionId,
                request.materialization
            );
            store.addPublication(publication);
            if (
                !store.compareAndSetSlate(
                    request.expectedRevision,
                    current.publish(request.publicationId)
                )
            )
                throw revisionConflict(request.slateId);
            return publication;
        });
    }

    public async deploy(
        publicationId: SlatePublicationId,
        target: string,
        externalKey: string
    ): Promise<SlateDeploymentOutcome> {
        if (typeof externalKey !== "string" || externalKey.trim() !== externalKey ||
            externalKey.length === 0) {
            throw new TypeError("Slate deployment external key must be canonical");
        }
        const existing = this.store.findDeploymentReservationByExternalKey(externalKey);
        if (existing !== undefined) {
            if (!existing.publicationId.equals(publicationId) || existing.target !== target) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Slate deployment effect identity was reused for a different request"
                );
            }
            return this.reconcileDeployment(existing.id);
        }
        const publication = this.requirePublication(this.store, publicationId);
        const slate = this.requireSlate(this.store, publication.slateId);
        const request = freezeSlateInvocationRequest({
            operation: "deploy",
            impact: "externalSend",
            workspaceId: slate.workspaceId,
            slateId: slate.id,
            deploymentId: this.ids.allocateDeploymentId(),
            publicationId: publication.id,
            publicationMaterialization: publication.materialization,
            target,
            expectedActiveDeploymentId: slate.activeDeploymentId
        });
        const invocationId = await this.invocations.prepare(request);
        const reserve = freezeSlateMutationRequest({
            ...request,
            operation: "deploy.reserve",
            impact: "mutate",
            invocationId
        });
        await this.mutate(reserve, (store) =>
            store.reserveDeployment(deploymentReservation(reserve, externalKey))
        );
        const result = await this.invocations.invoke(request, invocationId, async (context) =>
            this.provider.deploy(deploymentProviderRequest(request, invocationId, context))
        );
        return this.finalizeDeployment(request, invocationId, result);
    }

    public async reconcileDeployment(id: SlateDeploymentId): Promise<SlateDeploymentOutcome> {
        const completed = this.store.getDeployment(id);
        if (completed !== undefined) {
            return {
                outcome: "succeeded",
                deployment: completed,
                receiptId: completed.receiptId,
                activated:
                    this.requireSlate(this.store, completed.slateId).activeDeploymentId?.equals(
                        id
                    ) === true
            };
        }
        const reservation = this.store.getDeploymentReservation(id);
        if (reservation === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slate deployment ${id.value} is unknown`
            );
        }
        const request = deploymentInvocationRequest(reservation);
        const result = await this.invocations.reconcile(
            request,
            reservation.invocationId,
            async (context) =>
                this.provider.reconcileDeployment(
                    deploymentProviderRequest(request, reservation.invocationId, context)
                )
        );
        return this.finalizeDeployment(request, reservation.invocationId, result);
    }

    public async materializeResource(
        deploymentId: SlateDeploymentId,
        name: string,
        source: ContentRef
    ): Promise<SlateResourceOutcome> {
        const deployment = this.requireDeployment(this.store, deploymentId);
        const request = freezeSlateInvocationRequest({
            operation: "resource.materialize",
            impact: "externalSend",
            workspaceId: deployment.workspaceId,
            slateId: deployment.slateId,
            resourceId: this.ids.allocateResourceId(),
            deploymentId: deployment.id,
            deploymentMaterialization: deployment.materialization,
            resourceName: name,
            resourceSource: source
        });
        const invocationId = await this.invocations.prepare(request);
        const reserve = freezeSlateMutationRequest({
            ...request,
            operation: "resource.reserve",
            impact: "mutate",
            invocationId
        });
        await this.mutate(reserve, (store) => store.reserveResource(resourceReservation(reserve)));
        const result = await this.invocations.invoke(request, invocationId, async (context) =>
            this.provider.materializeResource(
                resourceProviderRequest(request, invocationId, context)
            )
        );
        return this.finalizeResource(request, invocationId, result);
    }

    public async reconcileResource(id: SlateResourceId): Promise<SlateResourceOutcome> {
        const completed = this.store.getResource(id);
        if (completed !== undefined) {
            return { outcome: "succeeded", resource: completed, receiptId: completed.receiptId };
        }
        const reservation = this.store.getResourceReservation(id);
        if (reservation === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slate resource ${id.value} is unknown`
            );
        }
        const request = resourceInvocationRequest(reservation);
        const result = await this.invocations.reconcile(
            request,
            reservation.invocationId,
            async (context) =>
                this.provider.reconcileResource(
                    resourceProviderRequest(request, reservation.invocationId, context)
                )
        );
        return this.finalizeResource(request, reservation.invocationId, result);
    }

    public async linkPreview(
        slateId: SlateId,
        capability: EnvironmentSessionCapability,
        exposureId: PortExposureId,
        versionId?: SlateVersionId
    ): Promise<SlatePreview> {
        const slate = this.requireSlate(this.store, slateId);
        const version =
            versionId === undefined ? undefined : this.requireVersion(this.store, versionId);
        if (version !== undefined && !version.slateId.equals(slate.id)) {
            throw new AgentCoreError(
                "slate.invalid-version",
                "Slate preview version belongs to another Slate"
            );
        }
        const request = freezeSlateMutationRequest({
            operation: "preview.link",
            impact: "mutate",
            workspaceId: slate.workspaceId,
            slateId: slate.id,
            previewId: this.ids.allocatePreviewId(),
            source: version?.source ?? slate.source,
            versionId: version?.id,
            environmentId: capability.environmentId,
            sessionId: capability.sessionId,
            environmentRevision: capability.environmentRevision,
            sessionEpoch: capability.epoch,
            exposureId,
            expectedRevision: slate.revision
        });
        await this.previewValidation.validate(request);
        return this.mutate(request, (store) => {
            this.requireExpectedSlate(store, request.slateId, request.expectedRevision);
            const preview = previewFromIntent(request);
            store.addPreview(preview);
            return preview;
        });
    }

    public async rollback(
        slateId: SlateId,
        deploymentId: SlateDeploymentId,
        expectedActiveDeploymentId?: SlateDeploymentId
    ): Promise<Slate> {
        const current = this.requireSlate(this.store, slateId);
        const deployment = this.requireDeployment(this.store, deploymentId);
        if (!deployment.slateId.equals(slateId)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Rollback deployment belongs to another Slate"
            );
        }
        const request = freezeSlateMutationRequest({
            operation: "rollback",
            impact: "mutate",
            workspaceId: current.workspaceId,
            slateId: current.id,
            deploymentId: deployment.id,
            expectedActiveDeploymentId: expectedActiveDeploymentId ?? current.activeDeploymentId,
            expectedRevision: current.revision
        });
        return this.mutate(request, (store) => {
            const latest = this.requireExpectedSlate(
                store,
                request.slateId,
                request.expectedRevision
            );
            if (
                !sameOptionalDeployment(
                    latest.activeDeploymentId,
                    request.expectedActiveDeploymentId
                )
            )
                throw revisionConflict(request.slateId);
            const next = latest.selectDeployment(request.deploymentId);
            if (!store.compareAndSetSlate(request.expectedRevision, next)) {
                throw revisionConflict(request.slateId);
            }
            return next;
        });
    }

    private async finalizeDeployment(
        invocation: SlateDeployInvocationIntent,
        invocationId: import("../interaction-references").InvocationId,
        result: SlateInvocationResult<SlateProviderDeployment>
    ): Promise<SlateDeploymentOutcome> {
        requireInvocationResult(result);
        if (result.outcome !== "succeeded") {
            return {
                outcome: result.outcome,
                deploymentId: invocation.deploymentId,
                receiptId: result.receiptId
            };
        }
        requireProviderMaterialization(result.value, "deployment");
        const request = freezeSlateMutationRequest({
            ...invocation,
            operation: "deploy.finalize",
            impact: "mutate",
            invocationId,
            receiptId: result.receiptId,
            materialization: result.value.materialization
        });
        const activated = await this.mutate(request, (store) => {
            const deployment = deploymentFromIntent(request);
            store.addDeployment(deployment);
            const latest = this.requireSlate(store, request.slateId);
            if (
                !sameOptionalDeployment(
                    latest.activeDeploymentId,
                    request.expectedActiveDeploymentId
                )
            )
                return false;
            return store.compareAndSetSlate(
                latest.revision,
                latest.selectDeployment(request.deploymentId)
            );
        });
        return {
            outcome: "succeeded",
            deployment: deploymentFromIntent(request),
            receiptId: request.receiptId,
            activated
        };
    }

    private async finalizeResource(
        invocation: SlateResourceInvocationIntent,
        invocationId: import("../interaction-references").InvocationId,
        result: SlateInvocationResult<SlateProviderResource>
    ): Promise<SlateResourceOutcome> {
        requireInvocationResult(result);
        if (result.outcome !== "succeeded") {
            return {
                outcome: result.outcome,
                resourceId: invocation.resourceId,
                receiptId: result.receiptId
            };
        }
        requireProviderMaterialization(result.value, "resource");
        const request = freezeSlateMutationRequest({
            ...invocation,
            operation: "resource.finalize",
            impact: "mutate",
            invocationId,
            receiptId: result.receiptId,
            materialization: result.value.materialization
        });
        await this.mutate(request, (store) => store.addResource(resourceFromIntent(request)));
        return {
            outcome: "succeeded",
            resource: resourceFromIntent(request),
            receiptId: request.receiptId
        };
    }

    private async mutate<Result>(
        request: SlateMutationRequest,
        mutation: (store: SlateStore) => Result
    ): Promise<Result> {
        if (!Object.isFrozen(request)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Slate mutation intent must be frozen"
            );
        }
        return this.mutations.mutate(request, () => this.store.transaction(mutation));
    }

    private requireSlate(store: SlateStore, id: SlateId): Slate {
        const slate = store.getSlate(id);
        if (slate === undefined) {
            throw new AgentCoreError("operation.invalid-input", `Slate ${id.value} is unknown`);
        }
        return slate;
    }

    private requireExpectedSlate(store: SlateStore, id: SlateId, expected: Revision): Slate {
        const slate = this.requireSlate(store, id);
        if (!slate.revision.equals(expected)) throw revisionConflict(id);
        return slate;
    }

    private requireVersion(store: SlateStore, id: SlateVersionId): SlateVersion {
        const version = store.getVersion(id);
        if (version === undefined) {
            throw new AgentCoreError(
                "slate.invalid-version",
                `Slate version ${id.value} is unknown`
            );
        }
        return version;
    }

    private requirePublication(store: SlateStore, id: SlatePublicationId): SlatePublication {
        const publication = store.getPublication(id);
        if (publication === undefined) {
            throw new AgentCoreError(
                "slate.unpublished",
                `Slate publication ${id.value} is unknown`
            );
        }
        return publication;
    }

    private requireDeployment(store: SlateStore, id: SlateDeploymentId): SlateDeployment {
        const deployment = store.getDeployment(id);
        if (deployment === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slate deployment ${id.value} is unknown`
            );
        }
        return deployment;
    }
}

function deploymentReservation(
    request: Extract<SlateMutationRequest, { readonly operation: "deploy.reserve" }>,
    externalKey: string
): SlateDeploymentReservation {
    return new SlateDeploymentReservation({
        externalKey,
        id: request.deploymentId,
        workspaceId: request.workspaceId,
        slateId: request.slateId,
        publicationId: request.publicationId,
        publicationMaterialization: request.publicationMaterialization,
        target: request.target,
        invocationId: request.invocationId,
        ...(request.expectedActiveDeploymentId === undefined
            ? {}
            : { expectedActiveDeploymentId: request.expectedActiveDeploymentId })
    });
}

function resourceReservation(
    request: Extract<SlateMutationRequest, { readonly operation: "resource.reserve" }>
): SlateResourceReservation {
    return new SlateResourceReservation({
        id: request.resourceId,
        workspaceId: request.workspaceId,
        slateId: request.slateId,
        deploymentId: request.deploymentId,
        deploymentMaterialization: request.deploymentMaterialization,
        name: request.resourceName,
        source: request.resourceSource,
        invocationId: request.invocationId
    });
}

function deploymentInvocationRequest(
    reservation: SlateDeploymentReservation
): Readonly<SlateDeployInvocationIntent> {
    return freezeSlateInvocationRequest({
        operation: "deploy",
        impact: "externalSend",
        workspaceId: reservation.workspaceId,
        slateId: reservation.slateId,
        deploymentId: reservation.id,
        publicationId: reservation.publicationId,
        publicationMaterialization: reservation.publicationMaterialization,
        target: reservation.target,
        expectedActiveDeploymentId: reservation.expectedActiveDeploymentId
    });
}

function resourceInvocationRequest(
    reservation: SlateResourceReservation
): Readonly<SlateResourceInvocationIntent> {
    return freezeSlateInvocationRequest({
        operation: "resource.materialize",
        impact: "externalSend",
        workspaceId: reservation.workspaceId,
        slateId: reservation.slateId,
        resourceId: reservation.id,
        deploymentId: reservation.deploymentId,
        deploymentMaterialization: reservation.deploymentMaterialization,
        resourceName: reservation.name,
        resourceSource: reservation.source
    });
}

function deploymentProviderRequest(
    request: SlateDeployInvocationIntent,
    invocationId: import("../interaction-references").InvocationId,
    effectContext: SlateEffectContext
): SlateProviderDeploymentRequest {
    requireEffectContext(effectContext, invocationId);
    return Object.freeze({
        ...request,
        invocationId,
        effectContext,
        idempotencyKey: effectContext.idempotencyKey
    });
}

function resourceProviderRequest(
    request: SlateResourceInvocationIntent,
    invocationId: import("../interaction-references").InvocationId,
    effectContext: SlateEffectContext
): SlateProviderResourceRequest {
    requireEffectContext(effectContext, invocationId);
    return Object.freeze({
        ...request,
        invocationId,
        effectContext,
        idempotencyKey: effectContext.idempotencyKey
    });
}

function deploymentFromIntent(request: SlateDeployFinalizeIntent): SlateDeployment {
    return new SlateDeployment(
        request.deploymentId,
        request.workspaceId,
        request.slateId,
        request.publicationId,
        request.target,
        request.materialization,
        request.invocationId,
        request.receiptId
    );
}

function resourceFromIntent(request: SlateResourceFinalizeIntent): SlateResource {
    return new SlateResource(
        request.resourceId,
        request.workspaceId,
        request.slateId,
        request.deploymentId,
        request.resourceName,
        request.resourceSource,
        request.materialization,
        request.invocationId,
        request.receiptId
    );
}

function previewFromIntent(request: SlatePreviewLinkIntent): SlatePreview {
    return new SlatePreview(
        request.previewId,
        request.workspaceId,
        request.slateId,
        new EnvironmentSessionCapability(
            request.environmentId,
            request.sessionId,
            request.environmentRevision,
            request.sessionEpoch
        ),
        request.exposureId,
        request.source,
        request.versionId
    );
}

function requireProviderMaterialization(
    value: SlateProviderDeployment | SlateProviderResource,
    subject: string
): void {
    if (
        value === null ||
        typeof value !== "object" ||
        Reflect.ownKeys(value).length !== 1 ||
        !(value.materialization instanceof ContentRef)
    ) {
        throw new AgentCoreError(
            "operation.invalid-output",
            `Slate provider ${subject} result is malformed`
        );
    }
}

function requireEffectContext(
    context: SlateEffectContext,
    invocationId: import("../interaction-references").InvocationId
): void {
    if (
        !(context instanceof SlateEffectContext) ||
        !Object.isFrozen(context) ||
        !context.invocationId.equals(invocationId)
    ) {
        throw new AgentCoreError(
            "invocation.invalid",
            "Slate effect context does not match its Invocation"
        );
    }
}

function requireInvocationResult<Result>(result: SlateInvocationResult<Result>): void {
    if (
        result === null ||
        typeof result !== "object" ||
        !(result.receiptId instanceof ReceiptId) ||
        (result.outcome !== "succeeded" &&
            result.outcome !== "failed" &&
            result.outcome !== "indeterminate")
    ) {
        throw new AgentCoreError("invocation.invalid", "Slate invocation result is malformed");
    }
    const expectedKeys =
        result.outcome === "succeeded"
            ? ["outcome", "receiptId", "value"]
            : ["outcome", "receiptId"];
    const keys = Reflect.ownKeys(result);
    if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
        throw new AgentCoreError("invocation.invalid", "Slate invocation result is malformed");
    }
}

function sameOptionalDeployment(
    left: SlateDeploymentId | undefined,
    right: SlateDeploymentId | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function sameOptionalVersion(
    left: SlateVersionId | undefined,
    right: SlateVersionId | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function revisionConflict(id: SlateId): AgentCoreError {
    return new AgentCoreError(
        "protocol.revision-conflict",
        `Slate ${id.value} revision or active deployment changed`
    );
}
