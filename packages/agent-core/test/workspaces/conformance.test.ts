import { expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision } from "../../src/core";
import { EventKind, EventPattern, OperationRef, PayloadMapping, SurfaceId } from "../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import {
    AuthenticatedEventIntent,
    Event,
    EventCursor,
    EventId,
    EventIntentAuthenticator,
    EventProvenance,
    EventVerification,
    MemoryWorkspaceRecords,
    RouteProjection,
    RouteReservation,
    SubscriptionId,
    View,
    ViewDelta,
    deriveEventTrust,
    eventMatches,
    eventIntentBytes,
    requireAuthenticatedRouteProjection
} from "../../src/workspaces";
import type { EventIntentInput } from "../../src/workspaces";
import {
    content,
    eventFixture,
    eventRetention,
    principal,
    projectionFixture,
    reservationFixture,
    retentionFixture,
    scope,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

class ConformanceIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventIntentInput): Uint8Array {
        return new TextEncoder().encode(Digest.sha256(eventIntentBytes(intent)).value);
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = new TextEncoder().encode(Digest.sha256(message).value);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

test("duplicate route storage identity is rejected", () => {
    const records = new MemoryWorkspaceRecords();
    records.insertUnique({ namespace: "route", key: "same", recordKey: "first" });
    expect(() =>
        records.insertUnique({ namespace: "route", key: "same", recordKey: "second" })
    ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
});

test("[C13-ADV-FORGED-INITIATOR] provenance Principal cannot be forged", () => {
    const event = eventFixture("forged-initiator");
    expect(
        () =>
            new Event({
                id: event.id,
                scope: event.scope,
                source: event.source,
                kind: event.kind,
                payload: event.payload,
                payloadDigest: event.payloadDigest,
                idempotencyKey: event.idempotencyKey,
                correlation: event.correlation,
                provenance: event.provenance,
                trust: event.trust,
                visibility: event.visibility,
                initiator: new PrincipalRef(tenant, new PrincipalId("attacker"))
            })
    ).toThrow(/exact provenance Principal|substitute/);
});

test("caller tier is absent from authenticated origin data", () => {
    expect(
        Object.keys(
            new EventProvenance({
                verification: EventVerification.verified(),
                claims: {}
            })
        )
    ).not.toContain("trust");
});

test("[C13-ADV-OMITTED-TRUST-SET] accepted trust set cannot be empty", () => {
    expect(() => new EventPattern("task.*", [] as unknown as ["owner"])).toThrow(
        /must not be empty|known values/
    );
});

test("[C13-ADV-SUBSTITUTED-INITIATOR] routed initiator remains exact", () => {
    const route = reservationFixture("exact-initiator");
    expect(route.initiator?.equals(principal)).toBe(true);
    expect(route.authority.kind).toBe("initiator");
    expect(
        () =>
            new RouteReservation({
                ...route.init,
                initiator: new PrincipalRef(new TenantId("tenant-other"), principal.principalId)
            })
    ).toThrow(/source Tenant/);
});

test("[C13-ADV-UNAUTHENTICATED-PROJECTION] structural projection cannot bridge", () => {
    const reservation = reservationFixture("unverified-projection");
    const projection = projectionFixture(reservation);
    expect(() =>
        requireAuthenticatedRouteProjection({
            envelope: { reservation, projection }
        } as unknown as never)
    ).toThrow(expect.objectContaining({ code: "authority.denied" }));
});

test("[C13-ROUTE-PROJECTION-DIGEST] projection binds exact content digest", () => {
    const reservation = reservationFixture("projection-digest");
    expect(
        () =>
            new RouteProjection({
                id: reservation.projection,
                reservation: reservation.id,
                content: reservation.projectionRef,
                digest: Digest.sha256(new TextEncoder().encode("wrong"))
            })
    ).toThrow(/reference and digest must match/);
});

test("[C13-ROUTE-SOURCE-EVENT] reservation identifies its exact Event", () => {
    const route = reservationFixture("source-event");
    expect(route.event.equals(new EventId("event-source-event"))).toBe(true);
});

test("[C13-ROUTE-SOURCE-OWNED] reservation preserves source ownership", () => {
    expect(reservationFixture("source-owned").sourceActor.equals(sourceActor)).toBe(true);
});

test("[C13-ROUTE-STABLE-INVOCATION] reservation codec preserves InvocationId", () => {
    const route = reservationFixture("stable-invocation");
    expect(
        RouteReservation.decode(RouteReservation.encode(route)).invocation.equals(route.invocation)
    ).toBe(true);
});

test("[C13-ROUTE-TENANT-RELATION] reservation preserves tenant relation", () => {
    const route = reservationFixture("tenant-relation");
    expect(route.tenants.kind).toBe("same");
    if (route.tenants.kind === "same") expect(route.tenants.tenant.equals(tenant)).toBe(true);
});

test("[C13-SUBSCRIPTION-ACCEPTED-TIERS] matching is categorical", () => {
    const event = eventFixture("categorical");
    expect(eventMatches(new EventPattern("task.*", ["authenticated"]), event)).toBe(true);
    expect(eventMatches(new EventPattern("task.*", ["owner"]), event)).toBe(false);
});

test("[C13-TRUST-ASSERTION-REJECTION] trust derives from host facts only", () => {
    expect(
        deriveEventTrust({
            authenticatedPrincipal: principal,
            principalOwnsScope: false,
            validTurnLease: false,
            hostEmission: false
        }).tier
    ).toBe("authenticated");
});

test("[C13-TRUST-HOST-DERIVED] exact lease-backed host emission derives self", () => {
    expect(
        deriveEventTrust({
            authenticatedPrincipal: principal,
            principalOwnsScope: false,
            validTurnLease: true,
            hostEmission: true
        }).tier
    ).toBe("self");
});

test("[C13-TRUST-VERIFIED-INGRESS] verified evidence binds the complete Event intent", () => {
    const intent = eventIntentFixture("verified-ingress");
    const authenticator = new ConformanceIntentAuthenticator();
    const evidence = authenticator.evidence(intent);
    expect(authenticator.authenticate(intent, evidence)).toBeInstanceOf(AuthenticatedEventIntent);
    expect(() => authenticator.authenticate(intent, Uint8Array.of(0))).toThrow(
        expect.objectContaining({ code: "authority.denied" })
    );

    expect(() =>
        authenticator.authenticate(
            {
                ...intent,
                source: { kind: "actor", actor: targetActor }
            },
            evidence
        )
    ).toThrow(expect.objectContaining({ code: "authority.denied" }));

    const substitutedPayload = content("substituted-ingress-payload");
    expect(() =>
        authenticator.authenticate(
            {
                ...intent,
                payload: substitutedPayload.ref,
                payloadDigest: substitutedPayload.digest,
                payloadRetention: retentionFixture({
                    id: "retention-substituted-ingress-payload",
                    recordKind: "event",
                    recordId: intent.id.value,
                    content: substitutedPayload
                })
            },
            evidence
        )
    ).toThrow(expect.objectContaining({ code: "authority.denied" }));
});

test("ViewDelta revision continues its base", () => {
    const view = viewFixture(0, "conformance-replay");
    expect(viewDeltaFixture(view).baseRevision.equals(view.revision)).toBe(true);
});

test("[C13-VIEW-NO-LIVE-STATE] View rejects live non-JSON state", () => {
    expect(
        () =>
            new View({
                surface: new SurfaceId("live-state"),
                revision: Revision.initial(),
                body: { live: (() => undefined) as unknown as string },
                actions: [],
                cursor: new EventCursor("live-state-cursor")
            })
    ).toThrow();
});

test("conformance fixtures retain canonical route identity types", () => {
    const projection = content("identity-types");
    const route = new RouteReservation({
        id: new RouteReservationId("identity-route"),
        invocation: new InvocationId("identity-invocation"),
        event: new EventId("identity-event"),
        sourceAuditCause: new AuditRecordId("identity-audit"),
        sourceActor,
        targetActor,
        tenants: { kind: "same", tenant },
        subscription: new SubscriptionId("identity-subscription"),
        dedupeKey: "event:identity-event",
        operation: new OperationRef("facet.test:consume"),
        authority: subscriptionFixture().authority,
        projection: new RouteProjectionId("identity-projection"),
        projectionRef: projection.ref,
        projectionDigest: projection.digest,
        trust: "authenticated",
        initiator: principal
    });
    expect(route.id.value).toBe("identity-route");
    expect(new PayloadMapping([]).moves).toEqual([]);
    expect(new EventKind("identity.event").value).toBe("identity.event");
    expect(scope.tenantId.equals(tenant)).toBe(true);
    expect(new ActorRef("workspace", new ActorId("identity-actor")).kind).toBe("workspace");
    expect(new CorrelationId("identity-correlation").value).toBe("identity-correlation");
    expect(new InvocationId("identity-invocation-2").value).toBe("identity-invocation-2");
    expect(new RouteReservationId("identity-route-2").value).toBe("identity-route-2");
    expect(new RouteProjectionId("identity-projection-2").value).toBe("identity-projection-2");
    expect(new AuditRecordId("identity-audit-2").value).toBe("identity-audit-2");
    expect(
        new ViewDelta({
            surface: new SurfaceId("identity-surface"),
            baseRevision: Revision.initial(),
            revision: new Revision(1),
            patch: [],
            cursor: new EventCursor("identity-cursor")
        }).revision.value
    ).toBe(1);
});

function eventIntentFixture(suffix: string): EventIntentInput {
    const event = eventFixture(suffix);
    return {
        id: event.id,
        scope: event.scope,
        sourceActor,
        source: event.source,
        kind: event.kind,
        payload: event.payload,
        payloadDigest: event.payloadDigest,
        payloadRetention: eventRetention(event),
        idempotencyKey: event.idempotencyKey,
        correlation: event.correlation,
        ...(event.causation === undefined ? {} : { causation: event.causation }),
        provenance: event.provenance,
        visibility: event.visibility
    };
}
