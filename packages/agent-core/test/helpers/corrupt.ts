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

function mutableObject(value: JsonValue | undefined, segment: string): MutableJsonObject {
    if (!isMutableJsonObject(value)) {
        throw new TypeError(`Corruption path segment ${segment} is not an object`);
    }
    return value;
}

function isMutableJsonObject(value: JsonValue | undefined): value is MutableJsonObject {
    return (
        value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    );
}
