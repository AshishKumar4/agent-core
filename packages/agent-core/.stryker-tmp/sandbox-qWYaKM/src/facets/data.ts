// @ts-nocheck
import {
    RecordCodec,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonValue,
    type JsonValue,
    type RecordVersion
} from "../core";

export type FacetData = JsonValue;
export type FacetDataMap = { readonly [name: string]: FacetData };

export function isFacetData(value: unknown): value is FacetData {
    return isJsonValue(value);
}

export function isFacetDataMap(value: unknown): value is FacetDataMap {
    return isFacetData(value) && isDataObject(value);
}

export function canonicalFacetData(value: FacetData): FacetData {
    return freezeFacetData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

export function canonicalFacetDataMap(value: FacetDataMap): FacetDataMap {
    return canonicalFacetData(value) as FacetDataMap;
}

export class DataRecordCodec<Record> extends RecordCodec<Record> {
    public constructor(
        kind: string,
        private readonly encodeRecord: (record: Record) => FacetData,
        private readonly decodeRecord: (payload: FacetData, version: RecordVersion) => Record,
        version: RecordVersion = { major: 1, minor: 0 }
    ) {
        super(kind, version);
        Object.freeze(this.version);
        Object.freeze(this);
    }

    protected encodePayload(record: Record): FacetData {
        return this.encodeRecord(record);
    }

    protected decodePayload(payload: FacetData, version: RecordVersion): Record {
        return this.decodeRecord(payload, version);
    }
}

export function requireDataObject(value: FacetData, subject: string): FacetDataMap {
    if (!isDataObject(value)) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value;
}

export function requireExactFields(
    value: FacetDataMap,
    required: readonly string[],
    optional: readonly string[] = []
): void {
    const admitted = new Set([...required, ...optional]);
    if (
        required.some((field) => !(field in value)) ||
        Object.keys(value).some((field) => !admitted.has(field))
    ) {
        throw new TypeError("Declaration contains missing or unknown fields");
    }
}

export function requireString(value: FacetData | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

export function requireOptionalString(
    value: FacetData | undefined,
    subject: string
): string | undefined {
    return value === undefined ? undefined : requireString(value, subject);
}

export function requireBoolean(value: FacetData | undefined, subject: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${subject} must be a boolean`);
    }
    return value;
}

export function requireSafeInteger(value: FacetData | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
    return value;
}

export function requireArray(value: FacetData | undefined, subject: string): readonly FacetData[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function requireNonblank(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

function freezeFacetData(value: FacetData): FacetData {
    if (Array.isArray(value)) {
        for (const entry of value) {
            freezeFacetData(entry);
        }
        return Object.freeze(value);
    }
    if (isDataObject(value)) {
        for (const entry of Object.values(value)) {
            freezeFacetData(entry);
        }
        return Object.freeze(value);
    }
    return value;
}

function isDataObject(value: FacetData): value is FacetDataMap {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}
