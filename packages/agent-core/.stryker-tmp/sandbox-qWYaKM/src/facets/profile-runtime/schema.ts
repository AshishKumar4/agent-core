// @ts-nocheck
import { JsonSchema, type JsonSchemaDocument, type JsonValue } from "../../core";

export const EMPTY_OBJECT_SCHEMA = schema({
    type: "object",
    additionalProperties: false
});

export const JSON_VALUE_SCHEMA = JsonSchema.any();

export function schema(document: JsonSchemaDocument): JsonSchema {
    const value = new JsonSchema(document);
    value.assertValid();
    return value;
}

export function strictObjectSchema(
    properties: Readonly<Record<string, JsonValue>>,
    required: readonly string[] = []
): JsonSchema {
    return schema({
        type: "object",
        properties,
        required,
        additionalProperties: false
    });
}
