import {
    decodeScopeRef,
    decodeSubjectRef,
    encodeScopeRef,
    encodeSubjectRef,
    type ScopeRef,
    type SubjectRef
} from "../identity";
import type { JsonValue } from "../core";
import { authorityKey } from "./key";

export type { ScopeRef, SubjectRef } from "../identity";

export function scopeKey(scope: ScopeRef): string {
    return authorityKey("scope", [encodeScopeRef(scope)]);
}

export function subjectKey(subject: SubjectRef): string {
    return authorityKey("subject", [encodeSubjectRef(subject)]);
}

export function encodeAuthorityScope(scope: ScopeRef): JsonValue {
    return encodeScopeRef(scope);
}

export function decodeAuthorityScope(value: JsonValue): ScopeRef {
    return decodeScopeRef(value);
}

export function encodeAuthoritySubject(subject: SubjectRef): JsonValue {
    return encodeSubjectRef(subject);
}

export function decodeAuthoritySubject(value: JsonValue): SubjectRef {
    return decodeSubjectRef(value);
}
