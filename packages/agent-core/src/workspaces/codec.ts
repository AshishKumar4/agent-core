import { ActorId, ActorRef, type ActorKind } from "../actors";
import { ContentRef, Digest, Revision, hasExactJsonKeys, type JsonValue } from "../core";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    TenantId,
    decodeScopeRef,
    encodeScopeRef
} from "../identity";

export type JsonObject = { readonly [key: string]: JsonValue };

export function requireObject(value: JsonValue, subject: string): JsonObject {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as JsonObject;
}

export function requireFields(value: JsonObject, fields: readonly string[], subject: string): void {
    if (!hasExactJsonKeys(value, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

export function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

export function requireNullableString(
    value: JsonValue | undefined,
    subject: string
): string | undefined {
    if (value === null) return undefined;
    return requireString(value, subject);
}

export function requireBoolean(value: JsonValue | undefined, subject: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${subject} must be a boolean`);
    }
    return value;
}

export function requireInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

export function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

export function encodeActor(actor: ActorRef): JsonValue {
    return { kind: actor.kind, id: actor.id.value };
}

export function decodeActor(value: JsonValue, subject: string): ActorRef {
    const object = requireObject(value, subject);
    requireFields(object, ["id", "kind"], subject);
    return new ActorRef(
        requireActorKind(object["kind"], `${subject} kind`),
        new ActorId(requireString(object["id"], `${subject} ID`))
    );
}

export function encodeContent(ref: ContentRef, digest: Digest): JsonValue {
    return { ref: ref.value, digest: digest.value };
}

export function decodeContent(
    value: JsonValue,
    subject: string
): { readonly ref: ContentRef; readonly digest: Digest } {
    const object = requireObject(value, subject);
    requireFields(object, ["digest", "ref"], subject);
    const ref = new ContentRef(requireString(object["ref"], `${subject} reference`));
    const digest = new Digest(requireString(object["digest"], `${subject} digest`));
    if (!ref.digest.equals(digest)) {
        throw new TypeError(`${subject} reference and digest do not match`);
    }
    return { ref, digest };
}

export function encodeRevision(revision: Revision): JsonValue {
    return revision.value;
}

export function decodeRevision(value: JsonValue | undefined, subject: string): Revision {
    return new Revision(requireInteger(value, subject));
}

export function encodeOptionalPrincipalRef(principal: PrincipalRef | undefined): JsonValue {
    return principal === undefined
        ? null
        : { tenant: principal.tenantId.value, principal: principal.principalId.value };
}

export function decodeOptionalPrincipalRef(
    value: JsonValue | undefined,
    subject: string
): PrincipalRef | undefined {
    if (value === null) return undefined;
    const object = requireObject(value!, subject);
    requireFields(object, ["principal", "tenant"], subject);
    return new PrincipalRef(
        new TenantId(requireString(object["tenant"], `${subject} Tenant`)),
        new PrincipalId(requireString(object["principal"], `${subject} ID`))
    );
}

export function encodeScope(scope: ScopeRef): JsonValue {
    return encodeScopeRef(scope);
}

export function decodeScope(value: JsonValue): ScopeRef {
    return decodeScopeRef(value);
}

export function requireTenant(value: JsonValue | undefined, subject: string): TenantId {
    return new TenantId(requireString(value, subject));
}

function requireActorKind(value: JsonValue | undefined, subject: string): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new TypeError(`${subject} is invalid`);
}
