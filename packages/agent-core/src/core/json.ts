import { hasOnlyUnicodeScalarValues } from "./unicode";

export type JsonPrimitive = boolean | number | string | null;

export type JsonObject = {
    readonly [key: string]: JsonValue;
};

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/** A JsonObject whose named fields are known to be present. */
export type JsonFields<Field extends string> = JsonObject & {
    readonly [Key in Field]: JsonValue;
};

/** An object arriving as `unknown`, before any of its properties are narrowed. */
export type ObjectRecord = {
    readonly [key: string]: unknown;
};

export function isJsonValue(value: unknown): value is JsonValue {
    try {
        return isJsonValueAt(value, new WeakSet<object>());
    } catch {
        return false;
    }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

/**
 * The `unknown` counterpart of isJsonObject: narrows an untrusted value to a
 * property bag whose members are still `unknown`, so each one must be narrowed
 * on its own before use.
 */
export function isObjectRecord(value: unknown): value is ObjectRecord {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

export function hasExactJsonKeys<Field extends string>(
    value: JsonObject,
    expected: readonly Field[]
): value is JsonFields<Field> {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isJsonValueAt(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
    if (value === null || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "string") {
        return hasOnlyUnicodeScalarValues(value);
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value !== "object") {
        return false;
    }
    if (ancestors.has(value)) {
        return false;
    }

    ancestors.add(value);
    const valid = Array.isArray(value)
        ? isJsonArrayAt(value, ancestors)
        : isJsonObjectAt(value, ancestors);
    ancestors.delete(value);
    return valid;
}

function isJsonArrayAt(value: unknown[], ancestors: WeakSet<object>): value is JsonValue[] {
    if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
    ) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor) ||
            !isJsonValueAt(descriptor.value, ancestors)
        ) {
            return false;
        }
    }
    return true;
}

function isJsonObjectAt(
    value: object,
    ancestors: WeakSet<object>
): value is { readonly [key: string]: JsonValue } {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
        return false;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !hasOnlyUnicodeScalarValues(key)) {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor) ||
            !isJsonValueAt(descriptor.value, ancestors)
        ) {
            return false;
        }
    }
    return true;
}
