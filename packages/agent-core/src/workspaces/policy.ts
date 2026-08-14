import { decodeCanonicalJson, encodeCanonicalJson, isJsonObject, type JsonValue } from "../core";
import {
    EventPattern,
    JsonPointer,
    PayloadMapping,
    type DedupePolicy,
    type TrustTier
} from "../facets";
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
        const trust: DerivedEventTrust = { tier: "self" };
        return Object.freeze(
            facts.authenticatedPrincipal === undefined
                ? trust
                : { ...trust, initiator: facts.authenticatedPrincipal }
        );
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
        const value = mutableCopy(
            move.from === undefined
                ? requireMoveLiteral(move.literal)
                : readPointer(source, move.from)
        );
        target = writePointer(target, move.to, value);
    }
    return canonicalJson(target);
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
    const paths = mapping.moves.map((move) => new JsonPointer(move.to).tokens);
    for (const [leftIndex, left] of paths.entries()) {
        for (const right of paths.slice(leftIndex + 1)) {
            if (isPrefix(left, right) || isPrefix(right, left)) {
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
    for (const token of new JsonPointer(pointer).tokens) {
        if (Array.isArray(current)) {
            const index = parseArrayIndex(token);
            if (index >= current.length) throw missingPointer(pointer);
            const entry = current[index];
            if (entry === undefined) throw missingPointer(pointer);
            current = entry;
        } else if (isJsonObject(current) && Object.hasOwn(current, token)) {
            const entry = current[token];
            if (entry === undefined) throw missingPointer(pointer);
            current = entry;
        } else {
            throw missingPointer(pointer);
        }
    }
    return current;
}

function writePointer(document: MutableJson, pointer: string, value: MutableJson): MutableJson {
    const tokens = new JsonPointer(pointer).tokens;
    if (tokens.length === 0) return value;
    if (!isMutableContainer(document)) {
        throw invalidSubscription("Mapping target traverses a scalar value");
    }
    let current = document;
    for (let index = 0; index < tokens.length - 1; index += 1) {
        const token = tokens[index];
        const nextToken = tokens[index + 1];
        if (token === undefined || nextToken === undefined) {
            throw invalidSubscription("Mapping target pointer is malformed");
        }
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
            if (!isMutableContainer(child)) {
                throw invalidSubscription("Mapping target traverses a scalar value");
            }
            current = child;
        } else {
            let child = Object.hasOwn(current, token) ? current[token] : undefined;
            if (child === undefined) {
                child = arrayToken(nextToken) ? [] : {};
                defineDataProperty(current, token, child);
            }
            if (!isMutableContainer(child)) {
                throw invalidSubscription("Mapping target traverses a scalar value");
            }
            current = child;
        }
    }
    const finalToken = tokens.at(-1);
    if (finalToken === undefined) {
        throw invalidSubscription("Mapping target pointer is malformed");
    }
    if (Array.isArray(current)) {
        const position = finalToken === "-" ? current.length : parseArrayIndex(finalToken);
        if (position > current.length) {
            throw invalidSubscription("Mapping cannot create sparse arrays");
        }
        // position is at most current.length, and assigning at the length appends.
        current[position] = value;
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

function parseArrayIndex(token: string): number {
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
    return mutableValue(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function mutableValue(value: JsonValue): MutableJson {
    if (isJsonArrayValue(value)) return value.map(mutableValue);
    if (isJsonObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, mutableValue(entry)])
        );
    }
    return value;
}

function isJsonArrayValue(value: JsonValue): value is readonly JsonValue[] {
    return Array.isArray(value);
}

function isMutableContainer(
    value: MutableJson | undefined
): value is MutableJson[] | { [key: string]: MutableJson } {
    return value !== null && value !== undefined && typeof value === "object";
}

function requireMoveLiteral(value: JsonValue | undefined): JsonValue {
    if (value === undefined) {
        throw invalidSubscription("Literal mapping move has no literal value");
    }
    return value;
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
