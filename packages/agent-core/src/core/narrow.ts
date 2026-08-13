/**
 * Narrowing primitives shared by every bounded context. Decoders reach the same
 * three questions everywhere — is this string one of a closed vocabulary, does this
 * sequence carry at least one entry, and is this sequence made only of strings — and
 * every answer is reachable through a predicate, never through an assertion on the
 * value itself.
 */

import type { JsonValue } from "./json";

export type Nonempty<Value> = readonly [Value, ...Value[]];

export function isMember<Value extends string>(
    vocabulary: readonly Value[],
    candidate: unknown
): candidate is Value {
    const values: readonly string[] = vocabulary;
    return typeof candidate === "string" && values.includes(candidate);
}

export function isNonempty<Value>(values: readonly Value[]): values is Nonempty<Value> {
    return values.length > 0;
}

/**
 * Array.isArray narrows a JsonValue to any[], so a decoder that checks its members
 * inline keeps no record of what it proved and has to assert each one back to string.
 * Asking this instead carries the answer into the type.
 */
export function isStringArray(candidate: JsonValue | undefined): candidate is readonly string[] {
    return Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string");
}

export function requireNonempty<Value>(values: readonly Value[], subject: string): Nonempty<Value> {
    if (!isNonempty(values)) throw new TypeError(`${subject} must not be empty`);
    return values;
}
