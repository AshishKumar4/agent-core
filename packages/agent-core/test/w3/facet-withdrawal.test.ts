import { describe, expect, test } from "vitest";
import { AuditRecordId } from "../../src/interaction-references";
import { FacetRef, MemoryWorkspaceSlotStore, SlotName } from "../../src/facets";
import { WorkspaceId } from "../../src/identity";
import { AgentCoreError } from "../../src/errors";
import { FacetActivation, FacetWithdrawal } from "../../src/composition";
import {
    MemoryWorkspaceRecords,
    RouteDeliveryState,
    WITHDRAWN_TARGET_REASON,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort
} from "../../src/workspaces";
import {
    authenticatedProjectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant
} from "../workspaces/fixtures";
import { attribution, contribute, declarerSlot, entry } from "./slot-store-contract";
import { activationFacet } from "./facet-activation-fixture";

class DurableRetention implements ContentRetentionPort<MemoryWorkspaceRecords> {
    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(): void {}
}

class CountingAudits {
    #next = 0;

    public deliveryAudit(): AuditRecordId {
        this.#next += 1;
        return new AuditRecordId(`audit-withdrawal-${this.#next}`);
    }
}

describe("Facet withdrawal across owning Actors", () => {
    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires a contributed Subscription and drives its unprepared reservation to a terminal rejected delivery",
        { tags: "p0" },
        () => {
            const harness = routingHarness();
            const contributed = subscriptionFixture("withdrawn", {
                contribution: attribution("workspace:withdrawn")
            });
            const retained = subscriptionFixture("retained", {
                contribution: attribution("workspace:retained")
            });
            harness.persistence.saveSubscription(harness.records, contributed, undefined);
            harness.persistence.saveSubscription(harness.records, retained, undefined);
            const pending = reservationFixture("withdrawn");
            harness.persistence.appendReservation(
                harness.records,
                pending,
                reservationRetention(pending)
            );
            expect(harness.persistence.findDelivery(harness.records, pending.id)).toBeUndefined();

            const result = harness.routing.retire(
                harness.records,
                new FacetRef("workspace:withdrawn")
            );

            expect(result.subscriptions.map((id) => id.value)).toEqual(["subscription-withdrawn"]);
            expect(result.rejected.map((id) => id.value)).toEqual(["reservation-withdrawn"]);
            const delivery = harness.persistence.findDelivery(harness.records, pending.id);
            expect(delivery?.state.kind).toBe("rejected");
            expect(delivery?.state.reason).toBe(WITHDRAWN_TARGET_REASON);
            expect(
                harness.persistence
                    .listSubscriptions(harness.records)
                    .map((subscription) => subscription.id.value)
            ).toEqual(["subscription-retained"]);
            expect(
                harness.persistence.currentSubscription(harness.records, contributed.id)?.retired
            ).toBe(true);
        }
    );

    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses every later revision that rewrites, adds, or drops a Subscription's attribution",
        { tags: "p0" },
        () => {
            const harness = routingHarness();
            const contributed = subscriptionFixture("immutable", {
                contribution: attribution("workspace:owner")
            });
            harness.persistence.saveSubscription(harness.records, contributed, undefined);

            const rewritten = contributed.revise({
                source: contributed.source,
                target: contributed.target,
                mapping: contributed.mapping,
                dedupe: contributed.dedupe,
                authority: contributed.authority,
                contribution: attribution("workspace:other")
            });
            expect(() =>
                harness.persistence.saveSubscription(
                    harness.records,
                    rewritten,
                    contributed.revision
                )
            ).toThrow(/attribution is immutable/);

            const dropped = contributed.revise({
                source: contributed.source,
                target: contributed.target,
                mapping: contributed.mapping,
                dedupe: contributed.dedupe,
                authority: contributed.authority
            });
            expect(() =>
                harness.persistence.saveSubscription(harness.records, dropped, contributed.revision)
            ).toThrow(/attribution is immutable/);

            const unattributed = subscriptionFixture("unattributed");
            harness.persistence.saveSubscription(harness.records, unattributed, undefined);
            const backfilled = unattributed.revise({
                source: unattributed.source,
                target: unattributed.target,
                mapping: unattributed.mapping,
                dedupe: unattributed.dedupe,
                authority: unattributed.authority,
                contribution: attribution("workspace:owner")
            });
            expect(() =>
                harness.persistence.saveSubscription(
                    harness.records,
                    backfilled,
                    unattributed.revision
                )
            ).toThrow(/attribution is immutable/);

            // An unattributed Subscription is nobody's contribution, so no withdrawal names it.
            expect(() => unattributed.retire()).toThrow(/Only a contributed Subscription/);
            expect(
                harness.routing.retire(harness.records, new FacetRef("workspace:owner"))
                    .subscriptions
            ).toHaveLength(1);
            expect(
                harness.persistence.currentSubscription(harness.records, unattributed.id)?.retired
            ).toBeUndefined();
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] leaves a reservation that reached preparation to drain as an Invocation item",
        { tags: "p0" },
        () => {
            const harness = routingHarness(targetActor);
            const contributed = subscriptionFixture("prepared", {
                contribution: attribution("workspace:withdrawn")
            });
            harness.persistence.saveSubscription(harness.records, contributed, undefined);
            const prepared = reservationFixture("prepared");
            harness.persistence.appendReservation(
                harness.records,
                prepared,
                reservationRetention(prepared, undefined, targetActor)
            );
            const projection = authenticatedProjectionFixture(prepared);
            harness.persistence.appendProjection(
                harness.records,
                projection,
                projectionRetention(projection.envelope.projection)
            );

            const result = harness.routing.retire(
                harness.records,
                new FacetRef("workspace:withdrawn")
            );

            expect(result.rejected).toEqual([]);
            expect(harness.persistence.findDelivery(harness.records, prepared.id)).toBeUndefined();
            expect(() =>
                harness.persistence.appendWithdrawalRejection(
                    harness.records,
                    prepared,
                    new AuditRecordId("audit-forced"),
                    WITHDRAWN_TARGET_REASON
                )
            ).toThrow(/drains as an Invocation item/);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] never rejects a reservation whose Subscription is still live",
        { tags: "p0" },
        () => {
            const harness = routingHarness();
            const live = subscriptionFixture("live", {
                contribution: attribution("workspace:retained")
            });
            harness.persistence.saveSubscription(harness.records, live, undefined);
            const reservation = reservationFixture("live");
            harness.persistence.appendReservation(
                harness.records,
                reservation,
                reservationRetention(reservation)
            );

            expect(() =>
                harness.persistence.appendWithdrawalRejection(
                    harness.records,
                    reservation,
                    new AuditRecordId("audit-live"),
                    WITHDRAWN_TARGET_REASON
                )
            ).toThrow(/retired Subscription/);
            expect(
                harness.persistence.findDelivery(harness.records, reservation.id)
            ).toBeUndefined();
            expect(RouteDeliveryState.rejected(WITHDRAWN_TARGET_REASON).kind).toBe("rejected");
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires both planes for one Facet and leaves every other Facet's record byte-identical",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawnEntry = entry("workspace:withdrawn", 1, { title: "Withdrawn" });
            const retainedEntry = entry("workspace:retained", 2, { title: "Retained" });
            contribute(harness.slots, withdrawnEntry);
            contribute(harness.slots, retainedEntry);
            harness.persistence.saveSubscription(
                harness.records,
                subscriptionFixture("cross-withdrawn", {
                    contribution: attribution("workspace:withdrawn")
                }),
                undefined
            );
            harness.persistence.saveSubscription(
                harness.records,
                subscriptionFixture("cross-retained", {
                    contribution: attribution("workspace:retained")
                }),
                undefined
            );

            const result = harness.withdrawal.withdraw(new FacetRef("workspace:withdrawn"));

            expect(result.slots.entries.map((id) => id.value)).toEqual([withdrawnEntry.id.value]);
            expect(result.routing.subscriptions.map((id) => id.value)).toEqual([
                "subscription-cross-withdrawn"
            ]);
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toHaveLength(1);
            expect(
                harness.slots
                    .entries(new SlotName("dashboard.card"))[0]
                    ?.id.equals(retainedEntry.id)
            ).toBe(true);
            expect(
                harness.persistence
                    .listSubscriptions(harness.records)
                    .map((subscription) => subscription.id.value)
            ).toEqual(["subscription-cross-retained"]);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] refuses the whole withdrawal when a plane cannot answer the attribution query",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawnEntry = entry("workspace:withdrawn", 1, { title: "Withdrawn" });
            contribute(harness.slots, withdrawnEntry);
            harness.routingFails = true;

            expect(() => harness.withdrawal.withdraw(new FacetRef("workspace:withdrawn"))).toThrow(
                /not computable from the routing plane/
            );
            // No plane was written, so the slot record the set named is still present.
            expect(
                harness.slots.transaction((transaction) =>
                    harness.slots.loadEntry(transaction, withdrawnEntry.id)
                )
            ).toBeDefined();
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] carries a non-Error refusal from a plane into the reason it reports",
        { tags: "p2" },
        () => {
            // A control transaction that rejects with something other than an Error still has
            // to name why the set is incomputable, so the raised value is reported as text
            // rather than swallowed into an empty reason.
            const harness = crossPlaneHarness();
            contribute(harness.slots, entry("workspace:withdrawn", 1, { title: "Withdrawn" }));
            harness.routingFails = true;
            harness.routingFailure = "routing Actor rejected without an Error";

            expect(() => harness.withdrawal.plan(new FacetRef("workspace:withdrawn"))).toThrow(
                new AgentCoreError(
                    "protocol.invalid-state",
                    "Withdrawal set is not computable from the routing plane: routing Actor rejected without an Error"
                )
            );
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] refuses before writing any plane when the set holds a Slot a retained Facet still contributes to",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const declarerEntry = entry("workspace:declarer", 0, { title: "Own" });
            const retainedEntry = entry("workspace:retained", 1, { title: "Retained" });
            contribute(harness.slots, declarerEntry);
            contribute(harness.slots, retainedEntry);
            harness.persistence.saveSubscription(
                harness.records,
                subscriptionFixture("refused", {
                    contribution: attribution("workspace:declarer")
                }),
                undefined
            );

            expect(() => harness.withdrawal.withdraw(new FacetRef("workspace:declarer"))).toThrow(
                /still contributes/
            );

            expect(harness.slots.entries(new SlotName("dashboard.card"))).toHaveLength(2);
            expect(
                harness.persistence
                    .listSubscriptions(harness.records)
                    .map((subscription) => subscription.id.value)
            ).toEqual(["subscription-refused"]);
        }
    );
});

describe("Facet activation atomicity", () => {
    test(
        "[C13-FACET-START-ATOMIC] leaves nothing behind when start does not complete",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const activation = new FacetActivation(harness.withdrawal);
            const contributor = attribution("workspace:partial");
            const before = harness.slots.entries(new SlotName("dashboard.card"));
            const facet = activationFacet(contributor.contributor, () => {
                // A partial activation: two committed contributions, then a failure.
                contribute(harness.slots, entry("workspace:partial", 1, { title: "One" }));
                harness.persistence.saveSubscription(
                    harness.records,
                    subscriptionFixture("partial", { contribution: contributor }),
                    undefined
                );
                throw new TypeError("start failed after materializing");
            });

            const outcome = await activation.activate(facet, contributor, {
                signal: new AbortController().signal
            });

            expect(outcome).toEqual({
                kind: "failed",
                facet: contributor.contributor,
                reason: "start failed after materializing"
            });
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toEqual(before);
            expect(harness.persistence.listSubscriptions(harness.records)).toEqual([]);
            expect(
                harness.slots.transaction((transaction) =>
                    harness.slots.withdrawalSet(transaction, contributor.contributor)
                ).entries
            ).toEqual([]);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] records a non-Error start rejection as the failed install's reason",
        { tags: "p2" },
        async () => {
            // The outcome is the record of the install, so a Facet that rejects with a value
            // that is not an Error still has to say what it rejected with.
            const harness = crossPlaneHarness();
            const activation = new FacetActivation(harness.withdrawal);
            const contributor = attribution("workspace:non-error");
            const facet = activationFacet(contributor.contributor, () => {
                contribute(harness.slots, entry("workspace:non-error", 1, { title: "One" }));
                throw "start rejected without an Error";
            });

            const outcome = await activation.activate(facet, contributor, {
                signal: new AbortController().signal
            });

            expect(outcome).toEqual({
                kind: "failed",
                facet: contributor.contributor,
                reason: "start rejected without an Error"
            });
            expect(
                harness.slots.transaction((transaction) =>
                    harness.slots.withdrawalSet(transaction, contributor.contributor)
                ).entries
            ).toEqual([]);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses a retry against a Scope whose prior partial effect was not retired",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const activation = new FacetActivation(harness.withdrawal);
            const contributor = attribution("workspace:partial");
            contribute(harness.slots, entry("workspace:partial", 1, { title: "Stranded" }));
            const facet = activationFacet(contributor.contributor, () => undefined);

            await expect(
                activation.activate(facet, contributor, { signal: new AbortController().signal })
            ).rejects.toThrow(/still holds materialized contributions/);

            // A Facet whose activation was refused obstructs no other Facet's activation.
            const other = attribution("workspace:other");
            const outcome = await activation.activate(
                activationFacet(other.contributor, () => undefined),
                other,
                { signal: new AbortController().signal }
            );
            expect(outcome.kind).toBe("active");
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses an activation whose attribution names another Facet",
        { tags: "p1" },
        async () => {
            const harness = crossPlaneHarness();
            const activation = new FacetActivation(harness.withdrawal);
            await expect(
                activation.activate(
                    activationFacet(new FacetRef("workspace:one"), () => undefined),
                    attribution("workspace:two"),
                    { signal: new AbortController().signal }
                )
            ).rejects.toThrow(/names another Facet/);
        }
    );
});

interface RoutingHarness {
    readonly records: MemoryWorkspaceRecords;
    readonly persistence: WorkspacePersistence<MemoryWorkspaceRecords>;
    readonly routing: WorkspaceRoutingWithdrawal<MemoryWorkspaceRecords>;
}

function routingHarness(actor = sourceActor): RoutingHarness {
    const records = new MemoryWorkspaceRecords();
    const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (state) => state,
        new DurableRetention(),
        actor,
        tenant
    );
    return {
        records,
        persistence,
        routing: new WorkspaceRoutingWithdrawal(persistence, new CountingAudits())
    };
}

type SlotTransaction = Parameters<Parameters<MemoryWorkspaceSlotStore["transaction"]>[0]>[0];

interface CrossPlaneHarness {
    readonly records: MemoryWorkspaceRecords;
    readonly persistence: WorkspacePersistence<MemoryWorkspaceRecords>;
    readonly slots: MemoryWorkspaceSlotStore;
    readonly withdrawal: FacetWithdrawal<SlotTransaction, MemoryWorkspaceRecords>;
    routingFails: boolean;
    /** What the routing Actor's control transaction raises when it fails. */
    routingFailure: unknown;
}

function crossPlaneHarness(): CrossPlaneHarness {
    const routing = routingHarness();
    const slots = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
    slots.install(declarerSlot("dashboard.card"));
    const harness: CrossPlaneHarness = {
        records: routing.records,
        persistence: routing.persistence,
        slots,
        withdrawal: new FacetWithdrawal(slots, routing.routing, (operation) => {
            if (harness.routingFails) throw harness.routingFailure;
            return operation(routing.records);
        }),
        routingFails: false,
        routingFailure: new TypeError("routing Actor is unreachable")
    };
    return harness;
}
