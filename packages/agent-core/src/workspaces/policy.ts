import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../core";
import { EventPattern, PayloadMapping, type DedupePolicy, type TrustTier } from "../facets";
import { AgentCoreError } from "../errors";
import type { PrincipalRef } from "../identity";
import { Event } from "./event";
import { canonicalJson, type DerivedEventTrust, type EventSource } from "./value";

export interface TrustDerivationFacts {
    readonly authenticatedPrincipal?: PrincipalRef;
    readonly principalOwnsScope: boolean;
    readonly validTurnLease: boolean;
    readonly hostEmission: boolean;
}

export function deriveEventTrust(facts: TrustDerivationFacts): DerivedEventTrust {
    if (facts.validTurnLease || facts.hostEmission) {
        if (!facts.validTurnLease || !facts.hostEmission) {
            throw denied("Self trust requires a host emission under a valid Turn lease");
        }
        return Object.freeze({
            tier: "self" as const,
            ...(facts.authenticatedPrincipal === undefined
                ? {}
                : { initiator: facts.authenticatedPrincipal })
        });
    }
    if (facts.principalOwnsScope) {
        if (facts.authenticatedPrincipal === undefined) {
            throw denied("Owner trust requires an authenticated Principal");
        }
        return Object.freeze({ tier: "owner" as const, initiator: facts.authenticatedPrincipal });
    }
    if (facts.authenticatedPrincipal !== undefined) {
        return Object.freeze({
            tier: "authenticated" as const,
            initiator: facts.authenticatedPrincipal
        });
    }
    return Object.freeze({ tier: "external" as const });
}

export function eventMatches(pattern: EventPattern, event: Event): boolean {
    return (
        patternMatches(pattern.kind, event.kind.value) &&
        (pattern.source === undefined ||
            patternMatches(pattern.source, eventSourceId(event.source))) &&
        pattern.acceptedTrust.includes(event.trust)
    );
}

export function applyPayloadMapping(mapping: PayloadMapping, source: JsonValue): JsonValue {
    const snapshot = PayloadMapping.decode(PayloadMapping.encode(mapping));
    validatePayloadMapping(snapshot);
    let target: MutableJson = {};
    for (const move of snapshot.moves) {
        const value =
            move.from === undefined
                ? mutableCopy(move.literal!)
                : mutableCopy(readPointer(source, move.from));
        target = writePointer(target, move.to, value);
    }
    return canonicalJson(target as JsonValue);
}

export function routeDedupeKey(
    policy: DedupePolicy,
    event: Event,
    logicalDeliveryKey?: string
): string {
    switch (policy) {
        case "event":
            return `event:${event.id.value}`;
        case "causation":
            if (event.causation === undefined) {
                throw invalidSubscription("Causation dedupe requires an Event cause");
            }
            return `causation:${event.causation.value}`;
        case "payload":
            return `payload:${event.payloadDigest.algorithm}:${event.payloadDigest.value}`;
        case "none":
            if (
                logicalDeliveryKey === undefined ||
                logicalDeliveryKey.length === 0 ||
                logicalDeliveryKey.trim() !== logicalDeliveryKey
            ) {
                throw invalidSubscription(
                    "No-dedupe routing requires a stable logical delivery key"
                );
            }
            return `none:${logicalDeliveryKey}`;
    }
}

export function trustAccepted(accepted: readonly TrustTier[], tier: TrustTier): boolean {
    return accepted.includes(tier);
}

type MutableJson =
    null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson };

function patternMatches(pattern: string, value: string): boolean {
    return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function eventSourceId(source: EventSource): string {
    return source.kind === "facet" ? source.facet.value : source.actor.id.value;
}

export function validatePayloadMapping(mapping: PayloadMapping): void {
    const paths = mapping.moves.map((move) => parsePointer(move.to));
    for (let left = 0; left < paths.length; left += 1) {
        for (let right = left + 1; right < paths.length; right += 1) {
            if (isPrefix(paths[left]!, paths[right]!) || isPrefix(paths[right]!, paths[left]!)) {
                throw new TypeError("Mapping targets must not duplicate or overlap");
            }
        }
    }
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
    return left.length <= right.length && left.every((part, index) => right[index] === part);
}

function readPointer(document: JsonValue, pointer: string): JsonValue {
    let current: JsonValue = document;
    for (const token of parsePointer(pointer)) {
        if (Array.isArray(current)) {
            const index = parseArrayIndex(token, false);
            if (index >= current.length) throw missingPointer(pointer);
            current = current[index]!;
        } else if (isObject(current) && Object.hasOwn(current, token)) {
            current = current[token]!;
        } else {
            throw missingPointer(pointer);
        }
    }
    return current;
}

function writePointer(document: MutableJson, pointer: string, value: MutableJson): MutableJson {
    const tokens = parsePointer(pointer);
    if (tokens.length === 0) return value;
    if (document === null || typeof document !== "object") {
        throw invalidSubscription("Mapping cannot write a child beneath a scalar root");
    }
    let current: MutableJson[] | { [key: string]: MutableJson } = document;
    for (let index = 0; index < tokens.length - 1; index += 1) {
        const token = tokens[index]!;
        const nextToken = tokens[index + 1]!;
        if (Array.isArray(current)) {
            const position = token === "-" ? current.length : parseArrayIndex(token);
            if (position > current.length) {
                throw invalidSubscription("Mapping cannot create sparse arrays");
            }
            let child = current[position];
            if (child === undefined) {
                child = arrayToken(nextToken) ? [] : {};
                current.push(child);
            }
            if (child === null || typeof child !== "object") {
                throw invalidSubscription("Mapping target traverses a scalar value");
            }
            current = child;
        } else {
            let child = Object.hasOwn(current, token) ? current[token] : undefined;
            if (child === undefined) {
                child = arrayToken(nextToken) ? [] : {};
                defineDataProperty(current, token, child);
            }
            if (child === null || typeof child !== "object") {
                throw invalidSubscription("Mapping target traverses a scalar value");
            }
            current = child;
        }
    }
    const finalToken = tokens.at(-1)!;
    if (Array.isArray(current)) {
        const position = finalToken === "-" ? current.length : parseArrayIndex(finalToken);
        if (position > current.length) {
            throw invalidSubscription("Mapping cannot create sparse arrays");
        }
        if (position === current.length) current.push(value);
        else current[position] = value;
    } else {
        defineDataProperty(current, finalToken, value);
    }
    return document;
}

function defineDataProperty(
    target: { [key: string]: MutableJson },
    key: string,
    value: MutableJson
): void {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
    });
}

function parsePointer(pointer: string): readonly string[] {
    if (pointer === "") return [];
    if (!pointer.startsWith("/"))
        throw new TypeError("JSON Pointer must be empty or begin with '/'");
    return pointer
        .slice(1)
        .split("/")
        .map((token) => {
            if (/~(?:[^01]|$)/u.test(token)) {
                throw new TypeError("JSON Pointer contains an invalid escape");
            }
            return token.replaceAll("~1", "/").replaceAll("~0", "~");
        });
}

function parseArrayIndex(token: string, _allowAppend?: false): number {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        throw new TypeError("JSON Pointer array index is invalid");
    }
    const index = Number(token);
    if (!Number.isSafeInteger(index)) throw new TypeError("JSON Pointer array index is too large");
    return index;
}

function arrayToken(token: string): boolean {
    return token === "-" || /^(?:0|[1-9][0-9]*)$/u.test(token);
}

function mutableCopy(value: JsonValue): MutableJson {
    return decodeCanonicalJson(encodeCanonicalJson(value)) as MutableJson;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function missingPointer(pointer: string): AgentCoreError {
    return invalidSubscription(`Mapping source pointer does not exist: ${pointer}`);
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function invalidSubscription(message: string): AgentCoreError {
    return new AgentCoreError("subscription.invalid", message);
}
