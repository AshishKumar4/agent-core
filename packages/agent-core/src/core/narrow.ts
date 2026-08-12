/**
 * Narrowing primitives shared by every bounded context. Decoders reach the same
 * two questions everywhere — is this string one of a closed vocabulary, and does
 * this sequence carry at least one entry — and both answers are only reachable
 * through a predicate, never through an assertion on the value itself.
 */

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

export function requireNonempty<Value>(values: readonly Value[], subject: string): Nonempty<Value> {
    if (!isNonempty(values)) throw new TypeError(`${subject} must not be empty`);
    return values;
}
