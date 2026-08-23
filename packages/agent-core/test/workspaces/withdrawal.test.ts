import { describe, expect, test } from "vitest";
import { FacetRef } from "../../src/facets";
import { AuditRecordId } from "../../src/interaction-references";
import {
    MemoryWorkspaceRecords,
    WITHDRAWN_TARGET_REASON,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort
} from "../../src/workspaces";
import { attribution } from "../w3/slot-store-contract";
import {
    authenticatedProjectionFixture,
    deliveryFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant
} from "./fixtures";

class DurableRetention implements ContentRetentionPort<MemoryWorkspaceRecords> {
    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(): void {}
}

class SequentialAudits {
    #next = 0;

    public deliveryAudit(): AuditRecordId {
        this.#next += 1;
        return new AuditRecordId(`audit-sweep-${this.#next}`);
    }
}

interface SweepHarness {
    readonly records: MemoryWorkspaceRecords;
    /** The reservation-owning Actor: it appends reservations and the withdrawal's rejections. */
    readonly source: WorkspacePersistence<MemoryWorkspaceRecords>;
    /** The invoked Actor: only it may append an authenticated projection or a delivery. */
    readonly target: WorkspacePersistence<MemoryWorkspaceRecords>;
    readonly routing: WorkspaceRoutingWithdrawal<MemoryWorkspaceRecords>;
}

function sweepHarness(): SweepHarness {
    const source = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (state) => state,
        new DurableRetention(),
        sourceActor,
        tenant
    );
    return {
        records: new MemoryWorkspaceRecords(),
        source,
        target: new WorkspacePersistence<MemoryWorkspaceRecords>(
            (state) => state,
            new DurableRetention(),
            targetActor,
            tenant
        ),
        routing: new WorkspaceRoutingWithdrawal(source, new SequentialAudits())
    };
}

describe("routing withdrawal sweep", () => {
    test(
        "[C13-FACET-WITHDRAWAL-EXACT] the sweep rejects only the withdrawn Facet's own reservations that never reached preparation",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const withdrawn = new FacetRef("workspace:withdrawn");

            // swept qualifies; settled is already terminal; prepared drains as an Invocation
            // item; foreign belongs to another Facet, so it is outside this withdrawal set.
            for (const suffix of ["swept", "settled", "prepared"]) {
                harness.source.saveSubscription(
                    harness.records,
                    subscriptionFixture(suffix, { contribution: attribution(withdrawn.value) }),
                    undefined
                );
            }
            const foreignSubscription = subscriptionFixture("foreign", {
                contribution: attribution("workspace:other")
            });
            harness.source.saveSubscription(harness.records, foreignSubscription, undefined);

            const swept = reservationFixture("swept");
            const settled = reservationFixture("settled");
            const prepared = reservationFixture("prepared");
            const foreign = reservationFixture("foreign");
            for (const reservation of [swept, settled, prepared, foreign]) {
                harness.source.appendReservation(
                    harness.records,
                    reservation,
                    reservationRetention(reservation)
                );
            }
            for (const reservation of [settled, prepared]) {
                const projection = authenticatedProjectionFixture(reservation);
                harness.target.appendProjection(
                    harness.records,
                    projection,
                    projectionRetention(projection.envelope.projection)
                );
            }
            harness.target.appendDelivery(harness.records, deliveryFixture(settled));

            const result = harness.routing.retire(harness.records, withdrawn);

            expect(result.subscriptions.map((id) => id.value)).toEqual([
                "subscription-prepared",
                "subscription-settled",
                "subscription-swept"
            ]);
            expect(result.rejected.map((id) => id.value)).toEqual(["reservation-swept"]);

            const rejection = harness.source.findDelivery(harness.records, swept.id);
            expect(rejection?.state.kind).toBe("rejected");
            expect(rejection?.state.reason).toBe(WITHDRAWN_TARGET_REASON);

            // Every reservation the sweep skipped keeps exactly the state it already had.
            expect(harness.source.findDelivery(harness.records, settled.id)?.state.kind).toBe(
                "delivered"
            );
            expect(harness.source.findDelivery(harness.records, prepared.id)).toBeUndefined();
            expect(harness.source.findDelivery(harness.records, foreign.id)).toBeUndefined();
            expect(
                harness.source.currentSubscription(harness.records, foreignSubscription.id)?.retired
            ).toBeUndefined();
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] a Facet that contributed nothing retires nothing and rejects nothing",
        { tags: "p1" },
        () => {
            const harness = sweepHarness();
            const contributed = subscriptionFixture("untouched", {
                contribution: attribution("workspace:owner")
            });
            harness.source.saveSubscription(harness.records, contributed, undefined);
            const reservation = reservationFixture("untouched");
            harness.source.appendReservation(
                harness.records,
                reservation,
                reservationRetention(reservation)
            );

            const stranger = new FacetRef("workspace:stranger");
            expect(harness.routing.contributed(harness.records, stranger)).toEqual([]);

            const result = harness.routing.retire(harness.records, stranger);

            expect(result.subscriptions).toEqual([]);
            expect(result.rejected).toEqual([]);
            expect(harness.source.findDelivery(harness.records, reservation.id)).toBeUndefined();
            expect(
                harness.source.currentSubscription(harness.records, contributed.id)?.retired
            ).toBeUndefined();
        }
    );

    test(
        "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] a Subscription no Facet contributed belongs to no withdrawal set",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const owner = new FacetRef("workspace:owner");
            const contributed = subscriptionFixture("member", {
                contribution: attribution(owner.value)
            });
            const direct = subscriptionFixture("nonmember");
            harness.source.saveSubscription(harness.records, contributed, undefined);
            harness.source.saveSubscription(harness.records, direct, undefined);

            // Presence of the attribution is the membership test, so the caller-created
            // route answers to its contributor and to every other Facet the same way.
            expect(
                harness.routing
                    .contributed(harness.records, owner)
                    .map((subscription) => subscription.id.value)
            ).toEqual([contributed.id.value]);
            for (const facet of [owner, new FacetRef("workspace:other")]) {
                expect(
                    harness.routing
                        .contributed(harness.records, facet)
                        .map((subscription) => subscription.id.value)
                ).not.toContain(direct.id.value);
            }

            const result = harness.routing.retire(harness.records, owner);

            expect(result.subscriptions.map((id) => id.value)).toEqual([contributed.id.value]);
            const untouched = harness.source.currentSubscription(harness.records, direct.id);
            expect(untouched?.retired).toBeUndefined();
            expect(untouched?.revision.value).toBe(0);
        }
    );
});
