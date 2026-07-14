import { ActorId, type ActorKind } from "@agent-core/core";
import { isWellFormedUnicode } from "./unicode.js";

const ACTOR_NAME_PREFIX = "agent-core:actor:v1";
const MAX_OBJECT_NAME_BYTES = 1024;

export interface ActorObjectIdentity {
    readonly kind: ActorKind;
    readonly id: ActorId;
    readonly jurisdiction: string;
}

/** Jurisdiction is identity data in this name; it does not select runtime placement. */
export function actorObjectName(identity: ActorObjectIdentity): string {
    requirePart(identity.kind, "kind");
    requireActorId(identity.id);
    requirePart(identity.jurisdiction, "jurisdiction");
    const name = [
        ACTOR_NAME_PREFIX,
        encodeURIComponent(identity.kind),
        encodeURIComponent(identity.id.value),
        encodeURIComponent(identity.jurisdiction)
    ].join(":");
    validateActorObjectNameLength(name);
    return name;
}

export function parseActorObjectName(name: string): ActorObjectIdentity {
    const parts = name.split(":");
    if (parts.length !== 6 || parts.slice(0, 3).join(":") !== ACTOR_NAME_PREFIX) {
        throw new TypeError("Actor object name is malformed or has an unsupported version");
    }
    try {
        const identity: ActorObjectIdentity = Object.freeze({
            kind: requireActorKind(decodeURIComponent(parts[3] ?? "")),
            id: new ActorId(decodeURIComponent(parts[4] ?? "")),
            jurisdiction: decodeURIComponent(parts[5] ?? "")
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
