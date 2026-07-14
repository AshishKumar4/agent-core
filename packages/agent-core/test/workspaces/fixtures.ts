import { ActorId, ActorRef } from "../../src/actors";
import { TurnId } from "../../src/agents";
import { ContentRef, Digest, JsonSchema, Revision, type JsonValue } from "../../src/core";
import {
    BindingName,
    EventKind,
    EventPattern,
    FacetPackageId,
    FieldMove,
    OperationRef,
    PayloadMapping,
    SurfaceId,
    type DedupePolicy,
    type TrustTier
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    TenantId,
    WorkspaceId as IdentityWorkspaceId
} from "../../src/identity";
import {
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { Event } from "../../src/workspaces/event";
import {
    ActionId,
    ContentRetentionId,
    EventCursor,
    InboxReferenceId,
    RetainedRecordRef
} from "../../src/workspaces/id";
import { EventId, SubscriptionId } from "../../src/workspaces";
import { InboxEventReference } from "../../src/workspaces/inbox";
import { ContentRetentionReference, RetainedRecordKind } from "../../src/workspaces/retention";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteDeliveryState,
    RouteProjection,
    RouteProjectionAuthenticator,
    RouteReservation,
    routeProjectionEnvelopeBytes
} from "../../src/workspaces/route";
import { Subscription } from "../../src/workspaces/subscription";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import { ActionDescriptor, View, ViewDelta } from "../../src/workspaces/view";

const encoder = new TextEncoder();

export const tenant = new TenantId("tenant-test");
export const principalId = new PrincipalId("principal-test");
export const principal = new PrincipalRef(tenant, principalId);
export const sourceActor = new ActorRef("workspace", new ActorId("workspace-source"));
export const targetActor = new ActorRef("workspace", new ActorId("workspace-target"));
export const scope = ScopeRef.workspace(tenant, new IdentityWorkspaceId("workspace-scope"));

export function content(label: string): { readonly ref: ContentRef; readonly digest: Digest } {
    const digest = Digest.sha256(encoder.encode(label));
    return { digest, ref: ContentRef.fromDigest(digest) };
}

export function eventFixture(
    suffix = "default",
    init: {
        readonly causation?: EventId;
        readonly kind?: string;
        readonly source?: "actor" | "facet";
        readonly trust?: TrustTier;
    } = {}
): Event {
    const payload = content(`event-payload-${suffix}`);
    const trust = init.trust ?? "authenticated";
    const provenance = new EventProvenance({
        verification: trust === "self" ? EventVerification.host() : EventVerification.verified(),
        principal,
        channel: "test-channel",
        claims: { nested: { accepted: true }, roles: ["operator"] }
    });
    return new Event({
        id: new EventId(`event-${suffix}`),
        scope,
        source:
            init.source === "actor"
                ? { kind: "actor", actor: sourceActor }
                : { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind(init.kind ?? "task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        idempotencyKey: `event-key-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        ...(init.causation === undefined ? {} : { causation: init.causation }),
        provenance,
        trust,
        visibility: "workspace",
        initiator: principal
    });
}

export function subscriptionFixture(
    suffix = "default",
    init: {
        readonly dedupe?: DedupePolicy;
        readonly mapping?: PayloadMapping;
        readonly revision?: Revision;
    } = {}
): Subscription {
    return new Subscription({
        id: new SubscriptionId(`subscription-${suffix}`),
        revision: init.revision ?? Revision.initial(),
        source: new EventPattern("task.*", ["authenticated", "owner", "self"], "facet.*"),
        target: new OperationRef("facet.test:consume"),
        mapping: init.mapping ?? new PayloadMapping([new FieldMove("", { from: "" })]),
        dedupe: init.dedupe ?? "event",
        authority: { kind: "initiator", binding: new BindingName("binding.route") }
    });
}

export function reservationFixture(
    suffix = "default",
    init: {
        readonly projectionContent?: ReturnType<typeof content>;
        readonly source?: ActorRef;
        readonly target?: ActorRef;
    } = {}
): RouteReservation {
    const projectionContent = init.projectionContent ?? content(`projection-${suffix}`);
    return new RouteReservation({
        id: new RouteReservationId(`reservation-${suffix}`),
        invocation: new InvocationId(`invocation-${suffix}`),
        event: new EventId(`event-${suffix}`),
        sourceAuditCause: new AuditRecordId(`audit-event-${suffix}`),
        sourceActor: init.source ?? sourceActor,
        targetActor: init.target ?? targetActor,
        tenants: { kind: "same", tenant },
        subscription: new SubscriptionId(`subscription-${suffix}`),
        dedupeKey: `event:event-${suffix}`,
        operation: new OperationRef("facet.test:consume"),
        authority: { kind: "initiator", binding: new BindingName("binding.route") },
        projection: new RouteProjectionId(`projection-${suffix}`),
        projectionRef: projectionContent.ref,
        projectionDigest: projectionContent.digest,
        trust: "authenticated",
        initiator: principal
    });
}

export function projectionFixture(reservation: RouteReservation): RouteProjection {
    return new RouteProjection({
        id: reservation.projection,
        reservation: reservation.id,
        content: reservation.projectionRef,
        digest: reservation.projectionDigest
    });
}

class FixtureProjectionAuthenticator extends RouteProjectionAuthenticator {
    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = new TextEncoder().encode(Digest.sha256(message).value);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

export function authenticatedProjectionFixture(
    reservation: RouteReservation
): AuthenticatedRouteProjection {
    const projection = projectionFixture(reservation);
    const envelope = { reservation, projection };
    const evidence = new TextEncoder().encode(
        Digest.sha256(routeProjectionEnvelopeBytes(envelope)).value
    );
    return new FixtureProjectionAuthenticator().authenticate(envelope, evidence);
}

export function deliveryFixture(
    reservation: RouteReservation,
    outcome: "delivered" | "rejected" = "delivered"
): RouteDelivery {
    return new RouteDelivery({
        reservation: reservation.id,
        state:
            outcome === "delivered"
                ? RouteDeliveryState.delivered()
                : RouteDeliveryState.rejected("authority denied"),
        targetAudit: new AuditRecordId(`audit-delivery-${reservation.id.value}`)
    });
}

export function retentionFixture(init: {
    readonly actor?: ActorRef;
    readonly content: ReturnType<typeof content>;
    readonly id: string;
    readonly recordId: string;
    readonly recordKind: RetainedRecordKind["kind"];
}): ContentRetentionReference {
    return new ContentRetentionReference({
        id: new ContentRetentionId(init.id),
        tenant,
        actor: init.actor ?? sourceActor,
        recordKind: retainedKind(init.recordKind),
        record: new RetainedRecordRef(init.recordId),
        content: init.content.ref,
        digest: init.content.digest
    });
}

function retainedKind(kind: RetainedRecordKind["kind"]): RetainedRecordKind {
    if (kind === "event") return RetainedRecordKind.event();
    if (kind === "routeReservation") return RetainedRecordKind.routeReservation();
    if (kind === "routeProjection") return RetainedRecordKind.routeProjection();
    if (kind === "view") return RetainedRecordKind.view();
    return RetainedRecordKind.viewDelta();
}

export function eventRetention(
    event: Event,
    id = `retention-${event.id.value}`
): ContentRetentionReference {
    return retentionFixture({
        id,
        recordKind: "event",
        recordId: event.id.value,
        content: { ref: event.payload, digest: event.payloadDigest }
    });
}

export function reservationRetention(
    reservation: RouteReservation,
    id = `retention-${reservation.id.value}`
): ContentRetentionReference {
    return retentionFixture({
        id,
        recordKind: "routeReservation",
        recordId: reservation.id.value,
        content: { ref: reservation.projectionRef, digest: reservation.projectionDigest }
    });
}

export function projectionRetention(
    projection: RouteProjection,
    actor = targetActor,
    id = `retention-${projection.id.value}`
): ContentRetentionReference {
    return retentionFixture({
        actor,
        id,
        recordKind: "routeProjection",
        recordId: projection.id.value,
        content: { ref: projection.content, digest: projection.digest }
    });
}

export function inboxFixture(
    suffix = "default",
    sequence = 0,
    leaseEpoch = 4,
    turn = new TurnId("turn-test")
): InboxEventReference {
    return new InboxEventReference({
        id: new InboxReferenceId(`inbox-${suffix}`),
        turn,
        event: new EventId(`event-${suffix}`),
        sequence,
        leaseEpoch
    });
}

export function viewFixture(revision = 0, suffix = "default"): View {
    return new View({
        surface: new SurfaceId(`surface-${suffix}`),
        revision: new Revision(revision),
        body: { count: revision, nested: { enabled: true } },
        actions: [
            new ActionDescriptor({
                id: new ActionId("increment"),
                label: "Increment",
                emits: new EventKind("counter.increment"),
                arguments: new JsonSchema({ type: "object", additionalProperties: false })
            })
        ],
        cursor: new EventCursor(`cursor-${revision}`)
    });
}

export function viewDeltaFixture(view: View, count = view.revision.value + 1): ViewDelta {
    return new ViewDelta({
        surface: view.surface,
        baseRevision: view.revision,
        revision: view.revision.next(),
        patch: [{ op: "replace", path: "/body/count", value: count }],
        cursor: new EventCursor(`cursor-${view.revision.value + 1}`)
    });
}

export class DeterministicJsonPatchEngine {
    public readonly calls: {
        readonly document: JsonValue;
        readonly patch: readonly JsonValue[];
    }[] = [];

    public apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue {
        this.calls.push({ document, patch });
        const result = structuredClone(document) as JsonValue;
        for (const operation of patch) {
            if (
                !isObject(operation) ||
                operation["op"] !== "replace" ||
                typeof operation["path"] !== "string" ||
                !("value" in operation)
            ) {
                throw new TypeError("Test JSON Patch engine only supports replace operations");
            }
            replace(result, operation["path"], structuredClone(operation["value"]));
        }
        return result;
    }
}

function replace(document: JsonValue, pointer: string, value: JsonValue): void {
    const tokens = pointer
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = document;
    for (const token of tokens.slice(0, -1)) {
        if (Array.isArray(parent)) parent = parent[Number(token)]!;
        else if (isObject(parent)) parent = parent[token]!;
        else throw new TypeError("Patch path traverses a scalar");
    }
    const token = tokens.at(-1)!;
    if (Array.isArray(parent)) parent[Number(token)] = value;
    else if (isObject(parent) && Object.hasOwn(parent, token)) {
        (parent as { [key: string]: JsonValue })[token] = value;
    } else {
        throw new TypeError("Patch replace path does not exist");
    }
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}
