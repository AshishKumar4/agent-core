// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import { Digest, type JsonValue } from "../../src/core";
import {
    EventKind,
    FacetPackageId,
    FieldMove,
    OperationRef,
    PayloadMapping
} from "../../src/facets";
import { PrincipalId } from "../../src/identity";
import {
    CommandCallerPolicy,
    type CommandEnvelope,
    type ProtocolValueCodec
} from "../../src/protocol";
import {
    AuditRecordId,
    CorrelationId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { InboxProtocol } from "../../src/workspaces/inbox-protocol";
import {
    AuthenticatedEventIntent,
    EventIntentAuthenticator,
    eventIntentBytes
} from "../../src/workspaces/origin";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import type {
    EventPayloadPort,
    EventTrustPort,
    InteractionAuditPort,
    InteractionIdPort,
    InvocationAdmissionDecision,
    InvocationAdmissionPort,
    PreparedRouteMaterial,
    RouteMaterialPreparation,
    RunInboxPort,
    SourceRoutePort,
    TargetAuthorityDecision,
    TargetRouteAuthorityPort
} from "../../src/workspaces/ports";
import type { ContentRetentionPort } from "../../src/workspaces/retention";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteReservation,
    RouteProjectionAuthenticator,
    routeProjectionEnvelopeBytes,
    type RouteProjectionEnvelope
} from "../../src/workspaces/route";
import {
    SOURCE_EVENT_COMMAND,
    SourceEventCommandPort,
    SourceEventProtocol,
    createSourceEventProtocolCommand,
    type EventAcceptanceResult,
    type EventDraft,
    type PreparedEventRouting
} from "../../src/workspaces/source-protocol";
import {
    TARGET_PROJECTION_COMMAND,
    TargetProjectionCommandPort,
    TargetProjectionProtocol,
    createTargetProjectionProtocolCommand,
    type TargetProjectionAdmission
} from "../../src/workspaces/target-protocol";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import {
    content,
    inboxFixture,
    principal,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    retentionFixture,
    scope,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant
} from "./fixtures";

interface ProtocolState {
    readonly records: MemoryWorkspaceRecords;
    readonly audit: string[];
    readonly inbox: string[];
    readonly inboxBySequence: Map<string, string>;
    authorityCalls: number;
    invocationCalls: number;
}

interface ProtocolHarness {
    readonly persistence: WorkspacePersistence<ProtocolState>;
    transaction<Result>(
        operation: (state: ProtocolState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    snapshot(): ProtocolState;
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
        return new AuditRecordId(this.id("audit-event"));
    }

    public reservationAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-reservation"));
    }

    public projectionAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-projection"));
    }

    public deliveryAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-delivery"));
    }

    public logicalDelivery(): string {
        return this.id("logical-delivery");
    }

    private id(kind: string): string {
        this.#next += 1;
        return `${kind}-${this.#next}`;
    }
}

class AuditPort implements InteractionAuditPort<ProtocolState> {
    public failReservation = false;

    public appendEvent(state: ProtocolState): void {
        state.audit.push("event");
    }

    public appendReservation(state: ProtocolState): void {
        state.audit.push("reservation");
        if (this.failReservation) throw new TypeError("fault inside transaction");
    }

    public appendProjectionRoot(state: ProtocolState): void {
        state.audit.push("projection-root");
    }

    public appendDelivery(state: ProtocolState): void {
        state.audit.push("delivery");
    }
}

class TestProjectionAuthenticator extends RouteProjectionAuthenticator {
    public evidence(envelope: RouteProjectionEnvelope): Uint8Array {
        return signature(routeProjectionEnvelopeBytes(envelope));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

class TestEventIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventDraft): Uint8Array {
        return signature(eventIntentBytes(intent));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

describe("SourceEventProtocol", () => {
    test("registers opaque prepared routing as typed W1 command evidence", async () => {
        const harness = createProtocolHarness();
        harness.transaction((state) =>
            harness.persistence.saveSubscription(
                state,
                subscriptionFixture("source-command"),
                undefined
            )
        );
        const protocol = sourceProtocol(
            harness,
            new SourceRoutes(),
            new AuditPort(),
            new SequenceIds()
        );
        const prepared = await protocol.prepare(
            harness.transaction((state) => protocol.snapshot(state, eventIntent("source-command")))
        );
        const port = new SourceCommandPort(prepared);
        const command = createSourceEventProtocolCommand(protocol, port);
        const payload = command.payload.decode(port.payloadBytes);
        const envelope = {} as CommandEnvelope;
        const at = new Date("2026-07-12T12:00:00.000Z");

        expect(command.command).toBe(SOURCE_EVENT_COMMAND);
        expect(command.currentLease({}, envelope, payload, at)).toBeUndefined();
        expect(port.decisionAt).toBe(at);
        const execution = harness.transaction((state) =>
            command.execute(state, envelope, payload, at)
        );
        if (execution instanceof Uint8Array) throw new TypeError("Expected typed execution");
        expect(execution.reply.duplicate).toBe(false);
        expect(execution.observation).toBe(execution.reply);
    });

    test("prepares outside the transaction, commits source-owned reservations, and replays unknown ack", async () => {
        const harness = createProtocolHarness();
        const subscription = subscriptionFixture("source", {
            mapping: new PayloadMapping([new FieldMove("/argument", { from: "/value" })])
        });
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, subscription, undefined)
        );
        const ids = new SequenceIds();
        const audit = new AuditPort();
        const routes = new SourceRoutes();
        const retention = new RetentionPort();
        const protocol = sourceProtocol(harness, routes, audit, ids, retention);
        const intent = eventIntent("source");

        const snapshot = harness.transaction((state) => protocol.snapshot(state, intent));
        expect(harness.snapshot().records.listRecords("event")).toHaveLength(0);
        const prepared = await protocol.prepare(snapshot);
        expect(routes.prepared).toHaveLength(1);
        expect(routes.prepared[0]?.mappedInput).toEqual({ argument: 7 });
        expect(harness.snapshot().records.listRecords("routeReservation")).toHaveLength(0);

        let firstResult: ReturnType<typeof protocol.commit> | undefined;
        expect(() => {
            firstResult = harness.transaction((state) => protocol.commit(state, prepared));
            throw new TypeError("ack lost after commit");
        }).toThrow(/ack lost/);
        expect(firstResult?.duplicate).toBe(false);
        expect(firstResult?.reservations).toHaveLength(1);
        expect(firstResult?.reservations[0]?.sourceActor.equals(sourceActor)).toBe(true);
        expect(firstResult?.reservations[0]?.targetActor.equals(targetActor)).toBe(true);

        const replay = harness.transaction((state) => protocol.commit(state, prepared));
        expect(replay.duplicate).toBe(true);
        expect(replay.reservations).toHaveLength(1);
        expect(replay.reservations[0]?.id).toEqual(firstResult?.reservations[0]?.id);
        expect(replay.reservations[0]?.invocation).toEqual(
            firstResult?.reservations[0]?.invocation
        );
        expect(harness.snapshot().records.listRecords("event")).toHaveLength(1);
        expect(harness.snapshot().records.listRecords("routeReservation")).toHaveLength(1);
        expect(harness.snapshot().audit).toEqual(["event", "reservation"]);
        expect(retention.discarded).toEqual([`retention-${routes.prepared[0]?.reservation.value}`]);
    });

    test("rejects wrong source ownership and a stale subscription snapshot", async () => {
        const harness = createProtocolHarness();
        const subscription = subscriptionFixture("snapshot");
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, subscription, undefined)
        );
        const protocol = sourceProtocol(
            harness,
            new SourceRoutes(),
            new AuditPort(),
            new SequenceIds()
        );
        const wrongSource = new ActorRef("workspace", new ActorId("wrong-source"));
        const wrongSourceIntent = authenticateEventDraft({
            ...eventDraft("wrong-source"),
            sourceActor: wrongSource
        });
        expect(() =>
            harness.transaction((state) => protocol.snapshot(state, wrongSourceIntent))
        ).toThrow(/accepting Actor/);

        const snapshot = harness.transaction((state) =>
            protocol.snapshot(state, eventIntent("snapshot"))
        );
        const prepared = await protocol.prepare(snapshot);
        harness.transaction((state) =>
            harness.persistence.saveSubscription(
                state,
                subscriptionFixture("snapshot-added"),
                undefined
            )
        );

        expect(() => harness.transaction((state) => protocol.commit(state, prepared))).toThrow(
            /snapshot changed/
        );
        expect(harness.snapshot().records.listRecords("event")).toHaveLength(0);
    });

    test("rolls back faults before and inside commit without phantom reservations", async () => {
        const harness = createProtocolHarness();
        const subscription = subscriptionFixture("fault");
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, subscription, undefined)
        );
        harness.transaction((state) =>
            harness.persistence.saveSubscription(
                state,
                subscriptionFixture("fault-second"),
                undefined
            )
        );
        const routes = new SourceRoutes();
        const audit = new AuditPort();
        const retention = new RetentionPort();
        const protocol = sourceProtocol(harness, routes, audit, new SequenceIds(), retention);
        const snapshot = harness.transaction((state) =>
            protocol.snapshot(state, eventIntent("fault"))
        );

        routes.failPrepareAfter = 1;
        await expect(protocol.prepare(snapshot)).rejects.toThrow(/before transaction/);
        expect(harness.snapshot().records.listRecords("event")).toHaveLength(0);
        expect(retention.discarded).toEqual([`retention-${routes.prepared[0]?.reservation.value}`]);

        routes.failPrepareAfter = undefined;
        retention.discarded.length = 0;
        const prepared = await protocol.prepare(snapshot);
        audit.failReservation = true;
        expect(() => harness.transaction((state) => protocol.commit(state, prepared))).toThrow(
            /inside transaction/
        );
        expect(harness.snapshot().records.listRecords("event")).toHaveLength(0);
        expect(harness.snapshot().records.listRecords("routeReservation")).toHaveLength(0);
        expect(harness.snapshot().records.listRecords("contentRetention")).toHaveLength(0);
        expect(harness.snapshot().audit).toEqual([]);
        expect(retention.discarded).toEqual([
            snapshot.payloadRetention.id.value,
            ...routes.prepared.slice(1).map((route) => `retention-${route.reservation.value}`)
        ]);
    });

    test("rejects caller-assembled preparation and trust changed during async preparation", async () => {
        const harness = createProtocolHarness();
        const subscription = subscriptionFixture("prepared-brand");
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, subscription, undefined)
        );
        let currentTrust: "authenticated" | "external" = "authenticated";
        const trust: EventTrustPort<ProtocolState> = {
            derive: () =>
                currentTrust === "authenticated"
                    ? { tier: "authenticated", initiator: principal }
                    : { tier: "external" }
        };
        const protocol = new SourceEventProtocol(
            sourceActor,
            harness.persistence,
            trust,
            { load: async () => ({ value: 7 }) },
            new SourceRoutes(),
            new RetentionPort(),
            new AuditPort(),
            new SequenceIds()
        );
        const snapshot = harness.transaction((state) =>
            protocol.snapshot(state, eventIntent("brand"))
        );
        await expect(protocol.prepare({ ...snapshot })).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
        const ForgedPreparation = {
            snapshot,
            routes: []
        } as unknown as Awaited<ReturnType<typeof protocol.prepare>>;
        expect(() =>
            harness.transaction((state) => protocol.commit(state, ForgedPreparation))
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));

        const prepared = await protocol.prepare(snapshot);
        currentTrust = "external";
        expect(() => harness.transaction((state) => protocol.commit(state, prepared))).toThrow(
            expect.objectContaining({ code: "authority.denied" })
        );
        expect(harness.snapshot().records.listRecords("event")).toEqual([]);
    });

    test("keeps payload-dedupe results stable across a second Event retry", async () => {
        const harness = createProtocolHarness();
        const subscription = subscriptionFixture("payload-reply", { dedupe: "payload" });
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, subscription, undefined)
        );
        const routes = new SourceRoutes();
        const retention = new RetentionPort();
        const protocol = sourceProtocol(
            harness,
            routes,
            new AuditPort(),
            new SequenceIds(),
            retention
        );
        const firstDraft = eventDraft("payload-first");
        const secondDraft = {
            ...eventDraft("payload-second"),
            payload: firstDraft.payload,
            payloadDigest: firstDraft.payloadDigest,
            payloadRetention: retentionFixture({
                id: "retention-event-payload-second-shared",
                recordKind: "event",
                recordId: "event-payload-second",
                content: { ref: firstDraft.payload, digest: firstDraft.payloadDigest }
            })
        };
        const first = await protocol.prepare(
            harness.transaction((state) =>
                protocol.snapshot(state, authenticateEventDraft(firstDraft))
            )
        );
        harness.transaction((state) => protocol.commit(state, first));
        const second = await protocol.prepare(
            harness.transaction((state) =>
                protocol.snapshot(state, authenticateEventDraft(secondDraft))
            )
        );

        const initial = harness.transaction((state) => protocol.commit(state, second));
        expect(retention.discarded).toEqual([]);
        const replay = harness.transaction((state) => protocol.commit(state, second));
        expect(initial.reservations).toEqual([]);
        expect(replay.reservations).toEqual([]);
        expect(retention.discarded).toEqual([]);
    });
});

describe("authenticated target projection protocol", () => {
    test("registers authenticated target admission as typed W1 command evidence", () => {
        const harness = createProtocolHarness();
        const protocol = targetProtocol(harness, new AuditPort(), new SequenceIds());
        const admission = authenticatedAdmission("target-command");
        const port = new TargetCommandPort(admission);
        const command = createTargetProjectionProtocolCommand(protocol, port);
        const payload = command.payload.decode(port.payloadBytes);
        const envelope = {} as CommandEnvelope;
        const at = new Date("2026-07-12T12:00:00.000Z");

        expect(command.command).toBe(TARGET_PROJECTION_COMMAND);
        expect(command.currentLease({}, envelope, payload, at)).toBeUndefined();
        expect(port.decisionAt).toBe(at);
        const execution = harness.transaction((state) =>
            command.execute(state, envelope, payload, at)
        );
        if (execution instanceof Uint8Array) throw new TypeError("Expected typed execution");
        expect(execution.reply.state.kind).toBe("delivered");
        expect(execution.observation).toBe(execution.reply);
    });

    test("rejects tampering, wrong targets, and public attempts to forge the bridge", () => {
        const authenticator = new TestProjectionAuthenticator();
        const reservation = reservationFixture("authentication");
        const projection = projectionFixture(reservation);
        const envelope = { reservation, projection };
        const evidence = authenticator.evidence(envelope);
        expect(authenticator.authenticate(envelope, evidence)).toBeInstanceOf(
            AuthenticatedRouteProjection
        );

        const tamperedReservation = new RouteReservation({
            ...reservation.init,
            dedupeKey: "event:tampered"
        });
        expect(() =>
            authenticator.authenticate({ reservation: tamperedReservation, projection }, evidence)
        ).toThrow(/authentication failed/);

        const ForgedProjection = AuthenticatedRouteProjection as unknown as new (
            token: symbol,
            value: RouteProjectionEnvelope
        ) => AuthenticatedRouteProjection;
        expect(() => new ForgedProjection(Symbol("forged"), envelope)).toThrow(/host-only/);

        const structuralForgery = { envelope } as unknown as AuthenticatedRouteProjection;
        const structuralHarness = createProtocolHarness();
        expect(() =>
            structuralHarness.transaction((state) =>
                targetProtocol(structuralHarness, new AuditPort(), new SequenceIds()).admit(state, {
                    projection: structuralForgery,
                    retention: projectionRetention(projection)
                })
            )
        ).toThrow(expect.objectContaining({ code: "authority.denied" }));
        expect(structuralHarness.snapshot().audit).toEqual([]);

        const harness = createProtocolHarness();
        const wrongTargetReservation = reservationFixture("wrong-target", { target: sourceActor });
        const wrongTargetProjection = projectionFixture(wrongTargetReservation);
        const authenticated = authenticator.authenticate(
            { reservation: wrongTargetReservation, projection: wrongTargetProjection },
            authenticator.evidence({
                reservation: wrongTargetReservation,
                projection: wrongTargetProjection
            })
        );
        const protocol = targetProtocol(harness, new AuditPort(), new SequenceIds());
        expect(() =>
            harness.transaction((state) =>
                protocol.admit(state, {
                    projection: authenticated,
                    retention: projectionRetention(wrongTargetProjection)
                })
            )
        ).toThrow(/another Actor/);
        expect(harness.snapshot().records.listRecords("routeProjection")).toHaveLength(0);
    });

    test("admits projection and invocation once, then returns the terminal delivery on replay", () => {
        const harness = createProtocolHarness();
        const audit = new AuditPort();
        const protocol = targetProtocol(harness, audit, new SequenceIds());
        const input = authenticatedAdmission("target-accepted");

        let delivery: ReturnType<typeof protocol.admit> | undefined;
        expect(() => {
            delivery = harness.transaction((state) => protocol.admit(state, input));
            throw new TypeError("target ack lost");
        }).toThrow(/ack lost/);
        expect(delivery?.state.kind).toBe("delivered");
        expect(harness.snapshot()).toMatchObject({
            audit: ["projection-root", "delivery"],
            authorityCalls: 1,
            invocationCalls: 1
        });

        const replay = harness.transaction((state) => protocol.admit(state, input));
        expect(replay).toEqual(delivery);
        expect(harness.snapshot()).toMatchObject({
            audit: ["projection-root", "delivery"],
            authorityCalls: 1,
            invocationCalls: 1
        });
    });

    test("records authority and invocation rejection as terminal without invoking past denial", () => {
        for (const rejection of ["authority", "invocation"] as const) {
            const harness = createProtocolHarness();
            const authority = new TargetAuthority(
                rejection === "authority"
                    ? { kind: "rejected", reason: "target authority denied" }
                    : { kind: "accepted" }
            );
            const invocations = new InvocationAdmission(
                rejection === "invocation"
                    ? { kind: "rejected", reason: "invocation denied" }
                    : { kind: "accepted" }
            );
            const protocol = new TargetProjectionProtocol(
                targetActor,
                targetPersistence(),
                new RetentionPort(),
                authority,
                invocations,
                new AuditPort(),
                new SequenceIds()
            );
            const input = authenticatedAdmission(`target-${rejection}`);

            const delivery = harness.transaction((state) => protocol.admit(state, input));
            expect(delivery.state).toMatchObject({
                kind: "rejected",
                reason: rejection === "authority" ? "target authority denied" : "invocation denied"
            });
            expect(harness.snapshot().invocationCalls).toBe(rejection === "authority" ? 0 : 1);
            const replay = harness.transaction((state) => protocol.admit(state, input));
            expect(replay).toEqual(delivery);
        }
    });

    test("rolls back a fault after projection append and succeeds on retry", () => {
        const harness = createProtocolHarness();
        const invocations = new InvocationAdmission({ kind: "accepted" });
        invocations.fail = true;
        const protocol = new TargetProjectionProtocol(
            targetActor,
            targetPersistence(),
            new RetentionPort(),
            new TargetAuthority({ kind: "accepted" }),
            invocations,
            new AuditPort(),
            new SequenceIds()
        );
        const input = authenticatedAdmission("target-fault");

        expect(() => harness.transaction((state) => protocol.admit(state, input))).toThrow(
            /invocation fault/
        );
        expect(harness.snapshot().records.listRecords("routeProjection")).toHaveLength(0);
        expect(harness.snapshot().records.listRecords("routeDelivery")).toHaveLength(0);
        expect(harness.snapshot().audit).toEqual([]);

        invocations.fail = false;
        expect(harness.transaction((state) => protocol.admit(state, input)).state.kind).toBe(
            "delivered"
        );
    });

    test("rejects a differently authenticated intent reusing a terminal reservation ID", () => {
        const harness = createProtocolHarness();
        const protocol = targetProtocol(harness, new AuditPort(), new SequenceIds());
        const original = authenticatedAdmission("target-conflict");
        harness.transaction((state) => protocol.admit(state, original));
        const source = original.projection.envelope.reservation;
        const changed = new RouteReservation({
            ...source.init,
            operation: new OperationRef("facet.test:changed")
        });
        const projection = projectionFixture(changed);
        const authenticator = new TestProjectionAuthenticator();
        const envelope = { reservation: changed, projection };

        expect(() =>
            harness.transaction((state) =>
                protocol.admit(state, {
                    projection: authenticator.authenticate(
                        envelope,
                        authenticator.evidence(envelope)
                    ),
                    retention: projectionRetention(projection)
                })
            )
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        expect(harness.snapshot().invocationCalls).toBe(1);
    });

    test("rejects invocation admission that substitutes the stable Invocation ID", () => {
        const harness = createProtocolHarness();
        const protocol = new TargetProjectionProtocol(
            targetActor,
            targetPersistence(),
            new RetentionPort(),
            new TargetAuthority({ kind: "accepted" }),
            {
                admit: () => ({
                    kind: "accepted",
                    invocation: new InvocationId("substituted-invocation")
                })
            },
            new AuditPort(),
            new SequenceIds()
        );

        expect(() =>
            harness.transaction((state) =>
                protocol.admit(state, authenticatedAdmission("target-substituted-invocation"))
            )
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
        expect(harness.snapshot().records.listRecords("routeProjection")).toEqual([]);
    });
});

describe("InboxProtocol", () => {
    test("accepts only the exact live Turn lease and preserves sequence uniqueness", () => {
        const harness = createProtocolHarness();
        const now = new Date("2026-07-10T12:00:00.000Z");
        const holder = new PrincipalId("lease-holder");
        const turn = new TurnId("turn-test");
        const lease = TurnLease.restore(turn, holder, 4, new Date(now.getTime() + 60_000));
        const runs = new LeaseInboxPort(lease, now);
        const protocol = new InboxProtocol(runs);
        const reference = inboxFixture("lease-valid", 0, 4, turn);
        const token: LeaseToken = { turn, holder, epoch: 4 };

        expect(harness.transaction((state) => protocol.append(state, reference, token))).toEqual({
            kind: "appended"
        });
        expect(harness.snapshot().inbox).toEqual([reference.id.value]);
        expect(() =>
            harness.transaction((state) =>
                protocol.append(
                    state,
                    inboxFixture("wrong-turn", 1, 4, new TurnId("other-turn")),
                    token
                )
            )
        ).toThrow(/exact current Turn lease/);
        expect(() =>
            harness.transaction((state) =>
                protocol.append(state, inboxFixture("stale-epoch", 1, 3, turn), token)
            )
        ).toThrow(/exact current Turn lease/);
        expect(() =>
            harness.transaction((state) =>
                protocol.append(state, inboxFixture("wrong-holder", 1, 4, turn), {
                    turn,
                    holder: new PrincipalId("other-holder"),
                    epoch: 4
                })
            )
        ).toThrow(/exact current Turn lease/);

        expect(harness.transaction((state) => protocol.append(state, reference, token))).toEqual({
            kind: "duplicate"
        });
        expect(() =>
            harness.transaction((state) =>
                protocol.append(state, inboxFixture("duplicate-sequence", 0, 4, turn), token)
            )
        ).toThrow(/conflict/);
        expect(harness.snapshot().inbox).toEqual([reference.id.value]);

        const expired = new InboxProtocol(
            new LeaseInboxPort(TurnLease.restore(turn, holder, 4, new Date(now.getTime() - 1)), now)
        );
        expect(() =>
            harness.transaction((state) =>
                expired.append(state, inboxFixture("expired", 1, 4, turn), token)
            )
        ).toThrow(/exact current Turn lease/);
    });
});

class SourceCommandPort extends SourceEventCommandPort<object> {
    public readonly caller = CommandCallerPolicy.actor("workspace");
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new ReferenceCodec<PreparedEventRouting>();
    public readonly resultCodec: ProtocolValueCodec<EventAcceptanceResult> =
        new ReferenceCodec<EventAcceptanceResult>();
    public readonly payloadBytes: Uint8Array;
    public decisionAt: Date | undefined;

    public constructor(prepared: PreparedEventRouting) {
        super();
        this.payloadBytes = this.payload.encode(prepared);
    }

    public authorize(): boolean {
        return true;
    }
    public permitsLifecycle(): boolean {
        return true;
    }
    public currentRevision(): undefined {
        return undefined;
    }
    public currentLease(
        _read: object,
        _envelope: CommandEnvelope,
        _prepared: PreparedEventRouting,
        at: Date
    ): undefined {
        this.decisionAt = at;
        return undefined;
    }
}

class TargetCommandPort extends TargetProjectionCommandPort<object> {
    public readonly caller = CommandCallerPolicy.actor("workspace");
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new ReferenceCodec<TargetProjectionAdmission>();
    public readonly resultCodec: ProtocolValueCodec<RouteDelivery> =
        new ReferenceCodec<RouteDelivery>();
    public readonly payloadBytes: Uint8Array;
    public decisionAt: Date | undefined;

    public constructor(admission: TargetProjectionAdmission) {
        super();
        this.payloadBytes = this.payload.encode(admission);
    }

    public authorize(): boolean {
        return true;
    }
    public permitsLifecycle(): boolean {
        return true;
    }
    public currentRevision(): undefined {
        return undefined;
    }
    public currentLease(
        _read: object,
        _envelope: CommandEnvelope,
        _admission: TargetProjectionAdmission,
        at: Date
    ): undefined {
        this.decisionAt = at;
        return undefined;
    }
}

class ReferenceCodec<Value> implements ProtocolValueCodec<Value> {
    readonly #values = new Map<string, Value>();
    #next = 0;

    public encode(value: Value): Uint8Array {
        this.#next += 1;
        const key = `reference-${this.#next}`;
        this.#values.set(key, value);
        return new TextEncoder().encode(key);
    }

    public decode(bytes: Uint8Array): Value {
        const value = this.#values.get(new TextDecoder().decode(bytes));
        if (value === undefined) throw new TypeError("Unknown test command reference");
        return value;
    }
}

class SourceRoutes implements SourceRoutePort<ProtocolState> {
    public readonly prepared: RouteMaterialPreparation[] = [];
    public failPrepareAfter: number | undefined;

    public async prepare(input: RouteMaterialPreparation): Promise<PreparedRouteMaterial> {
        if (this.prepared.length === this.failPrepareAfter) {
            throw new TypeError("fault before transaction");
        }
        this.prepared.push(input);
        const projected = content(`prepared-${input.reservation.value}`);
        return {
            targetActor,
            tenants: { kind: "same", tenant },
            content: projected.ref,
            digest: projected.digest,
            retention: retentionFixture({
                id: `retention-${input.reservation.value}`,
                recordKind: "routeReservation",
                recordId: input.reservation.value,
                content: projected
            }),
            evidence: "source-authority"
        };
    }

    public authorize(): {
        readonly kind: "accepted";
        readonly targetActor: ActorRef;
        readonly tenants: { readonly kind: "same"; readonly tenant: typeof tenant };
        readonly operation: ReturnType<typeof subscriptionFixture>["target"];
    } {
        return {
            kind: "accepted",
            targetActor,
            tenants: { kind: "same", tenant },
            operation: subscriptionFixture().target
        };
    }
}

class RetentionPort implements ContentRetentionPort<ProtocolState> {
    public readonly discarded: string[] = [];

    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(reference: Parameters<ContentRetentionPort<ProtocolState>["discard"]>[0]): void {
        this.discarded.push(reference.id.value);
    }
}

class TargetAuthority implements TargetRouteAuthorityPort<ProtocolState> {
    public constructor(private readonly decision: TargetAuthorityDecision) {}

    public authorize(state: ProtocolState): TargetAuthorityDecision {
        state.authorityCalls += 1;
        return this.decision;
    }
}

class InvocationAdmission implements InvocationAdmissionPort<ProtocolState> {
    public fail = false;

    public constructor(private readonly decision: TargetAuthorityDecision) {}

    public admit(
        state: ProtocolState,
        input: Parameters<InvocationAdmissionPort<ProtocolState>["admit"]>[1]
    ): InvocationAdmissionDecision {
        state.invocationCalls += 1;
        if (this.fail) throw new TypeError("invocation fault");
        return this.decision.kind === "accepted"
            ? { kind: "accepted", invocation: input.reservation.invocation }
            : this.decision;
    }
}

class LeaseInboxPort implements RunInboxPort<ProtocolState> {
    public constructor(
        private readonly lease: TurnLease,
        private readonly now: Date
    ) {}

    public append(
        state: ProtocolState,
        reference: ReturnType<typeof inboxFixture>,
        token: LeaseToken
    ) {
        if (!this.lease.admits(token, this.now)) {
            return { kind: "rejected", reason: "lease" } as const;
        }
        const sequence = `${reference.turn.value}:${reference.sequence}`;
        const existing = state.inboxBySequence.get(sequence);
        if (existing === reference.id.value) return { kind: "duplicate" } as const;
        if (existing !== undefined) return { kind: "rejected", reason: "conflict" } as const;
        state.inbox.push(reference.id.value);
        state.inboxBySequence.set(sequence, reference.id.value);
        return { kind: "appended" } as const;
    }
}

function sourceProtocol(
    harness: ProtocolHarness,
    routes: SourceRoutes,
    audit: AuditPort,
    ids: SequenceIds,
    retention = new RetentionPort()
): SourceEventProtocol<ProtocolState> {
    const trust: EventTrustPort<ProtocolState> = {
        derive: () => ({ tier: "authenticated", initiator: principal })
    };
    const payloads: EventPayloadPort = {
        load: async (): Promise<JsonValue> => ({ value: 7 })
    };
    return new SourceEventProtocol(
        sourceActor,
        harness.persistence,
        trust,
        payloads,
        routes,
        retention,
        audit,
        ids
    );
}

function targetProtocol(
    _harness: ProtocolHarness,
    audit: AuditPort,
    ids: SequenceIds
): TargetProjectionProtocol<ProtocolState> {
    return new TargetProjectionProtocol(
        targetActor,
        targetPersistence(),
        new RetentionPort(),
        new TargetAuthority({ kind: "accepted" }),
        new InvocationAdmission({ kind: "accepted" }),
        audit,
        ids
    );
}

function eventDraft(suffix: string): EventDraft {
    const payload = content(`draft-${suffix}`);
    const event = new EventId(`event-${suffix}`);
    return {
        id: event,
        scope,
        sourceActor,
        source: { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind("task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: retentionFixture({
            id: `retention-event-${suffix}`,
            recordKind: "event",
            recordId: event.value,
            content: payload
        }),
        idempotencyKey: `draft-key-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        provenance: new EventProvenance({
            verification: EventVerification.verified(),
            principal,
            claims: { source: "test" }
        }),
        visibility: "workspace"
    };
}

function authenticateEventDraft(draft: EventDraft): AuthenticatedEventIntent {
    const authenticator = new TestEventIntentAuthenticator();
    return authenticator.authenticate(draft, authenticator.evidence(draft));
}

function eventIntent(suffix: string): AuthenticatedEventIntent {
    return authenticateEventDraft(eventDraft(suffix));
}

function authenticatedAdmission(suffix: string): {
    readonly projection: AuthenticatedRouteProjection;
    readonly retention: ReturnType<typeof projectionRetention>;
} {
    const reservation = reservationFixture(suffix);
    const projection = projectionFixture(reservation);
    const envelope = { reservation, projection };
    const authenticator = new TestProjectionAuthenticator();
    return {
        projection: authenticator.authenticate(envelope, authenticator.evidence(envelope)),
        retention: projectionRetention(projection)
    };
}

function createProtocolHarness(): ProtocolHarness {
    const clone = (state: ProtocolState): ProtocolState => ({
        records: state.records.clone(),
        audit: [...state.audit],
        inbox: [...state.inbox],
        inboxBySequence: new Map(state.inboxBySequence),
        authorityCalls: state.authorityCalls,
        invocationCalls: state.invocationCalls
    });
    const store = new MemoryActorStore<ProtocolState>(
        {
            records: new MemoryWorkspaceRecords(),
            audit: [],
            inbox: [],
            inboxBySequence: new Map(),
            authorityCalls: 0,
            invocationCalls: 0
        },
        clone
    );
    return {
        persistence: new WorkspacePersistence(
            (state) => state.records,
            new RetentionPort(),
            sourceActor,
            tenant
        ),
        transaction<Result>(
            operation: (state: ProtocolState) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return store.transaction(operation, ...guard);
        },
        snapshot(): ProtocolState {
            return store.snapshot().state;
        }
    };
}

function targetPersistence(): WorkspacePersistence<ProtocolState> {
    return new WorkspacePersistence(
        (state) => state.records,
        new RetentionPort(),
        targetActor,
        tenant
    );
}

function signature(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}
