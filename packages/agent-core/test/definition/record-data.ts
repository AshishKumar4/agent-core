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

/**
 * Copies an already validated record onto a bare instance of its own class with fields replaced.
 * These records enforce their invariants in their constructors, so a value that violates one can
 * only be built by skipping it — and the codecs and store checks that re-validate on the way back
 * out exist precisely to catch a record that did.
 */
export function tamperedRecord<TRecord extends object>(
    source: TRecord,
    overrides: Partial<TRecord>
): TRecord {
    // SAFETY: the copy carries the source's prototype and fields but never ran its constructor,
    // so its invariants are unchecked. Callers hand it straight to the code asserted to reject it.
    const bare = Object.create(Object.getPrototypeOf(source)) as TRecord;
    return Object.assign(bare, source, overrides);
}
