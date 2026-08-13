export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonKind =
    "absent" | "array" | "boolean" | "null" | "number" | "object" | "other" | "string";

export function globMatches(pattern: string, path: string): boolean;
export function readJson(path: string): Promise<JsonValue>;
export function readCanonicalJson(path: string): Promise<JsonValue>;
export function parseCanonicalJson(source: string, label: string): JsonValue;
export function jsonKind(value: JsonValue): JsonKind;
export function isJsonObject(value: JsonValue): value is JsonObject;
export function isNonEmptyString(value: JsonValue): value is string;
export function assertObject(value: JsonValue, owner: string): JsonObject;
export function assertArray(value: JsonValue, owner: string): readonly JsonValue[];
export function assertBoolean(value: JsonValue, owner: string): boolean;
export function assertString(value: JsonValue, owner: string): string;
export function assertOneOf<Allowed extends JsonValue>(
    value: JsonValue,
    allowed: readonly Allowed[],
    owner: string
): Allowed;
export function assertUniqueIds<T>(
    items: readonly T[],
    idOf: (item: T) => string,
    owner: string
): readonly T[];
