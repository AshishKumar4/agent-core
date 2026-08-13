import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core";

/** Any definition record that can encode itself to canonical data and be decoded back. */
export interface CanonicalRecord {
    toData(): JsonValue;
}

/**
 * A record's canonical data as the object its decoder will see. Codec tests corrupt one field of
 * a valid encoding and decode it again, which needs the object form; narrowing here rather than
 * asserting at each call site means a record whose data stopped being an object fails loudly at
 * the fixture instead of silently spreading nothing into the corrupted copy.
 */
export function recordData(record: CanonicalRecord): JsonObject {
    return requireObject(record.toData(), "canonical record data");
}

/** Narrows one field of already decoded data so a nested field can be read or replaced. */
export function requireObject(value: JsonValue, subject = "value"): JsonObject {
    if (!isJsonObject(value)) throw new TypeError(`Expected ${subject} to be an object`);
    return value;
}
