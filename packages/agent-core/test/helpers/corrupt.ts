import type { JsonValue } from "../../src/core";

type MutableJsonObject = { [key: string]: JsonValue };

/**
 * Builds a deliberately invalid copy of a decoded record so a codec can be shown
 * rejecting it. The corruption is applied to a structured clone, so the encoding of the
 * original and the encoding of the result differ in exactly the named field.
 */
export function corrupt(
    record: JsonValue,
    parentPath: readonly string[],
    field: string,
    value: JsonValue
): JsonValue {
    const copy: JsonValue = structuredClone(record);
    let cursor = mutableObject(copy, "record");
    for (const segment of parentPath) cursor = mutableObject(cursor[segment], segment);
    cursor[field] = value;
    return copy;
}

// The clone is freshly owned by this helper, so dropping `readonly` to write the
// corrupted field cannot reach the record the caller passed in.
function mutableObject(value: JsonValue | undefined, segment: string): MutableJsonObject {
    if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`Corruption path segment ${segment} is not an object`);
    }
    return value as MutableJsonObject;
}
