// @ts-nocheck
import type { ActorRef } from "../actors";
import type { Revision } from "../core";
import type { LeaseToken } from "../agents";
import { AgentCoreError } from "../errors";
import type {
    CommandCallerPolicy,
    CommandEnvelope,
    CommandPayloadCodec,
    CurrentLease,
    ExpectedRevisionPolicy,
    LeaseTokenPolicy,
    ProtocolCommand,
    ProtocolCommandExecution,
    ProtocolValueCodec
} from "../protocol";
import {
    ContentRetentionReference,
    RetainedRecordKind,
    type ContentRetentionPort
} from "./retention";
import { Event } from "./event";
import {
    AuthenticatedEventIntent,
    requireAuthenticatedEventIntent,
    type EventIntentInput
} from "./origin";
import type {
    EventPayloadPort,
    EventTrustPort,
    InteractionAuditPort,
    InteractionIdPort,
    PreparedRouteMaterial,
    SourceRoutePort
} from "./ports";
import { applyPayloadMapping, eventMatches, routeDedupeKey } from "./policy";
import { WorkspacePersistence } from "./persistence";
import { RouteProjection, RouteReservation } from "./route";
import type { Subscription } from "./subscription";
import { canonicalJson } from "./value";
export type EventDraft = EventIntentInput;

export interface EventRoutingSnapshot {
    readonly event: Event;
    readonly sourceActor: ActorRef;
    readonly payloadRetention: ContentRetentionReference;
    readonly subscriptions: readonly Subscription[];
    readonly dedupedRouteKeys: readonly string[];
    readonly eventAudit: ReturnType<InteractionIdPort["eventAudit"]>;
    readonly lease: LeaseToken | undefined;
    readonly existingEvent: Event | undefined;
}

export interface PreparedRoute {
    readonly subscription: Subscription;
    readonly material: PreparedRouteMaterial;
    readonly reservationId: ReturnType<InteractionIdPort["reservation"]>;
    readonly invocationId: ReturnType<InteractionIdPort["invocation"]>;
    readonly projection: RouteProjection;
    readonly dedupeKey: string;
    readonly reservationAudit: ReturnType<InteractionIdPort["reservationAudit"]>;
}

export class PreparedEventRouting {
    public constructor(
        token: typeof preparedRoutingToken,
        owner: object,
        snapshot: EventRoutingSnapshot,
        routes: readonly PreparedRoute[]
    ) {
        if (token !== preparedRoutingToken) {
            throw new TypeError("Prepared Event routing construction is host-only");
        }
        preparedRoutingInstances.set(
            this,
            Object.freeze({
                owner,
                snapshot,
                routes: Object.freeze([...routes])
            })
        );
        Object.freeze(this);
    }
}

const preparedRoutingToken: unique symbol = Symbol("prepared-event-routing");
const preparedRoutingInstances = new WeakMap<
    object,
    {
        readonly owner: object;
        readonly snapshot: EventRoutingSnapshot;
        readonly routes: readonly PreparedRoute[];
    }
>();
const routingSnapshots = new WeakMap<object, object>();

export interface EventAcceptanceResult {
    readonly event: Event;
    readonly duplicate: boolean;
    readonly reservations: readonly RouteReservation[];
}

export const SOURCE_EVENT_COMMAND = "workspace.event.accept";

export abstract class SourceEventCommandPort<Read> {
    public abstract readonly caller: CommandCallerPolicy;
    public abstract readonly expectedRevision: ExpectedRevisionPolicy;
    public abstract readonly lease: LeaseTokenPolicy;
    public abstract readonly payload: CommandPayloadCodec<PreparedEventRouting>;
    public abstract readonly resultCodec: ProtocolValueCodec<EventAcceptanceResult>;
    public abstract authorize(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): boolean;
    public abstract permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): boolean;
    public abstract currentRevision(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): Revision | undefined;
    public abstract currentLease(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting,
        at: Date
    ): CurrentLease | undefined;
}

export class SourceEventProtocol<Transaction> {
    public constructor(
        private readonly actor: ActorRef,
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly trust: EventTrustPort<Transaction>,
        private readonly payloads: EventPayloadPort,
        private readonly routes: SourceRoutePort<Transaction>,
        private readonly retention: ContentRetentionPort<Transaction>,
        private readonly audit: InteractionAuditPort<Transaction>,
        private readonly ids: InteractionIdPort
    ) {}

    public snapshot(
        transaction: Transaction,
        authenticatedIntent: AuthenticatedEventIntent
    ): EventRoutingSnapshot {
        const capturedIntent = authenticatedIntent;
        requireAuthenticatedEventIntent(capturedIntent);
        const draft = capturedIntent.intent;
        if (!draft.sourceActor.equals(this.actor)) {
            throw denied("Event source Actor must be the accepting Actor");
        }
        const derived = this.trust.derive(
            transaction,
            this.actor,
            draft.scope,
            draft.provenance,
            draft.lease
        );
        const event = new Event({
            id: draft.id,
            scope: draft.scope,
            source: draft.source,
            kind: draft.kind,
            payload: draft.payload,
            payloadDigest: draft.payloadDigest,
            idempotencyKey: draft.idempotencyKey,
            correlation: draft.correlation,
            ...(draft.causation === undefined ? {} : { causation: draft.causation }),
            provenance: draft.provenance,
            trust: derived.tier,
            visibility: draft.visibility,
            ...(derived.initiator === undefined ? {} : { initiator: derived.initiator })
        });
        const subscriptions = this.persistence.listSubscriptions(transaction);
        const existingEvent = this.persistence.findEventByIdentity(
            transaction,
            event.idempotencyKey
        );
        if (
            existingEvent !== undefined &&
            !equalBytes(Event.encode(existingEvent), Event.encode(event))
        ) {
            throw new AgentCoreError(
                "protocol.duplicate",
                "Event idempotency key conflicts with another authenticated intent"
            );
        }
        const dedupedRouteKeys = subscriptions.flatMap((subscription) => {
            if (!eventMatches(subscription.source, event) || subscription.dedupe === "none")
                return [];
            const key = routeDedupeKey(subscription.dedupe, event);
            return this.persistence.findReservationByDedupe(transaction, subscription.id, key) ===
                undefined
                ? []
                : [routeIdentity(subscription, key)];
        });
        const snapshot = Object.freeze({
            event,
            sourceActor: draft.sourceActor,
            payloadRetention: draft.payloadRetention,
            subscriptions,
            dedupedRouteKeys: Object.freeze(dedupedRouteKeys),
            eventAudit: this.ids.eventAudit(),
            lease: draft.lease === undefined ? undefined : Object.freeze({ ...draft.lease }),
            existingEvent
        });
        routingSnapshots.set(snapshot, this);
        return snapshot;
    }

    public async prepare(snapshot: EventRoutingSnapshot): Promise<PreparedEventRouting> {
        if (routingSnapshots.get(snapshot) !== this) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Event routing snapshot was not created by this host runtime"
            );
        }
        if (snapshot.existingEvent !== undefined) {
            return new PreparedEventRouting(preparedRoutingToken, this, snapshot, []);
        }
        const payload = await this.payloads.load(
            snapshot.event.payload,
            snapshot.event.payloadDigest
        );
        const prepared: PreparedRoute[] = [];
        const existingRoutes = new Set(snapshot.dedupedRouteKeys);
        try {
            for (const subscription of snapshot.subscriptions) {
                if (!eventMatches(subscription.source, snapshot.event)) continue;
                const reservationId = this.ids.reservation();
                const projectionId = this.ids.projection();
                const logicalDelivery =
                    subscription.dedupe === "none" ? this.ids.logicalDelivery() : undefined;
                const dedupeKey = routeDedupeKey(
                    subscription.dedupe,
                    snapshot.event,
                    logicalDelivery
                );
                if (existingRoutes.has(routeIdentity(subscription, dedupeKey))) continue;
                const mappedInput = applyPayloadMapping(subscription.mapping, payload);
                const material = copyPreparedMaterial(
                    await this.routes.prepare({
                        subscription,
                        event: snapshot.event,
                        mappedInput,
                        reservation: reservationId,
                        projection: projectionId
                    })
                );
                prepared.push(
                    Object.freeze({
                        subscription,
                        material,
                        reservationId,
                        invocationId: this.ids.invocation(),
                        projection: new RouteProjection({
                            id: projectionId,
                            reservation: reservationId,
                            content: material.content,
                            digest: material.digest
                        }),
                        dedupeKey,
                        reservationAudit: this.ids.reservationAudit()
                    })
                );
            }
        } catch (error) {
            for (const route of prepared) this.retention.discard(route.material.retention);
            throw error;
        }
        return new PreparedEventRouting(preparedRoutingToken, this, snapshot, prepared);
    }

    public commit(transaction: Transaction, prepared: PreparedEventRouting): EventAcceptanceResult {
        const preparedState = preparedRoutingInstances.get(prepared);
        if (
            !(prepared instanceof PreparedEventRouting) ||
            preparedState === undefined ||
            preparedState.owner !== this
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Event routing was not prepared by this host runtime"
            );
        }
        try {
            if (!preparedState.snapshot.sourceActor.equals(this.actor)) {
                throw new AgentCoreError(
                    "authority.denied",
                    "Prepared Event belongs to another Actor"
                );
            }
            const existingEvent = this.persistence.findEventByIdentity(
                transaction,
                preparedState.snapshot.event.idempotencyKey
            );
            if (existingEvent !== undefined) {
                if (
                    !equalBytes(
                        Event.encode(existingEvent),
                        Event.encode(preparedState.snapshot.event)
                    )
                ) {
                    throw new AgentCoreError(
                        "protocol.duplicate",
                        "Event idempotency key conflicts with another authenticated intent"
                    );
                }
                const retained = this.persistence.listRetentionsFor(
                    transaction,
                    RetainedRecordKind.event(),
                    existingEvent.id.value
                );
                if (
                    !retained.some((reference) =>
                        reference.id.equals(preparedState.snapshot.payloadRetention.id)
                    )
                ) {
                    this.retention.discard(preparedState.snapshot.payloadRetention);
                }
                for (const route of preparedState.routes) {
                    this.retention.discard(route.material.retention);
                }
                return Object.freeze({
                    event: existingEvent,
                    duplicate: true,
                    reservations: this.persistence.listReservationsForEvent(
                        transaction,
                        existingEvent.id
                    )
                });
            }
            this.requireSnapshotCurrent(transaction, preparedState.snapshot);
            this.requireTrustCurrent(transaction, preparedState.snapshot);
            if (!this.retention.verify(transaction, preparedState.snapshot.payloadRetention)) {
                throw invalidState("Event payload retention is not durable");
            }
            requireRetentionActor(
                preparedState.snapshot.payloadRetention,
                preparedState.snapshot.sourceActor,
                preparedState.snapshot.event.scope.tenantId,
                RetainedRecordKind.event(),
                preparedState.snapshot.event.id.value
            );
            this.audit.appendEvent(
                transaction,
                preparedState.snapshot.event,
                preparedState.snapshot.eventAudit
            );
            this.persistence.appendEvent(
                transaction,
                preparedState.snapshot.event,
                preparedState.snapshot.payloadRetention
            );

            const reservations: RouteReservation[] = [];
            for (const route of preparedState.routes) {
                const existing = this.persistence.findReservationByDedupe(
                    transaction,
                    route.subscription.id,
                    route.dedupeKey
                );
                if (existing !== undefined) {
                    this.retention.discard(route.material.retention);
                    continue;
                }
                const decision = this.routes.authorize(
                    transaction,
                    route.subscription,
                    preparedState.snapshot.event,
                    route.material
                );
                if (decision.kind !== "accepted") {
                    throw denied("Source route authority rejected prepared material");
                }
                if (
                    !decision.targetActor.equals(route.material.targetActor) ||
                    !tenantRelationsEqual(decision.tenants, route.material.tenants) ||
                    !decision.operation.equals(route.subscription.target)
                ) {
                    throw invalidState("Prepared route target changed before source commit");
                }
                if (!this.retention.verify(transaction, route.material.retention)) {
                    throw invalidState("Route projection retention is not durable");
                }
                requireRetentionActor(
                    route.material.retention,
                    preparedState.snapshot.sourceActor,
                    preparedState.snapshot.event.scope.tenantId,
                    RetainedRecordKind.routeReservation(),
                    route.reservationId.value
                );
                const reservation = new RouteReservation({
                    id: route.reservationId,
                    invocation: route.invocationId,
                    event: preparedState.snapshot.event.id,
                    sourceAuditCause: preparedState.snapshot.eventAudit,
                    sourceActor: preparedState.snapshot.sourceActor,
                    targetActor: route.material.targetActor,
                    tenants: route.material.tenants,
                    subscription: route.subscription.id,
                    dedupeKey: route.dedupeKey,
                    operation: route.subscription.target,
                    authority: route.subscription.authority,
                    projection: route.projection.id,
                    projectionRef: route.projection.content,
                    projectionDigest: route.projection.digest,
                    trust: preparedState.snapshot.event.trust,
                    ...(preparedState.snapshot.event.initiator === undefined
                        ? {}
                        : { initiator: preparedState.snapshot.event.initiator })
                });
                this.audit.appendReservation(transaction, reservation, route.reservationAudit);
                this.persistence.appendReservation(
                    transaction,
                    reservation,
                    route.material.retention
                );
                reservations.push(reservation);
            }
            return Object.freeze({
                event: preparedState.snapshot.event,
                duplicate: false,
                reservations: Object.freeze(reservations)
            });
        } catch (error) {
            this.retention.discard(preparedState.snapshot.payloadRetention);
            for (const route of preparedState.routes) {
                this.retention.discard(route.material.retention);
            }
            throw error;
        }
    }

    private requireSnapshotCurrent(transaction: Transaction, snapshot: EventRoutingSnapshot): void {
        const current = this.persistence.listSubscriptions(transaction);
        if (
            current.length !== snapshot.subscriptions.length ||
            current.some((subscription, index) => {
                const expected = snapshot.subscriptions[index];
                return (
                    expected === undefined ||
                    !subscription.id.equals(expected.id) ||
                    !subscription.revision.equals(expected.revision)
                );
            })
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Subscription snapshot changed during Event preparation"
            );
        }
    }

    private requireTrustCurrent(transaction: Transaction, snapshot: EventRoutingSnapshot): void {
        const event = snapshot.event;
        const derived = this.trust.derive(
            transaction,
            this.actor,
            event.scope,
            event.provenance,
            snapshot.lease
        );
        if (
            derived.tier !== event.trust ||
            (derived.initiator === undefined) !== (event.initiator === undefined) ||
            (derived.initiator !== undefined &&
                event.initiator !== undefined &&
                !derived.initiator.equals(event.initiator))
        ) {
            throw denied("Event trust changed during asynchronous preparation");
        }
    }
}

export function createSourceEventProtocolCommand<Transaction, Read>(
    protocol: SourceEventProtocol<Transaction>,
    port: SourceEventCommandPort<Read>
): ProtocolCommand<
    Transaction,
    Read,
    PreparedEventRouting,
    EventAcceptanceResult,
    EventAcceptanceResult
> {
    return new SourceEventProtocolCommand(protocol, port);
}

class SourceEventProtocolCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    PreparedEventRouting,
    EventAcceptanceResult,
    EventAcceptanceResult
> {
    public readonly command = SOURCE_EVENT_COMMAND;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision: ExpectedRevisionPolicy;
    public readonly lease: LeaseTokenPolicy;
    public readonly payload: CommandPayloadCodec<PreparedEventRouting>;
    public readonly replyCodec: ProtocolValueCodec<EventAcceptanceResult>;
    public readonly observationCodec: ProtocolValueCodec<EventAcceptanceResult>;

    public constructor(
        private readonly protocol: SourceEventProtocol<Transaction>,
        private readonly port: SourceEventCommandPort<Read>
    ) {
        this.caller = port.caller;
        this.expectedRevision = port.expectedRevision;
        this.lease = port.lease;
        this.payload = port.payload;
        this.replyCodec = port.resultCodec;
        this.observationCodec = port.resultCodec;
    }

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): boolean {
        return this.port.authorize(read, envelope, prepared);
    }

    public permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): boolean {
        return this.port.permitsLifecycle(read, envelope, prepared);
    }

    public currentRevision(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting
    ): Revision | undefined {
        return this.port.currentRevision(read, envelope, prepared);
    }

    public currentLease(
        read: Read,
        envelope: CommandEnvelope,
        prepared: PreparedEventRouting,
        at: Date
    ): CurrentLease | undefined {
        return this.port.currentLease(read, envelope, prepared, at);
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        prepared: PreparedEventRouting,
        _at: Date
    ): ProtocolCommandExecution<EventAcceptanceResult, EventAcceptanceResult> {
        const result = this.protocol.commit(transaction, prepared);
        return { reply: result, observation: result };
    }
}

function requireRetentionActor(
    retention: ContentRetentionReference,
    actor: ActorRef,
    tenant: ContentRetentionReference["tenant"],
    kind: ContentRetentionReference["recordKind"],
    recordKey: string
): void {
    if (
        !retention.actor.equals(actor) ||
        !retention.tenant.equals(tenant) ||
        !retention.recordKind.equals(kind) ||
        retention.record.value !== recordKey
    ) {
        throw invalidState("Content retention belongs to another Actor or record");
    }
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    );
}

function tenantRelationsEqual(
    left: PreparedRouteMaterial["tenants"],
    right: PreparedRouteMaterial["tenants"]
): boolean {
    return (
        left.kind === right.kind &&
        (left.kind === "same"
            ? right.kind === "same" && left.tenant.equals(right.tenant)
            : right.kind === "cross" &&
              left.source.equals(right.source) &&
              left.target.equals(right.target) &&
              left.authority.equals(right.authority))
    );
}

function routeIdentity(subscription: Subscription, dedupeKey: string): string {
    return `${subscription.id.value.length}:${subscription.id.value}${dedupeKey}`;
}

function copyPreparedMaterial(material: PreparedRouteMaterial): PreparedRouteMaterial {
    const tenants =
        material.tenants.kind === "same"
            ? Object.freeze({ kind: material.tenants.kind, tenant: material.tenants.tenant })
            : Object.freeze({
                  kind: material.tenants.kind,
                  source: material.tenants.source,
                  target: material.tenants.target,
                  authority: material.tenants.authority
              });
    return Object.freeze({
        targetActor: material.targetActor,
        tenants,
        content: material.content,
        digest: material.digest,
        retention: ContentRetentionReference.codec.decode(
            ContentRetentionReference.codec.encode(material.retention)
        ),
        evidence: canonicalJson(material.evidence)
    });
}
