// @ts-nocheck
import { ContentRef, Revision, encodeCanonicalJson, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { EnvironmentId, EnvironmentSessionId, PortExposureId } from "../environments";
import { WorkspaceId } from "../identity";
import { InvocationId } from "../interaction-references";
import { ReceiptId } from "../invocation-references";
import {
    SlateDeploymentId,
    SlateId,
    SlatePreviewId,
    SlatePublicationId,
    SlateResourceId,
    SlateVersionId
} from "./id";

interface SlateIntentBase {
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
}

export interface SlateCreateIntent extends SlateIntentBase {
    readonly operation: "create";
    readonly impact: "mutate";
    readonly source: ContentRef;
}

export interface SlateUpdateIntent extends SlateIntentBase {
    readonly operation: "update";
    readonly impact: "mutate";
    readonly source: ContentRef;
    readonly expectedRevision: Revision;
}

export interface SlateCommitIntent extends SlateIntentBase {
    readonly operation: "commit";
    readonly impact: "mutate";
    readonly versionId: SlateVersionId;
    readonly source: ContentRef;
    readonly parentVersionId: SlateVersionId | undefined;
    readonly expectedRevision: Revision;
}

export interface SlateForkIntent extends SlateIntentBase {
    readonly operation: "fork";
    readonly impact: "mutate";
    readonly sourceSlateId: SlateId;
    readonly sourceVersionId: SlateVersionId;
    readonly source: ContentRef;
    readonly expectedSourceRevision: Revision;
}

export interface SlatePublishIntent extends SlateIntentBase {
    readonly operation: "publish";
    readonly impact: "mutate";
    readonly publicationId: SlatePublicationId;
    readonly versionId: SlateVersionId;
    readonly source: ContentRef;
    readonly materialization: ContentRef;
    readonly expectedRevision: Revision;
}

export interface SlateDeployInvocationIntent extends SlateIntentBase {
    readonly operation: "deploy";
    readonly impact: "externalSend";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
}

export interface SlateResourceInvocationIntent extends SlateIntentBase {
    readonly operation: "resource.materialize";
    readonly impact: "externalSend";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
}

export type SlateInvocationRequest = SlateDeployInvocationIntent | SlateResourceInvocationIntent;

export interface SlateDeployReserveIntent extends SlateIntentBase {
    readonly operation: "deploy.reserve";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly invocationId: InvocationId;
}

export interface SlateDeployFinalizeIntent extends SlateIntentBase {
    readonly operation: "deploy.finalize";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    readonly materialization: ContentRef;
}

export interface SlateResourceReserveIntent extends SlateIntentBase {
    readonly operation: "resource.reserve";
    readonly impact: "mutate";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
    readonly invocationId: InvocationId;
}

export interface SlateResourceFinalizeIntent extends SlateIntentBase {
    readonly operation: "resource.finalize";
    readonly impact: "mutate";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    readonly materialization: ContentRef;
}

export interface SlatePreviewLinkIntent extends SlateIntentBase {
    readonly operation: "preview.link";
    readonly impact: "mutate";
    readonly previewId: SlatePreviewId;
    readonly source: ContentRef;
    readonly versionId: SlateVersionId | undefined;
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly sessionEpoch: number;
    readonly exposureId: PortExposureId;
    readonly expectedRevision: Revision;
}

export interface SlateRollbackIntent extends SlateIntentBase {
    readonly operation: "rollback";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly expectedRevision: Revision;
}

export type SlateMutationRequest =
    | SlateCreateIntent
    | SlateUpdateIntent
    | SlateCommitIntent
    | SlateForkIntent
    | SlatePublishIntent
    | SlateDeployReserveIntent
    | SlateDeployFinalizeIntent
    | SlateResourceReserveIntent
    | SlateResourceFinalizeIntent
    | SlatePreviewLinkIntent
    | SlateRollbackIntent;

export type SlateMutationOperation = SlateMutationRequest["operation"];
export type SlateInvocationOperation = SlateInvocationRequest["operation"];

export function freezeSlateMutationRequest<Request extends SlateMutationRequest>(
    request: Request
): Readonly<Request> {
    canonicalSlateMutationRequest(request);
    return Object.freeze({ ...request }) as unknown as Readonly<Request>;
}

export function freezeSlateInvocationRequest<Request extends SlateInvocationRequest>(
    request: Request
): Readonly<Request> {
    canonicalSlateInvocationRequest(request);
    return Object.freeze({ ...request }) as unknown as Readonly<Request>;
}

export function canonicalSlateMutationRequest(request: SlateMutationRequest): Uint8Array {
    return encodeCanonicalJson(mutationData(request));
}

export function canonicalSlateInvocationRequest(request: SlateInvocationRequest): Uint8Array {
    return encodeCanonicalJson(invocationData(request));
}

export function sameSlateInvocationRequest(
    left: SlateInvocationRequest,
    right: SlateInvocationRequest
): boolean {
    return equalBytes(
        canonicalSlateInvocationRequest(left),
        canonicalSlateInvocationRequest(right)
    );
}

function mutationData(request: SlateMutationRequest): JsonValue {
    if (request.impact !== "mutate") throw invalidInput("Slate mutation impact must be mutate");
    const base = mutationBase(request);
    switch (request.operation) {
        case "create":
            requireKeys(request, [...baseKeys, "source"]);
            requireInstance(request.source, ContentRef, "Slate source");
            return { ...base, source: request.source.value };
        case "update":
            requireKeys(request, [...baseKeys, "expectedRevision", "source"]);
            requireInstance(request.source, ContentRef, "Slate source");
            requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
            return {
                ...base,
                expectedRevision: request.expectedRevision.value,
                source: request.source.value
            };
        case "commit":
            requireKeys(request, [
                ...baseKeys,
                "expectedRevision",
                "parentVersionId",
                "source",
                "versionId"
            ]);
            requireInstance(request.versionId, SlateVersionId, "Slate version ID");
            requireOptionalInstance(
                request.parentVersionId,
                SlateVersionId,
                "Parent Slate version ID"
            );
            requireInstance(request.source, ContentRef, "Slate source");
            requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
            return {
                ...base,
                expectedRevision: request.expectedRevision.value,
                parentVersionId: request.parentVersionId?.value ?? null,
                source: request.source.value,
                versionId: request.versionId.value
            };
        case "fork":
            requireKeys(request, [
                ...baseKeys,
                "expectedSourceRevision",
                "source",
                "sourceSlateId",
                "sourceVersionId"
            ]);
            requireInstance(request.sourceSlateId, SlateId, "Source Slate ID");
            requireInstance(request.sourceVersionId, SlateVersionId, "Source Slate version ID");
            requireInstance(request.source, ContentRef, "Slate source");
            requireInstance(
                request.expectedSourceRevision,
                Revision,
                "Expected source Slate revision"
            );
            return {
                ...base,
                expectedSourceRevision: request.expectedSourceRevision.value,
                source: request.source.value,
                sourceSlateId: request.sourceSlateId.value,
                sourceVersionId: request.sourceVersionId.value
            };
        case "publish":
            requireKeys(request, [
                ...baseKeys,
                "expectedRevision",
                "materialization",
                "publicationId",
                "source",
                "versionId"
            ]);
            requireInstance(request.publicationId, SlatePublicationId, "Slate publication ID");
            requireInstance(request.versionId, SlateVersionId, "Slate version ID");
            requireInstance(request.source, ContentRef, "Slate source");
            requireInstance(
                request.materialization,
                ContentRef,
                "Slate publication materialization"
            );
            requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
            return {
                ...base,
                expectedRevision: request.expectedRevision.value,
                materialization: request.materialization.value,
                publicationId: request.publicationId.value,
                source: request.source.value,
                versionId: request.versionId.value
            };
        case "deploy.reserve":
            requireKeys(request, [...deployKeys, "invocationId"]);
            requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
            return { ...deployData(request), invocationId: request.invocationId.value };
        case "deploy.finalize":
            requireKeys(request, [...deployKeys, "invocationId", "materialization", "receiptId"]);
            requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
            requireInstance(request.receiptId, ReceiptId, "Slate receipt ID");
            requireInstance(
                request.materialization,
                ContentRef,
                "Slate deployment materialization"
            );
            return {
                ...deployData(request),
                invocationId: request.invocationId.value,
                materialization: request.materialization.value,
                receiptId: request.receiptId.value
            };
        case "resource.reserve":
            requireKeys(request, [...resourceKeys, "invocationId"]);
            requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
            return { ...resourceData(request), invocationId: request.invocationId.value };
        case "resource.finalize":
            requireKeys(request, [...resourceKeys, "invocationId", "materialization", "receiptId"]);
            requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
            requireInstance(request.receiptId, ReceiptId, "Slate receipt ID");
            requireInstance(request.materialization, ContentRef, "Slate resource materialization");
            return {
                ...resourceData(request),
                invocationId: request.invocationId.value,
                materialization: request.materialization.value,
                receiptId: request.receiptId.value
            };
        case "preview.link":
            requireKeys(request, [
                ...baseKeys,
                "environmentId",
                "environmentRevision",
                "expectedRevision",
                "exposureId",
                "previewId",
                "sessionEpoch",
                "sessionId",
                "source",
                "versionId"
            ]);
            requireInstance(request.previewId, SlatePreviewId, "Slate preview ID");
            requireInstance(request.source, ContentRef, "Slate preview source");
            requireOptionalInstance(request.versionId, SlateVersionId, "Slate preview version ID");
            requireInstance(request.environmentId, EnvironmentId, "Environment ID");
            requireInstance(request.sessionId, EnvironmentSessionId, "Environment session ID");
            requireInstance(request.environmentRevision, Revision, "Environment revision");
            requireInstance(request.exposureId, PortExposureId, "Port exposure ID");
            requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
            requireEpoch(request.sessionEpoch);
            return {
                ...base,
                environmentId: request.environmentId.value,
                environmentRevision: request.environmentRevision.value,
                expectedRevision: request.expectedRevision.value,
                exposureId: request.exposureId.value,
                previewId: request.previewId.value,
                sessionEpoch: request.sessionEpoch,
                sessionId: request.sessionId.value,
                source: request.source.value,
                versionId: request.versionId?.value ?? null
            };
        case "rollback":
            requireKeys(request, [
                ...baseKeys,
                "deploymentId",
                "expectedActiveDeploymentId",
                "expectedRevision"
            ]);
            requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
            requireOptionalInstance(
                request.expectedActiveDeploymentId,
                SlateDeploymentId,
                "Expected active Slate deployment ID"
            );
            requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
            return {
                ...base,
                deploymentId: request.deploymentId.value,
                expectedActiveDeploymentId: request.expectedActiveDeploymentId?.value ?? null,
                expectedRevision: request.expectedRevision.value
            };
    }
}

function invocationData(request: SlateInvocationRequest): JsonValue {
    if (request.operation === "deploy") {
        requireKeys(request, deployKeys);
        return deployData(request);
    }
    requireKeys(request, resourceKeys);
    return resourceData(request);
}

const baseKeys = ["impact", "operation", "slateId", "workspaceId"] as const;
const deployKeys = [
    ...baseKeys,
    "deploymentId",
    "expectedActiveDeploymentId",
    "publicationId",
    "publicationMaterialization",
    "target"
] as const;
const resourceKeys = [
    ...baseKeys,
    "deploymentId",
    "deploymentMaterialization",
    "resourceId",
    "resourceName",
    "resourceSource"
] as const;

function mutationBase(request: SlateMutationRequest): { readonly [key: string]: JsonValue } {
    requireBase(request);
    return {
        impact: request.impact,
        operation: request.operation,
        slateId: request.slateId.value,
        workspaceId: request.workspaceId.value
    };
}

function deployData(
    request: SlateDeployInvocationIntent | SlateDeployReserveIntent | SlateDeployFinalizeIntent
): { readonly [key: string]: JsonValue } {
    if (request.operation === "deploy" && request.impact !== "externalSend") {
        throw invalidInput("Slate deploy invocation impact must be externalSend");
    }
    requireBase(request);
    requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
    requireInstance(request.publicationId, SlatePublicationId, "Slate publication ID");
    requireInstance(
        request.publicationMaterialization,
        ContentRef,
        "Slate publication materialization"
    );
    requireOptionalInstance(
        request.expectedActiveDeploymentId,
        SlateDeploymentId,
        "Expected active Slate deployment ID"
    );
    requireText(request.target, "Slate deployment target", 512);
    return {
        impact: request.impact,
        operation: request.operation,
        workspaceId: request.workspaceId.value,
        slateId: request.slateId.value,
        deploymentId: request.deploymentId.value,
        publicationId: request.publicationId.value,
        publicationMaterialization: request.publicationMaterialization.value,
        target: request.target,
        expectedActiveDeploymentId: request.expectedActiveDeploymentId?.value ?? null
    };
}

function resourceData(
    request:
        SlateResourceInvocationIntent | SlateResourceReserveIntent | SlateResourceFinalizeIntent
): { readonly [key: string]: JsonValue } {
    if (request.operation === "resource.materialize" && request.impact !== "externalSend") {
        throw invalidInput("Slate resource invocation impact must be externalSend");
    }
    requireBase(request);
    requireInstance(request.resourceId, SlateResourceId, "Slate resource ID");
    requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
    requireInstance(
        request.deploymentMaterialization,
        ContentRef,
        "Slate deployment materialization"
    );
    requireText(request.resourceName, "Slate resource name", 256);
    requireInstance(request.resourceSource, ContentRef, "Slate resource source");
    return {
        impact: request.impact,
        operation: request.operation,
        workspaceId: request.workspaceId.value,
        slateId: request.slateId.value,
        resourceId: request.resourceId.value,
        deploymentId: request.deploymentId.value,
        deploymentMaterialization: request.deploymentMaterialization.value,
        resourceName: request.resourceName,
        resourceSource: request.resourceSource.value
    };
}

function requireKeys(value: object, expected: readonly string[]): void {
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== expected.length ||
        expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    ) {
        throw invalidInput("Slate intent contains missing or unknown fields");
    }
}

function requireEpoch(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw invalidInput("Slate preview session epoch must be a non-negative safe integer");
    }
}

function requireBase(value: SlateMutationRequest | SlateInvocationRequest): void {
    requireInstance(value.workspaceId, WorkspaceId, "Slate Workspace ID");
    requireInstance(value.slateId, SlateId, "Slate ID");
}

function requireInstance<Value>(
    value: unknown,
    constructor: abstract new (...arguments_: never[]) => Value,
    subject: string
): asserts value is Value {
    if (!(value instanceof constructor)) throw invalidInput(`${subject} is invalid`);
}

function requireOptionalInstance<Value>(
    value: unknown,
    constructor: abstract new (...arguments_: never[]) => Value,
    subject: string
): asserts value is Value | undefined {
    if (value !== undefined) requireInstance(value, constructor, subject);
}

function requireText(value: unknown, subject: string, maximum: number): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        throw invalidInput(`${subject} must not be blank or exceed ${maximum} characters`);
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidInput(message: string): AgentCoreError {
    return new AgentCoreError("operation.invalid-input", message);
}
