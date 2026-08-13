import {
    RecordCodec,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    isJsonValue,
    requireNonempty,
    type JsonSchemaDocument,
    type JsonValue,
    type Nonempty,
    type RecordVersion
} from "../core";

export type FacetData = JsonValue;
export type FacetDataMap = { readonly [name: string]: FacetData };

export function isFacetData(value: unknown): value is FacetData {
    return isJsonValue(value);
}

export function isFacetDataMap(value: unknown): value is FacetDataMap {
    return isFacetData(value) && isJsonObject(value);
}

export function canonicalFacetData(value: FacetData): FacetData {
    return freezeFacetData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

export function canonicalFacetDataMap(value: FacetDataMap): FacetDataMap {
    return requireDataObject(canonicalFacetData(value), "Canonical data map");
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

export function requireDataObject(value: FacetData | undefined, subject: string): FacetDataMap {
    if (!isJsonObject(value)) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value;
}

/**
 * A declaration's schema field, which JSON Schema states either as a document or as the
 * boolean that admits or rejects everything.
 */
export function requireSchemaDocument(
    value: FacetData | undefined,
    subject: string
): JsonSchemaDocument {
    if (typeof value === "boolean") {
        return value;
    }
    if (!isJsonObject(value)) {
        throw new TypeError(`${subject} must be an object or boolean`);
    }
    return value;
}

/**
 * Builds a data record from named fields, dropping every field whose value is absent. An
 * optional field has to be missing rather than null: `requireExactFields` admits only the
 * fields a declaration names, and canonical JSON distinguishes an omitted key from an
 * explicit null, so encoding an absent field as null would change the record's identity.
 */
export function dataRecord(fields: {
    readonly [name: string]: FacetData | undefined;
}): FacetDataMap {
    const record: { [name: string]: FacetData } = {};
    for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) record[name] = value;
    }
    return record;
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
    if (!isSafeInteger(value)) {
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

/**
 * Restates a chosen set of vocabulary values in the vocabulary's own canonical order, so
 * that two declarations naming the same values encode identically. Unknown, repeated, and
 * empty selections are rejected here rather than reaching a comparison downstream.
 */
export function canonicalOrder<Value extends string>(
    values: readonly Value[],
    order: readonly Value[],
    subject: string
): Nonempty<Value> {
    if (values.length === 0 || values.some((value) => !order.includes(value))) {
        throw new TypeError(`${subject} must contain known values`);
    }
    if (new Set(values).size !== values.length) {
        throw new TypeError(`${subject} must be unique`);
    }
    return requireNonempty(Object.freeze(order.filter((value) => values.includes(value))), subject);
}

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function requireNonblank(value: string, subject: string): void {
    if (value.length === 0 || value !== value.trim()) {
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
    if (isJsonObject(value)) {
        for (const entry of Object.values(value)) {
            freezeFacetData(entry);
        }
        return Object.freeze(value);
    }
    return value;
}

// Number.isSafeInteger is already the complete check — it is false for every non-number —
// but it carries no type predicate, so a paired `typeof` test would be a guard no test
// could ever reach. This gives the check the narrowing it lacks instead.
function isSafeInteger(value: FacetData | undefined): value is number {
    return Number.isSafeInteger(value);
}
