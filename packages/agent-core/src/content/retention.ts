import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    ContentRef,
    Digest,
    RecordCodec,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion,
    TextId
} from "../core";
import { AgentCoreError } from "../errors";
import { TenantId } from "../identity";
import type { ContentStat } from "./stat";

const MAX_OWNER_KEY_LENGTH = 512;

class ContentOwnerEdgeCodec extends RecordCodec<ContentOwnerEdge> {
    public constructor() {
        super(
            [ContentOwnerEdge, ActorRef, TextId, ContentRef, Digest, ActorId, TenantId],
            "content.owner-edge",
            {
                major: 1,
                minor: 0
            }
        );
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
            !isContentString(actor["id"]) ||
            !isActorKind(actor["kind"]) ||
            !isContentString(payload["ownerKey"]) ||
            !isContentString(payload["ref"]) ||
            !isContentString(payload["tenant"])
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

function isContentString(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

export class ContentOwnerEdge {
    public static get codec(): RecordCodec<ContentOwnerEdge> {
        return contentOwnerEdgeCodecInstance;
    }

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

const contentOwnerEdgeCodecInstance = new ContentOwnerEdgeCodec();

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

    public verifyExactNamespace(
        transaction: TTransaction,
        ownerKeyPrefixes: readonly string[],
        expected: readonly ContentOwnerEdge[]
    ): void {
        if (
            ownerKeyPrefixes.length === 0 ||
            ownerKeyPrefixes.some((prefix) => prefix.length === 0)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Content owner namespace prefixes must be nonempty"
            );
        }
        const expectedByKey = new Map<string, ContentOwnerEdge>();
        for (const edge of expected) {
            this.requireOwner(edge);
            if (!ownerKeyPrefixes.some((prefix) => edge.ownerKey.startsWith(prefix))) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Expected content owner edge is outside its namespace"
                );
            }
            if (expectedByKey.has(edge.ownerKey)) {
                throw new AgentCoreError(
                    "codec.invalid",
                    "Expected content custody contains a duplicate owner key"
                );
            }
            expectedByKey.set(edge.ownerKey, edge);
        }
        const actual = this.listOwnerEdges(transaction).filter((edge) =>
            ownerKeyPrefixes.some((prefix) => edge.ownerKey.startsWith(prefix))
        );
        if (actual.length !== expectedByKey.size) {
            throw invalidCustody();
        }
        const actualKeys = new Set<string>();
        for (const edge of actual) {
            if (actualKeys.has(edge.ownerKey)) {
                throw new AgentCoreError(
                    "codec.invalid",
                    "Stored content custody contains a duplicate owner key"
                );
            }
            actualKeys.add(edge.ownerKey);
            if (!expectedByKey.get(edge.ownerKey)?.equals(edge)) throw invalidCustody();
        }
    }

    protected abstract listOwnerEdges(transaction: TTransaction): readonly ContentOwnerEdge[];

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

function invalidCustody(): AgentCoreError {
    return new AgentCoreError(
        "codec.invalid",
        "Stored content custody does not match its owning records"
    );
}
