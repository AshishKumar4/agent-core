export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonKind =
    "absent" | "array" | "boolean" | "null" | "number" | "object" | "other" | "string";

export function compareCanonicalText(left: string, right: string): number;
export function globMatches(pattern: string, path: string): boolean;
export function readJson(path: string): Promise<JsonValue>;
export function readCanonicalJson(path: string): Promise<JsonValue>;
export function parseCanonicalJson(source: string, label: string): JsonValue;
export function jsonKind(value: JsonValue | undefined): JsonKind;
export function isJsonObject(value: JsonValue | undefined): value is JsonObject;
export function isNonEmptyString(value: JsonValue | undefined): value is string;
export function assertObject(value: JsonValue | undefined, owner: string): JsonObject;
export function assertArray(value: JsonValue | undefined, owner: string): readonly JsonValue[];
export function assertBoolean(value: JsonValue | undefined, owner: string): boolean;
export function assertString(value: JsonValue | undefined, owner: string): string;
export function assertOneOf<Allowed extends JsonValue>(
    value: JsonValue | undefined,
    allowed: readonly Allowed[],
    owner: string
): Allowed;
export function assertUniqueIds<T>(
    items: readonly T[],
    idOf: (item: T) => string,
    owner: string
): readonly T[];
export function sha256(value: string | Uint8Array): string;
