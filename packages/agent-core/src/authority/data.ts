import {
    type JsonFields,
    decodeCanonicalJson,
    encodeCanonicalJson,
    jsonDataParser,
    type JsonValue
} from "../core";

export type JsonObject = { readonly [key: string]: JsonValue };

const parse = jsonDataParser((message) => new TypeError(message));

export function requireObject(value: JsonValue | undefined, name: string): JsonObject {
    return parse.object(value, name);
}

export function requireExact<Field extends string>(
    object: JsonObject,
    keys: readonly Field[],
    name: string
): asserts object is JsonFields<Field> {
    parse.exact(object, keys, name);
}

export function requireString(object: JsonObject, key: string, name = key): string {
    return parse.string(object[key], name);
}

export function requireBoolean(object: JsonObject, key: string, name = key): boolean {
    return parse.boolean(object[key], name);
}

export function requireSafeInteger(object: JsonObject, key: string, name = key): number {
    return parse.safeInteger(object[key], name);
}

export function requireArray(value: JsonValue | undefined, name: string): readonly JsonValue[] {
    return parse.array(value, name);
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
