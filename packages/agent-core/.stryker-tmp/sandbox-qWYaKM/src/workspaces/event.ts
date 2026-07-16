// @ts-nocheck
import { ActorRef } from "../actors";
import { ContentRef, Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { EventKind, FacetPackageId, type EventVisibility, type TrustTier } from "../facets";
import { PrincipalRef, ScopeRef } from "../identity";
import { CorrelationId, EventId } from "../interaction-references";
import {
    decodeActor,
    decodeContent,
    decodeOptionalPrincipalRef,
    decodeScope,
    encodeActor,
    encodeContent,
    encodeOptionalPrincipalRef,
    encodeScope,
    requireFields,
    requireNullableString,
    requireObject,
    requireString
} from "./codec";
import { EventProvenance, type EventSource } from "./value";

export interface EventInit {
    readonly id: EventId;
    readonly scope: ScopeRef;
    readonly source: EventSource;
    readonly kind: EventKind;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly idempotencyKey: string;
    readonly correlation: CorrelationId;
    readonly causation?: EventId;
    readonly provenance: EventProvenance;
    readonly trust: TrustTier;
    readonly visibility: EventVisibility;
    readonly initiator?: PrincipalRef;
}

class EventCodecV1 extends RecordCodec<Event> {
    public constructor() {
        super("workspace.event", { major: 1, minor: 0 });
    }

    protected encodePayload(event: Event): JsonValue {
        return {
            id: event.id.value,
            scope: encodeScope(event.scope),
            source: encodeSource(event.source),
            category: event.kind.value,
            content: encodeContent(event.payload, event.payloadDigest),
            idempotencyKey: event.idempotencyKey,
            correlation: event.correlation.value,
            causation: event.causation?.value ?? null,
            provenance: encodeProvenance(event.provenance),
            trust: event.trust,
            visibility: event.visibility,
            initiator: encodeOptionalPrincipalRef(event.initiator)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Event {
        const object = requireObject(payload, "Event payload");
        requireFields(
            object,
            [
                "category",
                "causation",
                "content",
                "correlation",
                "id",
                "idempotencyKey",
                "initiator",
                "provenance",
                "scope",
                "source",
                "trust",
                "visibility"
            ],
            "Event payload"
        );
        const content = decodeContent(object["content"]!, "Event content");
        const causation = requireNullableString(object["causation"], "Event causation");
        const initiator = decodeOptionalPrincipalRef(object["initiator"], "Event initiator");
        return new Event({
            id: new EventId(requireString(object["id"], "Event ID")),
            scope: decodeScope(object["scope"]!),
            source: decodeSource(object["source"]!),
            kind: new EventKind(requireString(object["category"], "Event category")),
            payload: content.ref,
            payloadDigest: content.digest,
            idempotencyKey: requireString(object["idempotencyKey"], "Event idempotency key"),
            correlation: new CorrelationId(
                requireString(object["correlation"], "Event correlation")
            ),
            ...(causation === undefined ? {} : { causation: new EventId(causation) }),
            provenance: decodeProvenance(object["provenance"]!),
            trust: decodeTrust(object["trust"]),
            visibility: decodeVisibility(object["visibility"]),
            ...(initiator === undefined ? {} : { initiator })
        });
    }
}

export class Event {
    public static readonly codec: RecordCodec<Event> = new EventCodecV1();

    public static encode(event: Event): Uint8Array {
        return Event.codec.encode(event);
    }

    public static decode(bytes: Uint8Array): Event {
        return Event.codec.decode(bytes);
    }

    public readonly id: EventId;
    public readonly scope: ScopeRef;
    public readonly source: EventSource;
    public readonly kind: EventKind;
    public readonly payload: ContentRef;
    public readonly payloadDigest: Digest;
    public readonly idempotencyKey: string;
    public readonly correlation: CorrelationId;
    public readonly causation: EventId | undefined;
    public readonly provenance: EventProvenance;
    public readonly trust: TrustTier;
    public readonly visibility: EventVisibility;
    public readonly initiator: PrincipalRef | undefined;

    public constructor(init: EventInit) {
        if (!init.payload.digest.equals(init.payloadDigest)) {
            throw new TypeError("Event payload reference and digest must match");
        }
        if (
            init.idempotencyKey.length === 0 ||
            init.idempotencyKey.length > 512 ||
            init.idempotencyKey.trim() !== init.idempotencyKey
        ) {
            throw new TypeError(
                "Event idempotency key must be a canonical string of at most 512 characters"
            );
        }
        if (init.trust === "self" && init.provenance.verification.kind !== "host") {
            throw new TypeError("Self trust requires host provenance");
        }
        if (init.trust === "owner" && init.initiator === undefined) {
            throw new TypeError("Owner trust requires an authenticated initiator");
        }
        if (
            (init.trust === "owner" || init.trust === "authenticated") &&
            (init.provenance.principal === undefined ||
                init.initiator === undefined ||
                !init.provenance.principal.equals(init.initiator))
        ) {
            throw new TypeError("Authenticated trust requires the exact provenance Principal");
        }
        if (
            init.provenance.principal !== undefined &&
            init.initiator !== undefined &&
            !init.provenance.principal.equals(init.initiator)
        ) {
            throw new TypeError("Event initiator cannot substitute another Principal");
        }
        if (init.initiator !== undefined && !init.initiator.tenantId.equals(init.scope.tenantId)) {
            throw new TypeError("Event initiator Tenant must match the Event scope");
        }
        this.id = init.id;
        this.scope = init.scope;
        this.source = copySource(init.source);
        this.kind = init.kind;
        this.payload = init.payload;
        this.payloadDigest = init.payloadDigest;
        this.idempotencyKey = init.idempotencyKey;
        this.correlation = init.correlation;
        this.causation = init.causation;
        this.provenance = new EventProvenance({
            verification: init.provenance.verification,
            ...(init.provenance.principal === undefined
                ? {}
                : { principal: init.provenance.principal }),
            ...(init.provenance.channel === undefined ? {} : { channel: init.provenance.channel }),
            ...(init.provenance.group === undefined ? {} : { group: init.provenance.group }),
            claims: init.provenance.claims
        });
        this.trust = init.trust;
        this.visibility = init.visibility;
        this.initiator = init.initiator;
        Object.freeze(this);
    }
}

function encodeSource(source: EventSource): JsonValue {
    return source.kind === "facet"
        ? { kind: source.kind, facet: source.facet.value }
        : { kind: source.kind, actor: encodeActor(source.actor) };
}

function decodeSource(value: JsonValue): EventSource {
    const object = requireObject(value, "Event source");
    if (object["kind"] === "facet") {
        requireFields(object, ["facet", "kind"], "Facet Event source");
        return {
            kind: "facet",
            facet: new FacetPackageId(requireString(object["facet"], "Event source Facet"))
        };
    }
    if (object["kind"] === "actor") {
        requireFields(object, ["actor", "kind"], "Actor Event source");
        return { kind: "actor", actor: decodeActor(object["actor"]!, "Event source Actor") };
    }
    throw new TypeError("Event source kind is invalid");
}

function copySource(source: EventSource): EventSource {
    return source.kind === "facet"
        ? Object.freeze({ kind: source.kind, facet: source.facet })
        : Object.freeze({
              kind: source.kind,
              actor: new ActorRef(source.actor.kind, source.actor.id)
          });
}

function encodeProvenance(provenance: EventProvenance): JsonValue {
    return provenance.toData();
}

function decodeProvenance(value: JsonValue): EventProvenance {
    return EventProvenance.fromData(value);
}

function decodeTrust(value: JsonValue | undefined): TrustTier {
    if (
        value === "owner" ||
        value === "authenticated" ||
        value === "external" ||
        value === "self"
    ) {
        return value;
    }
    throw new TypeError("Event trust is invalid");
}

function decodeVisibility(value: JsonValue | undefined): EventVisibility {
    if (value === "workspace" || value === "private") return value;
    throw new TypeError("Event visibility is invalid");
}
