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

export interface RecordClass<Record = object> {
    readonly prototype: Record;
}

export type RecordClasses<Record> = readonly [RecordClass<Record>, ...RecordClass[]];

const functionSource = Function.prototype.toString;

export abstract class RecordCodec<Record> {
    public readonly kind: string;
    public readonly version: RecordVersion;

    protected constructor(
        recordClasses: RecordClasses<Record>,
        kind: string,
        version: RecordVersion
    ) {
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
        sealRecordClasses(recordClasses);
        this.#encodePayload = this.encodePayload.bind(this);
        this.#decodePayload = this.decodePayload.bind(this);
        const encode = this.encode.bind(this);
        const decode = this.decode.bind(this);
        Object.defineProperties(this, {
            decode: {
                configurable: false,
                enumerable: false,
                value: (bytes: Uint8Array): Record => decode(bytes),
                writable: false
            },
            encode: {
                configurable: false,
                enumerable: false,
                value: (record: Record): Uint8Array => encode(record),
                writable: false
            },
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

    readonly #decodePayload: (payload: JsonValue, version: RecordVersion) => Record;
    readonly #encodePayload: (record: Record) => JsonValue;

    public encode(record: Record): Uint8Array {
        return encodeCanonicalJson({
            kind: this.kind,
            version: {
                major: this.version.major,
                minor: this.version.minor
            },
            payload: this.#encodePayload(record)
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
        assertCompatibleRecordVersion(this.kind, value.version, this.version);
        const version = Object.freeze({
            major: value.version.major,
            minor: value.version.minor
        });
        try {
            return this.#decodePayload(value.payload, version);
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

/**
 * The single §8.3 compatibility decision shared by every record-codec reader:
 * an unknown major fails as codec.unknown-major, an unsupported newer minor
 * fails as codec.invalid, and an older minor tolerates read within the major.
 * Both components must already be non-negative safe integers.
 */
export function assertCompatibleRecordVersion(
    subject: string,
    declared: RecordVersion,
    supported: RecordVersion
): void {
    if (declared.major !== supported.major) {
        throw new AgentCoreError(
            "codec.unknown-major",
            `Unsupported ${subject} codec major ${declared.major}`
        );
    }
    if (declared.minor > supported.minor) {
        throw new AgentCoreError(
            "codec.invalid",
            `Unsupported ${subject} codec minor ${declared.minor}`
        );
    }
}

function sealRecordClasses<Record>(recordClasses: RecordClasses<Record>): void {
    const classes = validateAndDetachRecordClasses(recordClasses);
    for (const recordClass of classes) {
        Object.freeze(recordClass.prototype);
        Object.freeze(recordClass);
    }
}

function validateAndDetachRecordClasses<Record>(
    recordClasses: RecordClasses<Record>
): ReadonlyArray<RecordClass> {
    if (
        !Array.isArray(recordClasses) ||
        Object.getPrototypeOf(recordClasses) !== Array.prototype ||
        recordClasses.length === 0 ||
        Reflect.ownKeys(recordClasses).length !== recordClasses.length + 1
    ) {
        throw new TypeError("Record codec must name a nonempty ordinary class tuple");
    }
    const detached: RecordClass[] = [];
    for (let index = 0; index < recordClasses.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(recordClasses, index);
        const candidate = descriptor?.value;
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable ||
            !isOrdinaryRecordClass(candidate)
        ) {
            throw new TypeError("Record codec classes must be ordinary class constructors");
        }
        if (!detached.includes(candidate)) detached.push(candidate);
    }
    return Object.freeze(detached);
}

function isOrdinaryRecordClass(value: unknown): value is RecordClass {
    if (typeof value !== "function") return false;
    if (!functionSource.call(value).startsWith("class")) return false;
    const prototype = Object.getOwnPropertyDescriptor(value, "prototype")?.value;
    if (!isObjectPrototype(prototype)) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    return constructor !== undefined && "value" in constructor && constructor.value === value;
}

function isObjectPrototype(value: unknown): value is object {
    return typeof value === "object" && value !== null;
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
