import { AgentCoreError } from "../errors";
import { type JsonFields, Revision, jsonDataParser, type JsonValue } from "../core";

export type IdentityData = JsonValue;
export type IdentityDataMap = { readonly [key: string]: IdentityData };

const parse = jsonDataParser(invalid);

export function requireIdentityObject(value: IdentityData, subject: string): IdentityDataMap {
    return parse.object(value, subject);
}

export function requireIdentityFields<Field extends string>(
    value: IdentityDataMap,
    fields: readonly Field[],
    subject: string
): asserts value is IdentityDataMap & JsonFields<Field> {
    parse.exact(value, fields, subject);
}

export function requireIdentityString(value: IdentityData | undefined, subject: string): string {
    return parse.string(value, subject);
}

export function requireIdentityArray(
    value: IdentityData | undefined,
    subject: string
): readonly IdentityData[] {
    return parse.array(value, subject);
}

export function requireIdentityRevision(
    value: IdentityData | undefined,
    subject: string
): Revision {
    return new Revision(parse.safeInteger(value, subject));
}

export function compareIdentityText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function invalid(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
