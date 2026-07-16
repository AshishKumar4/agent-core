// @ts-nocheck
import { Revision, hasExactJsonKeys, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";

export type JsonObject = { readonly [key: string]: JsonValue };

export function requireInstance<Value>(
    value: unknown,
    constructor: abstract new (...arguments_: never[]) => Value,
    name: string
): asserts value is Value {
    if (!(value instanceof constructor)) throw new TypeError(`${name} is invalid`);
}

export function requireObject(value: JsonValue, name: string): JsonObject {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${name} must be an object`);
    }
    return value as JsonObject;
}

export function requireExact(object: JsonObject, keys: readonly string[], name: string): void {
    if (!hasExactJsonKeys(object, keys)) {
        throw new TypeError(`${name} has invalid fields`);
    }
}

export function requireString(value: JsonValue | undefined, name: string): string {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
}

export function requireSafeInteger(value: JsonValue | undefined, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

export function requireOptionalString(
    value: JsonValue | undefined,
    name: string
): string | undefined {
    if (value === null) return undefined;
    return requireString(value, name);
}

export function increment(value: number, name: string): number {
    if (value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
    }
    return value + 1;
}

export function advanceRevision(revision: Revision, name: string): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
    }
    return revision.next();
}
