// @ts-nocheck
import {
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";

export type JsonObject = { readonly [key: string]: JsonValue };

export function requireObject(value: JsonValue | undefined, name: string): JsonObject {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as JsonObject;
}

export function requireExact(object: JsonObject, keys: readonly string[], name: string): void {
    if (!hasExactJsonKeys(object, keys)) {
        throw new TypeError(`${name} contains missing or unknown fields`);
    }
}

export function requireString(object: JsonObject, key: string, name = key): string {
    const value = object[key];
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

export function requireBoolean(object: JsonObject, key: string, name = key): boolean {
    const value = object[key];
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be a boolean`);
    }
    return value;
}

export function requireSafeInteger(object: JsonObject, key: string, name = key): number {
    const value = object[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

export function requireArray(value: JsonValue | undefined, name: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array`);
    }
    return value;
}

export function canonicalJson<Value extends JsonValue>(value: Value): Value {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)) as Value);
}

export function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean {
    return bytesEqual(encodeCanonicalJson(left), encodeCanonicalJson(right));
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function deepFreeze<Value>(value: Value): Value {
    if (value !== null && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
