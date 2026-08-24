import { describe, expect, test } from "vitest";
import { Digest } from "../../src/core";
import { AuditRecordId } from "../../src/interaction-references";
import {
    FacetRef,
    FacetManifest,
    SlotEntry,
    SlotName,
    type ContributionAttribution,
    type Facet
} from "../../src/facets";
import { ScopeRef, WorkspaceId } from "../../src/identity";
import { AgentCoreError } from "../../src/errors";
import {
    FacetActivation,
    FacetWithdrawal,
    WorkspaceFacetMaterializer
} from "../../src/composition";
import { FacetCorrespondenceValidator, type ValidatedFacetRuntime } from "../../src/operations";
import {
    MemoryWorkspaceRecords,
    RouteDeliveryState,
    WITHDRAWN_TARGET_REASON,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort
} from "../../src/workspaces";
import {
    SqliteWorkspaceRecords,
    SqliteWorkspaceSlotStore,
    type TransactionalSqlite
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    authenticatedProjectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    materializeAttributedSubscription,
    sourceActor,
    subscriptionFixture,
    targetActor,
    TestPackageInstallationProvenance,
    authenticatedInstallationFixture,
    tenant
} from "../workspaces/fixtures";

import { attribution, contribute, declarerSlot, entry } from "./slot-store-contract";
import { activationFacet } from "./facet-activation-fixture";
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

class DurableRetention<Transaction> implements ContentRetentionPort<Transaction> {
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
            const contributed = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:withdrawn"),
                subscriptionFixture("withdrawn")
            );
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:retained"),
                subscriptionFixture("retained")
            );
            const pending = reservationFixture("withdrawn");
            harness.persistence.appendReservation(
                harness.records,
                pending,
                reservationRetention(pending)
            );
            expect(harness.persistence.findDelivery(harness.records, pending.id)).toBeUndefined();

            const result = harness.routing.retire(
                harness.records,
                attribution("workspace:withdrawn")
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
            const contributed = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:owner"),
                subscriptionFixture("immutable")
            );

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
                harness.routing.retire(harness.records, attribution("workspace:owner"))
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
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:withdrawn"),
                subscriptionFixture("prepared")
            );
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
                attribution("workspace:withdrawn")
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
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:retained"),
                subscriptionFixture("live")
            );
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
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:withdrawn"),
                subscriptionFixture("cross-withdrawn")
            );
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:retained"),
                subscriptionFixture("cross-retained")
            );

            const result = harness.withdrawal.withdraw(attribution("workspace:withdrawn"));

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
        "[C13-FACET-WITHDRAWAL-EXACT] withdraws one release across both planes and preserves another release of the same Facet",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const releaseA = attribution("workspace:dual", "1.0.0");
            const releaseB = attribution("workspace:dual", "2.0.0");
            const entryA = new SlotEntry(new SlotName("dashboard.card"), releaseA, 1, {
                title: "Release A"
            });
            const entryB = new SlotEntry(new SlotName("dashboard.card"), releaseB, 2, {
                title: "Release B"
            });
            contribute(harness.slots, entryA);
            contribute(harness.slots, entryB);
            const subscriptionA = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                releaseA,
                subscriptionFixture("dual-a")
            );
            const subscriptionB = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                releaseB,
                subscriptionFixture("dual-b")
            );
            const entryBBytes = SlotEntry.encode(entryB);

            const result = harness.withdrawal.withdraw(releaseA);

            expect(result.attribution.equals(releaseA)).toBe(true);
            expect(result.slots.entries.map((id) => id.value)).toEqual([entryA.id.value]);
            expect(result.routing.subscriptions.map((id) => id.value)).toEqual([
                subscriptionA.id.value
            ]);
            const retainedEntry = harness.slots.transaction((transaction) =>
                harness.slots.loadEntry(transaction, entryB.id)
            );
            expect(retainedEntry).toBeDefined();
            expect([...SlotEntry.encode(retainedEntry!)]).toEqual([...entryBBytes]);
            expect(
                harness.persistence.currentSubscription(harness.records, subscriptionB.id)?.retired
            ).toBeUndefined();

            const wrongPin = harness.withdrawal.withdraw(attribution("workspace:dual", "9.9.9"));
            expect(wrongPin.slots.entries).toEqual([]);
            expect(wrongPin.routing.subscriptions).toEqual([]);
            const replay = harness.withdrawal.withdraw(releaseA);
            expect(replay.slots.entries).toEqual([]);
            expect(replay.routing.subscriptions).toEqual([]);
            expect(
                harness.persistence.currentSubscription(harness.records, subscriptionB.id)?.retired
            ).toBeUndefined();
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

            expect(() => harness.withdrawal.withdraw(attribution("workspace:withdrawn"))).toThrow(
                /not computable from the Workspace Actor transaction/
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
            // A control transaction that rejects with something other than an Error still
            // names why the set is incomputable.
            const harness = crossPlaneHarness();
            contribute(harness.slots, entry("workspace:withdrawn", 1, { title: "Withdrawn" }));
            harness.routingFails = true;
            harness.routingFailure = "Workspace Actor rejected without an Error";

            expect(() => harness.withdrawal.plan(attribution("workspace:withdrawn"))).toThrow(
                new AgentCoreError(
                    "protocol.invalid-state",
                    "Withdrawal set is not computable from the Workspace Actor transaction: Workspace Actor rejected without an Error"
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
            materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                attribution("workspace:declarer"),
                subscriptionFixture("refused")
            );

            expect(() => harness.withdrawal.withdraw(attribution("workspace:declarer"))).toThrow(
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
            const contributor = attribution("workspace:partial");
            const activation = activationFor(harness, contributor);
            const before = harness.slots.entries(new SlotName("dashboard.card"));
            const facet = validatedActivationFacet(
                activationFacet(contributor.contributor, () => {
                    throw new TypeError("start failed before publication");
                })
            );

            const outcome = await activation.activate(
                facet,
                harness.database,
                { installationId: "installation" },
                { signal: new AbortController().signal }
            );

            expect(outcome).toEqual({
                kind: "failed",
                facet: contributor.contributor,
                reason: "start failed before publication"
            });
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toEqual(before);
            expect(harness.persistence.listSubscriptions(harness.records)).toEqual([]);
            expect(
                harness.slots.transaction((transaction) =>
                    harness.slots.withdrawalSet(transaction, contributor)
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
            const contributor = attribution("workspace:non-error");
            const activation = activationFor(harness, contributor);
            const facet = validatedActivationFacet(
                activationFacet(contributor.contributor, () => {
                    throw "start rejected without an Error";
                })
            );

            const outcome = await activation.activate(
                facet,
                harness.database,
                { installationId: "installation" },
                { signal: new AbortController().signal }
            );

            expect(outcome).toEqual({
                kind: "failed",
                facet: contributor.contributor,
                reason: "start rejected without an Error"
            });
            expect(
                harness.slots.transaction((transaction) =>
                    harness.slots.withdrawalSet(transaction, contributor)
                ).entries
            ).toEqual([]);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses a retry against a Scope whose prior partial effect was not retired",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const contributor = attribution("workspace:partial");
            const activation = activationFor(harness, contributor);
            contribute(harness.slots, entry("workspace:partial", 1, { title: "Stranded" }));
            const facet = validatedActivationFacet(
                activationFacet(contributor.contributor, () => undefined)
            );

            await expect(
                activation.activate(
                    facet,
                    harness.database,
                    { installationId: "installation" },
                    { signal: new AbortController().signal }
                )
            ).rejects.toThrow(/still holds materialized contributions/);

            // A Facet whose activation was refused obstructs no other Facet's activation.
            const other = attribution("workspace:other");
            const outcome = await activationFor(harness, other).activate(
                validatedActivationFacet(activationFacet(other.contributor, () => undefined)),
                harness.database,
                { installationId: "installation" },
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
            const contribution = attribution("workspace:two");
            const activation = activationFor(harness, contribution);
            await expect(
                activation.activate(
                    validatedActivationFacet(
                        activationFacet(new FacetRef("workspace:one"), () => undefined)
                    ),
                    harness.database,
                    { installationId: "installation" },
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
        new DurableRetention<MemoryWorkspaceRecords>(),
        actor,
        tenant
    );
    return {
        records,
        persistence,
        routing: new WorkspaceRoutingWithdrawal(persistence, new CountingAudits())
    };
}

interface CrossPlaneHarness {
    readonly database: TestSqlite;
    readonly records: TransactionalSqlite;
    readonly storage: SqliteWorkspaceRecords;
    readonly persistence: WorkspacePersistence<TransactionalSqlite>;
    readonly slots: SqliteWorkspaceSlotStore;
    readonly withdrawal: FacetWithdrawal<TransactionalSqlite>;
    routingFails: boolean;
    /** What the Workspace Actor's control transaction raises when it fails. */
    routingFailure: unknown;
}

function crossPlaneHarness(): CrossPlaneHarness {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceRecords(database);
    const persistence = new WorkspacePersistence<TransactionalSqlite>(
        () => records,
        new DurableRetention<TransactionalSqlite>(),
        sourceActor,
        tenant
    );
    const routing = new WorkspaceRoutingWithdrawal(persistence, new CountingAudits());
    const slots = new SqliteWorkspaceSlotStore(new WorkspaceId("workspace"), database);
    slots.install(declarerSlot("dashboard.card"));
    const harness: CrossPlaneHarness = {
        database,
        records: database,
        storage: records,
        persistence,
        slots,
        withdrawal: new FacetWithdrawal(slots, routing, persistence, (operation, ...guard) => {
            if (harness.routingFails) throw harness.routingFailure;
            return database.transaction(() => operation(database), ...guard);
        }),
        routingFails: false,
        routingFailure: new TypeError("Workspace Actor is unreachable")
    };
    return harness;
}

function activationFor(
    harness: CrossPlaneHarness,
    contribution: ContributionAttribution
): FacetActivation<TransactionalSqlite, TransactionalSqlite, { readonly installationId: string }> {
    const manifest = activationFacet(contribution.contributor, () => undefined).manifest;
    const base = authenticatedInstallationFixture(
        contribution.contributor.value,
        contribution.package,
        Digest.sha256(FacetManifest.encode(manifest))
    );
    const provenance = new TestPackageInstallationProvenance<TransactionalSqlite>({
        ...base,
        facet: contribution.contributor,
        packageFacet: contribution.contributor.packageId
    });
    const materializer = new WorkspaceFacetMaterializer(
        harness.persistence,
        harness.slots,
        provenance,
        ScopeRef.workspace(tenant, new WorkspaceId("workspace"))
    );
    return new FacetActivation(harness.withdrawal, materializer, (operation, ...guard) =>
        harness.database.transaction(() => operation(harness.database), ...guard)
    );
}

function validatedActivationFacet(facet: Facet): CorrespondentFacet {
    const validated = new FacetCorrespondenceValidator().validate([facet.manifest], [facet])
        .facets[0];
    if (validated === undefined) throw new TypeError("Expected validated activation Facet");
    return validated;
}
