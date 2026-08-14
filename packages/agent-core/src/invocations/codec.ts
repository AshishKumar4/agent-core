import {
    type JsonFields,
    Digest,
    TextId,
    encodeCanonicalJson,
    jsonDataParser,
    type JsonObject,
    type JsonValue
} from "../core";

export interface StructuralCodec<Value> {
    encode(value: Value): JsonValue;
    decode(value: JsonValue): Value;
}

const parse = jsonDataParser((message) => new TypeError(message));

export function requireObject(value: JsonValue | undefined, subject: string): JsonObject {
    return parse.object(value, subject);
}

export function requireExactObject<Field extends string>(
    value: JsonValue | undefined,
    fields: readonly Field[],
    subject: string
): JsonFields<Field> {
    return parse.exact(requireObject(value, subject), fields, subject);
}

export function requireString(object: JsonObject, key: string, subject = key): string {
    return parse.string(object[key], subject);
}

export function requireNullableString(
    object: JsonObject,
    key: string,
    subject = key
): string | undefined {
    const value = object[key];
    if (value === null) return undefined;
    if (!isString(value)) throw new TypeError(`${subject} must be a string or null`);
    return value;
}

export function requireSafeInteger(object: JsonObject, key: string, subject = key): number {
    const value = object[key];
    if (!isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
    return value;
}

export function requireNonnegativeInteger(object: JsonObject, key: string): number {
    const value = requireSafeInteger(object, key);
    if (value < 0) throw new TypeError(`${key} must be non-negative`);
    return value;
}

export function requireDate(object: JsonObject, key: string): Date {
    const value = requireString(object, key);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw new TypeError(`${key} must be a canonical ISO date`);
    }
    return date;
}

export function requireNullableDate(object: JsonObject, key: string): Date | undefined {
    if (object[key] === null) return undefined;
    return requireDate(object, key);
}

export function requireDigest(object: JsonObject, key: string): Digest {
    return new Digest(requireString(object, key));
}

export function requireArray(object: JsonObject, key: string): readonly JsonValue[] {
    return parse.array(object[key], key);
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
    return requireFrozenReference(value, new WeakSet<object>());
}

function requireFrozenReference<Value>(value: Value, seen: WeakSet<object>): Value {
    if (isCallable(value)) {
        throw new TypeError("Structural references must not contain functions");
    }
    if (!isReferenceObject(value)) return value;
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
        if (!isStringPropertyKey(key)) {
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

function isSafeInteger(value: JsonValue | undefined): value is number {
    return Number.isSafeInteger(value);
}

function isString(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function isCallable(value: unknown): value is CallableFunction {
    return typeof value === "function";
}

function isReferenceObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isStringPropertyKey(value: PropertyKey): value is string {
    return typeof value === "string";
}
