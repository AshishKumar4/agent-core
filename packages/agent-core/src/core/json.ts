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

/** Every JavaScript value admitted through an untyped object-property boundary. */
export type UntrustedProperty =
    | boolean
    | number
    | string
    | null
    | bigint
    | symbol
    | CallableFunction
    | readonly UntrustedProperty[]
    | ObjectRecord
    | undefined;

/** An object arriving as `unknown`, before any of its properties are narrowed. */
export type ObjectRecord = {
    readonly [key: string]: UntrustedProperty;
};

export function isJsonString(value: unknown): value is string {
    return typeof value === "string";
}

export function isJsonNumber(value: unknown): value is number {
    return typeof value === "number";
}

export function isJsonBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

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
 * The `unknown` counterpart of isJsonObject. Its recursive property-value type
 * covers the JavaScript value space without falsely claiming nested JSON, so
 * every member still requires its own domain predicate before use.
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

/**
 * The decode boundary shared by every bounded context. Each context decodes the same
 * canonical JSON vocabulary — object, exact field set, string, boolean, non-negative
 * safe integer, array — but reports a malformed record in its own terms: identity
 * raises a `codec.invalid` AgentCoreError where the rest raise TypeError, and the
 * subject wording belongs to the record being decoded. Binding the checks to a failure
 * factory keeps one implementation of what canonical data is while leaving each
 * context its own error vocabulary.
 */
export interface JsonDataParser {
    object(value: JsonValue | undefined, subject: string): JsonObject;

    /**
     * Narrows to exactly `fields` — no missing and no unknown members. `malformed`
     * overrides the wording for contexts whose records describe that failure
     * differently.
     */
    exact<Field extends string>(
        value: JsonObject,
        fields: readonly Field[],
        subject: string,
        malformed?: string
    ): JsonObject & JsonFields<Field>;

    string(value: JsonValue | undefined, subject: string): string;

    /** A string that must also carry at least one character. */
    nonemptyString(value: JsonValue | undefined, subject: string): string;

    /** JSON null stands for an absent string; any other non-string is malformed. */
    nullableString(value: JsonValue | undefined, subject: string): string | undefined;

    boolean(value: JsonValue | undefined, subject: string): boolean;

    safeInteger(value: JsonValue | undefined, subject: string): number;

    array(value: JsonValue | undefined, subject: string): readonly JsonValue[];
}

export function jsonDataParser(fail: (message: string) => Error): JsonDataParser {
    const string = (value: JsonValue | undefined, subject: string): string => {
        if (!isJsonString(value)) throw fail(`${subject} must be a string`);
        return value;
    };
    return Object.freeze({
        object(value: JsonValue | undefined, subject: string): JsonObject {
            if (!isJsonObject(value)) throw fail(`${subject} must be an object`);
            return value;
        },
        exact<Field extends string>(
            value: JsonObject,
            fields: readonly Field[],
            subject: string,
            malformed = "contains missing or unknown fields"
        ): JsonObject & JsonFields<Field> {
            if (!hasExactJsonKeys(value, fields)) throw fail(`${subject} ${malformed}`);
            return value;
        },
        string,
        nonemptyString(value: JsonValue | undefined, subject: string): string {
            if (!isJsonString(value) || value.length === 0) {
                throw fail(`${subject} must be a non-empty string`);
            }
            return value;
        },
        nullableString(value: JsonValue | undefined, subject: string): string | undefined {
            return value === null ? undefined : string(value, subject);
        },
        boolean(value: JsonValue | undefined, subject: string): boolean {
            if (!isJsonBoolean(value)) throw fail(`${subject} must be a boolean`);
            return value;
        },
        safeInteger(value: JsonValue | undefined, subject: string): number {
            if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
                throw fail(`${subject} must be a non-negative safe integer`);
            }
            return value;
        },
        array(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
            if (!isJsonArray(value)) throw fail(`${subject} must be an array`);
            return value;
        }
    });
}

function isJsonValueAt(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
    if (value === null || isJsonBoolean(value)) {
        return true;
    }
    if (isJsonString(value)) {
        return hasOnlyUnicodeScalarValues(value);
    }
    if (isJsonNumber(value)) {
        return Number.isFinite(value);
    }
    if (!Array.isArray(value) && !isObjectRecord(value)) {
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
    value: ObjectRecord,
    ancestors: WeakSet<object>
): value is { readonly [key: string]: JsonValue } {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
        return false;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (!isStringPropertyKey(key) || !hasOnlyUnicodeScalarValues(key)) {
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

function isStringPropertyKey(value: PropertyKey): value is string {
    return typeof value === "string";
}
