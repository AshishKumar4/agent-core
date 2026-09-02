import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    canonicalTupleKey,
    ContentRef,
    type ContentRetentionField,
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

/**
 * The namespace one record kind's owner keys share. A store verifies its whole custody
 * against exactly the namespaces of the kinds it owns, and the encoded tuple below always
 * begins with the kind, so this prefix reaches every key of one kind and no key of another.
 */
export function contentOwnerNamespace(kind: string): string {
    return canonicalTupleKey("record", [kind]).slice(0, -1) + ",";
}

/**
 * The owner key one durable record's field holds its ContentRef under. It is the repo's
 * injective composite-key idiom — one canonical JSON tuple of the kind, the record's own
 * key, and the field — so no record identity or field name can collide with another's key
 * by containing a separator, and one Actor's record families stay distinct inside the
 * single custody namespace §8.4 gives it.
 *
 * The format changed once, from a hand-built `record:<kind>:<len>:<key>:<field>`
 * concatenation to this tuple encoding, inside the same wave that introduced it and before
 * any durable store shipped an owner edge written under the old shape. No migration is owed:
 * the two builds never meet over one stored set, and the §8.3 declaration gate refuses the
 * older build's records on activation rather than decoding them.
 */
export function contentOwnerKey(kind: string, key: string, field: string): string {
    return canonicalTupleKey("record", [kind, key, field]);
}

/**
 * A durable record as the custody plane sees it: its wire kind, the identity its store
 * keys it under, and the ContentRefs its fields name right now.
 */
export interface RetainedContentRecord {
    readonly kind: string;
    readonly key: string;
    readonly fields: readonly ContentRetentionField[];
}

/**
 * The seam a record store calls on every durable write of a content-bearing record. It is
 * deliberately narrower than `ContentRetention`: a store registers and releases the records
 * it owns and never collects, and it names records rather than owner edges, so the Tenant,
 * the Actor and the owner key stay the custody plane's to decide.
 */
export interface ContentCustodyPort<Transaction> {
    /**
     * Registers every ContentRef `record` names and releases every one the stored record
     * named before and no longer does, inside the writer's own transaction.
     */
    retain(
        transaction: Transaction,
        record: RetainedContentRecord,
        previous?: RetainedContentRecord
    ): void;

    /** Releases every ContentRef `record` names, for a removal path that drops the record. */
    release(transaction: Transaction, record: RetainedContentRecord): void;
}

/**
 * The one implementation of that seam: it derives each record's owner edges and reconciles
 * them through a `ContentRetention`, so a store's write path and the collection sweep read
 * the same custody state. Retention is idempotent, so re-registering an unchanged record is
 * a no-op rather than a conflict, and a field whose ContentRef moved releases the old edge
 * before it retains the new one — the swap the §8.4 custody contract requires.
 */
export class ContentRecordCustody<Transaction> implements ContentCustodyPort<Transaction> {
    public constructor(
        private readonly retention: ContentRetention<Transaction>,
        private readonly now: () => Date = () => new Date()
    ) {
        Object.freeze(this);
    }

    public retain(
        transaction: Transaction,
        record: RetainedContentRecord,
        previous?: RetainedContentRecord
    ): void {
        const after = this.edges(record);
        const before = previous === undefined ? [] : this.edges(previous);
        if (before.length === 0 && after.length === 0) return;
        const operationAt = this.operationTime();
        for (const edge of before) {
            if (!after.some((candidate) => candidate.equals(edge))) {
                this.retention.release(transaction, edge, operationAt);
            }
        }
        for (const edge of after) this.retention.retain(transaction, edge, operationAt);
    }

    public release(transaction: Transaction, record: RetainedContentRecord): void {
        const edges = this.edges(record);
        if (edges.length === 0) return;
        const operationAt = this.operationTime();
        for (const edge of edges) this.retention.release(transaction, edge, operationAt);
    }

    private edges(record: RetainedContentRecord): readonly ContentOwnerEdge[] {
        return record.fields.map(
            ({ field, ref }) =>
                new ContentOwnerEdge(
                    this.retention.tenant,
                    this.retention.actor,
                    contentOwnerKey(record.kind, record.key, field),
                    ref
                )
        );
    }

    private operationTime(): Date {
        return requireOperationTime(this.now(), "Content custody time");
    }
}
Object.freeze(ContentRecordCustody.prototype);
Object.freeze(ContentRecordCustody);

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

    /**
     * Whether this Actor's content plane holds the bytes `ref` names, read inside the
     * caller's own transaction. A record may name only content its Actor already holds, and
     * `retain` refuses the rest; this is the same question asked before the record is built,
     * so a write path can reject with its own protocol error instead of a custody fault.
     */
    public abstract holds(transaction: TTransaction, ref: ContentRef): boolean;

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
