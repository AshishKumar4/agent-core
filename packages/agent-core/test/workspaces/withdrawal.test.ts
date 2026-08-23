import { describe, expect, test } from "vitest";
import { SemVer } from "../../src/core";
import { PackagePin } from "../../src/definition-references";
import { ContributionAttribution } from "../../src/facets";
import { AuditRecordId } from "../../src/interaction-references";
import {
    MemoryWorkspaceRecords,
    WITHDRAWN_TARGET_REASON,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort
} from "../../src/workspaces";
import {
    contributionAttributionFixture,
    authenticatedProjectionFixture,
    deliveryFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    materializeAttributedSubscription,
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
            const withdrawn = contributionAttributionFixture("workspace:withdrawn");

            // swept qualifies; settled is already terminal; prepared drains as an Invocation
            for (const suffix of ["swept", "settled", "prepared"]) {
                materializeAttributedSubscription(
                    harness.source,
                    harness.records,
                    withdrawn,
                    subscriptionFixture(suffix)
                );
            }
            const foreignSubscription = materializeAttributedSubscription(
                harness.source,
                harness.records,
                contributionAttributionFixture("workspace:other"),
                subscriptionFixture("foreign")
            );

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
            const contributed = materializeAttributedSubscription(
                harness.source,
                harness.records,
                contributionAttributionFixture("workspace:owner"),
                subscriptionFixture("untouched")
            );
            const reservation = reservationFixture("untouched");
            harness.source.appendReservation(
                harness.records,
                reservation,
                reservationRetention(reservation)
            );

            const stranger = contributionAttributionFixture("workspace:stranger");
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
            const owner = contributionAttributionFixture("workspace:owner");
            const contributed = materializeAttributedSubscription(
                harness.source,
                harness.records,
                owner,
                subscriptionFixture("member")
            );
            const direct = subscriptionFixture("nonmember");
            harness.source.saveSubscription(harness.records, direct, undefined);

            // Presence of the attribution is the membership test, so the caller-created
            // route answers to its contributor and to every other Facet the same way.
            expect(
                harness.routing
                    .contributed(harness.records, owner)
                    .map((subscription) => subscription.id.value)
            ).toEqual([contributed.id.value]);
            for (const attribution of [
                owner,
                contributionAttributionFixture("workspace:other")
            ]) {
                expect(
                    harness.routing
                        .contributed(harness.records, attribution)
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

    test(
        "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] [C13-FACET-WITHDRAWAL-EXACT] same-Facet releases withdraw independently and replay idempotently",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const releaseA = releaseAttribution("workspace:dual", "1.0.0");
            const releaseB = releaseAttribution("workspace:dual", "2.0.0");
            const wrongRelease = releaseAttribution("workspace:dual", "9.9.9");
            const subscriptionA = materializeAttributedSubscription(
                harness.source,
                harness.records,
                releaseA,
                subscriptionFixture("pin-a")
            );
            const subscriptionB = materializeAttributedSubscription(
                harness.source,
                harness.records,
                releaseB,
                subscriptionFixture("pin-b")
            );
            const direct = subscriptionFixture("direct");
            harness.source.saveSubscription(harness.records, direct, undefined);
            const reservationA = reservationFixture("pin-a");
            const reservationB = reservationFixture("pin-b");
            for (const reservation of [reservationA, reservationB]) {
                harness.source.appendReservation(
                    harness.records,
                    reservation,
                    reservationRetention(reservation)
                );
            }

            expect(
                harness.routing
                    .contributed(harness.records, releaseA)
                    .map((subscription) => subscription.id.value)
            ).toEqual([subscriptionA.id.value]);
            expect(
                harness.routing
                    .contributed(harness.records, releaseB)
                    .map((subscription) => subscription.id.value)
            ).toEqual([subscriptionB.id.value]);
            expect(harness.routing.retire(harness.records, wrongRelease)).toEqual({
                subscriptions: [],
                rejected: []
            });

            const result = harness.routing.retire(harness.records, releaseA);

            expect(result.subscriptions.map((id) => id.value)).toEqual([subscriptionA.id.value]);
            expect(result.rejected.map((id) => id.value)).toEqual([reservationA.id.value]);
            expect(
                harness.source.currentSubscription(harness.records, subscriptionA.id)?.retired
            ).toBe(true);
            expect(
                harness.source.currentSubscription(harness.records, subscriptionB.id)?.retired
            ).toBeUndefined();
            expect(
                harness.source.currentSubscription(harness.records, direct.id)?.retired
            ).toBeUndefined();
            expect(harness.source.findDelivery(harness.records, reservationA.id)?.state.kind).toBe(
                "rejected"
            );
            expect(harness.source.findDelivery(harness.records, reservationB.id)).toBeUndefined();

            expect(harness.routing.retire(harness.records, releaseA)).toEqual({
                subscriptions: [],
                rejected: []
            });
            expect(
                harness.source.currentSubscription(harness.records, subscriptionB.id)?.retired
            ).toBeUndefined();
        }
    );
});

function releaseAttribution(facet: string, version: string): ContributionAttribution {
    const baseline = contributionAttributionFixture(facet);
    return new ContributionAttribution(
        baseline.contributor,
        new PackagePin(
            baseline.package.id,
            new SemVer(version),
            baseline.package.manifestDigest,
            baseline.package.codeDigest
        )
    );
}
