/**
 * Boundary parsers for the protocol's durable records, matching the per-context
 * codec modules the other bounded contexts carry. Every helper answers a decode
 * question by returning the decoded value, so callers never re-state a fact the
 * parser already established.
 */

import { isJsonObject, type JsonObject, type JsonValue } from "../core";

/** A record being encoded, before it is published as an immutable JsonValue. */
export type MutableJsonObject = { [key: string]: JsonValue };

export function requireObject(value: JsonValue | undefined, subject: string): JsonObject {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

export function requireStringValue(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}

export function requireString(object: JsonObject, key: string, subject = key): string {
    return requireStringValue(object[key], subject);
}

export function requireNonemptyString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${subject} must be a non-empty string`);
    }
    return value;
}

export function requireNullableString(
    object: JsonObject,
    key: string,
    subject = key
): string | undefined {
    const value = object[key];
    if (value === null) return undefined;
    return requireStringValue(value, subject);
}

export function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
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
