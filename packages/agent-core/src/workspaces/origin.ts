import { ActorId, ActorRef } from "../actors";
import type { LeaseToken } from "../agents";
import { ContentRef, Digest, encodeBase64, encodeCanonicalJson, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { EventKind, FacetPackageId, type EventVisibility } from "../facets";
import { PrincipalRef, decodeScopeRef, encodeScopeRef, type ScopeRef } from "../identity";
import { CorrelationId, EventId } from "../interaction-references";
import { ContentRetentionReference } from "./retention";
import { EventProvenance, type EventSource } from "./value";

const intentToken: unique symbol = Symbol("authenticated-event-intent");
const authenticatedIntents = new WeakSet<AuthenticatedEventIntent>();

export interface EventIntentInput {
    readonly id: EventId;
    readonly scope: ScopeRef;
    readonly sourceActor: ActorRef;
    readonly source: EventSource;
    readonly kind: EventKind;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly payloadRetention: ContentRetentionReference;
    readonly idempotencyKey: string;
    readonly correlation: CorrelationId;
    readonly causation?: EventId;
    readonly provenance: EventProvenance;
    readonly visibility: EventVisibility;
    readonly lease?: LeaseToken;
}

export class AuthenticatedEventIntent {
    public readonly intent: EventIntentInput;
    public readonly digest: Digest;

    public constructor(token: typeof intentToken, intent: EventIntentInput) {
        if (token !== intentToken) {
            throw new TypeError("Authenticated Event intent construction is host-only");
        }
        this.intent = detachIntent(intent);
        this.digest = Digest.sha256(eventIntentBytes(this.intent));
        authenticatedIntents.add(this);
        Object.freeze(this);
    }
}

export abstract class EventIntentAuthenticator {
    public authenticate(input: EventIntentInput, evidence: Uint8Array): AuthenticatedEventIntent {
        const intent = detachIntent(input);
        const message = eventIntentBytes(intent);
        if (!this.verify(message.slice(), evidence.slice())) {
            throw new AgentCoreError("authority.denied", "Event intent authentication failed");
        }
        return new AuthenticatedEventIntent(intentToken, intent);
    }

    protected abstract verify(message: Uint8Array, evidence: Uint8Array): boolean;
}

export function requireAuthenticatedEventIntent(
    value: AuthenticatedEventIntent
): asserts value is AuthenticatedEventIntent {
    if (!(value instanceof AuthenticatedEventIntent) || !authenticatedIntents.has(value)) {
        throw new AgentCoreError("authority.denied", "Event intent lacks host authentication");
    }
}

export function eventIntentBytes(intent: EventIntentInput): Uint8Array {
    requireIntentPayloadDigest(intent);
    return encodeCanonicalJson(intentData(intent));
}

function intentData(intent: EventIntentInput): JsonValue {
    return {
        domain: "agent-core.event-intent.v1",
        id: intent.id.value,
        scope: encodeScopeRef(intent.scope),
        sourceActor: { kind: intent.sourceActor.kind, id: intent.sourceActor.id.value },
        source:
            intent.source.kind === "facet"
                ? { kind: intent.source.kind, facet: intent.source.facet.value }
                : {
                      kind: intent.source.kind,
                      actor: { kind: intent.source.actor.kind, id: intent.source.actor.id.value }
                  },
        kind: intent.kind.value,
        payload: intent.payload.value,
        payloadDigest: intent.payloadDigest.value,
        payloadRetention: encodeBase64(ContentRetentionReference.encode(intent.payloadRetention)),
        idempotencyKey: intent.idempotencyKey,
        correlation: intent.correlation.value,
        causation: intent.causation?.value ?? null,
        provenance: provenanceData(intent.provenance),
        visibility: intent.visibility,
        lease:
            intent.lease === undefined
                ? null
                : {
                      turn: intent.lease.turn.value,
                      holder: {
                          principal: intent.lease.holder.principalId.value,
                          tenant: intent.lease.holder.tenantId.value
                      },
                      epoch: intent.lease.epoch
                  }
    };
}

function detachIntent(intent: EventIntentInput): EventIntentInput {
    requireIntentPayloadDigest(intent);
    const source: EventSource =
        intent.source.kind === "facet"
            ? { kind: "facet", facet: new FacetPackageId(intent.source.facet.value) }
            : {
                  kind: "actor",
                  actor: new ActorRef(
                      intent.source.actor.kind,
                      new ActorId(intent.source.actor.id.value)
                  )
              };
    return Object.freeze({
        id: intent.id,
        scope: decodeScopeRef(encodeScopeRef(intent.scope)),
        sourceActor: new ActorRef(
            intent.sourceActor.kind,
            new ActorId(intent.sourceActor.id.value)
        ),
        source: Object.freeze(source),
        kind: new EventKind(intent.kind.value),
        payload: new ContentRef(intent.payload.value),
        payloadDigest: new Digest(intent.payloadDigest.value),
        payloadRetention: ContentRetentionReference.decode(
            ContentRetentionReference.encode(intent.payloadRetention)
        ),
        idempotencyKey: intent.idempotencyKey,
        correlation: intent.correlation,
        ...(intent.causation === undefined ? {} : { causation: intent.causation }),
        provenance: copyProvenance(intent.provenance),
        visibility: intent.visibility,
        ...(intent.lease === undefined
            ? {}
            : {
                  lease: Object.freeze({
                      turn: intent.lease.turn,
                      holder: new PrincipalRef(
                          intent.lease.holder.tenantId,
                          intent.lease.holder.principalId
                      ),
                      epoch: intent.lease.epoch
                  })
              })
    });
}

function requireIntentPayloadDigest(intent: EventIntentInput): void {
    if (!intent.payload.digest.equals(intent.payloadDigest)) {
        throw new TypeError("Event intent payload reference and digest must match");
    }
}

function provenanceData(provenance: EventProvenance): JsonValue {
    return provenance.toData();
}

function copyProvenance(provenance: EventProvenance): EventProvenance {
    return new EventProvenance({
        verification: provenance.verification,
        ...(provenance.principal === undefined ? {} : { principal: provenance.principal }),
        ...(provenance.channel === undefined ? {} : { channel: provenance.channel }),
        ...(provenance.group === undefined ? {} : { group: provenance.group }),
        claims: provenance.claims
    });
}
