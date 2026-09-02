import { describe, expect, test } from "vitest";
import { SemVer } from "../../src/core";
import { PackagePin } from "../../src/definition-references";
import { ContributionAttribution } from "../../src/facets";
import {
    AuditRecordId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import {
    MemoryWorkspaceRecords,
    TargetProjectionProtocol,
    WITHDRAWN_TARGET_REASON,
    WithdrawalDrainCapture,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort,
    type InteractionIdPort,
    type MemoryWorkspaceSnapshot
} from "../../src/workspaces";
import {
    contributionAttributionFixture,
    authenticatedProjectionFixture,
    deliveryFixture,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    materializeAttributedSubscription,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant
} from "./fixtures";
import { malformed } from "../helpers/malformed";

class DurableRetention implements ContentRetentionPort<MemoryWorkspaceRecords> {
    public verify(): boolean {
        return true;
    }

    public retain(): void {}

    public release(): void {}

    public discard(): void {}
}

/** One counter behind every identity the routing surface mints, so ids stay distinguishable. */
class SequentialAudits implements InteractionIdPort {
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
        return new AuditRecordId(this.id("audit-sweep"));
    }

    public logicalDelivery(): string {
        return this.id("delivery");
    }

    private id(prefix: string): string {
        this.#next += 1;
        return `${prefix}-${this.#next}`;
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
            for (const attribution of [owner, contributionAttributionFixture("workspace:other")]) {
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

describe("routing withdrawal against the Actor that owns RouteDelivery", () => {
    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] the target's own admission splits the reservations a withdrawal terminates from the one that drains",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const withdrawn = contributionAttributionFixture("workspace:withdrawn");
            for (const suffix of ["admitted", "unadmitted"]) {
                materializeAttributedSubscription(
                    harness.source,
                    harness.records,
                    withdrawn,
                    subscriptionFixture(suffix)
                );
            }
            const admitted = reservationFixture("admitted");
            const unadmitted = reservationFixture("unadmitted");
            for (const reservation of [admitted, unadmitted]) {
                harness.source.appendReservation(
                    harness.records,
                    reservation,
                    reservationRetention(reservation)
                );
            }
            const target = targetAdmission(harness);

            // The Actor that owns RouteDelivery admits the first reservation itself, so the
            // reservation reaches preparation through its own path rather than a hand-written
            // projection record.
            const delivered = target.protocol.admit(harness.records, {
                projection: authenticatedProjectionFixture(admitted),
                retention: projectionRetention(projectionFixture(admitted), targetActor)
            });
            expect(delivered.state.kind).toBe("delivered");
            expect(target.admissions).toEqual([admitted.invocation.value]);

            const result = harness.routing.retire(harness.records, withdrawn);

            // Exactly the reservation the target never admitted is terminated by the
            // withdrawal; the admitted one keeps the delivery its own Actor wrote and drains
            // as an Invocation item instead.
            expect(result.rejected.map((id) => id.value)).toEqual([unadmitted.id.value]);
            expect(
                harness.source.findDelivery(harness.records, unadmitted.id)?.state
            ).toMatchObject({
                kind: "rejected",
                reason: WITHDRAWN_TARGET_REASON
            });
            expect(harness.source.findDelivery(harness.records, admitted.id)?.state.kind).toBe(
                "delivered"
            );
            expect(() =>
                harness.source.appendWithdrawalRejection(
                    harness.records,
                    admitted,
                    new AuditRecordId("audit-forced"),
                    WITHDRAWN_TARGET_REASON
                )
            ).toThrow(/drains as an Invocation item/);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] a projection presented after the captured withdrawal is refused by the durable capture across a restart",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const withdrawn = contributionAttributionFixture("workspace:withdrawn");
            materializeAttributedSubscription(
                harness.source,
                harness.records,
                withdrawn,
                subscriptionFixture("late")
            );
            harness.routing.retire(harness.records, withdrawn);
            harness.source.captureWithdrawalDrain(
                harness.records,
                new WithdrawalDrainCapture(withdrawn, [new InvocationId("invocation-draining")])
            );
            // A source that had already lost its view of the retired Subscription appends one
            // more reservation, so the withdrawal's own sweep never saw it.
            const late = reservationFixture("late");
            harness.source.appendReservation(harness.records, late, reservationRetention(late));

            // Reopen every Actor-local object over the same durable records: the refusal below
            // can only come from the stored capture.
            const reopened = reopen(harness.records.snapshot());
            const target = targetAdmission(reopened);
            const delivery = target.protocol.admit(reopened.records, {
                projection: authenticatedProjectionFixture(late),
                retention: projectionRetention(projectionFixture(late), targetActor)
            });

            expect(delivery.state).toMatchObject({
                kind: "rejected",
                reason: WITHDRAWN_TARGET_REASON
            });
            // Admission stopped: the Invocation plane was never asked, so the frozen drain set
            // could not grow behind the capture.
            expect(target.admissions).toEqual([]);
            expect(
                reopened.source
                    .findWithdrawalDrain(reopened.records, withdrawn)
                    ?.items.map((item) => item.value)
            ).toEqual(["invocation-draining"]);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] one withdrawal captures one frozen set, and a replay reads it back instead of freezing a later one",
        { tags: "p0" },
        () => {
            const harness = sweepHarness();
            const withdrawn = contributionAttributionFixture("workspace:withdrawn");
            const frozen = harness.source.captureWithdrawalDrain(
                harness.records,
                new WithdrawalDrainCapture(withdrawn, [new InvocationId("invocation-frozen")])
            );

            const replay = harness.source.captureWithdrawalDrain(
                harness.records,
                new WithdrawalDrainCapture(withdrawn, [
                    new InvocationId("invocation-frozen"),
                    new InvocationId("invocation-later")
                ])
            );

            expect(replay.items.map((item) => item.value)).toEqual(["invocation-frozen"]);
            expect(WithdrawalDrainCapture.encode(replay)).toEqual(
                WithdrawalDrainCapture.encode(frozen)
            );
            // Another release of the same Facet is a different contribution, so it owns a
            // different capture rather than joining this one.
            const otherRelease = releaseAttribution(withdrawn.contributor.value, "9.9.9");
            expect(
                harness.source.findWithdrawalDrain(harness.records, otherRelease)
            ).toBeUndefined();
            expect(
                harness.source
                    .listWithdrawalDrains(harness.records, withdrawn.contributor)
                    .map((capture) => capture.items.length)
            ).toEqual([1]);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] a capture that cannot carry its attribution is refused rather than recorded unattributed",
        { tags: "p0" },
        () => {
            // A halved or forged attribution is not a withdrawal key: the record cannot
            // exist without the exact pair the Workspace Actor retired its records under,
            // so a capture the host cannot attribute is refused at construction, and the
            // store never sees it. The items beside it are refused on their own terms too.
            for (const unattributed of [
                malformed<ContributionAttribution>({
                    contributor: "workspace:forged",
                    package: { id: "workspace:forged", version: "1.0.0" }
                }),
                malformed<ContributionAttribution>(null),
                malformed<ContributionAttribution>("workspace:halved")
            ] as const) {
                expect(() => new WithdrawalDrainCapture(unattributed, [])).toThrow(
                    new TypeError("Withdrawal drain capture requires its contribution attribution")
                );
            }
            const withdrawn = contributionAttributionFixture("workspace:withdrawn");
            expect(
                () =>
                    new WithdrawalDrainCapture(withdrawn, [
                        // SAFETY: a plain string is not an InvocationId; the capture must
                        // refuse it rather than freeze it into the drain set.
                        malformed<InvocationId>("not-an-invocation")
                    ])
            ).toThrow(new TypeError("Withdrawal drain capture holds exact InvocationIds"));
            expect(harnessOf(withdrawn).records.listRecords("withdrawalDrainCapture")).toEqual([]);

            function harnessOf(contribution: ContributionAttribution) {
                const store = new MemoryWorkspaceRecords();
                const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
                    (state) => state,
                    new DurableRetention(),
                    sourceActor,
                    tenant
                );
                expect(persistence.findWithdrawalDrain(store, contribution)).toBeUndefined();
                return { records: store, persistence };
            }
        }
    );
});

/** Reopens the Actor-local objects over one durable snapshot: nothing in-memory survives. */
function reopen(snapshot: MemoryWorkspaceSnapshot): SweepHarness {
    const records = new MemoryWorkspaceRecords(snapshot);
    const source = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (state) => state,
        new DurableRetention(),
        sourceActor,
        tenant
    );
    return {
        records,
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

interface TargetAdmissionHarness {
    readonly protocol: TargetProjectionProtocol<MemoryWorkspaceRecords>;
    /** The Invocations the target's own admission port was asked to admit, in order. */
    readonly admissions: readonly string[];
}

/**
 * The invoked Actor's real projection-admission path: it authorizes, admits the Invocation,
 * and writes the RouteDelivery it owns. Only the Invocation plane beyond the admission seam
 * is a reference implementation, so the delivery under test is the one this Actor produced.
 */
function targetAdmission(harness: SweepHarness): TargetAdmissionHarness {
    const admissions: string[] = [];
    const protocol = new TargetProjectionProtocol<MemoryWorkspaceRecords>(
        targetActor,
        harness.target,
        new DurableRetention(),
        { authorize: () => ({ kind: "accepted" }) },
        {
            admit: (_transaction, input) => {
                admissions.push(input.reservation.invocation.value);
                return { kind: "accepted", invocation: input.reservation.invocation };
            }
        },
        {
            appendEvent: () => undefined,
            appendReservation: () => undefined,
            appendProjectionRoot: () => undefined,
            appendDelivery: () => undefined
        },
        new SequentialAudits()
    );
    return { protocol, admissions };
}

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
