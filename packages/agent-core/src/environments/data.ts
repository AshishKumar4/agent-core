import { type JsonFields, Revision, jsonDataParser, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";

export type JsonObject = { readonly [key: string]: JsonValue };

const parse = jsonDataParser((message) => new TypeError(message));

export function requireInstance<Value>(
    value: unknown,
    constructor: abstract new (...arguments_: never[]) => Value,
    name: string
): asserts value is Value {
    if (!(value instanceof constructor)) throw new TypeError(`${name} is invalid`);
}

export function requireObject(value: JsonValue, name: string): JsonObject {
    return parse.object(value, name);
}

export function requireExact<Field extends string>(
    object: JsonObject,
    keys: readonly Field[],
    name: string
): asserts object is JsonFields<Field> {
    parse.exact(object, keys, name, "has invalid fields");
}

export function requireString(value: JsonValue | undefined, name: string): string {
    return parse.string(value, name);
}

export function requireSafeInteger(value: JsonValue | undefined, name: string): number {
    return parse.safeInteger(value, name);
}

export function requireOptionalString(
    value: JsonValue | undefined,
    name: string
): string | undefined {
    return parse.nullableString(value, name);
}

export function increment(value: number, name: string): number {
    if (value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
    }
    return value + 1;
}

export function advanceRevision(revision: Revision, name: string): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
    }
    return revision.next();
}
