import Ajv2020 from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { AgentCoreError } from "../errors";
import { canonicalJsonCopy, encodeCanonicalJson, frozenCanonicalJson } from "./canonical";
import { RecordCodec, type RecordVersion } from "./codec";
import {
    hasExactJsonKeys,
    isJsonBoolean,
    isJsonObject,
    isJsonString,
    isJsonValue,
    type JsonValue
} from "./json";

export type JsonSchemaDocument = boolean | { readonly [key: string]: JsonValue };

export interface JsonSchemaValidator {
    validate(schema: JsonSchemaDocument, value: JsonValue): boolean;
}

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SUPPORTED_FORMATS = new Set(["uri"]);

export class StrictJsonSchemaValidator implements JsonSchemaValidator {
    // Compiled validators are memoized by canonical schema identity. The memo is
    // bounded because schemas also arrive from decoded records, where an unbounded
    // cache would let untrusted definitions grow memory without limit.
    static readonly #compiledLimit = 512;
    readonly #compiled = new Map<string, (value: JsonValue) => boolean>();

    public assertSchema(schema: JsonSchemaDocument): void {
        this.validateAndCompile(schema);
    }

    public assertSupportedSchema(schema: JsonSchemaDocument): void {
        assertSupportedSchema(frozenCanonicalJson(schema));
    }

    public validate(schema: JsonSchemaDocument, value: JsonValue): boolean {
        const validate = this.validateAndCompile(schema);
        return validate(frozenCanonicalJson(value));
    }

    private validateAndCompile(schema: JsonSchemaDocument): (value: JsonValue) => boolean {
        const canonical = frozenCanonicalJson(schema);
        const key = new TextDecoder().decode(encodeCanonicalJson(canonical));
        const memoized = this.#compiled.get(key);
        if (memoized !== undefined) return memoized;
        assertSupportedSchema(canonical);
        let compiled: (value: JsonValue) => boolean;
        try {
            compiled = createAjv().compile<JsonValue>(canonical);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new TypeError(`Unsupported JSON Schema: ${message}`);
        }
        if (this.#compiled.size >= StrictJsonSchemaValidator.#compiledLimit) {
            const oldest = this.#compiled.keys().next().value;
            if (oldest !== undefined) this.#compiled.delete(oldest);
        }
        this.#compiled.set(key, compiled);
        return compiled;
    }
}

export const strictJsonSchemaValidator = new StrictJsonSchemaValidator();

class JsonSchemaCodec extends RecordCodec<JsonSchema> {
    public constructor() {
        super("core.json-schema", { major: 1, minor: 0 });
    }

    protected encodePayload(schema: JsonSchema): JsonValue {
        return { document: schema.document };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): JsonSchema {
        if (!isJsonObject(payload) || !hasExactJsonKeys(payload, ["document"])) {
            throw new AgentCoreError("codec.invalid", "JSON Schema payload is malformed");
        }
        const document = payload["document"];
        if (!isSchemaDocument(document)) {
            throw new AgentCoreError(
                "codec.invalid",
                "JSON Schema document must be an object or boolean"
            );
        }
        return new JsonSchema(document);
    }
}

const jsonSchemaCodec = new JsonSchemaCodec();

export class JsonSchema {
    public readonly document: JsonSchemaDocument;

    public constructor(document: JsonSchemaDocument) {
        if (!isSchemaDocument(document)) {
            throw new TypeError(
                "JSON Schema document must be canonical JSON object or boolean data"
            );
        }
        this.document = frozenCanonicalJson(document);
        Object.freeze(this);
    }

    public static any(): JsonSchema {
        return anyJsonSchema;
    }

    public static encode(schema: JsonSchema): Uint8Array {
        return jsonSchemaCodec.encode(schema);
    }

    public static decode(bytes: Uint8Array): JsonSchema {
        return jsonSchemaCodec.decode(bytes);
    }

    public accepts(
        value: unknown,
        validator: JsonSchemaValidator = strictJsonSchemaValidator
    ): value is JsonValue {
        if (!isJsonValue(value) || !strictJsonSchemaValidator.validate(this.document, value)) {
            return false;
        }
        if (validator === strictJsonSchemaValidator) return true;
        const candidate = canonicalJsonCopy(value);
        const before = encodeCanonicalJson(candidate);
        let accepted: boolean;
        try {
            accepted = validator.validate(this.document, candidate);
        } catch (error) {
            requireUnchanged(candidate, before);
            throw error;
        }
        requireUnchanged(candidate, before);
        requireValidationResult(accepted);
        return accepted;
    }

    public assertValid(): void {
        strictJsonSchemaValidator.assertSchema(this.document);
    }

    /**
     * The structural subset of assertValid: rejects unsupported dialects, references,
     * and formats without compiling. Declaration-time checks on first-party schemas
     * use this so module initialization stays within substrate startup CPU limits;
     * compilation still asserts the full schema on first validation.
     */
    public assertSupported(): void {
        strictJsonSchemaValidator.assertSupportedSchema(this.document);
    }
}

function isSchemaDocument(value: unknown): value is JsonSchemaDocument {
    return isJsonBoolean(value) || (isJsonValue(value) && isJsonObject(value));
}

const anyJsonSchema = new JsonSchema({});

function assertSupportedSchema(schema: JsonSchemaDocument): void {
    const resources = new Set<string>();
    visitSchemas(schema, undefined, (_value, base) => {
        if (base !== undefined) resources.add(withoutFragment(base));
    });
    visitSchemas(schema, undefined, (value, base) => {
        const dialect = ownValue(value, "$schema");
        if (dialect !== undefined && dialect !== JSON_SCHEMA_2020_12) {
            throw new TypeError("Only JSON Schema 2020-12 is supported");
        }
        if (Object.hasOwn(value, "$async")) {
            throw new TypeError("Asynchronous JSON Schema validation is not supported");
        }
        if (Object.hasOwn(value, "$recursiveRef")) {
            throw new TypeError("$recursiveRef is not supported by JSON Schema 2020-12");
        }
        requireLocalReference(ownValue(value, "$ref"), base, resources, "$ref");
        requireDynamicReference(ownValue(value, "$dynamicRef"));
        const format = ownValue(value, "format");
        if (isJsonString(format) && !SUPPORTED_FORMATS.has(format)) {
            throw new TypeError(`Unsupported JSON Schema format: ${format}`);
        }
    });
}

function visitSchemas(
    value: JsonSchemaDocument,
    inheritedBase: string | undefined,
    inspect: (value: { readonly [key: string]: JsonValue }, base: string | undefined) => void
): void {
    if (!isJsonObject(value)) return;
    const base = resolveIdentifier(ownValue(value, "$id"), inheritedBase) ?? inheritedBase;
    inspect(value, base);
    for (const keyword of SCHEMA_KEYWORDS) {
        visitSchemaValue(ownValue(value, keyword), base, inspect);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
        const children = ownValue(value, keyword);
        if (!Array.isArray(children)) continue;
        for (const child of children) visitSchemaValue(child, base, inspect);
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
        const children = ownValue(value, keyword);
        if (!isJsonObject(children)) continue;
        for (const child of Object.values(children)) visitSchemaValue(child, base, inspect);
    }
}

function visitSchemaValue(
    value: JsonValue | undefined,
    base: string | undefined,
    inspect: (value: { readonly [key: string]: JsonValue }, base: string | undefined) => void
): void {
    if (isJsonBoolean(value) || isJsonObject(value)) visitSchemas(value, base, inspect);
}

function resolveIdentifier(
    value: JsonValue | undefined,
    base: string | undefined
): string | undefined {
    if (!isJsonString(value)) return undefined;
    try {
        return new URL(value, base).href;
    } catch {
        return undefined;
    }
}

function requireLocalReference(
    value: JsonValue | undefined,
    base: string | undefined,
    resources: ReadonlySet<string>,
    keyword: string
): void {
    if (!isJsonString(value) || value.startsWith("#")) return;
    const resolved = resolveIdentifier(value, base);
    if (resolved === undefined || !resources.has(withoutFragment(resolved))) {
        throw new TypeError(`Remote JSON Schema reference is not supported: ${keyword} ${value}`);
    }
}

function requireDynamicReference(value: JsonValue | undefined): void {
    if (isJsonString(value) && !value.startsWith("#")) {
        throw new TypeError(`Remote JSON Schema reference is not supported: $dynamicRef ${value}`);
    }
}

function withoutFragment(value: string): string {
    const index = value.indexOf("#");
    return index === -1 ? value : value.slice(0, index);
}

function ownValue(
    value: { readonly [key: string]: JsonValue },
    key: string
): JsonValue | undefined {
    return Object.hasOwn(value, key) ? value[key] : undefined;
}

function requireUnchanged(value: JsonValue, expected: Uint8Array): void {
    let unchanged = false;
    try {
        const actual = encodeCanonicalJson(value);
        unchanged =
            actual.byteLength === expected.byteLength &&
            actual.every((entry, index) => entry === expected[index]);
    } catch {
        unchanged = false;
    }
    if (!unchanged) throw new TypeError("Injected JSON Schema validators must not mutate input");
}

function requireValidationResult(value: unknown): asserts value is boolean {
    if (typeof value !== "boolean") {
        throw new TypeError("Injected JSON Schema validators must return a boolean synchronously");
    }
}

function createAjv(): Ajv2020 {
    const ajv = new Ajv2020(
        Object.assign(Object.create(null), {
            addUsedSchema: false,
            allErrors: false,
            coerceTypes: false,
            logger: false,
            ownProperties: true,
            removeAdditional: false,
            strict: true,
            strictSchema: true,
            strictTypes: false,
            useDefaults: false,
            validateFormats: true
        })
    );
    ajv.addFormat("uri", fullFormats.uri);
    return ajv;
}

const SCHEMA_KEYWORDS = [
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties"
] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_MAP_KEYWORDS = [
    "$defs",
    "dependentSchemas",
    "patternProperties",
    "properties"
] as const;
