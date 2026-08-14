/**
 * Boundary parsers for the protocol's durable records, matching the per-context
 * codec modules the other bounded contexts carry. Every helper answers a decode
 * question by returning the decoded value, so callers never re-state a fact the
 * parser already established.
 */

import { jsonDataParser, type JsonObject, type JsonValue } from "../core";

/** A record being encoded, before it is published as an immutable JsonValue. */
export type MutableJsonObject = { [key: string]: JsonValue };

const parse = jsonDataParser((message) => new TypeError(message));

export function requireObject(value: JsonValue | undefined, subject: string): JsonObject {
    return parse.object(value, subject);
}

export function requireStringValue(value: JsonValue | undefined, subject: string): string {
    return parse.string(value, subject);
}

export function requireString(object: JsonObject, key: string, subject = key): string {
    return requireStringValue(object[key], subject);
}

export function requireNonemptyString(value: JsonValue | undefined, subject: string): string {
    return parse.nonemptyString(value, subject);
}

export function requireNullableString(
    object: JsonObject,
    key: string,
    subject = key
): string | undefined {
    return parse.nullableString(object[key], subject);
}

export function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): number {
    return parse.safeInteger(value, subject);
}

export function requireKeys(
    object: JsonObject,
    required: readonly string[],
    optional: readonly string[],
    subject: string
): void {
    const admitted = new Set([...required, ...optional]);
    if (
        required.some((key) => !(key in object)) ||
        Object.keys(object).some((key) => !admitted.has(key))
    ) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}
