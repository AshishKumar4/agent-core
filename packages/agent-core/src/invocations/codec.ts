import { Digest, TextId, encodeCanonicalJson, hasExactJsonKeys, type JsonValue } from "../core";

export interface StructuralCodec<Value> {
    encode(value: Value): JsonValue;
    decode(value: JsonValue): Value;
}

export function requireObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

export function requireExactObject(
    value: JsonValue | undefined,
    fields: readonly string[],
    subject: string
): { readonly [key: string]: JsonValue } {
    const object = requireObject(value, subject);
    if (!hasExactJsonKeys(object, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
    return object;
}

export function requireString(object: { readonly [key: string]: JsonValue }, key: string): string {
    const value = object[key];
    if (typeof value !== "string") {
        throw new TypeError(`${key} must be a string`);
    }
    return value;
}

export function requireNullableString(
    object: { readonly [key: string]: JsonValue },
    key: string
): string | undefined {
    const value = object[key];
    if (value === null) return undefined;
    if (typeof value !== "string") {
        throw new TypeError(`${key} must be a string or null`);
    }
    return value;
}

export function requireSafeInteger(
    object: { readonly [key: string]: JsonValue },
    key: string
): number {
    const value = object[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`${key} must be a safe integer`);
    }
    return value;
}

export function requireNonnegativeInteger(
    object: { readonly [key: string]: JsonValue },
    key: string
): number {
    const value = requireSafeInteger(object, key);
    if (value < 0) throw new TypeError(`${key} must be non-negative`);
    return value;
}

export function requireDate(object: { readonly [key: string]: JsonValue }, key: string): Date {
    const value = requireString(object, key);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw new TypeError(`${key} must be a canonical ISO date`);
    }
    return date;
}

export function requireNullableDate(
    object: { readonly [key: string]: JsonValue },
    key: string
): Date | undefined {
    if (object[key] === null) return undefined;
    return requireDate(object, key);
}

export function requireDigest(object: { readonly [key: string]: JsonValue }, key: string): Digest {
    return new Digest(requireString(object, key));
}

export function requireArray(
    object: { readonly [key: string]: JsonValue },
    key: string
): readonly JsonValue[] {
    const value = object[key];
    if (!Array.isArray(value)) throw new TypeError(`${key} must be an array`);
    return value;
}

export function requireCanonicalText(value: string, subject: string): void {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be nonblank canonical text`);
    }
}

export function validDate(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isFinite(time)) throw new TypeError(`${subject} must be a valid Date`);
    return time;
}

export function sameJson(left: JsonValue, right: JsonValue): boolean {
    const leftBytes = encodeCanonicalJson(left);
    const rightBytes = encodeCanonicalJson(right);
    return (
        leftBytes.byteLength === rightBytes.byteLength &&
        leftBytes.every((value, index) => value === rightBytes[index])
    );
}

export function immutableReference<Value>(value: Value): Value {
    return requireFrozenReference(value, new WeakSet<object>()) as Value;
}

function requireFrozenReference(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "function") {
        throw new TypeError("Structural references must not contain functions");
    }
    if (typeof value !== "object" || value === null) return value;
    if (
        value instanceof Date ||
        value instanceof Map ||
        value instanceof Set ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
    ) {
        throw new TypeError("Structural references must use immutable codec values");
    }
    if (value instanceof TextId) {
        if (Object.getPrototypeOf(Object.getPrototypeOf(value)) !== TextId.prototype) {
            throw new TypeError("Structural identifier references must use exact context classes");
        }
        return Object.freeze(value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
        throw new TypeError("Structural references must use data-only prototypes");
    }
    if (seen.has(value)) throw new TypeError("Structural references must not contain cycles");
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            throw new TypeError("Structural references must not contain symbol keys");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
            throw new TypeError("Structural references must not contain accessors");
        }
        requireFrozenReference(descriptor.value, seen);
    }
    seen.delete(value);
    return Object.freeze(value);
}
