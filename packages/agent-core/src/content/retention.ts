import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    ContentRef,
    RecordCodec,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AgentCoreError } from "../errors";
import { TenantId } from "../identity";
import type { ContentStat } from "./stat";

const MAX_OWNER_KEY_LENGTH = 512;

class ContentOwnerEdgeCodec extends RecordCodec<ContentOwnerEdge> {
    public constructor() {
        super("content.owner-edge", { major: 1, minor: 0 });
    }

    protected encodePayload(edge: ContentOwnerEdge): JsonValue {
        return {
            actor: { id: edge.actor.id.value, kind: edge.actor.kind },
            ownerKey: edge.ownerKey,
            ref: edge.ref.value,
            tenant: edge.tenant.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ContentOwnerEdge {
        const actor = isObject(payload) ? payload["actor"] : undefined;
        if (
            !isObject(payload) ||
            !hasExactJsonKeys(payload, ["actor", "ownerKey", "ref", "tenant"]) ||
            !isObject(actor) ||
            !hasExactJsonKeys(actor, ["id", "kind"]) ||
            typeof actor["id"] !== "string" ||
            !isActorKind(actor["kind"]) ||
            typeof payload["ownerKey"] !== "string" ||
            typeof payload["ref"] !== "string" ||
            typeof payload["tenant"] !== "string"
        ) {
            throw invalidEdge("Content owner edge payload is malformed");
        }
        try {
            return new ContentOwnerEdge(
                new TenantId(payload["tenant"]),
                new ActorRef(actor["kind"], new ActorId(actor["id"])),
                payload["ownerKey"],
                new ContentRef(payload["ref"])
            );
        } catch (error) {
            throw invalidEdge(
                `Content owner edge payload is invalid: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

export class ContentOwnerEdge {
    public static readonly codec: RecordCodec<ContentOwnerEdge> = new ContentOwnerEdgeCodec();

    public constructor(
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        public readonly ownerKey: string,
        public readonly ref: ContentRef
    ) {
        if (ownerKey.trim().length === 0 || ownerKey.length > MAX_OWNER_KEY_LENGTH) {
            throw new TypeError(
                `Content owner key must not be blank or exceed ${MAX_OWNER_KEY_LENGTH} characters`
            );
        }
        Object.freeze(this);
    }

    public static encode(edge: ContentOwnerEdge): Uint8Array {
        return ContentOwnerEdge.codec.encode(edge);
    }

    public static decode(bytes: Uint8Array): ContentOwnerEdge {
        return ContentOwnerEdge.codec.decode(bytes);
    }

    public equals(other: ContentOwnerEdge): boolean {
        return (
            this.tenant.equals(other.tenant) &&
            this.actor.equals(other.actor) &&
            this.ownerKey === other.ownerKey &&
            this.ref.equals(other.ref)
        );
    }
}

export interface ContentCollectionCandidate {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly stat: ContentStat;
    readonly unownedSince: Date;
    readonly observedAt: Date;
}

export interface TenantContentPolicyReader<TTransaction> {
    allowsCollection(
        transaction: TTransaction,
        candidate: ContentCollectionCandidate
    ): boolean | undefined;
}

export abstract class ContentRetention<TTransaction> {
    protected constructor(
        public readonly tenant: TenantId,
        public readonly actor: ActorRef
    ) {}

    public abstract retain(
        transaction: TTransaction,
        edge: ContentOwnerEdge,
        operationAt: Date
    ): void;

    public abstract release(
        transaction: TTransaction,
        edge: ContentOwnerEdge,
        operationAt: Date
    ): void;

    public abstract collect(
        transaction: TTransaction,
        policy: TenantContentPolicyReader<TTransaction>,
        observedAt: Date
    ): readonly ContentRef[];

    protected requireOwner(edge: ContentOwnerEdge): void {
        if (!edge.tenant.equals(this.tenant)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Content owner edge belongs to a different Tenant"
            );
        }
        if (!edge.actor.equals(this.actor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Content owner edge belongs to a different Actor"
            );
        }
    }
}

export function requireCollectionTime(value: Date): Date {
    return requireOperationTime(value, "Content collection time");
}

export function requireOperationTime(value: Date, name = "Content operation time"): Date {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
        throw new TypeError(`${name} must be a valid non-negative Date`);
    }
    return new Date(time);
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
    return (
        value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    );
}

function isActorKind(value: JsonValue | undefined): value is ActorKind {
    return (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    );
}

function invalidEdge(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
