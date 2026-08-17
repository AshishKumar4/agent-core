import {
    type JsonFields,
    ContentRef,
    Digest,
    Revision,
    jsonDataParser,
    type JsonValue
} from "../core";
import { BindingRequirement } from "../facets";
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

const parse = jsonDataParser((message) => new TypeError(message));

export function requireObjectValue(value: JsonValue | undefined, subject: string): JsonObject {
    return parse.object(value, subject);
}

export function requireExactObject<Field extends string>(
    value: JsonValue | undefined,
    fields: readonly Field[],
    subject: string
): JsonObject & JsonFields<Field> {
    return parse.exact(parse.object(value, subject), fields, subject);
}

export function requireStringValue(value: JsonValue | undefined, subject: string): string {
    return parse.string(value, subject);
}

export function nullableString(value: JsonValue | undefined, subject: string): string | undefined {
    return parse.nullableString(value, subject);
}

export function requireIntegerValue(value: JsonValue | undefined, subject: string): number {
    return parse.safeInteger(value, subject);
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

export function digest(value: JsonValue | undefined, subject: string): Digest {
    return new Digest(requireStringValue(value, subject));
}

/**
 * The canonical form of a declared capability set: sorted by `BindingName` and unique by
 * it, because the namespace loaded code addresses holds one entry per name (SPEC §4.7).
 * A name declared twice would leave which entry a consumer must bind undecided, so it is
 * a shape violation rather than a duplicate to be collapsed.
 */
export function canonicalBindingRequirements(
    value: readonly BindingRequirement[],
    subject: string
): readonly BindingRequirement[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array of binding requirements`);
    }
    const names = new Set<string>();
    for (const requirement of value) {
        if (!(requirement instanceof BindingRequirement)) {
            throw new TypeError(`${subject} must contain only binding requirements`);
        }
        if (names.has(requirement.name.value)) {
            throw new TypeError(`${subject} declares ${requirement.name.value} more than once`);
        }
        names.add(requirement.name.value);
    }
    return Object.freeze(
        [...value].sort((left, right) => (left.name.value < right.name.value ? -1 : 1))
    );
}

export function bindingRequirements(
    value: JsonValue | undefined,
    subject: string
): readonly BindingRequirement[] {
    return canonicalBindingRequirements(
        parse.array(value, subject).map((entry) => BindingRequirement.fromData(entry)),
        subject
    );
}
