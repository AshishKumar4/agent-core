import { ActorId, ActorRef } from "../actors";
import {
    ContentRef,
    Digest,
    RecordCodec,
    type JsonValue,
    type RecordVersion,
    TextId
} from "../core";
import {
    ContentOwnerEdge,
    ContentRetention,
    contentOwnerKey,
    requireOperationTime
} from "../content";
import { TenantId } from "../identity";
import {
    decodeActor,
    decodeContent,
    encodeActor,
    encodeContent,
    requireFields,
    requireObject,
    requireString
} from "./codec";
import { ContentRetentionId, RetainedRecordRef } from "./id";

export abstract class RetainedRecordKind {
    public static event(): RetainedRecordKind {
        return retainedEvent;
    }
    public static routeReservation(): RetainedRecordKind {
        return retainedReservation;
    }
    public static routeProjection(): RetainedRecordKind {
        return retainedProjection;
    }
    public static view(): RetainedRecordKind {
        return retainedView;
    }
    public static viewDelta(): RetainedRecordKind {
        return retainedViewDelta;
    }

    public abstract readonly kind:
        "event" | "routeReservation" | "routeProjection" | "view" | "viewDelta";

    public equals(other: RetainedRecordKind): boolean {
        return this.kind === other.kind;
    }
}

class RetainedEvent extends RetainedRecordKind {
    public readonly kind = "event" as const;
}

class RetainedReservation extends RetainedRecordKind {
    public readonly kind = "routeReservation" as const;
}

class RetainedProjection extends RetainedRecordKind {
    public readonly kind = "routeProjection" as const;
}

class RetainedView extends RetainedRecordKind {
    public readonly kind = "view" as const;
}

class RetainedViewDelta extends RetainedRecordKind {
    public readonly kind = "viewDelta" as const;
}

const retainedEvent = Object.freeze(new RetainedEvent());
const retainedReservation = Object.freeze(new RetainedReservation());
const retainedProjection = Object.freeze(new RetainedProjection());
const retainedView = Object.freeze(new RetainedView());
const retainedViewDelta = Object.freeze(new RetainedViewDelta());

export interface ContentRetentionReferenceInit {
    readonly id: ContentRetentionId;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly recordKind: RetainedRecordKind;
    readonly record: RetainedRecordRef;
    readonly content: ContentRef;
    readonly digest: Digest;
}

class ContentRetentionReferenceCodecV1 extends RecordCodec<ContentRetentionReference> {
    public constructor() {
        super(
            [
                ContentRetentionReference,
                ActorRef,
                ContentRef,
                RetainedRecordKind,
                RetainedEvent,
                RetainedReservation,
                RetainedProjection,
                RetainedView,
                RetainedViewDelta,
                TextId,
                Digest,
                RetainedRecordRef,
                ActorId,
                TenantId,
                ContentRetentionId
            ],
            "workspace.content-retention-reference",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(reference: ContentRetentionReference): JsonValue {
        return {
            id: reference.id.value,
            tenant: reference.tenant.value,
            actor: encodeActor(reference.actor),
            recordKind: reference.recordKind.kind,
            record: reference.record.value,
            content: encodeContent(reference.content, reference.digest)
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): ContentRetentionReference {
        const object = requireObject(payload, "Content retention payload");
        requireFields(
            object,
            ["actor", "content", "id", "record", "recordKind", "tenant"],
            "Content retention payload"
        );
        const content = decodeContent(object["content"], "Retained content");
        return new ContentRetentionReference({
            id: new ContentRetentionId(requireString(object["id"], "Content retention ID")),
            tenant: new TenantId(requireString(object["tenant"], "Content retention tenant")),
            actor: decodeActor(object["actor"], "Content retention Actor"),
            recordKind: decodeRecordKind(object["recordKind"]),
            record: new RetainedRecordRef(
                requireString(object["record"], "Retained record reference")
            ),
            content: content.ref,
            digest: content.digest
        });
    }
}

export class ContentRetentionReference {
    public static get codec(): RecordCodec<ContentRetentionReference> {
        return contentRetentionReferenceCodecInstance;
    }

    public static encode(reference: ContentRetentionReference): Uint8Array {
        return ContentRetentionReference.codec.encode(reference);
    }

    public static decode(bytes: Uint8Array): ContentRetentionReference {
        return ContentRetentionReference.codec.decode(bytes);
    }

    public readonly init: ContentRetentionReferenceInit;

    public constructor(init: ContentRetentionReferenceInit) {
        if (!init.content.digest.equals(init.digest)) {
            throw new TypeError("Retained ContentRef and digest must match");
        }
        this.init = Object.freeze({
            ...init,
            recordKind: decodeRecordKind(init.recordKind.kind)
        });
        Object.freeze(this);
    }

    public get id(): ContentRetentionId {
        return this.init.id;
    }
    public get tenant(): TenantId {
        return this.init.tenant;
    }
    public get actor(): ActorRef {
        return this.init.actor;
    }
    public get recordKind(): RetainedRecordKind {
        return this.init.recordKind;
    }
    public get record(): RetainedRecordRef {
        return this.init.record;
    }
    public get content(): ContentRef {
        return this.init.content;
    }
    public get digest(): Digest {
        return this.init.digest;
    }
}

const contentRetentionReferenceCodecInstance = new ContentRetentionReferenceCodecV1();

/**
 * The workspaces plane's window onto content custody (§8.4). `verify` asks whether the
 * named bytes are durably present before a record may name them; `retain` registers the
 * owner edge for the record that now names them, inside the same transaction as that
 * record; `release` drops the edge when the naming record is retired; `discard` reclaims
 * bytes a rejected write left behind.
 */
export interface ContentRetentionPort<Transaction> {
    verify(transaction: Transaction, reference: ContentRetentionReference): boolean;
    retain(transaction: Transaction, reference: ContentRetentionReference): void;
    release(transaction: Transaction, reference: ContentRetentionReference): void;
    discard(reference: ContentRetentionReference): void;
}

/**
 * The one implementation of that port over the §8.4 seam: the retained reference names its
 * own record kind and identity, so its owner key is the same shape every other plane's
 * custody derives, and the retention it writes is the retention the collection sweep reads.
 */
export class WorkspaceContentRetention<Transaction> implements ContentRetentionPort<Transaction> {
    public constructor(
        private readonly retention: ContentRetention<Transaction>,
        private readonly now: () => Date = () => new Date()
    ) {
        Object.freeze(this);
    }

    public verify(transaction: Transaction, reference: ContentRetentionReference): boolean {
        return (
            reference.tenant.equals(this.retention.tenant) &&
            reference.actor.equals(this.retention.actor) &&
            this.retention.holds(transaction, reference.content)
        );
    }

    public retain(transaction: Transaction, reference: ContentRetentionReference): void {
        this.retention.retain(transaction, this.edge(reference), this.operationTime());
    }

    public release(transaction: Transaction, reference: ContentRetentionReference): void {
        this.retention.release(transaction, this.edge(reference), this.operationTime());
    }

    public discard(_reference: ContentRetentionReference): void {
        // Bytes a rejected write left unnamed are reclaimed by the collection sweep, which
        // never offers content no owner edge and no lease holds. There is nothing to undo
        // here that the sweep does not already do, and nothing to delete that a concurrent
        // writer may not have named in the meantime.
    }

    private edge(reference: ContentRetentionReference): ContentOwnerEdge {
        return new ContentOwnerEdge(
            reference.tenant,
            reference.actor,
            contentOwnerKey(
                RETAINED_RECORD_KINDS[reference.recordKind.kind],
                reference.record.value,
                "content"
            ),
            reference.content
        );
    }

    private operationTime(): Date {
        return requireOperationTime(this.now(), "Workspace content retention time");
    }
}
Object.freeze(WorkspaceContentRetention.prototype);
Object.freeze(WorkspaceContentRetention);

/**
 * The wire kind each retained record family is registered under, so one owner namespace per
 * record kind matches what the record registry declares for that kind.
 */
const RETAINED_RECORD_KINDS: Readonly<Record<RetainedRecordKind["kind"], string>> = Object.freeze({
    event: "workspace.event",
    routeReservation: "workspace.route-reservation",
    routeProjection: "workspace.route-projection",
    view: "workspace.view",
    viewDelta: "workspace.view-delta"
});

function decodeRecordKind(value: JsonValue | undefined): RetainedRecordKind {
    if (value === "event") return RetainedRecordKind.event();
    if (value === "routeReservation") return RetainedRecordKind.routeReservation();
    if (value === "routeProjection") return RetainedRecordKind.routeProjection();
    if (value === "view") return RetainedRecordKind.view();
    if (value === "viewDelta") return RetainedRecordKind.viewDelta();
    throw new TypeError("Retained record kind is invalid");
}
