import { ActorId, type ActorKind } from "@agent-core/core";
import { isWellFormedUnicode } from "./unicode.js";

const ACTOR_NAME_PREFIX = "agent-core:actor:v1";
const ACTOR_NAME_PARTS = 5;
const MAX_OBJECT_NAME_BYTES = 1024;

/**
 * The core Actor identity `(kind, id)`. The Durable Object name is a pure function of
 * this identity, so one `ActorRef` always maps to exactly one object and one
 * authoritative store. Jurisdiction is physical placement, never name identity data.
 */
export interface ActorObjectIdentity {
    readonly kind: ActorKind;
    readonly id: ActorId;
}

export function actorObjectName(identity: ActorObjectIdentity): string {
    requirePart(identity.kind, "kind");
    requireActorId(identity.id);
    const name = [
        ACTOR_NAME_PREFIX,
        encodeURIComponent(identity.kind),
        encodeURIComponent(identity.id.value)
    ].join(":");
    validateActorObjectNameLength(name);
    return name;
}

export function parseActorObjectName(name: string): ActorObjectIdentity {
    const parts = name.split(":");
    if (parts.length !== ACTOR_NAME_PARTS || parts.slice(0, 3).join(":") !== ACTOR_NAME_PREFIX) {
        throw new TypeError("Actor object name is malformed or has an unsupported version");
    }
    try {
        const identity: ActorObjectIdentity = Object.freeze({
            kind: requireActorKind(decodeURIComponent(parts[3] ?? "")),
            id: new ActorId(decodeURIComponent(parts[4] ?? ""))
        });
        if (actorObjectName(identity) !== name) {
            throw new TypeError("Actor object name is not canonically encoded");
        }
        return identity;
    } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new TypeError("Actor object name contains invalid UTF-8 encoding");
    }
}

function requireActorId(value: ActorId): void {
    if (!(value instanceof ActorId)) throw new TypeError("Actor ID is invalid");
}

function requireActorKind(value: string): ActorKind {
    if (
        value !== "tenant" &&
        value !== "workspace" &&
        value !== "run" &&
        value !== "environment" &&
        value !== "slate"
    ) {
        throw new TypeError("Actor kind is invalid");
    }
    return value;
}

function requirePart(value: string, label: string): void {
    if (value.length === 0 || !isWellFormedUnicode(value)) {
        throw new TypeError(`Actor ${label} must be non-empty well-formed Unicode`);
    }
}

function validateActorObjectNameLength(name: string): void {
    if (new TextEncoder().encode(name).byteLength > MAX_OBJECT_NAME_BYTES) {
        throw new TypeError("Actor object name exceeds Cloudflare's 1024-byte limit");
    }
}
