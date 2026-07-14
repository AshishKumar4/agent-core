import { AgentCoreError } from "../errors";
import { decodeCanonicalJson, encodeCanonicalJson } from "./canonical";
import { hasExactJsonKeys, type JsonValue } from "./json";
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
            typeof kind !== "string" ||
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
            throw new AgentCoreError(
                "codec.invalid",
                `Invalid ${this.kind} record: ${errorMessage(error)}`
            );
        }
    }

    protected abstract encodePayload(record: Record): JsonValue;

    protected abstract decodePayload(payload: JsonValue, version: RecordVersion): Record;
}

function isEnvelope(value: JsonValue): value is JsonValue & RecordEnvelope {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        return false;
    }
    const object = value as { readonly [key: string]: JsonValue };
    const version = object["version"];
    return (
        hasExactJsonKeys(object, ["kind", "payload", "version"]) &&
        typeof object["kind"] === "string" &&
        isJsonObject(version) &&
        hasExactJsonKeys(version, ["major", "minor"]) &&
        Number.isSafeInteger(version["major"]) &&
        typeof version["major"] === "number" &&
        version["major"] >= 0 &&
        Number.isSafeInteger(version["minor"]) &&
        typeof version["minor"] === "number" &&
        version["minor"] >= 0 &&
        Object.hasOwn(object, "payload")
    );
}

function isJsonObject(
    value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
    return (
        value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object"
    );
}

function validateAndDetachVersion(version: RecordVersion): RecordVersion {
    if (
        typeof version !== "object" ||
        version === null ||
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
    const major = majorDescriptor.value as unknown;
    const minor = minorDescriptor.value as unknown;
    if (
        typeof major !== "number" ||
        !Number.isSafeInteger(major) ||
        major < 0 ||
        typeof minor !== "number" ||
        !Number.isSafeInteger(minor) ||
        minor < 0
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    return Object.freeze({ major, minor });
}

function hasExactVersionKeys(version: object): boolean {
    const keys = Reflect.ownKeys(version);
    return keys.length === 2 && keys.includes("major") && keys.includes("minor");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
