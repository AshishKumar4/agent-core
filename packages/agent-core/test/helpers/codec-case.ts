import type { RecordCodec } from "../../src/core";

/**
 * One record paired with the codec that owns it.
 *
 * A table of records of different kinds is a heterogeneous list, so reading the codec and
 * the record out of it separately loses the fact that they belong together, and the codec
 * ends up accepting only their intersection. Binding the pair inside these closures keeps
 * it checked where the case is built: a case made from a codec and a record of another
 * kind does not compile.
 */
export type CodecCase = {
    /** Encodes the case's own record with its own codec. */
    readonly encode: () => Uint8Array;
    /** Decodes then re-encodes, so a round trip can be compared byte for byte. */
    readonly reencode: (bytes: Uint8Array) => Uint8Array;
    /** Whether the decoded record is frozen. */
    readonly decodeIsFrozen: (bytes: Uint8Array) => boolean;
    /** Decodes and discards, for bytes the codec must reject. */
    readonly decode: (bytes: Uint8Array) => void;
};

export function codecCase<Record>(codec: RecordCodec<Record>, record: Record): CodecCase {
    return {
        encode: () => codec.encode(record),
        reencode: (bytes) => codec.encode(codec.decode(bytes)),
        decodeIsFrozen: (bytes) => Object.isFrozen(codec.decode(bytes)),
        decode: (bytes) => {
            codec.decode(bytes);
        }
    };
}
