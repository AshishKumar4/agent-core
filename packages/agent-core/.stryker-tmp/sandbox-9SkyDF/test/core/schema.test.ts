// @ts-nocheck
import { describe, expect, test, vi } from "vitest";
import {
    JsonSchema,
    StrictJsonSchemaValidator,
    encodeCanonicalJson,
    strictJsonSchemaValidator,
    type JsonSchemaValidator
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("JSON Schema values", () => {
    test("[json-schema-validator] strict memory reference enforces the shared validation contract", () => {
        const validator = new StrictJsonSchemaValidator();
        expect(validator.validate({ type: "integer" }, 1)).toBe(true);
        expect(validator.validate({ type: "integer" }, "1")).toBe(false);
    });

    test("stores a deeply frozen canonical copy", () => {
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

    test("supports boolean schemas and an injectable validator seam", () => {
        const validate = vi.fn((schema, value) => schema === true && value === "accepted");
        const validator: JsonSchemaValidator = { validate };
        const schema = new JsonSchema(true);

        expect(schema.accepts("accepted", validator)).toBe(true);
        expect(schema.accepts("rejected", validator)).toBe(false);
        expect(validate).toHaveBeenCalledWith(true, "accepted");
    });

    test("rejects noncanonical input before calling the validator seam", () => {
        const validator: JsonSchemaValidator = { validate: vi.fn(() => true) };
        const schema = JsonSchema.any();

        expect(schema.accepts(new Date(), validator)).toBe(false);
        expect(schema.accepts(Number.NaN, validator)).toBe(false);
        expect(validator.validate).not.toHaveBeenCalled();
    });

    test("does not let an injected validator loosen strict production validation", () => {
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

    test("rejects non-JSON and cyclic schema documents", () => {
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

    test("validates draft 2020-12 synchronously without coercion or defaults", () => {
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

    test("supports uri format without warnings and rejects unknown formats", () => {
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

    test("rejects remote references and non-2020 dialects deterministically", () => {
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

    test("checks unsupported behavior in every schema-bearing keyword shape", () => {
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

    test("does not interpret const and annotation data as nested schemas", () => {
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

    test("rejects asynchronous validation and inherited required properties", () => {
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

    test("uses immutable schema snapshots without cross-schema id retention", () => {
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

    test("enforces RFC 3986 uri syntax", () => {
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

    test("[core.json-schema] round-trips canonical bytes and rejects unknown fields", () => {
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
});

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
