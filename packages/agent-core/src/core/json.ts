import { hasOnlyUnicodeScalarValues } from "./unicode";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | {
          readonly [key: string]: JsonValue;
      };

export function isJsonValue(value: unknown): value is JsonValue {
    try {
        return isJsonValueAt(value, new WeakSet<object>());
    } catch {
        return false;
    }
}

export function hasExactJsonKeys(
    value: { readonly [key: string]: JsonValue },
    expected: readonly string[]
): boolean {
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
        ? isJsonArray(value, ancestors)
        : isJsonObject(value, ancestors);
    ancestors.delete(value);
    return valid;
}

function isJsonArray(value: unknown[], ancestors: WeakSet<object>): value is JsonValue[] {
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

function isJsonObject(
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
