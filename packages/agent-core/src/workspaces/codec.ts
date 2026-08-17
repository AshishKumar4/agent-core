import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    type JsonFields,
    ContentRef,
    Digest,
    Revision,
    hasExactJsonKeys,
    isJsonObject,
    type JsonValue
} from "../core";
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
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

export function requireFields<Field extends string>(
    value: JsonObject,
    fields: readonly Field[],
    subject: string
): asserts value is JsonFields<Field> {
    if (!hasExactJsonKeys(value, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

/**
 * The same exactness as `requireFields` for records whose optional fields are encoded by
 * presence: every required key must appear, and no key outside the two lists may.
 */
export function requireOptionalFields<Field extends string>(
    value: JsonObject,
    required: readonly Field[],
    optional: readonly string[],
    subject: string
): asserts value is JsonFields<Field> {
    const admissible = new Set<string>([...required, ...optional]);
    const present = Object.keys(value);
    if (
        required.some((field) => !Object.hasOwn(value, field)) ||
        present.some((key) => !admissible.has(key))
    ) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

export function requireString(value: JsonValue | undefined, subject: string): string {
    if (!isStringValue(value)) {
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
    if (!isBooleanValue(value)) {
        throw new TypeError(`${subject} must be a boolean`);
    }
    return value;
}

export function requireInteger(value: JsonValue | undefined, subject: string): number {
    if (!isNumberValue(value) || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

function isStringValue(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function isBooleanValue(value: JsonValue | undefined): value is boolean {
    return typeof value === "boolean";
}

function isNumberValue(value: JsonValue | undefined): value is number {
    return typeof value === "number";
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

/**
 * A stored payload named by its content address, together with the digest that
 * address resolves to. decodeContent proves the two agree before returning one.
 */
export interface AddressedContent {
    readonly ref: ContentRef;
    readonly digest: Digest;
}

export function decodeContent(value: JsonValue, subject: string): AddressedContent {
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
