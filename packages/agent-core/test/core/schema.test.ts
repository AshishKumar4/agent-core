import { describe, expect, test, vi } from "vitest";
import {
    JsonSchema,
    StrictJsonSchemaValidator,
    encodeCanonicalJson,
    strictJsonSchemaValidator,
    type JsonSchemaValidator,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("JSON Schema values", () => {
    test("[json-schema-validator] strict memory reference enforces the shared validation contract", { tags: "p1" }, () => {
        const validator = new StrictJsonSchemaValidator();
        expect(validator.validate({ type: "integer" }, 1)).toBe(true);
        expect(validator.validate({ type: "integer" }, "1")).toBe(false);
    });

    test("stores a deeply frozen canonical copy", { tags: "p0" }, () => {
        const source = {
            required: ["name"],
            properties: { name: { type: "string" } },
            type: "object"
        };
        const schema = new JsonSchema(source);
        source.required.push("later");
        source.properties.name.type = "number";

        expect(schema.document).toEqual({
            properties: { name: { type: "string" } },
            required: ["name"],
            type: "object"
        });
        expect(Object.isFrozen(schema)).toBe(true);
        expect(Object.isFrozen(schema.document)).toBe(true);
        expect(Object.isFrozen((schema.document as { required: readonly string[] }).required)).toBe(
            true
        );
    });

    test("supports boolean schemas and an injectable validator seam", { tags: "p1" }, () => {
        const validate = vi.fn((schema, value) => schema === true && value === "accepted");
        const validator: JsonSchemaValidator = { validate };
        const schema = new JsonSchema(true);

        expect(schema.accepts("accepted", validator)).toBe(true);
        expect(schema.accepts("rejected", validator)).toBe(false);
        expect(validate).toHaveBeenCalledWith(true, "accepted");
    });

    test("rejects noncanonical input before calling the validator seam", { tags: "p0" }, () => {
        const validator: JsonSchemaValidator = { validate: vi.fn(() => true) };
        const schema = JsonSchema.any();

        expect(schema.accepts(new Date(), validator)).toBe(false);
        expect(schema.accepts(Number.NaN, validator)).toBe(false);
        expect(validator.validate).not.toHaveBeenCalled();
    });

    test("does not let an injected validator loosen strict production validation", { tags: "p0" }, () => {
        const permissive: JsonSchemaValidator = { validate: vi.fn(() => true) };

        expect(new JsonSchema({ type: "integer" }).accepts("1", permissive)).toBe(false);
        expect(permissive.validate).not.toHaveBeenCalled();
        expect(() =>
            new JsonSchema({
                $ref: "https://example.com/remote.json"
            }).accepts({}, permissive)
        ).toThrow(/Remote JSON Schema reference/);

        const mutating: JsonSchemaValidator = {
            validate: (_schema, value) => {
                (value as { injected?: boolean }).injected = true;
                return true;
            }
        };
        const original = {};
        expect(() => JsonSchema.any().accepts(original, mutating)).toThrow(/must not mutate input/);
        expect(original).toEqual({});
        const throwing: JsonSchemaValidator = {
            validate: (_schema, value) => {
                (value as { injected?: boolean }).injected = true;
                throw new TypeError("custom failure");
            }
        };
        expect(() => JsonSchema.any().accepts(original, throwing)).toThrow(/must not mutate input/);
        expect(original).toEqual({});
    });

    test("rejects non-JSON and cyclic schema documents", { tags: "p1" }, () => {
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const accessor = Object.defineProperty({}, "type", {
            enumerable: true,
            get: () => "string"
        });
        const symbolKeyed = { type: "string", [Symbol("hidden")]: true };

        expect(() => new JsonSchema([] as never)).toThrow(TypeError);
        expect(() => new JsonSchema(new Date() as never)).toThrow(TypeError);
        expect(() => new JsonSchema(cycle as never)).toThrow(TypeError);
        expect(() => new JsonSchema(accessor as never)).toThrow(TypeError);
        expect(() => new JsonSchema(symbolKeyed as never)).toThrow(TypeError);
        expect(() => new JsonSchema(Object.create({ type: "string" }) as never)).toThrow(TypeError);
    });

    test("reports a non-document schema as unsupported, not as a read fault", { tags: "p1" }, () => {
        // JsonSchema screens its own document, so this is the shape that reaches the
        // validator only through its public entry points. The structural walk runs before
        // anything compiles and reads keys off whatever it is handed; null is the one
        // non-document for which reading a key throws the engine's own message rather
        // than being carried through to the compiler's verdict.
        const validator = new StrictJsonSchemaValidator();

        expect(() => validator.assertSchema(null as never)).toThrow(/^Unsupported JSON Schema: /u);
        expect(() => validator.validate(null as never, 1)).toThrow(/^Unsupported JSON Schema: /u);
    });

    test("validates draft 2020-12 synchronously without coercion or defaults", { tags: "p1" }, () => {
        const validator = new StrictJsonSchemaValidator();
        const value: { count: string; added?: string } = { count: "1" };
        const before = structuredClone(value);

        expect(
            validator.validate(
                {
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    properties: {
                        added: { default: "injected", type: "string" },
                        count: { type: "integer" }
                    },
                    required: ["count"],
                    type: "object"
                },
                value
            )
        ).toBe(false);
        expect(value).toEqual(before);
        expect(
            validator.validate(
                {
                    properties: { added: { default: "injected", type: "string" } },
                    type: "object"
                },
                {}
            )
        ).toBe(true);
        expect(validator.validate(true, null)).toBe(true);
        expect(validator.validate({ minimum: 0 }, 1)).toBe(true);
        validator.assertSchema({ type: "string" });
        new JsonSchema({ type: "string" }).assertValid();
    });

    test("supports uri format without warnings and rejects unknown formats", { tags: "p1" }, () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const schema = new JsonSchema({ format: "uri", type: "string" });

        expect(schema.accepts("https://example.com/path", strictJsonSchemaValidator)).toBe(true);
        expect(schema.accepts("not a uri", strictJsonSchemaValidator)).toBe(false);
        expect(() =>
            strictJsonSchemaValidator.validate({ format: "email", type: "string" }, "a@example.com")
        ).toThrow(/Unsupported JSON Schema format: email/);
        expect(warning).not.toHaveBeenCalled();
        warning.mockRestore();
    });

    test("rejects remote references and non-2020 dialects deterministically", { tags: "p0" }, () => {
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    $ref: "https://example.com/schema.json"
                },
                {}
            )
        ).toThrow(/Remote JSON Schema reference/);
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    $schema: "http://json-schema.org/draft-07/schema#"
                },
                {}
            )
        ).toThrow(/Only JSON Schema 2020-12/);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    $defs: { name: { type: "string" } },
                    $ref: "#/$defs/name"
                },
                "valid"
            )
        ).toBe(true);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    $defs: { name: { type: "string" } },
                    $id: "https://example.com/root.json",
                    $ref: "https://example.com/root.json#/$defs/name"
                },
                "valid"
            )
        ).toBe(true);
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    $recursiveRef: "#"
                },
                {}
            )
        ).toThrow(/\$recursiveRef is not supported/);
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    $dynamicRef: "https://example.com/dynamic"
                },
                {}
            )
        ).toThrow(/Remote JSON Schema reference.*\$dynamicRef/);
    });

    test("checks unsupported behavior in every schema-bearing keyword shape", { tags: "p2" }, () => {
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    allOf: [{ format: "email" }]
                },
                "value"
            )
        ).toThrow(/Unsupported JSON Schema format: email/);
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    items: { format: "email" }
                },
                []
            )
        ).toThrow(/Unsupported JSON Schema format: email/);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    $id: "://invalid"
                },
                {}
            )
        ).toBe(true);
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    unknownKeyword: true
                },
                {}
            )
        ).toThrow(/Unsupported JSON Schema/);
    });

    test("does not interpret const and annotation data as nested schemas", { tags: "p1" }, () => {
        expect(
            strictJsonSchemaValidator.validate(
                {
                    const: { format: "email" }
                },
                { format: "email" }
            )
        ).toBe(true);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    enum: [{ $ref: "https://example.com/instance-data" }]
                },
                { $ref: "https://example.com/instance-data" }
            )
        ).toBe(true);
    });

    test("rejects asynchronous validation and inherited required properties", { tags: "p1" }, () => {
        expect(() =>
            strictJsonSchemaValidator.validate(
                {
                    $async: true,
                    type: "integer"
                },
                1
            )
        ).toThrow(/Asynchronous JSON Schema validation/);
        const asynchronous = {
            validate: () => Promise.resolve(true)
        } as unknown as JsonSchemaValidator;
        expect(() => JsonSchema.any().accepts({}, asynchronous)).toThrow(
            /return a boolean synchronously/
        );

        const cyclicMutating: JsonSchemaValidator = {
            validate: (_schema, value) => {
                (value as { self?: unknown }).self = value;
                return true;
            }
        };
        expect(() => JsonSchema.any().accepts({}, cyclicMutating)).toThrow(/must not mutate input/);

        const throwing: JsonSchemaValidator = {
            validate: () => {
                throw new TypeError("validator failure");
            }
        };
        expect(() => JsonSchema.any().accepts({}, throwing)).toThrow("validator failure");

        const prototype = Object.prototype as { admin?: boolean };
        Object.defineProperty(prototype, "admin", {
            configurable: true,
            enumerable: false,
            value: true,
            writable: true
        });
        try {
            expect(
                strictJsonSchemaValidator.validate(
                    {
                        properties: { admin: { const: true } },
                        required: ["admin"],
                        type: "object"
                    },
                    {}
                )
            ).toBe(false);
        } finally {
            delete prototype.admin;
        }
    });

    test("uses immutable schema snapshots without cross-schema id retention", { tags: "p0" }, () => {
        const mutable: { type: string } = { type: "string" };
        expect(strictJsonSchemaValidator.validate(mutable, "value")).toBe(true);
        mutable.type = "number";
        expect(strictJsonSchemaValidator.validate(mutable, 1)).toBe(true);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    $id: "https://example.com/reused.json",
                    type: "string"
                },
                "first"
            )
        ).toBe(true);
        expect(
            strictJsonSchemaValidator.validate(
                {
                    $id: "https://example.com/reused.json",
                    type: "integer"
                },
                2
            )
        ).toBe(true);
    });

    test("enforces RFC 3986 uri syntax", { tags: "p2" }, () => {
        for (const invalid of [
            "https://example.com/a b",
            "https://éxample.com/",
            "https://example.com/%zz",
            "https://example.com/a\\b"
        ]) {
            expect(
                strictJsonSchemaValidator.validate({ format: "uri", type: "string" }, invalid)
            ).toBe(false);
        }
    });

    test("[core.json-schema] round-trips canonical bytes and rejects unknown fields", { tags: "p0" }, () => {
        const schema = new JsonSchema({ type: "string", minLength: 1 });
        const encoded = JsonSchema.encode(schema);

        expect(JsonSchema.encode(JsonSchema.decode(encoded))).toEqual(encoded);
        expect(JsonSchema.decode(encoded).document).toEqual({ minLength: 1, type: "string" });
        expectCodecError(
            () =>
                JsonSchema.decode(
                    encodeCanonicalJson({
                        kind: "core.json-schema",
                        payload: { document: {}, extra: true },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                JsonSchema.decode(
                    encodeCanonicalJson({
                        kind: "core.json-schema",
                        payload: { document: null },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
    });

    test("[core.json-schema] reports malformed payloads verbatim", { tags: "p1" }, () => {
        expectCodecFailure(
            () =>
                JsonSchema.decode(
                    encodeCanonicalJson({
                        kind: "core.json-schema",
                        payload: { document: {}, extra: true },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid",
            "JSON Schema payload is malformed"
        );
        for (const payload of [null, "document", ["document"], 1]) {
            expectCodecFailure(
                () =>
                    JsonSchema.decode(
                        encodeCanonicalJson({
                            kind: "core.json-schema",
                            payload,
                            version: { major: 1, minor: 0 }
                        })
                    ),
                "codec.invalid",
                "JSON Schema payload is malformed"
            );
        }
        for (const document of [null, 1, "schema", []]) {
            expectCodecFailure(
                () =>
                    JsonSchema.decode(
                        encodeCanonicalJson({
                            kind: "core.json-schema",
                            payload: { document },
                            version: { major: 1, minor: 0 }
                        })
                    ),
                "codec.invalid",
                "JSON Schema document must be an object or boolean"
            );
        }
    });

    test("asserts structural support without compiling the schema", { tags: "p1" }, () => {
        new JsonSchema({ $dynamicRef: "#node" }).assertSupported();
        new JsonSchema({ type: "string" }).assertSupported();
        new JsonSchema(true).assertSupported();
        new JsonSchema({
            $defs: { name: { type: "string" } },
            $id: "https://example.com/root.json",
            $ref: "https://example.com/root.json#/$defs/name"
        }).assertSupported();

        expectTypeFailure(
            () => new JsonSchema({ format: "email" }).assertSupported(),
            "Unsupported JSON Schema format: email"
        );
        expectTypeFailure(
            () =>
                new JsonSchema({
                    $schema: "http://json-schema.org/draft-07/schema#"
                }).assertSupported(),
            "Only JSON Schema 2020-12 is supported"
        );
        expectTypeFailure(
            () => new JsonSchema({ $async: true }).assertSupported(),
            "Asynchronous JSON Schema validation is not supported"
        );
        expectTypeFailure(
            () => new JsonSchema({ $recursiveRef: "#" }).assertSupported(),
            "$recursiveRef is not supported by JSON Schema 2020-12"
        );
        expectTypeFailure(
            () => new JsonSchema({ $ref: "not a url" }).assertSupported(),
            "Remote JSON Schema reference is not supported: $ref not a url"
        );
        expectTypeFailure(
            () =>
                new JsonSchema({
                    $id: "https://example.com/root.json",
                    $ref: "https://example.com/other.json"
                }).assertSupported(),
            "Remote JSON Schema reference is not supported: $ref https://example.com/other.json"
        );
        expectTypeFailure(
            () =>
                new JsonSchema({
                    $defs: { name: { type: "string" } },
                    $id: ["https://example.com/root.json"],
                    $ref: "https://example.com/root.json#/$defs/name"
                }).assertSupported(),
            "Remote JSON Schema reference is not supported: $ref https://example.com/root.json#/$defs/name"
        );
        expectTypeFailure(
            () => new JsonSchema({ $dynamicRef: "https://example.com/dynamic" }).assertSupported(),
            "Remote JSON Schema reference is not supported: $dynamicRef https://example.com/dynamic"
        );
    });

    test("keeps Ajv strict mode enabled for tuple schemas", { tags: "p1" }, () => {
        let thrown: unknown;
        try {
            strictJsonSchemaValidator.validate(
                { prefixItems: [{ type: "string" }], type: "array" },
                ["a"]
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TypeError);
        expect((thrown as Error).message).toMatch(
            /^Unsupported JSON Schema: strict mode: "prefixItems" is 1-tuple/
        );
    });

    test("detects length-preserving mutations by an injected validator", { tags: "p0" }, () => {
        const mutating: JsonSchemaValidator = {
            validate: (_schema, value) => {
                (value as { count: number }).count = 2;
                return true;
            }
        };
        const original = { count: 1 };

        expectTypeFailure(
            () => JsonSchema.any().accepts(original, mutating),
            "Injected JSON Schema validators must not mutate input"
        );
        expect(original).toEqual({ count: 1 });
    });

    test("deeply freezes canonical documents nested inside arrays", { tags: "p0" }, () => {
        const schema = new JsonSchema({ enum: [{ nested: [1] }], type: "object" });
        const enumeration = (schema.document as { readonly enum: readonly JsonValue[] }).enum;

        expect(enumeration).toHaveLength(1);
        expect(Object.isFrozen(enumeration)).toBe(true);
        expect(Object.isFrozen(enumeration[0])).toBe(true);
        expect(
            Object.isFrozen((enumeration[0] as { readonly nested: readonly number[] }).nested)
        ).toBe(true);
    });
});

function expectTypeFailure(action: () => unknown, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}

function expectCodecFailure(
    action: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentCoreError);
    expect(thrown).toMatchObject({ code, message });
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec to reject input");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ code });
    }
}
