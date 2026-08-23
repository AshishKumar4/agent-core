import { requireSynchronousResult } from "../actors";
import { compareCanonicalText } from "../core";
import { AgentCoreError } from "../errors";

/**
 * How a memory-backed record store holds records: codec bytes keyed by the record's own
 * identity, never live objects. Two Actor-local stores hold contributions this way — Slots
 * and Surfaces — and both owe the same immutability, ordering and revision arithmetic, so
 * the primitives live once rather than once per store.
 */
export type RecordMap = Map<string, Uint8Array>;

export function cloneRecordMap(records: RecordMap): RecordMap {
    return new Map([...records].map(([key, bytes]) => [key, bytes.slice()]));
}

/**
 * Writes a record, refusing a rewrite of one already held. Attribution is immutable for a
 * record's lifetime (SPEC §4.2), so superseding a record is a retirement followed by a
 * fresh materialization and never a write over the bytes it replaces.
 */
export function insertImmutable(
    records: RecordMap,
    key: string,
    bytes: Uint8Array,
    subject: string
): void {
    const previous = records.get(key);
    if (previous !== undefined && !equalBytes(previous, bytes)) {
        throw new AgentCoreError("protocol.invalid-state", `${subject} ${key} is immutable`);
    }
    records.set(key, bytes.slice());
}

/** The records in the one order every store lists them in, so two reads agree. */
export function orderedRecords(records: RecordMap): readonly (readonly [string, Uint8Array])[] {
    return [...records].sort(([left], [right]) => compareCanonicalText(left, right));
}

export function sameRecordMaps(left: RecordMap, right: RecordMap): boolean {
    if (left.size !== right.size) return false;
    for (const [key, bytes] of left) {
        const other = right.get(key);
        if (other === undefined || !equalBytes(bytes, other)) return false;
    }
    return true;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

/**
 * An Actor-local transaction is synchronous, so a callback that returned a promise escaped
 * the transaction rather than ran inside it. The caller names the store, because the code
 * is a protocol violation of that store and not of the guard. Only the async refusal is
 * relabelled: any other failure is a defect in the guard itself and is rethrown as it came,
 * because reporting it as a store protocol violation would name the wrong cause.
 */
export function requireSynchronousRecordResult<Result>(result: Result, subject: string): Result {
    try {
        return requireSynchronousResult(result);
    } catch (error) {
        if (error instanceof TypeError) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `${subject} transactions must be synchronous`
            );
        }
        throw error;
    }
}
