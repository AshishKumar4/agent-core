import { decodeCanonicalJson, jsonDataParser, type RecordEnvelope } from "../../src/core";

export interface RecordCodecCase {
    readonly name: string;
    readonly bytes: Uint8Array;
    decode(bytes: Uint8Array): void;
    fixtureIsFrozen(): boolean;
    roundTrip(): Uint8Array;
}

export function recordCodecCase<Record>(
    name: string,
    record: Record,
    encodeRecord: (record: Record) => Uint8Array,
    decodeRecord: (bytes: Uint8Array) => Record
): RecordCodecCase {
    const bytes = encodeRecord(record);
    return {
        name,
        bytes,
        decode(candidate) {
            decodeRecord(candidate);
        },
        fixtureIsFrozen() {
            return Object.isFrozen(decodeRecord(bytes));
        },
        roundTrip() {
            return encodeRecord(decodeRecord(bytes));
        }
    };
}

const recordParser = jsonDataParser((message) => new TypeError(message));

export function decodeRecordEnvelope(bytes: Uint8Array): RecordEnvelope {
    const envelope = recordParser.exact(
        recordParser.object(decodeCanonicalJson(bytes), "Record envelope"),
        ["kind", "version", "payload"],
        "Record envelope"
    );
    const version = recordParser.exact(
        recordParser.object(envelope["version"], "Record version"),
        ["major", "minor"],
        "Record version"
    );
    return {
        kind: recordParser.string(envelope["kind"], "Record kind"),
        version: {
            major: recordParser.safeInteger(version["major"], "Record major version"),
            minor: recordParser.safeInteger(version["minor"], "Record minor version")
        },
        payload: envelope["payload"]
    };
}
