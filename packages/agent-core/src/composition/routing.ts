import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    AuditRecord,
    type AuditEvidenceResolver,
    type AuditRecordId,
    type AuditRecordLookup,
    type InvocationLedger,
    type InvocationPersistence,
    type PreparedInvocation
} from "../invocations";
import type { CorrelationId } from "../interaction-references";
import {
    Event,
    type AuthenticatedRouteProjection,
    type InboxEventReference,
    type InteractionAuditPort,
    type InvocationAdmissionDecision,
    type InvocationAdmissionPort,
    type RouteDelivery,
    type RouteReservation,
    type RoutedInvocationAdmission,
    type RunInboxOutcome,
    type RunInboxPort
} from "../workspaces";
import { RunRuntime, TurnInboxEntry, type LeaseToken } from "../agents";
import type { Revision } from "../core";

export interface InteractionAuditMetadataPort<Transaction> {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    records(transaction: Transaction): AuditRecordLookup;
    evidence(transaction: Transaction): AuditEvidenceResolver;
    eventCause(transaction: Transaction, event: Event): AuditRecordId;
    correlationForProjection(
        transaction: Transaction,
        projection: AuthenticatedRouteProjection
    ): CorrelationId;
    correlationForDelivery(transaction: Transaction, delivery: RouteDelivery): CorrelationId;
    append(
        transaction: Transaction,
        record: AuditRecord,
        admission?: {
            readonly kind: "routeProjection";
            readonly projection: AuthenticatedRouteProjection["envelope"]["projection"]["id"];
            readonly reservation: RouteReservation["id"];
        }
    ): void;
}

export class InvocationInteractionAuditPort<
    Transaction
> implements InteractionAuditPort<Transaction> {
    public constructor(private readonly metadata: InteractionAuditMetadataPort<Transaction>) {}

    public appendEvent(transaction: Transaction, event: Event, audit: AuditRecordId): void {
        this.metadata.append(
            transaction,
            new AuditRecord({
                id: audit,
                actor: this.metadata.actor,
                tenant: this.metadata.tenant,
                correlation: event.correlation,
                cause: this.metadata.eventCause(transaction, event),
                kind: { kind: "event", id: event.id }
            })
        );
    }

    public appendReservation(
        transaction: Transaction,
        reservation: RouteReservation,
        audit: AuditRecordId
    ): void {
        const event = this.metadata.evidence(transaction).route(reservation.id);
        const cause = this.metadata.records(transaction).get(reservation.sourceAuditCause);
        if (event === undefined || cause === undefined) {
            throw invalid("Route reservation audit evidence is unavailable");
        }
        this.metadata.append(
            transaction,
            new AuditRecord({
                id: audit,
                actor: this.metadata.actor,
                tenant: this.metadata.tenant,
                correlation: cause.correlation,
                cause: reservation.sourceAuditCause,
                kind: { kind: "routeReserved", id: reservation.id }
            })
        );
    }

    public appendProjectionRoot(
        transaction: Transaction,
        projection: AuthenticatedRouteProjection,
        audit: AuditRecordId
    ): void {
        const envelope = projection.envelope;
        this.metadata.append(
            transaction,
            new AuditRecord({
                id: audit,
                actor: this.metadata.actor,
                tenant: this.metadata.tenant,
                correlation: this.metadata.correlationForProjection(transaction, projection),
                kind: {
                    kind: "routeProjected",
                    projection: envelope.projection.id,
                    reservation: envelope.reservation.id
                }
            }),
            {
                kind: "routeProjection",
                projection: envelope.projection.id,
                reservation: envelope.reservation.id
            }
        );
    }

    public appendDelivery(
        transaction: Transaction,
        delivery: RouteDelivery,
        projectionAudit: AuditRecordId,
        audit: AuditRecordId
    ): void {
        this.metadata.append(
            transaction,
            new AuditRecord({
                id: audit,
                actor: this.metadata.actor,
                tenant: this.metadata.tenant,
                correlation: this.metadata.correlationForDelivery(transaction, delivery),
                cause: projectionAudit,
                kind: { kind: "delivery", reservation: delivery.reservation }
            })
        );
    }
}

export interface RoutedInvocationFactory<Lease, Authority, Domain, PathEpochs> {
    prepare(input: RoutedInvocationAdmission): {
        readonly invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
        readonly audit: AuditRecord;
    };
}

export class RoutedInvocationAdmissionPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> implements InvocationAdmissionPort<Transaction> {
    public constructor(
        private readonly ledger: InvocationLedger<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly persistence: InvocationPersistence<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >,
        private readonly factory: RoutedInvocationFactory<Lease, Authority, Domain, PathEpochs>
    ) {}

    public admit(
        transaction: Transaction,
        input: RoutedInvocationAdmission
    ): InvocationAdmissionDecision {
        const prepared = this.factory.prepare(input);
        if (
            !prepared.invocation.header.id.equals(input.reservation.invocation) ||
            !prepared.invocation.header.route?.equals(input.reservation.id) ||
            !prepared.invocation.header.projectionDigest?.equals(input.projection.digest) ||
            !prepared.invocation.header.auditCause.equals(input.bridgeAudit) ||
            !prepared.audit.id.equals(input.bridgeAudit) ||
            prepared.audit.kind.kind !== "routeProjected" ||
            !prepared.audit.kind.projection.equals(input.projection.id) ||
            !prepared.audit.kind.reservation.equals(input.reservation.id) ||
            prepared.audit.cause !== undefined
        ) {
            return { kind: "rejected", reason: "routed invocation evidence was substituted" };
        }
        const existing = this.persistence.prepared(transaction, input.reservation.invocation);
        if (existing !== undefined) {
            return existing.intentDigest.equals(prepared.invocation.intentDigest)
                ? { kind: "accepted", invocation: existing.header.id }
                : { kind: "rejected", reason: "stable routed invocation identity conflicts" };
        }
        this.ledger.prepare(transaction, prepared.invocation);
        return { kind: "accepted", invocation: prepared.invocation.header.id };
    }
}

export interface RunInboxMaterialPort<Transaction> {
    materialize(
        transaction: Transaction,
        reference: InboxEventReference,
        lease: LeaseToken
    ): {
        readonly entry: TurnInboxEntry;
        readonly expectedTurnRevision: Revision;
        readonly now: Date;
    };
}

export class RuntimeRunInboxPort<Transaction> implements RunInboxPort<Transaction> {
    public constructor(
        private readonly runtime: RunRuntime<Transaction>,
        private readonly material: RunInboxMaterialPort<Transaction>
    ) {}

    public append(
        transaction: Transaction,
        reference: InboxEventReference,
        lease: LeaseToken
    ): RunInboxOutcome {
        const value = this.material.materialize(transaction, reference, lease);
        if (
            !value.entry.turn.equals(reference.turn) ||
            value.entry.sequence !== reference.sequence ||
            value.entry.event !== reference.event.value
        ) {
            return { kind: "rejected", reason: "conflict" };
        }
        const existing = this.runtime.repository.loadInbox(transaction, value.entry.id);
        if (existing !== undefined) {
            return sameBytes(
                TurnInboxEntry.codec.encode(existing),
                TurnInboxEntry.codec.encode(value.entry)
            )
                ? { kind: "duplicate" }
                : { kind: "rejected", reason: "conflict" };
        }
        try {
            this.runtime.deliverEventInTransaction(
                transaction,
                reference.turn,
                value.expectedTurnRevision,
                lease,
                value.entry,
                value.now
            );
            return { kind: "appended" };
        } catch (error) {
            if (error instanceof AgentCoreError && error.code === "lease.invalid") {
                return { kind: "rejected", reason: "lease" };
            }
            if (error instanceof AgentCoreError && error.code === "turn.invalid-state") {
                return { kind: "rejected", reason: "lifecycle" };
            }
            throw error;
        }
    }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
