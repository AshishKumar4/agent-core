import { AgentCoreError } from "../errors";
import type {
    ContributionAttribution,
    Facet,
    FacetLifecycleContext,
    FacetRef,
    SlotWithdrawalSet,
    WorkspaceSlotStore
} from "../facets";
import type { RoutingWithdrawal, WorkspaceRoutingWithdrawal } from "../workspaces";

/** Runs one control transaction of an owning Actor other than the Slot Actor. */
export interface ControlTransaction<Transaction> {
    <Result>(operation: (transaction: Transaction) => Result): Result;
}

export interface FacetWithdrawalPlan {
    readonly attribution: ContributionAttribution;
    readonly slots: SlotWithdrawalSet;
    readonly subscriptions: number;
}

export interface FacetWithdrawalResult {
    readonly attribution: ContributionAttribution;
    readonly slots: SlotWithdrawalSet;
    readonly routing: RoutingWithdrawal;
}

/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the `administer`-impact retirement of one
 * contribution's records, named by its complete `ContributionAttribution` — the FacetRef
 * and the PackagePin it was read from — computed by querying attribution and applied in one
 * control transaction per owning Actor. Another release of the same Facet is a different
 * contribution and keeps every record this withdrawal does not name.
 *
 * The set is computed across every plane before any of them is written. A plane that cannot
 * answer the attribution query makes the set incomputable, and the whole withdrawal is
 * refused rather than performed in part; so is a set whose Slot declaration still carries a
 * retained contribution's entry.
 */
export class FacetWithdrawal<SlotTransaction, RouteTransaction> {
    public constructor(
        private readonly slots: WorkspaceSlotStore<SlotTransaction>,
        private readonly routing: WorkspaceRoutingWithdrawal<RouteTransaction>,
        private readonly routingTransaction: ControlTransaction<RouteTransaction>
    ) {}

    public plan(attribution: ContributionAttribution): FacetWithdrawalPlan {
        const slots = this.compute(
            () =>
                this.slots.transaction((transaction) => {
                    const set = this.slots.withdrawalSet(transaction, attribution);
                    this.slots.requireWithdrawable(transaction, set);
                    return set;
                }),
            "slot"
        );
        const subscriptions = this.compute(
            () =>
                this.routingTransaction(
                    (transaction) => this.routing.contributed(transaction, attribution).length
                ),
            "routing"
        );
        return Object.freeze({ attribution, slots, subscriptions });
    }

    public withdraw(attribution: ContributionAttribution): FacetWithdrawalResult {
        const planned = this.plan(attribution);
        const routing = this.routingTransaction((transaction) =>
            this.routing.retire(transaction, attribution)
        );
        this.slots.withdraw(attribution);
        return Object.freeze({ attribution, slots: planned.slots, routing });
    }

    private compute<Result>(query: () => Result, plane: string): Result {
        try {
            return query();
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Withdrawal set is not computable from the ${plane} plane: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

export type FacetActivationOutcome =
    | { readonly kind: "active"; readonly facet: FacetRef }
    | { readonly kind: "failed"; readonly facet: FacetRef; readonly reason: string };

/**
 * SPEC §4.1 (C13-FACET-START-ATOMIC): activation is all-or-nothing at the Scope's records.
 * A Facet whose `start` does not complete contributes nothing, because the host retires
 * whatever the partial activation materialized through the same attributed withdrawal set a
 * withdrawal computes, and records the outcome as a typed failed install rather than as a
 * live Facet.
 */
export class FacetActivation<SlotTransaction, RouteTransaction> {
    public constructor(
        private readonly withdrawal: FacetWithdrawal<SlotTransaction, RouteTransaction>
    ) {}

    public async activate(
        facet: Facet,
        attribution: ContributionAttribution,
        context: FacetLifecycleContext
    ): Promise<FacetActivationOutcome> {
        const contributor = attribution.contributor;
        if (!facet.ref.equals(contributor)) {
            throw new AgentCoreError(
                "authority.denied",
                "Facet activation attribution names another Facet"
            );
        }
        // A retry against a Scope whose prior partial effect was never retired would compose
        // against state no Blueprint declares, so it is refused rather than repeated.
        const before = this.withdrawal.plan(attribution);
        if (before.slots.slots.length > 0 || before.slots.entries.length > 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Facet ${contributor.value} still holds materialized contributions; retire them before activating`
            );
        }
        try {
            await facet.start(context);
        } catch (error) {
            this.withdrawal.withdraw(attribution);
            return Object.freeze({
                kind: "failed",
                facet: contributor,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
        return Object.freeze({ kind: "active", facet: contributor });
    }
}
