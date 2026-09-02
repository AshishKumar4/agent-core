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
import { WITHDRAWN_TARGET_REASON } from "./withdrawal";

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
            const stopped = this.withdrawnTarget(transaction, envelope.reservation);
            const invocation =
                stopped ??
                (authority.kind === "accepted"
                    ? this.invocations.admit(transaction, {
                          reservation: envelope.reservation,
                          projection: persistedProjection,
                          bridgeAudit
                      })
                    : authority);
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

    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the durable admission stop of a withdrawn
     * contribution. The transaction that begins a withdrawal retires the Subscriptions the
     * Facet's `commands` and `automations` contributions materialized and freezes its drain
     * set in one Workspace-owned capture, so the set is finite at that transaction. A
     * projection presented afterwards — a reservation the source appended against a view it
     * had already lost, or an at-least-once retry of one — is refused by reading that
     * capture rather than admitted as a new Invocation item, which is what keeps the frozen
     * set from growing across a restart. The reservation then takes the terminal rejected
     * RouteDelivery the withdrawal set requires instead of resolving an unresolvable target.
     *
     * A Subscription no Facet contributed is nobody's withdrawal set (§4.2), so it is
     * admitted on its own terms.
     */
    private withdrawnTarget(
        transaction: Transaction,
        reservation: AuthenticatedRouteProjection["envelope"]["reservation"]
    ): InvocationAdmissionDecision | undefined {
        const contribution = this.persistence.currentSubscription(
            transaction,
            reservation.subscription
        )?.contribution;
        if (
            contribution === undefined ||
            this.persistence.findWithdrawalDrain(transaction, contribution) === undefined
        ) {
            return undefined;
        }
        return { kind: "rejected", reason: WITHDRAWN_TARGET_REASON };
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
        return { outcome: "committed", reply: result, observation: result };
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
