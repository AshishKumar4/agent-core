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
export { compareCanonicalText as compareText } from "../core";

export type FacetData = JsonValue;
export type FacetDataMap = { readonly [name: string]: FacetData };

export function isFacetData(value: unknown): value is FacetData {
    return isJsonValue(value);
}

export function isFacetDataMap(value: unknown): value is FacetDataMap {
    return isJsonValue(value) && isJsonObject(value);
}

export function canonicalFacetData(value: FacetData): FacetData {
    return freezeFacetData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

export function canonicalFacetDataMap(value: FacetDataMap): FacetDataMap {
    return requireDataObject(canonicalFacetData(value), "Canonical data map");
}

export class DataRecordCodec<Record> extends RecordCodec<Record> {
    readonly #encodeRecord: (record: Record) => FacetData;
    readonly #decodeRecord: (payload: FacetData, version: RecordVersion) => Record;

    public constructor(
        recordClasses: readonly [
            { readonly prototype: Record },
            ...{ readonly prototype: object }[]
        ],
        kind: string,
        encodeRecord: (record: Record) => FacetData,
        decodeRecord: (payload: FacetData, version: RecordVersion) => Record,
        version: RecordVersion = { major: 1, minor: 0 }
    ) {
        super(recordClasses, kind, version);
        this.#encodeRecord = encodeRecord.bind(undefined);
        this.#decodeRecord = decodeRecord.bind(undefined);
        Object.freeze(this);
    }

    protected encodePayload(record: Record): FacetData {
        return this.#encodeRecord(record);
    }

    protected decodePayload(payload: FacetData, version: RecordVersion): Record {
        return this.#decodeRecord(payload, version);
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
    if (value === true || value === false) {
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
    return Object.fromEntries(
        Object.entries(fields).filter(
            (entry): entry is [string, FacetData] => entry[1] !== undefined
        )
    );
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

export function isString(value: FacetData | undefined): value is string {
    return typeof value === "string";
}

export function requireString(value: FacetData | undefined, subject: string): string {
    if (!isString(value)) {
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
    if (value !== true && value !== false) {
        throw new TypeError(`${subject} must be a boolean`);
    }
    return value;
}

/**
 * SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): a declared field that carries a capability
 * rather than a datum is present exactly when the capability is offered, absent otherwise,
 * and a present negative form is refused rather than read as absence. The returned
 * `true | undefined` is what keeps the two encodings from collapsing: a reader asking this
 * field whether the capability is offered cannot get the same answer for a host that never
 * declared it and for one that declared a refusal, and there is no second value a later
 * edit could flip. Every reader and every writer of such a field goes through this one
 * function, so no path exists on which the negative form survives.
 */
export function requireOfferedCapability(
    value: FacetData | undefined,
    subject: string
): true | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value !== true) {
        throw new TypeError(`${subject} must be absent rather than a negative or null value`);
    }
    return value;
}

/**
 * The declared names an Operation's `input` schema may not offer (SPEC §4.1,
 * C13-FACET-CANCELLATION-REACH). Cancellation reaches a handler through its
 * `OperationContext` and never through the declared input, so a schema offering a field
 * that claims to carry it is refused where the declaration is read rather than where an
 * invocation would fail: the input schema is the surface a model authors against, and a
 * cancellation nameable there is omittable and shadowable by an ordinary field.
 *
 * The screen is exact rather than by substring, because the defect is the claim and not the
 * spelling: `cancelReason` states a datum a caller authors, while `cancellation` states the
 * thing only the host owns. Names are compared with separators and case removed, so
 * `abort_signal` and `abortSignal` are one name.
 */
const CANCELLATION_FIELD_NAMES = {
    abort: true,
    abortcontroller: true,
    abortsignal: true,
    cancel: true,
    cancellation: true,
    cancellationsignal: true,
    cancellationtoken: true,
    cancelsignal: true,
    canceltoken: true,
    signal: true
} satisfies Record<string, true>;

/** The keywords whose value is itself one schema, so a nested claim is reached too. */
const SCHEMA_VALUED_KEYWORDS: readonly string[] = [
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties"
];

/** The keywords whose value maps or lists schemas, each of which is screened in turn. */
const SCHEMA_COLLECTION_KEYWORDS: readonly string[] = [
    "$defs",
    "allOf",
    "anyOf",
    "definitions",
    "dependentSchemas",
    "oneOf",
    "patternProperties",
    "prefixItems",
    "properties"
];

/**
 * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): refuses a declared schema that offers a
 * cancellation-carrying field, at any depth. A nested object is the same authored surface
 * one level down, so screening only the top level would leave the claim expressible. A
 * schema requires a name it never declares is screened as well, because a name required
 * where additional properties are admitted is still offered.
 */
export function requireCancellationFreeSchema(
    document: JsonSchemaDocument,
    subject: string
): JsonSchemaDocument {
    if (document === true || document === false) return document;
    const properties = document["properties"];
    const required = document["required"];
    const declared = [
        ...(isJsonObject(properties) ? Object.keys(properties) : []),
        ...(isArray(required) ? required.filter(isString) : [])
    ];
    for (const name of declared) {
        const canonical = name.replaceAll(/[\s_-]+/gu, "").toLowerCase();
        if (Object.hasOwn(CANCELLATION_FIELD_NAMES, canonical)) {
            throw new TypeError(
                `${subject} must not declare ${name}: cancellation reaches a handler through its OperationContext and never through a declared input`
            );
        }
    }
    for (const keyword of SCHEMA_VALUED_KEYWORDS) {
        const nested = document[keyword];
        if (isSchemaDocument(nested)) requireCancellationFreeSchema(nested, subject);
    }
    for (const keyword of SCHEMA_COLLECTION_KEYWORDS) {
        const nested = document[keyword];
        const entries = isArray(nested)
            ? nested
            : isJsonObject(nested)
              ? Object.values(nested)
              : undefined;
        for (const entry of entries ?? []) {
            if (isSchemaDocument(entry)) requireCancellationFreeSchema(entry, subject);
        }
    }
    return document;
}

function isSchemaDocument(value: FacetData | undefined): value is JsonSchemaDocument {
    return value === true || value === false || isJsonObject(value);
}

export function requireSafeInteger(value: FacetData | undefined, subject: string): number {
    if (!isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
    return value;
}

export function requireArray(value: FacetData | undefined, subject: string): readonly FacetData[] {
    if (!isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

/**
 * Reads the array of numbers that carries binary content through canonical JSON. The
 * caller supplies the whole message because the profile owning the field names it, not
 * this parser.
 */
export function requireBytes(value: FacetData | undefined, message: string): Uint8Array {
    if (!isArray(value)) throw new TypeError(message);
    const bytes = new Uint8Array(value.length);
    for (const [index, entry] of value.entries()) {
        if (!isNumber(entry)) throw new TypeError(message);
        bytes[index] = entry;
    }
    return bytes;
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

export function requireNonblank(value: string, subject: string): void {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

/** Freezes a data value and everything beneath it in place, keeping the caller's type. */
export function freezeFacetData<Value extends FacetData>(value: Value): Value {
    if (isArray(value) || isJsonObject(value)) {
        for (const entry of Object.values(value)) {
            freezeFacetData(entry);
        }
        Object.freeze(value);
    }
    return value;
}

function isSafeInteger(value: FacetData | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

export function isNumber(value: FacetData | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isArray(value: FacetData | undefined): value is readonly FacetData[] {
    return Array.isArray(value);
}
