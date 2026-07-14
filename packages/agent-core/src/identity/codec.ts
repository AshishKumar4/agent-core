import { AgentCoreError } from "../errors";
import {
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";

export type IdentityData = JsonValue;
export type IdentityDataMap = { readonly [key: string]: IdentityData };

export function requireIdentityObject(value: IdentityData, subject: string): IdentityDataMap {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw invalid(`${subject} must be an object`);
    }
    return value as IdentityDataMap;
}

export function requireIdentityFields(
    value: IdentityDataMap,
    fields: readonly string[],
    subject: string
): void {
    if (!hasExactJsonKeys(value, fields)) {
        throw invalid(`${subject} contains missing or unknown fields`);
    }
}

export function requireIdentityString(value: IdentityData | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw invalid(`${subject} must be a string`);
    }
    return value;
}

export function requireIdentityRevision(
    value: IdentityData | undefined,
    subject: string
): Revision {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw invalid(`${subject} must be a non-negative safe integer`);
    }
    return new Revision(value);
}

export function canonicalIdentityData(value: IdentityData): IdentityData {
    return freezeIdentityData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

export function compareIdentityText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function invalid(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function freezeIdentityData(value: IdentityData): IdentityData {
    if (Array.isArray(value)) {
        for (const entry of value) {
            freezeIdentityData(entry);
        }
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) {
            freezeIdentityData(entry);
        }
        return Object.freeze(value);
    }
    return value;
}
