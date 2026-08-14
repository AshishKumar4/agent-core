import { AgentCoreError } from "../errors";
import { decodeCanonicalJson, encodeCanonicalJson } from "./canonical";
import {
    hasExactJsonKeys,
    isJsonNumber,
    isJsonObject,
    isJsonString,
    isObjectRecord,
    type JsonValue
} from "./json";
import { hasOnlyUnicodeScalarValues } from "./unicode";

export interface RecordVersion {
    readonly major: number;
    readonly minor: number;
}

export interface RecordEnvelope {
    readonly kind: string;
    readonly version: RecordVersion;
    readonly payload: JsonValue;
}

export abstract class RecordCodec<Record> {
    public readonly kind: string;
    public readonly version: RecordVersion;

    protected constructor(kind: string, version: RecordVersion) {
        if (
            !isJsonString(kind) ||
            kind.trim().length === 0 ||
            kind !== kind.trim() ||
            !hasOnlyUnicodeScalarValues(kind)
        ) {
            throw new TypeError("Record codec kind must be a nonblank canonical string");
        }
        this.kind = kind;
        this.version = validateAndDetachVersion(version);
        Object.defineProperties(this, {
            kind: {
                configurable: false,
                enumerable: true,
                value: this.kind,
                writable: false
            },
            version: {
                configurable: false,
                enumerable: true,
                value: this.version,
                writable: false
            }
        });
    }

    public encode(record: Record): Uint8Array {
        return encodeCanonicalJson({
            kind: this.kind,
            version: {
                major: this.version.major,
                minor: this.version.minor
            },
            payload: this.encodePayload(record)
        });
    }

    public decode(bytes: Uint8Array): Record {
        const value = decodeCanonicalJson(bytes);
        if (!isEnvelope(value)) {
            throw new AgentCoreError("codec.invalid", "Record envelope is malformed");
        }
        if (value.kind !== this.kind) {
            throw new AgentCoreError("codec.invalid", `Expected record kind ${this.kind}`);
        }
        if (value.version.major !== this.version.major) {
            throw new AgentCoreError(
                "codec.unknown-major",
                `Unsupported ${this.kind} codec major ${value.version.major}`
            );
        }
        if (value.version.minor > this.version.minor) {
            throw new AgentCoreError(
                "codec.invalid",
                `Unsupported ${this.kind} codec minor ${value.version.minor}`
            );
        }
        const version = Object.freeze({
            major: value.version.major,
            minor: value.version.minor
        });
        try {
            return this.decodePayload(value.payload, version);
        } catch (error) {
            if (error instanceof AgentCoreError) {
                throw error;
            }
            if (!(error instanceof TypeError)) throw error;
            const message = error.message;
            throw new AgentCoreError("codec.invalid", `Invalid ${this.kind} record: ${message}`);
        }
    }

    protected abstract encodePayload(record: Record): JsonValue;

    protected abstract decodePayload(payload: JsonValue, version: RecordVersion): Record;
}

function isEnvelope(value: JsonValue): value is JsonValue & RecordEnvelope {
    if (!isJsonObject(value)) {
        return false;
    }
    const version = value["version"];
    return (
        hasExactJsonKeys(value, ["kind", "payload", "version"]) &&
        isJsonString(value["kind"]) &&
        isJsonObject(version) &&
        hasExactJsonKeys(version, ["major", "minor"]) &&
        Number.isSafeInteger(version["major"]) &&
        isJsonNumber(version["major"]) &&
        version["major"] >= 0 &&
        Number.isSafeInteger(version["minor"]) &&
        isJsonNumber(version["minor"]) &&
        version["minor"] >= 0 &&
        Object.hasOwn(value, "payload")
    );
}

function validateAndDetachVersion(version: RecordVersion): RecordVersion {
    if (
        !isObjectRecord(version) ||
        Object.getPrototypeOf(version) !== Object.prototype ||
        !hasExactVersionKeys(version)
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    const majorDescriptor = Object.getOwnPropertyDescriptor(version, "major");
    const minorDescriptor = Object.getOwnPropertyDescriptor(version, "minor");
    if (
        majorDescriptor === undefined ||
        minorDescriptor === undefined ||
        !("value" in majorDescriptor) ||
        !("value" in minorDescriptor) ||
        !majorDescriptor.enumerable ||
        !minorDescriptor.enumerable
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    const major: unknown = majorDescriptor.value;
    const minor: unknown = minorDescriptor.value;
    if (
        !isJsonNumber(major) ||
        !Number.isSafeInteger(major) ||
        major < 0 ||
        !isJsonNumber(minor) ||
        !Number.isSafeInteger(minor) ||
        minor < 0
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    return Object.freeze({ major, minor });
}

function hasExactVersionKeys(version: RecordVersion): boolean {
    const keys = Reflect.ownKeys(version);
    return keys.length === 2 && keys.includes("major") && keys.includes("minor");
}
