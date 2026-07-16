// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorRef } from "../../src/actors";
import { TurnId, type LeaseToken } from "../../src/agents";
import {
    ContentRef,
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    BindingName,
    EventKind,
    EventPattern,
    FacetPackageId,
    FieldMove,
    OperationRef,
    PayloadMapping
} from "../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    AuditRecordId,
    CorrelationId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { InboxProtocol } from "../../src/workspaces/inbox-protocol";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import {
    AuthenticatedEventIntent,
    EventIntentAuthenticator,
    eventIntentBytes
} from "../../src/workspaces/origin";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import {
    applyPayloadMapping,
    deriveEventTrust,
    eventMatches,
    routeDedupeKey,
    trustAccepted,
    validatePayloadMapping
} from "../../src/workspaces/policy";
import type {
    EventPayloadPort,
    EventTrustPort,
    InteractionAuditPort,
    InteractionIdPort,
    InvocationAdmissionDecision,
    InvocationAdmissionPort,
    PreparedRouteMaterial,
    RouteMaterialPreparation,
    RunInboxOutcome,
    RunInboxPort,
    SourceRouteDecision,
    SourceRoutePort,
    TargetAuthorityDecision,
    TargetRouteAuthorityPort
} from "../../src/workspaces/ports";
import {
    ContentRetentionReference,
    RetainedRecordKind,
    type ContentRetentionPort
} from "../../src/workspaces/retention";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteDeliveryState,
    RouteProjection,
    RouteProjectionAuthenticator,
    RouteReservation,
    requireAuthenticatedRouteProjection,
    routeProjectionEnvelopeBytes,
    type RouteProjectionEnvelope
} from "../../src/workspaces/route";
import {
    PreparedEventRouting,
    SourceEventProtocol,
    type EventDraft,
    type EventRoutingSnapshot
} from "../../src/workspaces/source-protocol";
import { Subscription } from "../../src/workspaces/subscription";
import { TargetProjectionProtocol } from "../../src/workspaces/target-protocol";
import {
    EventProvenance,
    EventVerification,
    type DerivedEventTrust
} from "../../src/workspaces/value";
import { ContentRetentionId, RetainedRecordRef } from "../../src/workspaces/id";
import {
    content,
    authenticatedProjectionFixture,
    eventFixture,
    inboxFixture,
    principal,
    principalId,
    projectionFixture,
    projectionRetention,
    reservationRetention,
    reservationFixture,
    retentionFixture,
    scope,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant
} from "./fixtures";

interface State {
    readonly records: MemoryWorkspaceRecords;
    readonly audit: string[];
}

class SequenceIds implements InteractionIdPort {
    #next = 0;

    public reservation(): RouteReservationId {
        return new RouteReservationId(this.id("reservation"));
    }
    public projection(): RouteProjectionId {
        return new RouteProjectionId(this.id("projection"));
    }
    public invocation(): InvocationId {
        return new InvocationId(this.id("invocation"));
    }
    public eventAudit(): AuditRecordId {
        return new AuditRecordId(this.id("event-audit"));
    }
    public reservationAudit(): AuditRecordId {
        return new AuditRecordId(this.id("reservation-audit"));
    }
    public projectionAudit(): AuditRecordId {
        return new AuditRecordId(this.id("projection-audit"));
    }
    public deliveryAudit(): AuditRecordId {
        return new AuditRecordId(this.id("delivery-audit"));
    }
    public logicalDelivery(): string {
        return this.id("logical-delivery");
    }

    private id(prefix: string): string {
        this.#next += 1;
        return `${prefix}-${this.#next}`;
    }
}

class MutableRetention implements ContentRetentionPort<State> {
    public durable = true;
    public readonly discarded: string[] = [];

    public verify(): boolean {
        return this.durable;
    }
    public release(): void {}
    public discard(reference: ContentRetentionReference): void {
        this.discarded.push(reference.id.value);
    }
}

class RecordingAudit implements InteractionAuditPort<State> {
    public appendEvent(state: State): void {
        state.audit.push("event");
    }
    public appendReservation(state: State): void {
        state.audit.push("reservation");
    }
    public appendProjectionRoot(state: State): void {
        state.audit.push("projection");
    }
    public appendDelivery(state: State): void {
        state.audit.push("delivery");
    }
}

class ExactEventIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventDraft): Uint8Array {
        return intentEvidence(eventIntentBytes(intent));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = intentEvidence(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

class ConfigurableProjectionAuthenticator extends RouteProjectionAuthenticator {
    public valid = true;

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        return this.valid && message.byteLength > 0 && evidence.byteLength > 0;
    }
}

class MutableTrust implements EventTrustPort<State> {
    public current: DerivedEventTrust = { tier: "authenticated", initiator: principal };

    public derive(): DerivedEventTrust {
        return this.current;
    }
}

class ConfigurableSourceRoutes implements SourceRoutePort<State> {
    public materialTenants: RouteReservation["tenants"] = { kind: "same", tenant };
    public materialTarget = targetActor;
    public decision: SourceRouteDecision | undefined;
    public durableActor = sourceActor;
    public failPrepareAfter: number | undefined;
    public readonly preparations: RouteMaterialPreparation[] = [];

    public async prepare(input: RouteMaterialPreparation): Promise<PreparedRouteMaterial> {
        if (this.preparations.length === this.failPrepareAfter) {
            throw new TypeError("partial route preparation failure");
        }
        this.preparations.push(input);
        const projected = content(`coverage-${input.reservation.value}`);
        return {
            targetActor: this.materialTarget,
            tenants: this.materialTenants,
            content: projected.ref,
            digest: projected.digest,
            retention: retentionFixture({
                actor: this.durableActor,
                id: `retention-${input.reservation.value}`,
                recordKind: "routeReservation",
                recordId: input.reservation.value,
                content: projected
            }),
            evidence: "prepared-evidence"
        };
    }

    public authorize(
        _state: State,
        subscription: ReturnType<typeof subscriptionFixture>,
        _event: ReturnType<typeof eventFixture>,
        material: PreparedRouteMaterial
    ): SourceRouteDecision {
        return (
            this.decision ?? {
                kind: "accepted",
                targetActor: material.targetActor,
                tenants: material.tenants,
                operation: subscription.target
            }
        );
    }
}

class ConfigurableTargetAuthority implements TargetRouteAuthorityPort<State> {
    public constructor(public decision: TargetAuthorityDecision = { kind: "accepted" }) {}
    public authorize(): TargetAuthorityDecision {
        return this.decision;
    }
}

class ConfigurableInvocations implements InvocationAdmissionPort<State> {
    public decision: InvocationAdmissionDecision | undefined;

    public admit(
        _state: State,
        input: Parameters<InvocationAdmissionPort<State>["admit"]>[1]
    ): InvocationAdmissionDecision {
        return this.decision ?? { kind: "accepted", invocation: input.reservation.invocation };
    }
}

describe("policy branch coverage", () => {
    test("derives every trust tier and rejects every partial elevation", () => {
        expect(
            deriveEventTrust({
                principalOwnsScope: false,
                validTurnLease: true,
                hostEmission: true
            })
        ).toEqual({ tier: "self" });
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: true,
                hostEmission: true
            })
        ).toEqual({ tier: "self", initiator: principal });
        for (const facts of [
            { validTurnLease: true, hostEmission: false },
            { validTurnLease: false, hostEmission: true }
        ]) {
            expect(() =>
                deriveEventTrust({
                    authenticatedPrincipal: principal,
                    principalOwnsScope: false,
                    ...facts
                })
            ).toThrow(expect.objectContaining({ code: "authority.denied" }));
        }
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: true,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "owner", initiator: principal });
        expect(() =>
            deriveEventTrust({
                principalOwnsScope: true,
                validTurnLease: false,
                hostEmission: false
            })
        ).toThrow(/authenticated Principal/);
        expect(
            deriveEventTrust({
                authenticatedPrincipal: principal,
                principalOwnsScope: false,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "authenticated", initiator: principal });
        expect(
            deriveEventTrust({
                principalOwnsScope: false,
                validTurnLease: false,
                hostEmission: false
            })
        ).toEqual({ tier: "external" });
    });

    test("distinguishes exact and wildcard kind, facet, actor, and trust matching", () => {
        const facet = eventFixture("policy-facet", { kind: "task.created" });
        const actor = eventFixture("policy-actor", { source: "actor" });
        expect(eventMatches(new EventPattern("task.created", ["authenticated"]), facet)).toBe(true);
        expect(eventMatches(new EventPattern("task.deleted", ["authenticated"]), facet)).toBe(
            false
        );
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "facet.test"), facet)
        ).toBe(true);
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "facet.other"), facet)
        ).toBe(false);
        expect(
            eventMatches(new EventPattern("task.*", ["authenticated"], "workspace-*"), actor)
        ).toBe(true);
        expect(
            eventMatches(new EventPattern("task.*", ["external"], "workspace-source"), actor)
        ).toBe(false);
        expect(trustAccepted(["owner", "self"], "self")).toBe(true);
        expect(trustAccepted(["owner", "self"], "external")).toBe(false);
    });

    test("derives all dedupe modes and rejects unstable inputs", () => {
        const cause = new EventId("event-policy-cause");
        const event = eventFixture("policy-dedupe", { causation: cause });
        expect(routeDedupeKey("event", event)).toBe(`event:${event.id.value}`);
        expect(routeDedupeKey("causation", event)).toBe(`causation:${cause.value}`);
        expect(routeDedupeKey("payload", event)).toContain(event.payloadDigest.value);
        expect(routeDedupeKey("none", event, "logical-1")).toBe("none:logical-1");
        expect(() => routeDedupeKey("causation", eventFixture("without-cause"))).toThrow(
            /requires an Event cause/
        );
        for (const key of [undefined, "", " leading", "trailing "]) {
            expect(() => routeDedupeKey("none", event, key)).toThrow(/stable logical delivery key/);
        }
    });

    test("maps roots, objects, arrays, append, replace, escapes, and prototype names", () => {
        const source = JSON.parse(
            '{"items":[{"name":"first"},{"name":"second"}],"a/b":{"~name":7},"constructor":"safe"}'
        ) as JsonValue;
        expect(
            applyPayloadMapping(new PayloadMapping([new FieldMove("", { from: "/items" })]), source)
        ).toEqual([{ name: "first" }, { name: "second" }]);
        const mapped = applyPayloadMapping(
            new PayloadMapping([
                new FieldMove("/rows/-", { from: "/items/0" }),
                new FieldMove("/rows/0/name", { from: "/items/1/name" }),
                new FieldMove("/escaped", { from: "/a~1b/~0name" }),
                new FieldMove("/__proto__/polluted", { literal: true }),
                new FieldMove("/constructorValue", { from: "/constructor" })
            ]),
            source
        ) as { readonly rows: readonly JsonValue[]; readonly __proto__: JsonValue };
        expect(mapped.rows).toEqual([{ name: "second" }]);
        expect(mapped.__proto__).toEqual({ polluted: true });
        expect(Object.hasOwn(mapped, "__proto__")).toBe(true);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

        expect(
            applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/values/-", { literal: "old" }),
                    new FieldMove("/values/0", { literal: "new" })
                ]),
                {}
            )
        ).toEqual({ values: ["new"] });
        expect(
            applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/rows/0/left", { literal: 1 }),
                    new FieldMove("/rows/0/right", { literal: 2 })
                ]),
                {}
            )
        ).toEqual({ rows: [{ left: 1, right: 2 }] });
        expect(
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/rows/-/0", { literal: "nested" })]),
                {}
            )
        ).toEqual({ rows: [["nested"]] });
    });

    test("rejects overlap, malformed pointers, missing values, sparse arrays, and scalar traversal", () => {
        for (const moves of [
            [new FieldMove("/x", { literal: 1 }), new FieldMove("/x", { literal: 2 })],
            [new FieldMove("/x", { literal: 1 }), new FieldMove("/x/y", { literal: 2 })],
            [new FieldMove("/x/y", { literal: 1 }), new FieldMove("/x", { literal: 2 })]
        ]) {
            expect(() => validatePayloadMapping(new PayloadMapping(moves))).toThrow(/overlap/);
        }
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/items/2" })]),
                { items: [1] }
            )
        ).toThrow(/source pointer does not exist/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/items/-" })]),
                { items: [1] }
            )
        ).toThrow(/array index is invalid/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/items/01" })]),
                { items: [1] }
            )
        ).toThrow(/array index is invalid/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/items/9007199254740992" })]),
                { items: [1] }
            )
        ).toThrow(/array index is too large/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/value", { from: "/scalar/child" })]),
                { scalar: 1 }
            )
        ).toThrow(/source pointer does not exist/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/rows/1", { literal: true })]),
                {}
            )
        ).toThrow(/sparse arrays/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([new FieldMove("/rows/1/name", { literal: true })]),
                {}
            )
        ).toThrow(/sparse arrays/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/rows/-", { literal: 1 }),
                    new FieldMove("/rows/0/child", { literal: 2 })
                ]),
                {}
            )
        ).toThrow(/traverses a scalar/);
        expect(() =>
            applyPayloadMapping(
                new PayloadMapping([
                    new FieldMove("/rows/-", { literal: 1 }),
                    new FieldMove("/rows/name", { literal: 2 })
                ]),
                {}
            )
        ).toThrow(/array index is invalid/);
        expect(() =>
            applyPayloadMapping(forgedMapping([{ to: "not-a-pointer", literal: 1 }]), {})
        ).toThrow(/toData|begin with/);
        expect(() =>
            applyPayloadMapping(forgedMapping([{ to: "/bad~2escape", literal: 1 }]), {})
        ).toThrow(/toData|invalid escape/);
    });

    test("rejects a child write after an adversarial move replaces the root with a scalar", () => {
        let reads = 0;
        const first = {
            get to(): string {
                reads += 1;
                return reads === 1 ? "/validated-root" : "";
            },
            from: undefined,
            literal: 1
        };
        const second = {
            get to(): string {
                reads += 1;
                return reads === 2 ? "/validated-child" : "/child";
            },
            from: undefined,
            literal: 2
        };
        expect(() => applyPayloadMapping(forgedMapping([first, second]), {})).toThrow(
            /toData|beneath a scalar root/
        );

        const scalar = dynamicTarget("/validated-scalar", "/container/scalar", 1);
        const child = dynamicTarget("/validated-child", "/container/scalar/child", 2);
        expect(() => applyPayloadMapping(forgedMapping([scalar, child]), {})).toThrow(
            /toData|traverses a scalar/
        );
    });
});

describe("route records and authentication", () => {
    test("validates reservation invariants and round-trips authority, tenant, trust, and initiator variants", () => {
        const reservation = reservationFixture("route-invariants");
        const different = content("different-route-content");
        expect(
            () =>
                new RouteReservation({
                    ...reservation.init,
                    projectionDigest: different.digest
                })
        ).toThrow(/reference and digest/);
        for (const dedupeKey of ["", " padded "]) {
            expect(() => new RouteReservation({ ...reservation.init, dedupeKey })).toThrow(
                /dedupe key/
            );
        }
        expect(
            () =>
                new RouteReservation({
                    ...withoutInitiator(reservation.init)
                })
        ).toThrow(/authenticated Principal/);

        const cross = crossReservation("route-cross");
        expect(RouteReservation.decode(RouteReservation.encode(cross))).toMatchObject({
            trust: "external",
            initiator: undefined,
            authority: { kind: "delegated" },
            tenants: { kind: "cross" }
        });
        for (const trust of ["owner", "authenticated", "external", "self"] as const) {
            const authority =
                trust === "external"
                    ? { kind: "delegated" as const, binding: new BindingName("binding.route") }
                    : reservation.authority;
            const variant =
                trust === "external"
                    ? new RouteReservation({
                          ...withoutInitiator(reservation.init),
                          trust,
                          authority
                      })
                    : new RouteReservation({
                          ...reservation.init,
                          trust,
                          authority,
                          initiator: principal
                      });
            expect(RouteReservation.decode(RouteReservation.encode(variant)).trust).toBe(trust);
        }
    });

    test("rejects malformed reservation authority, tenant relation, and trust codecs", () => {
        const reservation = reservationFixture("route-codec-invalid");
        expect(() =>
            RouteReservation.decode(
                mutatePayload(RouteReservation.encode(reservation), (payload) => {
                    payload["authority"] = { kind: "root", binding: "binding.route" };
                })
            )
        ).toThrow(/authority kind/);
        expect(() =>
            RouteReservation.decode(
                mutatePayload(RouteReservation.encode(reservation), (payload) => {
                    payload["authority"] = {
                        kind: "initiator",
                        binding: "binding.route",
                        extra: true
                    };
                })
            )
        ).toThrow(/fields/);
        expect(() =>
            RouteReservation.decode(
                mutatePayload(RouteReservation.encode(reservation), (payload) => {
                    payload["tenants"] = { kind: "unknown" };
                })
            )
        ).toThrow(/relation kind/);
        expect(() =>
            RouteReservation.decode(
                mutatePayload(RouteReservation.encode(reservation), (payload) => {
                    payload["trust"] = "root";
                })
            )
        ).toThrow(/trust is invalid/);
        expect(() =>
            RouteReservation.decode(
                mutatePayload(
                    RouteReservation.encode(crossReservation("route-cross-codec")),
                    (payload) => {
                        payload["tenants"] = { kind: "cross", source: "source", target: "target" };
                    }
                )
            )
        ).toThrow(/fields/);
    });

    test("validates projection content, codec authentication markers, and one-time authentication", () => {
        const reservation = reservationFixture("projection-codec");
        const projection = projectionFixture(reservation);
        expect(
            () =>
                new RouteProjection({
                    ...projection.init,
                    digest: content("wrong-projection-digest").digest
                })
        ).toThrow(/reference and digest/);
        expect(() =>
            RouteProjection.decode(
                mutatePayload(RouteProjection.encode(projection), (payload) => {
                    payload["authenticated"] = "yes";
                })
            )
        ).toThrow(/marker is invalid/);
        expect(() =>
            RouteProjection.decode(
                mutatePayload(RouteProjection.encode(projection), (payload) => {
                    payload["authenticated"] = true;
                })
            )
        ).toThrow(/evidence is inconsistent/);
        const authenticated = projection.authenticate(
            Digest.sha256(new TextEncoder().encode("auth"))
        );
        expect(() =>
            RouteProjection.decode(
                mutatePayload(RouteProjection.encode(authenticated), (payload) => {
                    payload["authenticated"] = false;
                })
            )
        ).toThrow(/evidence is inconsistent/);
        expect(() =>
            authenticated.authenticate(Digest.sha256(new TextEncoder().encode("again")))
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
    });

    test("authenticates only exact envelopes and rejects source assertions, bad evidence, and forgeries", () => {
        const reservation = reservationFixture("projection-auth");
        const projection = projectionFixture(reservation);
        const envelope = { reservation, projection };
        const authenticator = new ConfigurableProjectionAuthenticator();
        const authenticated = authenticator.authenticate(envelope, new Uint8Array([1]));
        expect(() => requireAuthenticatedRouteProjection(authenticated)).not.toThrow();
        expect(
            authenticated.digest.equals(Digest.sha256(routeProjectionEnvelopeBytes(envelope)))
        ).toBe(true);

        authenticator.valid = false;
        expect(() => authenticator.authenticate(envelope, new Uint8Array([1]))).toThrow(
            /authentication failed/
        );
        authenticator.valid = true;
        expect(() =>
            authenticator.authenticate(
                {
                    reservation,
                    projection: projection.authenticate(
                        Digest.sha256(new TextEncoder().encode("source-auth"))
                    )
                },
                new Uint8Array([1])
            )
        ).toThrow(/cannot assert target authentication/);
        expect(() =>
            requireAuthenticatedRouteProjection({
                envelope
            } as unknown as AuthenticatedRouteProjection)
        ).toThrow(/lacks host authentication/);

        const Constructor = AuthenticatedRouteProjection as unknown as new (
            token: symbol,
            value: RouteProjectionEnvelope
        ) => AuthenticatedRouteProjection;
        expect(() => new Constructor(Symbol("forged"), envelope)).toThrow(/host-only/);
    });

    test("rejects each projection envelope identity or content mismatch", () => {
        const reservation = reservationFixture("projection-mismatch");
        const projection = projectionFixture(reservation);
        const otherReservation = reservationFixture("projection-other");
        const mismatches: RouteProjection[] = [
            new RouteProjection({ ...projection.init, id: otherReservation.projection }),
            new RouteProjection({ ...projection.init, reservation: otherReservation.id }),
            new RouteProjection({
                ...projection.init,
                content: otherReservation.projectionRef,
                digest: otherReservation.projectionDigest
            }),
            new RouteProjection({
                ...projection.init,
                content: ContentRef.fromDigest(content("mismatch-content").digest),
                digest: content("mismatch-content").digest
            })
        ];
        for (const mismatch of mismatches) {
            expect(() =>
                routeProjectionEnvelopeBytes({ reservation, projection: mismatch })
            ).toThrow(/does not match/);
        }
    });

    test("covers delivered and rejected states, reasons, equality, constructors, and codecs", () => {
        const reservation = reservationFixture("delivery");
        const delivered = RouteDeliveryState.delivered();
        const rejected = RouteDeliveryState.rejected("authority denied");
        expect(delivered.equals(RouteDeliveryState.delivered())).toBe(true);
        expect(delivered.equals(rejected)).toBe(false);
        expect(rejected.equals(RouteDeliveryState.rejected("authority denied"))).toBe(true);
        expect(rejected.equals(RouteDeliveryState.rejected("other"))).toBe(false);
        for (const reason of ["", " padded "]) {
            expect(() => RouteDeliveryState.rejected(reason)).toThrow(/canonical/);
        }
        for (const state of [delivered, rejected]) {
            const delivery = new RouteDelivery({
                reservation: reservation.id,
                state,
                targetAudit: new AuditRecordId(`audit-${state.kind}`)
            });
            expect(RouteDelivery.decode(RouteDelivery.encode(delivery)).state.equals(state)).toBe(
                true
            );
        }
        const encoded = RouteDelivery.encode(
            new RouteDelivery({
                reservation: reservation.id,
                state: delivered,
                targetAudit: new AuditRecordId("audit-delivery-codec")
            })
        );
        expect(() =>
            RouteDelivery.decode(
                mutatePayload(encoded, (payload) => {
                    payload["outcome"] = "pending";
                })
            )
        ).toThrow(/outcome is invalid/);
        expect(() =>
            RouteDelivery.decode(
                mutatePayload(encoded, (payload) => {
                    payload["outcome"] = "rejected";
                    payload["reason"] = null;
                })
            )
        ).toThrow();
    });
});

describe("source protocol adversarial coverage", () => {
    test("[C13-ADV-HOSTILE-TIER] accepts only complete authenticated intents", () => {
        const setup = sourceSetup("snapshot-options");
        const lease = leaseToken("snapshot-options");
        const cause = new EventId("event-snapshot-cause");
        const snapshot = setup.protocol.snapshot(
            setup.state,
            authenticateIntent({
                ...draft("snapshot-options"),
                causation: cause,
                lease
            })
        );
        expect(snapshot.event.causation?.equals(cause)).toBe(true);
        expect(snapshot.lease).toEqual(lease);

        setup.trust.current = { tier: "external" };
        const anonymous = setup.protocol.snapshot(
            setup.state,
            authenticateIntent(draft("snapshot-anonymous"))
        );
        expect(anonymous.event.initiator).toBeUndefined();
        expect(anonymous.lease).toBeUndefined();

        const assertedTrust = {
            ...draft("snapshot-asserted-trust"),
            trust: "self"
        } as EventDraft;
        expect(() =>
            setup.protocol.snapshot(
                setup.state,
                assertedTrust as unknown as AuthenticatedEventIntent
            )
        ).toThrow(/lacks host authentication/);
        expect(() =>
            setup.protocol.snapshot(setup.state, {
                intent: assertedTrust,
                digest: Digest.sha256(eventIntentBytes(assertedTrust))
            } as unknown as AuthenticatedEventIntent)
        ).toThrow(/lacks host authentication/);

        const authenticator = new ExactEventIntentAuthenticator();
        const original = draft("snapshot-evidence-reuse");
        const evidence = authenticator.evidence(original);
        expect(() =>
            authenticator.authenticate(
                {
                    ...original,
                    lease: leaseToken("snapshot-evidence-reuse")
                },
                evidence
            )
        ).toThrow(/authentication failed/);

        expect(() =>
            setup.protocol.snapshot(
                setup.state,
                authenticateIntent({
                    ...draft("snapshot-wrong-actor"),
                    sourceActor: targetActor
                })
            )
        ).toThrow(/accepting Actor/);
    });

    test("[C13-TRUST-ASSERTION-REJECTION] rejects structurally forged intent trust", () => {
        const setup = sourceSetup("forged-intent-trust");
        expect(() =>
            setup.protocol.snapshot(setup.state, {
                intent: draft("forged-intent-trust")
            } as unknown as AuthenticatedEventIntent)
        ).toThrow(expect.objectContaining({ code: "authority.denied" }));
    });

    test("prepares only matches, uses logical keys for no-dedupe, and rejects foreign snapshots", async () => {
        const setup = sourceSetup(
            "prepare-none",
            subscriptionFixture("prepare-none", { dedupe: "none" })
        );
        const snapshot = setup.protocol.snapshot(
            setup.state,
            authenticateIntent(draft("prepare-none"))
        );
        const prepared = await setup.protocol.prepare(snapshot);
        const result = setup.protocol.commit(setup.state, prepared);
        expect(result.reservations[0]?.dedupeKey).toMatch(/^none:logical-delivery-/u);
        expect(setup.routes.preparations).toHaveLength(1);

        const noMatch = sourceSetup("prepare-no-match", subscriptionFixture("prepare-no-match"));
        const noMatchSnapshot = noMatch.protocol.snapshot(
            noMatch.state,
            authenticateIntent({
                ...draft("prepare-no-match"),
                kind: new EventKind("other.created")
            })
        );
        expect(await noMatch.protocol.prepare(noMatchSnapshot)).toBeInstanceOf(
            PreparedEventRouting
        );
        expect(noMatch.routes.preparations).toEqual([]);
        const noMatchPrepared = await noMatch.protocol.prepare(noMatchSnapshot);
        expect(() => noMatch.protocol.commit(noMatch.state, noMatchPrepared)).not.toThrow();
        await expect(setup.protocol.prepare({ ...snapshot })).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });

        const Constructor = PreparedEventRouting as unknown as new (
            token: symbol,
            owner: object,
            snapshot: EventRoutingSnapshot,
            routes: readonly []
        ) => PreparedEventRouting;
        expect(() => new Constructor(Symbol("forged"), setup.protocol, snapshot, [])).toThrow(
            /host-only/
        );

        const partial = sourceSetup("prepare-partial-first");
        partial.persistence.saveSubscription(
            partial.state,
            subscriptionFixture("prepare-partial-second"),
            undefined
        );
        partial.routes.failPrepareAfter = 1;
        const partialSnapshot = partial.protocol.snapshot(
            partial.state,
            authenticateIntent(draft("prepare-partial"))
        );
        await expect(partial.protocol.prepare(partialSnapshot)).rejects.toThrow(/partial route/);
        expect(partial.retention.discarded).toEqual([
            `retention-${partial.routes.preparations[0]?.reservation.value}`
        ]);
    });

    test("[C13-ADV-DUPLICATE-ROUTE] returns duplicate Events and reuses route dedupe identity", async () => {
        const setup = sourceSetup("event-replay");
        const snapshot = setup.protocol.snapshot(
            setup.state,
            authenticateIntent(draft("event-replay"))
        );
        const prepared = await setup.protocol.prepare(snapshot);
        const first = setup.protocol.commit(setup.state, prepared);
        const replay = setup.protocol.commit(setup.state, prepared);
        expect(first.duplicate).toBe(false);
        expect(replay).toMatchObject({ duplicate: true });
        expect(replay.reservations).toHaveLength(1);
        expect(setup.retention.discarded).toEqual([
            `retention-${setup.routes.preparations[0]?.reservation.value}`
        ]);

        const payloadSetup = sourceSetup(
            "payload-dedupe",
            subscriptionFixture("payload-dedupe", { dedupe: "payload" })
        );
        const firstDraft = draft("payload-first");
        payloadSetup.protocol.commit(
            payloadSetup.state,
            await payloadSetup.protocol.prepare(
                payloadSetup.protocol.snapshot(payloadSetup.state, authenticateIntent(firstDraft))
            )
        );
        const secondDraft = draft("payload-second");
        const samePayload = {
            ...secondDraft,
            payload: firstDraft.payload,
            payloadDigest: firstDraft.payloadDigest,
            payloadRetention: eventRetentionFor(
                "payload-second",
                firstDraft.payload,
                firstDraft.payloadDigest
            )
        };
        const second = payloadSetup.protocol.commit(
            payloadSetup.state,
            await payloadSetup.protocol.prepare(
                payloadSetup.protocol.snapshot(payloadSetup.state, authenticateIntent(samePayload))
            )
        );
        expect(second.reservations).toEqual([]);
        expect(payloadSetup.retention.discarded).toEqual([]);

        const base = subscriptionFixture("external-route");
        const externalSubscription = new Subscription({
            id: base.id,
            revision: base.revision,
            source: new EventPattern("task.*", ["external"], "facet.*"),
            target: base.target,
            mapping: base.mapping,
            dedupe: base.dedupe,
            authority: { kind: "delegated", binding: base.authority.binding }
        });
        const external = sourceSetup("external-route", externalSubscription);
        external.trust.current = { tier: "external" };
        const externalResult = external.protocol.commit(
            external.state,
            await external.protocol.prepare(
                external.protocol.snapshot(
                    external.state,
                    authenticateIntent(draft("external-route"))
                )
            )
        );
        expect(externalResult.reservations[0]?.initiator).toBeUndefined();
    });

    test("rejects an idempotency replay whose authenticated provenance changed", async () => {
        const setup = sourceSetup("provenance-conflict");
        const original = draft("provenance-conflict");
        setup.protocol.commit(
            setup.state,
            await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(original))
            )
        );
        const changed = {
            ...original,
            provenance: new EventProvenance({
                verification: EventVerification.verified(),
                principal,
                claims: { source: "different-authenticated-provenance" }
            })
        };

        expect(() => setup.protocol.snapshot(setup.state, authenticateIntent(changed))).toThrow(
            expect.objectContaining({ code: "protocol.duplicate" })
        );
    });

    test("replays an Event safely after its retention index cache is lost", async () => {
        const setup = sourceSetup("retention-cache-loss");
        const snapshot = setup.protocol.snapshot(
            setup.state,
            authenticateIntent(draft("retention-cache-loss"))
        );
        const prepared = await setup.protocol.prepare(snapshot);
        setup.protocol.commit(setup.state, prepared);
        setup.state.records.deleteCompactedRecords(
            "contentRetention",
            setup.state.records.listRecords("contentRetention").map((record) => record.id)
        );

        const replay = setup.protocol.commit(setup.state, prepared);
        expect(replay).toMatchObject({ duplicate: true });
        expect(replay.reservations).toHaveLength(1);
        expect(setup.retention.discarded).toEqual([
            snapshot.payloadRetention.id.value,
            `retention-${setup.routes.preparations[0]?.reservation.value}`
        ]);
    });

    test("discards a prepared source route when its dedupe reservation wins the commit race", async () => {
        const setup = sourceSetup("source-route-race");
        const snapshot = setup.protocol.snapshot(
            setup.state,
            authenticateIntent(draft("source-route-race"))
        );
        const prepared = await setup.protocol.prepare(snapshot);
        const winner = reservationFixture("source-route-race");
        setup.persistence.appendReservation(setup.state, winner, reservationRetention(winner));

        const result = setup.protocol.commit(setup.state, prepared);
        expect(result.duplicate).toBe(false);
        expect(result.reservations).toEqual([]);
        expect(setup.retention.discarded).toEqual([
            `retention-${setup.routes.preparations[0]?.reservation.value}`
        ]);
    });

    test("[C13-ROUTE-SOURCE-OWNED] source protocol owns the committed reservation", async () => {
        const setup = sourceSetup("source-owned-proof");
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(setup.state, authenticateIntent(draft("source-owned-proof")))
        );
        const reservation = setup.protocol.commit(setup.state, prepared).reservations[0]!;
        expect(reservation.sourceActor.equals(sourceActor)).toBe(true);
        expect(reservation.targetActor.equals(targetActor)).toBe(true);
    });

    test("[C13-ROUTE-SOURCE-EVENT] committed reservation cites the authenticated Event", async () => {
        const setup = sourceSetup("source-event-proof");
        const intent = authenticateIntent(draft("source-event-proof"));
        const prepared = await setup.protocol.prepare(setup.protocol.snapshot(setup.state, intent));
        const result = setup.protocol.commit(setup.state, prepared);
        expect(result.reservations[0]?.event.equals(intent.intent.id)).toBe(true);
    });

    test("[C13-ROUTE-STABLE-INVOCATION] duplicate commit preserves InvocationId", async () => {
        const setup = sourceSetup("stable-invocation-proof");
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(
                setup.state,
                authenticateIntent(draft("stable-invocation-proof"))
            )
        );
        const first = setup.protocol.commit(setup.state, prepared).reservations[0]!;
        const duplicate = setup.protocol.commit(setup.state, prepared).reservations[0]!;
        expect(duplicate.id.equals(first.id)).toBe(true);
        expect(duplicate.invocation.equals(first.invocation)).toBe(true);
    });

    test("[C13-ROUTE-TENANT-RELATION] source protocol preserves admitted tenant relation", async () => {
        const setup = sourceSetup("tenant-relation-proof");
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(setup.state, authenticateIntent(draft("tenant-relation-proof")))
        );
        const relation = setup.protocol.commit(setup.state, prepared).reservations[0]!.tenants;
        expect(relation.kind).toBe("same");
        if (relation.kind === "same") expect(relation.tenant.equals(tenant)).toBe(true);
    });

    test("rejects foreign preparations, stale subscriptions, and each trust change", async () => {
        const first = sourceSetup("foreign-first");
        const second = sourceSetup("foreign-second");
        const prepared = await first.protocol.prepare(
            first.protocol.snapshot(first.state, authenticateIntent(draft("foreign")))
        );
        expect(() => second.protocol.commit(second.state, prepared)).toThrow(/not prepared/);

        const actorMutation = sourceSetup("foreign-actor");
        const actorPrepared = await actorMutation.protocol.prepare(
            actorMutation.protocol.snapshot(
                actorMutation.state,
                authenticateIntent(draft("foreign-actor"))
            )
        );
        (actorMutation.protocol as unknown as { actor: ActorRef }).actor = targetActor;
        expect(() => actorMutation.protocol.commit(actorMutation.state, actorPrepared)).toThrow(
            /another Actor/
        );

        const stale = sourceSetup("stale-subscription");
        const stalePrepared = await stale.protocol.prepare(
            stale.protocol.snapshot(stale.state, authenticateIntent(draft("stale-subscription")))
        );
        stale.persistence.saveSubscription(
            stale.state,
            stale.subscription.revise({
                source: stale.subscription.source,
                target: stale.subscription.target,
                mapping: stale.subscription.mapping,
                dedupe: "payload",
                authority: stale.subscription.authority
            }),
            stale.subscription.revision
        );
        expect(() => stale.protocol.commit(stale.state, stalePrepared)).toThrow(/snapshot changed/);

        for (const [suffix, changed] of [
            ["tier", { tier: "external" }],
            ["missing-initiator", { tier: "authenticated" }],
            [
                "different-initiator",
                {
                    tier: "authenticated",
                    initiator: new PrincipalRef(tenant, new PrincipalId("principal-different"))
                }
            ]
        ] as const) {
            const trust = sourceSetup(`trust-${suffix}`);
            const trustPrepared = await trust.protocol.prepare(
                trust.protocol.snapshot(trust.state, authenticateIntent(draft(`trust-${suffix}`)))
            );
            trust.trust.current = changed;
            expect(() => trust.protocol.commit(trust.state, trustPrepared)).toThrow(
                /trust changed/
            );
        }
    });

    test("rejects event and projection retention failures and ownership mismatch", async () => {
        const notDurable = sourceSetup("event-not-durable");
        const prepared = await notDurable.protocol.prepare(
            notDurable.protocol.snapshot(
                notDurable.state,
                authenticateIntent(draft("event-not-durable"))
            )
        );
        notDurable.retention.durable = false;
        expect(() => notDurable.protocol.commit(notDurable.state, prepared)).toThrow(
            /payload retention is not durable/
        );

        for (const [suffix, alter] of [
            [
                "actor",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, { actor: targetActor })
            ],
            [
                "tenant",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        tenant: new TenantId("tenant-other")
                    })
            ],
            [
                "kind",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        recordKind: RetainedRecordKind.routeReservation()
                    })
            ],
            [
                "record",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        record: new RetainedRecordRef("event-other")
                    })
            ]
        ] as const) {
            const setup = sourceSetup(`event-retention-${suffix}`);
            const input = draft(`event-retention-${suffix}`);
            const invalidDraft = { ...input, payloadRetention: alter(input.payloadRetention) };
            const invalidPrepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(invalidDraft))
            );
            expect(() => setup.protocol.commit(setup.state, invalidPrepared)).toThrow(
                /another Actor or record/
            );
        }

        const routeNotDurable = sourceSetup("route-not-durable");
        const routePrepared = await routeNotDurable.protocol.prepare(
            routeNotDurable.protocol.snapshot(
                routeNotDurable.state,
                authenticateIntent(draft("route-not-durable"))
            )
        );
        let verifies = 0;
        routeNotDurable.retention.verify = (): boolean => {
            verifies += 1;
            return verifies < 3;
        };
        expect(() => routeNotDurable.protocol.commit(routeNotDurable.state, routePrepared)).toThrow(
            /projection retention is not durable/
        );

        const wrongRouteOwner = sourceSetup("route-wrong-owner");
        wrongRouteOwner.routes.durableActor = targetActor;
        const wrongRoutePrepared = await wrongRouteOwner.protocol.prepare(
            wrongRouteOwner.protocol.snapshot(
                wrongRouteOwner.state,
                authenticateIntent(draft("route-wrong-owner"))
            )
        );
        expect(() =>
            wrongRouteOwner.protocol.commit(wrongRouteOwner.state, wrongRoutePrepared)
        ).toThrow(/another Actor or record/);
    });

    test("rejects source authority, target, tenant, and operation changes", async () => {
        const rejected = sourceSetup("route-rejected");
        const rejectedSnapshot = rejected.protocol.snapshot(
            rejected.state,
            authenticateIntent(draft("route-rejected"))
        );
        const rejectedPrepared = await rejected.protocol.prepare(rejectedSnapshot);
        rejected.routes.decision = { kind: "rejected" };
        expect(() => rejected.protocol.commit(rejected.state, rejectedPrepared)).toThrow(
            /authority rejected/
        );
        expect(rejected.retention.discarded).toEqual([
            rejectedSnapshot.payloadRetention.id.value,
            `retention-${rejected.routes.preparations[0]?.reservation.value}`
        ]);

        const wrongTarget = sourceSetup("route-target-change");
        const targetPrepared = await wrongTarget.protocol.prepare(
            wrongTarget.protocol.snapshot(
                wrongTarget.state,
                authenticateIntent(draft("route-target-change"))
            )
        );
        wrongTarget.routes.decision = {
            kind: "accepted",
            targetActor: sourceActor,
            tenants: { kind: "same", tenant },
            operation: wrongTarget.subscription.target
        };
        expect(() => wrongTarget.protocol.commit(wrongTarget.state, targetPrepared)).toThrow(
            /target changed/
        );

        const wrongTenant = sourceSetup("route-tenant-change");
        const tenantPrepared = await wrongTenant.protocol.prepare(
            wrongTenant.protocol.snapshot(
                wrongTenant.state,
                authenticateIntent(draft("route-tenant-change"))
            )
        );
        wrongTenant.routes.decision = {
            kind: "accepted",
            targetActor,
            tenants: { kind: "same", tenant: new TenantId("tenant-changed") },
            operation: wrongTenant.subscription.target
        };
        expect(() => wrongTenant.protocol.commit(wrongTenant.state, tenantPrepared)).toThrow(
            /target changed/
        );

        const wrongOperation = sourceSetup("route-operation-change");
        const operationPrepared = await wrongOperation.protocol.prepare(
            wrongOperation.protocol.snapshot(
                wrongOperation.state,
                authenticateIntent(draft("route-operation-change"))
            )
        );
        wrongOperation.routes.decision = {
            kind: "accepted",
            targetActor,
            tenants: { kind: "same", tenant },
            operation: new OperationRef("facet.test:changed")
        };
        expect(() =>
            wrongOperation.protocol.commit(wrongOperation.state, operationPrepared)
        ).toThrow(/target changed/);
    });

    test("[C13-ROUTE-CROSS-TENANT-BINDING] accepts an unchanged cross-tenant route and detects every cross relation change", async () => {
        const sourceTenant = tenant;
        const destination = new TenantId("tenant-destination");
        const authority = new BindingName("binding.cross-tenant");
        const relation = {
            kind: "cross" as const,
            source: sourceTenant,
            target: destination,
            authority
        };
        const accepted = sourceSetup("cross-accepted");
        accepted.routes.materialTenants = relation;
        const result = accepted.protocol.commit(
            accepted.state,
            await accepted.protocol.prepare(
                accepted.protocol.snapshot(
                    accepted.state,
                    authenticateIntent(draft("cross-accepted"))
                )
            )
        );
        expect(result.reservations[0]?.tenants).toMatchObject({ kind: "cross" });

        for (const [suffix, tenants] of [
            ["same", { kind: "same" as const, tenant }],
            ["source", { ...relation, source: new TenantId("tenant-other-source") }],
            ["target", { ...relation, target: new TenantId("tenant-other-target") }],
            ["authority", { ...relation, authority: new BindingName("binding.other") }]
        ] as const) {
            const changed = sourceSetup(`cross-${suffix}`);
            changed.routes.materialTenants = relation;
            const prepared = await changed.protocol.prepare(
                changed.protocol.snapshot(
                    changed.state,
                    authenticateIntent(draft(`cross-${suffix}`))
                )
            );
            changed.routes.decision = {
                kind: "accepted",
                targetActor,
                tenants,
                operation: changed.subscription.target
            };
            expect(() => changed.protocol.commit(changed.state, prepared)).toThrow(
                /target changed/
            );
        }
    });
});

describe("target protocol and port outcomes", () => {
    test("rejects structural authentication and projections for another actor", () => {
        const setup = targetSetup();
        const admission = authenticatedAdmission("target-structural");
        expect(() =>
            setup.protocol.admit(setup.state, {
                ...admission,
                projection: {
                    envelope: admission.projection.envelope
                } as AuthenticatedRouteProjection
            })
        ).toThrow(/lacks host authentication/);

        const wrong = authenticatedAdmission("target-wrong-actor", sourceActor);
        expect(() => setup.protocol.admit(setup.state, wrong)).toThrow(/another Actor/);
    });

    test("rejects nondurable retention and every retention ownership mismatch", () => {
        const notDurable = targetSetup();
        notDurable.retention.durable = false;
        expect(() =>
            notDurable.protocol.admit(
                notDurable.state,
                authenticatedAdmission("target-not-durable")
            )
        ).toThrow(/not durable/);

        for (const [suffix, alter] of [
            [
                "actor",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, { actor: sourceActor })
            ],
            [
                "tenant",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        tenant: new TenantId("tenant-other")
                    })
            ],
            [
                "kind",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        recordKind: RetainedRecordKind.event()
                    })
            ],
            [
                "record",
                (reference: ContentRetentionReference) =>
                    retentionCopy(reference, {
                        record: new RetainedRecordRef("projection-other")
                    })
            ]
        ] as const) {
            const setup = targetSetup();
            const admission = authenticatedAdmission(`target-retention-${suffix}`);
            expect(() =>
                setup.protocol.admit(setup.state, {
                    projection: admission.projection,
                    retention: alter(admission.retention)
                })
            ).toThrow(/another Actor or record/);
        }
    });

    test("uses the target tenant for cross-tenant admissions", () => {
        const reservation = crossReservation("target-cross");
        const destination =
            reservation.tenants.kind === "cross" ? reservation.tenants.target : tenant;
        const setup = targetSetup(destination);
        const projection = projectionFixture(reservation);
        const admission = authenticate(reservation, projection);
        const retention = new ContentRetentionReference({
            ...projectionRetention(projection).init,
            tenant: destination
        });
        expect(
            setup.protocol.admit(setup.state, { projection: admission, retention }).state.kind
        ).toBe("delivered");
    });

    test("records authority and invocation acceptance or every rejection reason", () => {
        const accepted = targetSetup();
        expect(
            accepted.protocol.admit(accepted.state, authenticatedAdmission("target-accepted")).state
        ).toMatchObject({ kind: "delivered", reason: undefined });

        const authority = targetSetup();
        authority.authority.decision = { kind: "rejected", reason: "authority denied" };
        expect(
            authority.protocol.admit(
                authority.state,
                authenticatedAdmission("target-authority-denied")
            ).state
        ).toMatchObject({ kind: "rejected", reason: "authority denied" });

        const invocation = targetSetup();
        invocation.invocations.decision = { kind: "rejected", reason: "invocation denied" };
        expect(
            invocation.protocol.admit(
                invocation.state,
                authenticatedAdmission("target-invocation-denied")
            ).state
        ).toMatchObject({ kind: "rejected", reason: "invocation denied" });
    });

    test("rejects invocation substitution and returns exact terminal duplicates", () => {
        const substitution = targetSetup();
        substitution.invocations.decision = {
            kind: "accepted",
            invocation: new InvocationId("invocation-substituted")
        };
        expect(() =>
            substitution.protocol.admit(
                substitution.state,
                authenticatedAdmission("target-substitution")
            )
        ).toThrow(/substituted/);

        const replay = targetSetup();
        const admission = authenticatedAdmission("target-replay");
        const first = replay.protocol.admit(replay.state, admission);
        expect(replay.protocol.admit(replay.state, admission)).toEqual(first);
        expect(replay.state.audit).toEqual(["projection", "delivery"]);
    });

    test("rejects replay when delivery lacks a projection or projection bytes conflict", () => {
        const missing = targetSetup();
        const missingAdmission = authenticatedAdmission("target-missing-projection");
        expect(() =>
            missing.persistence.appendDelivery(
                missing.state,
                new RouteDelivery({
                    reservation: missingAdmission.projection.envelope.reservation.id,
                    state: RouteDeliveryState.delivered(),
                    targetAudit: new AuditRecordId("audit-missing-projection")
                })
            )
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));

        const sameLength = targetSetup();
        const original = authenticatedAdmission("target-byte-conflict");
        sameLength.protocol.admit(sameLength.state, original);
        const changedReservation = new RouteReservation({
            ...original.projection.envelope.reservation.init,
            operation: new OperationRef("facet.test:different")
        });
        const changedProjection = projectionFixture(changedReservation);
        expect(() =>
            sameLength.protocol.admit(sameLength.state, {
                projection: authenticate(changedReservation, changedProjection),
                retention: projectionRetention(changedProjection)
            })
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));

        const differentLength = targetSetup();
        const incoming = authenticatedAdmission("target-length-conflict");
        const reservation = incoming.projection.envelope.reservation;
        const otherContent = content("short");
        const storedRoute = new RouteReservation({
            ...reservation.init,
            projection: new RouteProjectionId("projection-with-a-much-longer-identifier"),
            projectionRef: otherContent.ref,
            projectionDigest: otherContent.digest
        });
        const stored = projectionFixture(storedRoute);
        differentLength.persistence.appendProjection(
            differentLength.state,
            authenticatedProjectionFixture(storedRoute),
            projectionRetention(stored)
        );
        differentLength.persistence.appendDelivery(
            differentLength.state,
            new RouteDelivery({
                reservation: reservation.id,
                state: RouteDeliveryState.delivered(),
                targetAudit: new AuditRecordId("audit-length-conflict")
            })
        );
        expect(() => differentLength.protocol.admit(differentLength.state, incoming)).toThrow(
            expect.objectContaining({ code: "protocol.duplicate" })
        );
    });
});

describe("inbox protocol outcomes", () => {
    test("returns appended and duplicate and maps all rejection reasons", () => {
        const turn = new TurnId("turn-inbox-coverage");
        const lease: LeaseToken = { turn, holder: principalId, epoch: 7 };
        const reference = inboxFixture("coverage", 0, 7, turn);
        for (const outcome of [{ kind: "appended" }, { kind: "duplicate" }] as const) {
            const protocol = new InboxProtocol(new FixedInbox(outcome));
            expect(protocol.append({}, reference, lease)).toEqual(outcome);
        }
        for (const reason of ["lease", "lifecycle", "conflict"] as const) {
            const protocol = new InboxProtocol(new FixedInbox({ kind: "rejected", reason }));
            expect(() => protocol.append({}, reference, lease)).toThrow(
                expect.objectContaining({
                    code: reason === "lease" ? "lease.invalid" : "turn.invalid-state"
                })
            );
        }
    });

    test("rejects reference turn and epoch mismatches before calling the run port", () => {
        const turn = new TurnId("turn-inbox-exact");
        const lease: LeaseToken = { turn, holder: principalId, epoch: 3 };
        const runs = new FixedInbox({ kind: "appended" });
        const protocol = new InboxProtocol(runs);
        expect(() => protocol.append({}, inboxFixture("wrong-turn", 0, 3), lease)).toThrow(
            expect.objectContaining({ code: "lease.invalid" })
        );
        expect(() => protocol.append({}, inboxFixture("wrong-epoch", 0, 2, turn), lease)).toThrow(
            expect.objectContaining({ code: "lease.invalid" })
        );
        expect(runs.calls).toBe(0);
    });
});

class FixedInbox implements RunInboxPort<object> {
    public calls = 0;

    public constructor(private readonly outcome: RunInboxOutcome) {}

    public append(): RunInboxOutcome {
        this.calls += 1;
        return this.outcome;
    }
}

function forgedMapping(moves: readonly unknown[]): PayloadMapping {
    return { moves } as unknown as PayloadMapping;
}

function dynamicTarget(validated: string, actual: string, literal: JsonValue): unknown {
    let reads = 0;
    return {
        get to(): string {
            reads += 1;
            return reads === 1 ? validated : actual;
        },
        from: undefined,
        literal
    };
}

function mutatePayload(
    bytes: Uint8Array,
    mutate: (payload: { [key: string]: JsonValue }) => void
): Uint8Array {
    const envelope = decodeCanonicalJson(bytes) as {
        kind: string;
        version: { major: number; minor: number };
        payload: { [key: string]: JsonValue };
    };
    mutate(envelope.payload);
    return encodeCanonicalJson(envelope as unknown as JsonValue);
}

function emptyState(): State {
    return { records: new MemoryWorkspaceRecords(), audit: [] };
}

function persistence(
    retention: ContentRetentionPort<State>,
    actor = sourceActor,
    actorTenant = tenant
): WorkspacePersistence<State> {
    return new WorkspacePersistence((state) => state.records, retention, actor, actorTenant);
}

function sourceSetup(
    suffix: string,
    subscription = subscriptionFixture(suffix)
): {
    readonly state: State;
    readonly persistence: WorkspacePersistence<State>;
    readonly retention: MutableRetention;
    readonly trust: MutableTrust;
    readonly routes: ConfigurableSourceRoutes;
    readonly subscription: typeof subscription;
    readonly protocol: SourceEventProtocol<State>;
} {
    const state = emptyState();
    const retention = new MutableRetention();
    const records = persistence(retention);
    records.saveSubscription(state, subscription, undefined);
    const trust = new MutableTrust();
    const routes = new ConfigurableSourceRoutes();
    const payloads: EventPayloadPort = { load: async () => ({ value: 7 }) };
    return {
        state,
        persistence: records,
        retention,
        trust,
        routes,
        subscription,
        protocol: new SourceEventProtocol(
            sourceActor,
            records,
            trust,
            payloads,
            routes,
            retention,
            new RecordingAudit(),
            new SequenceIds()
        )
    };
}

function targetSetup(actorTenant = tenant): {
    readonly state: State;
    readonly persistence: WorkspacePersistence<State>;
    readonly retention: MutableRetention;
    readonly authority: ConfigurableTargetAuthority;
    readonly invocations: ConfigurableInvocations;
    readonly protocol: TargetProjectionProtocol<State>;
} {
    const state = emptyState();
    const retention = new MutableRetention();
    const records = persistence(retention, targetActor, actorTenant);
    const authority = new ConfigurableTargetAuthority();
    const invocations = new ConfigurableInvocations();
    return {
        state,
        persistence: records,
        retention,
        authority,
        invocations,
        protocol: new TargetProjectionProtocol(
            targetActor,
            records,
            retention,
            authority,
            invocations,
            new RecordingAudit(),
            new SequenceIds()
        )
    };
}

function draft(suffix: string): EventDraft {
    const payload = content(`draft-${suffix}`);
    const event = new EventId(`event-${suffix}`);
    const provenance = new EventProvenance({
        verification: EventVerification.verified(),
        principal,
        claims: { source: "coverage" }
    });
    return {
        id: event,
        scope,
        sourceActor,
        source: { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind("task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: eventRetentionFor(suffix, payload.ref, payload.digest),
        idempotencyKey: `idempotency-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        provenance,
        visibility: "workspace"
    };
}

function authenticateIntent(intent: EventDraft): AuthenticatedEventIntent {
    const authenticator = new ExactEventIntentAuthenticator();
    return authenticator.authenticate(intent, authenticator.evidence(intent));
}

function intentEvidence(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}

function eventRetentionFor(
    suffix: string,
    ref: ContentRef,
    digest: Digest
): ContentRetentionReference {
    return new ContentRetentionReference({
        id: new ContentRetentionId(`retention-event-${suffix}`),
        tenant,
        actor: sourceActor,
        recordKind: RetainedRecordKind.event(),
        record: new RetainedRecordRef(`event-${suffix}`),
        content: ref,
        digest
    });
}

function retentionCopy(
    reference: ContentRetentionReference,
    changes: Partial<ContentRetentionReference["init"]>
): ContentRetentionReference {
    return new ContentRetentionReference({ ...reference.init, ...changes });
}

function leaseToken(suffix: string): LeaseToken {
    return {
        turn: new TurnId(`turn-${suffix}`),
        holder: new PrincipalId(`holder-${suffix}`),
        epoch: 1
    };
}

function crossReservation(suffix: string): RouteReservation {
    const base = reservationFixture(suffix);
    return new RouteReservation({
        ...withoutInitiator(base.init),
        tenants: {
            kind: "cross",
            source: tenant,
            target: new TenantId("tenant-cross-target"),
            authority: new BindingName("binding.cross")
        },
        authority: { kind: "delegated", binding: new BindingName("binding.delegated") },
        trust: "external"
    });
}

function withoutInitiator(
    init: RouteReservation["init"]
): Omit<RouteReservation["init"], "initiator"> {
    const { initiator: _initiator, ...rest } = init;
    return rest;
}

function authenticate(
    reservation: RouteReservation,
    projection: RouteProjection
): AuthenticatedRouteProjection {
    return new ConfigurableProjectionAuthenticator().authenticate(
        { reservation, projection },
        new Uint8Array([1])
    );
}

function authenticatedAdmission(
    suffix: string,
    target = targetActor
): {
    readonly projection: AuthenticatedRouteProjection;
    readonly retention: ContentRetentionReference;
} {
    const reservation = reservationFixture(suffix, { target });
    const projection = projectionFixture(reservation);
    return {
        projection: authenticate(reservation, projection),
        retention: projectionRetention(projection)
    };
}
