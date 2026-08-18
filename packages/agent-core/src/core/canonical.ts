import { AgentCoreError } from "../errors";
import { isJsonValue, type JsonValue } from "./json";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeCanonicalJson(value: JsonValue): Uint8Array {
    if (!isJsonValue(value)) {
        throw new AgentCoreError("codec.invalid", "Value is not canonical JSON data");
    }
    try {
        return encoder.encode(canonicalString(value));
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError(
            "codec.invalid",
            `Invalid canonical JSON value: ${errorMessage(error)}`
        );
    }
}

export function decodeCanonicalJson(bytes: Uint8Array): JsonValue {
    let source: Uint8Array;
    let value: unknown;
    try {
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("Canonical JSON input must be a Uint8Array");
        }
        source = new Uint8Array(bytes);
        value = JSON.parse(decoder.decode(source));
    } catch (error) {
        throw new AgentCoreError("codec.invalid", `Invalid canonical JSON: ${errorMessage(error)}`);
    }
    if (!isJsonValue(value)) {
        throw new AgentCoreError("codec.invalid", "Decoded value is not canonical JSON data");
    }
    if (!bytesEqual(source, encodeCanonicalJson(value))) {
        throw new AgentCoreError("codec.invalid", "JSON bytes are not in canonical form");
    }
    return value;
}

/**
 * The repository's one ordering law: compare by UTF-16 code unit, the same order
 * `encodeCanonicalJson` imposes on object keys. Unlike `localeCompare` it is total --
 * it returns 0 only for equal strings -- and independent of the host locale and ICU
 * build, so any two hosts derive the same order and therefore the same digest.
 */
export function compareText(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/** Equality by canonical bytes: the only sound way to compare two JSON values. */
export function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean {
    return bytesEqual(encodeCanonicalJson(left), encodeCanonicalJson(right));
}

function canonicalString(value: JsonValue): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new AgentCoreError("codec.invalid", "Canonical JSON numbers must be finite");
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalString).join(",")}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalString(entry)}`).join(",")}}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) {
        return false;
    }
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}
