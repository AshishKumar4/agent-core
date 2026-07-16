// @ts-nocheck
import type { ActorRef } from "../actors";
import { ContentRef, Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core";
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
        super("workspace.content-retention-reference", { major: 1, minor: 0 });
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
        const content = decodeContent(object["content"]!, "Retained content");
        return new ContentRetentionReference({
            id: new ContentRetentionId(requireString(object["id"], "Content retention ID")),
            tenant: new TenantId(requireString(object["tenant"], "Content retention tenant")),
            actor: decodeActor(object["actor"]!, "Content retention Actor"),
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
    public static readonly codec: RecordCodec<ContentRetentionReference> =
        new ContentRetentionReferenceCodecV1();

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

export interface ContentRetentionPort<Transaction> {
    verify(transaction: Transaction, reference: ContentRetentionReference): boolean;
    release(transaction: Transaction, reference: ContentRetentionReference): void;
    discard(reference: ContentRetentionReference): void;
}

function decodeRecordKind(value: JsonValue | undefined): RetainedRecordKind {
    if (value === "event") return RetainedRecordKind.event();
    if (value === "routeReservation") return RetainedRecordKind.routeReservation();
    if (value === "routeProjection") return RetainedRecordKind.routeProjection();
    if (value === "view") return RetainedRecordKind.view();
    if (value === "viewDelta") return RetainedRecordKind.viewDelta();
    throw new TypeError("Retained record kind is invalid");
}
