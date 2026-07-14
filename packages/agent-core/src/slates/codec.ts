import { ContentRef, Revision, hasExactJsonKeys, type JsonValue } from "../core";
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

export type JsonObject = { readonly [key: string]: JsonValue };

export function requireObjectValue(value: JsonValue | undefined, subject: string): JsonObject {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as JsonObject;
}

export function requireExactObject(
    value: JsonValue | undefined,
    fields: readonly string[],
    subject: string
): JsonObject {
    const object = requireObjectValue(value, subject);
    if (!hasExactJsonKeys(object, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
    return object;
}

export function requireStringValue(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}

export function nullableString(value: JsonValue | undefined, subject: string): string | undefined {
    if (value === null) return undefined;
    return requireStringValue(value, subject);
}

export function requireIntegerValue(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

export function workspaceId(value: JsonValue | undefined): WorkspaceId {
    return new WorkspaceId(requireStringValue(value, "Slate workspace ID"));
}

export function slateId(value: JsonValue | undefined): SlateId {
    return new SlateId(requireStringValue(value, "Slate ID"));
}

export function versionId(value: JsonValue | undefined): SlateVersionId {
    return new SlateVersionId(requireStringValue(value, "Slate version ID"));
}

export function publicationId(value: JsonValue | undefined): SlatePublicationId {
    return new SlatePublicationId(requireStringValue(value, "Slate publication ID"));
}

export function deploymentId(value: JsonValue | undefined): SlateDeploymentId {
    return new SlateDeploymentId(requireStringValue(value, "Slate deployment ID"));
}

export function resourceId(value: JsonValue | undefined): SlateResourceId {
    return new SlateResourceId(requireStringValue(value, "Slate resource ID"));
}

export function previewId(value: JsonValue | undefined): SlatePreviewId {
    return new SlatePreviewId(requireStringValue(value, "Slate preview ID"));
}

export function contentRef(value: JsonValue | undefined, subject: string): ContentRef {
    return new ContentRef(requireStringValue(value, subject));
}

export function invocationId(value: JsonValue | undefined): InvocationId {
    return new InvocationId(requireStringValue(value, "Slate invocation ID"));
}

export function receiptId(value: JsonValue | undefined): ReceiptId {
    return new ReceiptId(requireStringValue(value, "Slate receipt ID"));
}

export function sessionId(value: JsonValue | undefined): EnvironmentSessionId {
    return new EnvironmentSessionId(requireStringValue(value, "Slate preview session ID"));
}

export function environmentId(value: JsonValue | undefined): EnvironmentId {
    return new EnvironmentId(requireStringValue(value, "Slate preview environment ID"));
}

export function exposureId(value: JsonValue | undefined): PortExposureId {
    return new PortExposureId(requireStringValue(value, "Slate preview exposure ID"));
}

export function revision(value: JsonValue | undefined): Revision {
    return new Revision(requireIntegerValue(value, "Slate revision"));
}

export function requireText(value: string, subject: string, maximum = 512): string {
    if (value.trim().length === 0 || value.length > maximum) {
        throw new TypeError(`${subject} must not be blank or exceed ${maximum} characters`);
    }
    return value;
}
