import type { ContributionAttribution } from "../facets";
import type { AuditRecordId, RouteReservationId, SubscriptionId } from "../interaction-references";
import type { WorkspacePersistence } from "./persistence";
import type { Subscription } from "./subscription";

/** The routing records one withdrawal retired, and the reservations it terminated. */
export interface RoutingWithdrawal {
    readonly subscriptions: readonly SubscriptionId[];
    readonly rejected: readonly RouteReservationId[];
}

/** Mints the audit identity the owning Actor writes each terminal rejection under. */
export interface RoutingWithdrawalAuditPort {
    deliveryAudit(): AuditRecordId;
}

export const WITHDRAWN_TARGET_REASON = "facet-withdrawn";

/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the routing Actor's half of a withdrawal. It
 * retires the Subscriptions the named `ContributionAttribution` — the exact FacetRef and
 * PackagePin pair — materialized, so no further reservation is appended against an
 * unresolvable target, and it admits every reservation already appended and not yet
 * prepared to a terminal rejected RouteDelivery. A reservation that reached preparation is
 * left alone: it drains as an Invocation item under C13-FACET-WITHDRAWAL-DRAIN. Another
 * release of the same Facet is a different contribution and owns a different withdrawal.
 */
export class WorkspaceRoutingWithdrawal<Transaction> {
    public constructor(
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly audits: RoutingWithdrawalAuditPort
    ) {}

    public contributed(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly Subscription[] {
        return this.persistence.listContributedSubscriptions(transaction, attribution);
    }

    public retire(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): RoutingWithdrawal {
        const contributed = this.contributed(transaction, attribution);
        const retired = new Set(contributed.map((subscription) => subscription.id.value));
        for (const subscription of contributed) {
            this.persistence.retireSubscription(transaction, subscription);
        }
        const rejected: RouteReservationId[] = [];
        for (const reservation of this.persistence.listReservations(transaction)) {
            if (!retired.has(reservation.subscription.value)) continue;
            if (this.persistence.findDelivery(transaction, reservation.id) !== undefined) continue;
            if (
                this.persistence.findProjectionByReservation(transaction, reservation.id) !==
                undefined
            ) {
                continue;
            }
            this.persistence.appendWithdrawalRejection(
                transaction,
                reservation,
                this.audits.deliveryAudit(),
                WITHDRAWN_TARGET_REASON
            );
            rejected.push(reservation.id);
        }
        return Object.freeze({
            subscriptions: Object.freeze(contributed.map((subscription) => subscription.id)),
            rejected: Object.freeze(rejected)
        });
    }
}
