// @ts-nocheck
import type { ActorRef } from "../actors";
import type { Revision } from "../core";
import { AgentCoreError } from "../errors";
import { InvocationId } from "../interaction-references";
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
    RetainedRecordKind,
    type ContentRetentionPort,
    type ContentRetentionReference
} from "./retention";
import type {
    InteractionAuditPort,
    InteractionIdPort,
    InvocationAdmissionDecision,
    InvocationAdmissionPort,
    TargetAuthorityDecision,
    TargetRouteAuthorityPort
} from "./ports";
import { WorkspacePersistence } from "./persistence";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteProjection,
    RouteDeliveryState,
    requireAuthenticatedRouteProjection
} from "./route";

export interface TargetProjectionAdmission {
    readonly projection: AuthenticatedRouteProjection;
    readonly retention: ContentRetentionReference;
}

export const TARGET_PROJECTION_COMMAND = "workspace.route.project";

export abstract class TargetProjectionCommandPort<Read> {
    public abstract readonly caller: CommandCallerPolicy;
    public abstract readonly expectedRevision: ExpectedRevisionPolicy;
    public abstract readonly lease: LeaseTokenPolicy;
    public abstract readonly payload: CommandPayloadCodec<TargetProjectionAdmission>;
    public abstract readonly resultCodec: ProtocolValueCodec<RouteDelivery>;
    public abstract authorize(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission
    ): boolean;
    public abstract permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission
    ): boolean;
    public abstract currentRevision(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission
    ): Revision | undefined;
    public abstract currentLease(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission,
        at: Date
    ): CurrentLease | undefined;
}

export class TargetProjectionProtocol<Transaction> {
    public constructor(
        private readonly actor: ActorRef,
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly retention: ContentRetentionPort<Transaction>,
        private readonly authority: TargetRouteAuthorityPort<Transaction>,
        private readonly invocations: InvocationAdmissionPort<Transaction>,
        private readonly audit: InteractionAuditPort<Transaction>,
        private readonly ids: InteractionIdPort
    ) {}

    public admit(transaction: Transaction, input: TargetProjectionAdmission): RouteDelivery {
        const authenticatedProjection = input.projection;
        requireAuthenticatedRouteProjection(authenticatedProjection);
        try {
            const envelope = authenticatedProjection.envelope;
            if (!envelope.reservation.targetActor.equals(this.actor)) {
                throw denied("Authenticated route projection targets another Actor");
            }
            const projectedRecord = envelope.projection.authenticate(
                authenticatedProjection.digest
            );
            const existing = this.persistence.findDelivery(transaction, envelope.reservation.id);
            if (existing !== undefined) {
                const stored = this.persistence.findProjectionByReservation(
                    transaction,
                    envelope.reservation.id
                );
                if (
                    stored === undefined ||
                    !equalBytes(
                        RouteProjection.codec.encode(stored),
                        RouteProjection.codec.encode(projectedRecord)
                    )
                ) {
                    throw new AgentCoreError(
                        "protocol.duplicate",
                        "Route retry conflicts with the admitted authenticated projection"
                    );
                }
                const retained = this.persistence.listRetentionsFor(
                    transaction,
                    RetainedRecordKind.routeProjection(),
                    stored.id.value
                );
                if (!retained.some((reference) => reference.id.equals(input.retention.id))) {
                    this.retention.discard(input.retention);
                }
                return existing;
            }
            if (!this.retention.verify(transaction, input.retention)) {
                throw invalidState("Target projection retention is not durable");
            }
            if (
                !input.retention.actor.equals(this.actor) ||
                !input.retention.tenant.equals(targetTenant(envelope.reservation.tenants)) ||
                !input.retention.recordKind.equals(RetainedRecordKind.routeProjection()) ||
                input.retention.record.value !== envelope.projection.id.value
            ) {
                throw invalidState(
                    "Target projection retention belongs to another Actor or record"
                );
            }
            const bridgeAudit = this.ids.projectionAudit();
            const deliveryAudit = this.ids.deliveryAudit();
            this.audit.appendProjectionRoot(transaction, authenticatedProjection, bridgeAudit);
            const persistedProjection = this.persistence.appendProjection(
                transaction,
                authenticatedProjection,
                input.retention
            );

            const authority = this.authority.authorize(transaction, authenticatedProjection);
            const invocation =
                authority.kind === "accepted"
                    ? this.invocations.admit(transaction, {
                          reservation: envelope.reservation,
                          projection: persistedProjection,
                          bridgeAudit
                      })
                    : authority;
            if (
                invocation.kind === "accepted" &&
                (!("invocation" in invocation) ||
                    !(invocation.invocation instanceof InvocationId) ||
                    !invocation.invocation.equals(envelope.reservation.invocation))
            ) {
                throw invalidState(
                    "Invocation admission substituted the stable route Invocation ID"
                );
            }
            const delivery = deliveryFromDecision(persistedProjection, invocation, deliveryAudit);
            this.audit.appendDelivery(transaction, delivery, bridgeAudit, deliveryAudit);
            this.persistence.appendDelivery(transaction, delivery);
            return delivery;
        } catch (error) {
            this.retention.discard(input.retention);
            throw error;
        }
    }
}

export function createTargetProjectionProtocolCommand<Transaction, Read>(
    protocol: TargetProjectionProtocol<Transaction>,
    port: TargetProjectionCommandPort<Read>
): ProtocolCommand<Transaction, Read, TargetProjectionAdmission, RouteDelivery, RouteDelivery> {
    return new TargetProjectionProtocolCommand(protocol, port);
}

class TargetProjectionProtocolCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    TargetProjectionAdmission,
    RouteDelivery,
    RouteDelivery
> {
    public readonly command = TARGET_PROJECTION_COMMAND;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision: ExpectedRevisionPolicy;
    public readonly lease: LeaseTokenPolicy;
    public readonly payload: CommandPayloadCodec<TargetProjectionAdmission>;
    public readonly replyCodec: ProtocolValueCodec<RouteDelivery>;
    public readonly observationCodec: ProtocolValueCodec<RouteDelivery>;

    public constructor(
        private readonly protocol: TargetProjectionProtocol<Transaction>,
        private readonly port: TargetProjectionCommandPort<Read>
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
        admission: TargetProjectionAdmission
    ): boolean {
        return this.port.authorize(read, envelope, admission);
    }

    public permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission
    ): boolean {
        return this.port.permitsLifecycle(read, envelope, admission);
    }

    public currentRevision(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission
    ): Revision | undefined {
        return this.port.currentRevision(read, envelope, admission);
    }

    public currentLease(
        read: Read,
        envelope: CommandEnvelope,
        admission: TargetProjectionAdmission,
        at: Date
    ): CurrentLease | undefined {
        return this.port.currentLease(read, envelope, admission, at);
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        admission: TargetProjectionAdmission,
        _at: Date
    ): ProtocolCommandExecution<RouteDelivery, RouteDelivery> {
        const result = this.protocol.admit(transaction, admission);
        return { reply: result, observation: result };
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    );
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function targetTenant(
    tenants: AuthenticatedRouteProjection["envelope"]["reservation"]["tenants"]
): ContentRetentionReference["tenant"] {
    return tenants.kind === "same" ? tenants.tenant : tenants.target;
}

function deliveryFromDecision(
    projection: RouteProjection,
    decision: TargetAuthorityDecision | InvocationAdmissionDecision,
    audit: ReturnType<InteractionIdPort["deliveryAudit"]>
): RouteDelivery {
    return decision.kind === "accepted"
        ? new RouteDelivery({
              reservation: projection.reservation,
              state: RouteDeliveryState.delivered(),
              targetAudit: audit
          })
        : new RouteDelivery({
              reservation: projection.reservation,
              state: RouteDeliveryState.rejected(decision.reason),
              targetAudit: audit
          });
}
