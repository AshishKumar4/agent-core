// @ts-nocheck
import { Digest, Revision, type JsonValue, type RecordCodec } from "../core";

export type JsonObject = { readonly [key: string]: JsonValue };

export abstract class CodecRecord {
    public static readonly encode = function <Value>(
        this: { readonly codec: RecordCodec<Value> },
        value: Value
    ): Uint8Array {
        return this.codec.encode(value);
    };

    public static readonly decode = function <Value>(
        this: { readonly codec: RecordCodec<Value> },
        bytes: Uint8Array
    ): Value {
        return this.codec.decode(bytes);
    };
}

export function requireObject(value: JsonValue, subject: string): JsonObject {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as JsonObject;
}

export function requireExactFields(
    value: JsonObject,
    required: readonly string[],
    optional: readonly string[],
    subject: string
): void {
    const expected = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    if (required.some((key) => !(key in value)) || keys.some((key) => !expected.has(key))) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

export function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${subject} must be a non-empty string`);
    }
    return value;
}

export function requireOptionalString(
    value: JsonValue | undefined,
    subject: string
): string | undefined {
    return value === undefined || value === null ? undefined : requireString(value, subject);
}

export function requireInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

export function requireTimestamp(value: JsonValue | undefined, subject: string): Date {
    const timestamp = requireInteger(value, subject);
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()))
        throw new TypeError(`${subject} must be a valid timestamp`);
    return date;
}

export function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
    return value;
}

export function revisionData(revision: Revision): number {
    return revision.value;
}

export function revisionFromData(value: JsonValue | undefined, subject: string): Revision {
    return new Revision(requireInteger(value, subject));
}

export function digestFromData(value: JsonValue | undefined, subject: string): Digest {
    return new Digest(requireString(value, subject));
}

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
