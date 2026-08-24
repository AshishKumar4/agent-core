import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { Digest } from "../../src/core";
import { AuditRecordId, InvocationId } from "../../src/interaction-references";
import {
    CatalogEntry,
    CatalogEntryId,
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetRef,
    Prompt,
    PromptContribution,
    PromptSection,
    PromptSectionId,
    PackageInstallationRef,
    SettingsLayer,
    SettingsLayerId,
    SlotEntry,
    SlotName,
    SlotWithdrawalSet,
    SurfaceDescriptor,
    SurfaceId,
    SurfaceRegistration,
    type ContributionAttribution,
    type FacetLifecycleContext,
    type Interceptor,
    type InterceptorDeclaration,
    type Operation,
    type OperationName,
    type Surface,
    type WorkspaceSlotStore
} from "../../src/facets";
import { ScopeRef, WorkspaceId } from "../../src/identity";
import { AgentCoreError } from "../../src/errors";
import { FacetInstallFailure, FacetInstallPhase, ManagedOrigin } from "../../src/definition";
import {
    FacetActivation,
    FacetInvocationDrainPort,
    FacetWithdrawal,
    WorkspaceFacetMaterializer,
    type FacetInstallEvidencePort,
    type FacetRelianceQuery,
    type FacetWithdrawalOutcome,
    type FacetWithdrawalResult
} from "../../src/composition";
import { FacetCorrespondenceValidator, type ValidatedFacetRuntime } from "../../src/operations";
import {
    IngressEndpoint,
    IngressEndpointId,
    MemoryWorkspaceRecords,
    RouteDeliveryState,
    Subscription,
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

import { reaching } from "../composition/fixture";
import { attribution, contribute, declarerSlot, entry } from "./slot-store-contract";
import { activationFacet } from "./facet-activation-fixture";
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

interface TestWorkspaceTransaction {
    readonly kind: "test-workspace-transaction";
}

const testWorkspaceTransaction: TestWorkspaceTransaction = Object.freeze({
    kind: "test-workspace-transaction"
});

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

/** No active Facet reached this provider, so no withdrawal is ever held. */
const noReliance: FacetRelianceQuery = { reliedUponBy: () => [] };

/**
 * The reliance answer the test sets. It answers only for the exact provider it names, so a
 * dependent recorded against another Facet cannot hold this Facet's withdrawal.
 */
class TestReliance implements FacetRelianceQuery {
    public provider: FacetRef | undefined;
    public dependents: readonly FacetRef[] = [];

    public reliedUponBy(provider: FacetRef): readonly FacetRef[] {
        return this.provider?.equals(provider) === true ? this.dependents : [];
    }
}

/** The admitted Invocation items and the ones that reached a terminal Receipt. */
class TestDrain<Transaction> extends FacetInvocationDrainPort<Transaction> {
    public admittedItems: readonly InvocationId[] = [];
    public terminalItems: readonly InvocationId[] = [];

    public admitted(): readonly InvocationId[] {
        return this.admittedItems;
    }

    public terminal(_transaction: Transaction, item: InvocationId): boolean {
        return this.terminalItems.some((settled) => settled.equals(item));
    }
}

/**
 * The recorded failed installs, and the refusal query a retry consults. The failure itself
 * answers whether it refuses a Scope, so this port holds no second copy of that rule.
 */
class MemoryInstallEvidence implements FacetInstallEvidencePort {
    public readonly recorded: FacetInstallFailure[] = [];

    public record(failure: FacetInstallFailure): void {
        this.recorded.push(failure);
    }

    public refusals(
        attributed: ContributionAttribution,
        materialization: ManagedOrigin
    ): readonly FacetInstallFailure[] {
        return this.recorded.filter((failure) => failure.refuses(attributed, materialization));
    }
}

/**
 * The activation Facet with one declared `prompt` contribution, so materializing it writes a
 * Workspace record a SQLite trigger can fail. The declaration lives on the manifest the
 * installation authenticates, so it is built from the fixture's manifest rather than beside it.
 */
class PromptContributingFacet extends Facet {
    public readonly manifest: FacetManifest;

    public constructor(private readonly inner: Facet) {
        super();
        this.manifest = new FacetManifest({
            id: inner.manifest.id,
            version: inner.manifest.version,
            compat: inner.manifest.compat,
            isolation: inner.manifest.isolation,
            bindings: inner.manifest.bindings,
            contributions: new Contributions([
                new Contribution(new SlotName("prompt"), [
                    new PromptContribution([new Prompt("Injected", "Injected body", 1)]).toData()
                ])
            ])
        });
    }

    public get ref(): FacetRef {
        return this.inner.ref;
    }

    public operation(name: OperationName): Operation | undefined {
        return this.inner.operation(name);
    }

    public surface(id: SurfaceId): Surface | undefined {
        return this.inner.surface(id);
    }

    public interceptor(id: InterceptorDeclaration["id"]): Interceptor | undefined {
        return this.inner.interceptor(id);
    }

    public children(): readonly Facet[] {
        return this.inner.children();
    }

    public start(context: FacetLifecycleContext): Promise<void> {
        return this.inner.start(context);
    }

    public stop(context: FacetLifecycleContext): Promise<void> {
        return this.inner.stop(context);
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

            const result = retired(harness.withdrawal.withdraw(attribution("workspace:withdrawn")));

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

            const result = retired(harness.withdrawal.withdraw(releaseA));

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

            const wrongPin = retired(
                harness.withdrawal.withdraw(attribution("workspace:dual", "9.9.9"))
            );
            expect(wrongPin.slots.entries).toEqual([]);
            expect(wrongPin.routing.subscriptions).toEqual([]);
            const replay = retired(harness.withdrawal.withdraw(releaseA));
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

    test(
        "[C13-FACET-DEPENDENCY-ORDER] defers a withdrawal a live Facet still relies on and writes no plane",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:withdrawn");
            contribute(harness.slots, entry("workspace:withdrawn", 1, { title: "Withdrawn" }));
            const subscription = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                withdrawn,
                subscriptionFixture("relied-upon")
            );
            contributePromptSection(harness, withdrawn, 1);
            const before = workspaceBytes(harness);
            const dependent = new FacetRef("workspace:dependent");
            harness.reliance.provider = withdrawn.contributor;
            harness.reliance.dependents = [dependent];

            const outcome = harness.withdrawal.withdraw(withdrawn);

            // Held, not rejected: the withdrawal reports the obligation instead of throwing.
            expect(outcome.kind).toBe("deferred");
            expect(outcome.attribution.equals(withdrawn)).toBe(true);
            expect(outcome.obligations).toEqual([{ kind: "reliance", dependent }]);
            // And not silent: the slot entries, the Subscriptions and every Workspace record
            // are the bytes the deferral read.
            expect(workspaceBytes(harness)).toEqual(before);
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toHaveLength(1);
            expect(
                harness.persistence.listContributedPromptSections(harness.records, withdrawn)
            ).toHaveLength(1);
            expect(
                harness.persistence.currentSubscription(harness.records, subscription.id)?.retired
            ).toBeUndefined();
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] retires the exact set once the reliance obligation discharges",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:withdrawn");
            const withdrawnEntry = entry("workspace:withdrawn", 1, { title: "Withdrawn" });
            contribute(harness.slots, withdrawnEntry);
            const subscription = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                withdrawn,
                subscriptionFixture("discharged")
            );
            const section = contributePromptSection(harness, withdrawn, 1);
            harness.reliance.provider = withdrawn.contributor;
            harness.reliance.dependents = [new FacetRef("workspace:dependent")];
            expect(harness.withdrawal.withdraw(withdrawn).kind).toBe("deferred");

            harness.reliance.dependents = [];
            const result = retired(harness.withdrawal.withdraw(withdrawn));

            expect(result.obligations).toEqual([]);
            expect(result.slots.entries.map((id) => id.value)).toEqual([withdrawnEntry.id.value]);
            expect(result.records.promptSections.map((id) => id.value)).toEqual([section.id.value]);
            expect(result.routing.subscriptions.map((id) => id.value)).toEqual([
                subscription.id.value
            ]);
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toEqual([]);
            expect(
                harness.persistence.listContributedPromptSections(harness.records, withdrawn)
            ).toEqual([]);
            expect(
                harness.persistence.currentSubscription(harness.records, subscription.id)?.retired
            ).toBe(true);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] keys reliance on the exact provider, so another Facet's dependent defers nothing",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:withdrawn");
            const withdrawnEntry = entry("workspace:withdrawn", 1, { title: "Withdrawn" });
            contribute(harness.slots, withdrawnEntry);
            harness.reliance.provider = new FacetRef("workspace:other");
            harness.reliance.dependents = [new FacetRef("workspace:dependent")];

            const result = retired(harness.withdrawal.withdraw(withdrawn));

            expect(result.obligations).toEqual([]);
            expect(result.slots.entries.map((id) => id.value)).toEqual([withdrawnEntry.id.value]);
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toEqual([]);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] retires the records and reports the admitted item that has no terminal Receipt",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:draining");
            const withdrawnEntry = entry("workspace:draining", 1, { title: "Draining" });
            contribute(harness.slots, withdrawnEntry);
            const subscription = materializeAttributedSubscription(
                harness.persistence,
                harness.records,
                withdrawn,
                subscriptionFixture("draining")
            );
            const item = new InvocationId("invocation-draining");
            harness.drain.admittedItems = [item];

            const result = retired(harness.withdrawal.withdraw(withdrawn));

            // The transaction that reports the obligation is the one that stops admission, so
            // the records are retired and the withdrawal is still not complete.
            expect(result.obligations).toEqual([{ kind: "drain", item }]);
            expect(result.slots.entries.map((id) => id.value)).toEqual([withdrawnEntry.id.value]);
            expect(harness.slots.entries(new SlotName("dashboard.card"))).toEqual([]);
            expect(
                harness.persistence.currentSubscription(harness.records, subscription.id)?.retired
            ).toBe(true);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] reports no obligation once the admitted item reaches a terminal Receipt",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:draining");
            contribute(harness.slots, entry("workspace:draining", 1, { title: "Draining" }));
            const item = new InvocationId("invocation-settling");
            harness.drain.admittedItems = [item];
            harness.drain.terminalItems = [item];

            const result = retired(harness.withdrawal.withdraw(withdrawn));

            expect(result.obligations).toEqual([]);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-DRAIN] reports exactly the admitted items that are not terminal",
        { tags: "p0" },
        () => {
            const harness = crossPlaneHarness();
            const withdrawn = attribution("workspace:draining");
            contribute(harness.slots, entry("workspace:draining", 1, { title: "Draining" }));
            const settled = new InvocationId("invocation-settled");
            const live = new InvocationId("invocation-live");
            harness.drain.admittedItems = [settled, live];
            harness.drain.terminalItems = [settled];

            const result = retired(harness.withdrawal.withdraw(withdrawn));

            // A settled item is never an obligation, and a live one is never discarded, so a
            // host can neither report completion early nor hold the set open on a settled item.
            expect(result.obligations).toEqual([{ kind: "drain", item: live }]);
        }
    );
    test(
        "retires every Workspace contribution record from the queried exact set",
        { tags: "p1" },
        () => {
            const contribution = attribution("workspace:all-records");
            const catalog = new CatalogEntryId("catalog:all-records");
            const ingress = new IngressEndpointId("ingress-all-records");
            const prompt = new PromptSectionId("prompt:all-records");
            const settings = new SettingsLayerId("settings:all-records");
            const surface = new SurfaceId("surface.all-records");
            const retiredRecords: string[] = [];
            const persistence = reaching<WorkspacePersistence<TestWorkspaceTransaction>>({
                listContributedCatalogEntries: () => [reaching<CatalogEntry>({ id: catalog })],
                listContributedIngressEndpoints: () => [reaching<IngressEndpoint>({ id: ingress })],
                listContributedPromptSections: () => [reaching<PromptSection>({ id: prompt })],
                listContributedSettingsLayers: () => [reaching<SettingsLayer>({ id: settings })],
                listContributedSurfaceRegistrations: () => [
                    reaching<SurfaceRegistration>({
                        descriptor: reaching<SurfaceDescriptor>({ id: surface })
                    })
                ],
                retireCatalogEntry: () => {
                    retiredRecords.push(catalog.value);
                },
                retireIngressEndpoint: () => {
                    retiredRecords.push(ingress.value);
                },
                retirePromptSection: () => {
                    retiredRecords.push(prompt.value);
                },
                retireSettingsLayer: () => {
                    retiredRecords.push(settings.value);
                },
                retireSurfaceRegistration: () => {
                    retiredRecords.push(surface.value);
                }
            });
            const slots = reaching<WorkspaceSlotStore<TestWorkspaceTransaction>>({
                withdrawalSet: () => new SlotWithdrawalSet(contribution, [], []),
                requireWithdrawable: () => undefined,
                retireWithdrawalSet: () => {
                    retiredRecords.push("slots");
                    return true;
                }
            });
            const routing = reaching<WorkspaceRoutingWithdrawal<TestWorkspaceTransaction>>({
                contributed: () => [],
                retire: () => ({ subscriptions: [], rejected: [] })
            });
            const withdrawal = new FacetWithdrawal(
                slots,
                routing,
                persistence,
                objectTransaction,
                noReliance,
                new TestDrain<TestWorkspaceTransaction>()
            );

            const result = retired(withdrawal.withdraw(contribution));
            expect(result.records).toEqual({
                catalogEntries: [catalog],
                ingressEndpoints: [ingress],
                promptSections: [prompt],
                settingsLayers: [settings],
                surfaces: [surface]
            });
            expect(retiredRecords).toEqual([
                "slots",
                catalog.value,
                ingress.value,
                prompt.value,
                settings.value,
                surface.value
            ]);
        }
    );

    test(
        "wraps record query failures and non-Error withdrawal transaction failures",
        { tags: "p1" },
        () => {
            const contribution = attribution("workspace:failure");
            const slots = reaching<WorkspaceSlotStore<TestWorkspaceTransaction>>({
                withdrawalSet: () => {
                    throw new TypeError("record decode failed");
                }
            });
            const routing = reaching<WorkspaceRoutingWithdrawal<TestWorkspaceTransaction>>({});
            const persistence = reaching<WorkspacePersistence<TestWorkspaceTransaction>>({});
            const queryFailure = new FacetWithdrawal(
                slots,
                routing,
                persistence,
                objectTransaction,
                noReliance,
                new TestDrain<TestWorkspaceTransaction>()
            );
            expect(() => queryFailure.plan(contribution)).toThrow(
                /not computable from Workspace records: record decode failed/
            );

            const controlFailure = new FacetWithdrawal(
                reaching<WorkspaceSlotStore<TestWorkspaceTransaction>>({}),
                routing,
                persistence,
                () => {
                    throw "control rejected";
                },
                noReliance,
                new TestDrain<TestWorkspaceTransaction>()
            );
            expect(() => controlFailure.withdraw(contribution)).toThrow(
                /Workspace Actor transaction: control rejected/
            );

            const errorControl = new FacetWithdrawal(
                reaching<WorkspaceSlotStore<TestWorkspaceTransaction>>({}),
                routing,
                persistence,
                () => {
                    throw new TypeError("control failed");
                },
                noReliance,
                new TestDrain<TestWorkspaceTransaction>()
            );
            expect(() => errorControl.plan(contribution)).toThrow(
                /Workspace Actor transaction: control failed/
            );
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

    test(
        "[C13-FACET-START-ATOMIC] records exactly one start-phase install failure for the exact contribution",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const contributor = attribution("workspace:start-failure");
            const facet = validatedActivationFacet(
                activationFacet(contributor.contributor, () => {
                    throw new TypeError("start failed before publication");
                })
            );

            await activationFor(harness, contributor).activate(
                facet,
                harness.database,
                { installationId: "installation" },
                { signal: new AbortController().signal }
            );

            expect(harness.evidence.recorded).toHaveLength(1);
            const failure = harness.evidence.recorded[0];
            if (failure === undefined) throw new TypeError("Expected a recorded install failure");
            expect(failure.phase).toBe(FacetInstallPhase.start);
            expect(failure.phase.materializedRecords).toBe(false);
            expect(failure.attribution.equals(contributor)).toBe(true);
            expect(failure.reason).toBe("start failed before publication");
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses a retry against the same ManagedOrigin before start runs",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const contributor = attribution("workspace:refused-retry");
            const context = { installationId: "installation" };
            const lifecycle = { signal: new AbortController().signal };
            await activationFor(harness, contributor).activate(
                validatedActivationFacet(
                    activationFacet(contributor.contributor, () => {
                        throw new TypeError("start failed once");
                    })
                ),
                harness.database,
                context,
                lifecycle
            );

            let started = 0;
            const retry = validatedActivationFacet(
                activationFacet(contributor.contributor, () => {
                    started += 1;
                })
            );
            await expect(
                activationFor(harness, contributor).activate(
                    retry,
                    harness.database,
                    context,
                    lifecycle
                )
            ).rejects.toThrow(
                /failed to install against this Scope and is not retried: start failed once/
            );
            expect(started).toBe(0);
            expect(harness.evidence.recorded).toHaveLength(1);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] admits the retry against a bumped materialization generation",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const contributor = attribution("workspace:new-generation");
            const context = { installationId: "installation" };
            const lifecycle = { signal: new AbortController().signal };
            await activationFor(harness, contributor).activate(
                validatedActivationFacet(
                    activationFacet(contributor.contributor, () => {
                        throw new TypeError("start failed once");
                    })
                ),
                harness.database,
                context,
                lifecycle
            );

            // A later generation is a different ManagedOrigin, so it is a changed Scope.
            const outcome = await activationFor(harness, contributor, {
                reorigin: nextGeneration
            }).activate(
                validatedActivationFacet(activationFacet(contributor.contributor, () => undefined)),
                harness.database,
                context,
                lifecycle
            );

            expect(outcome).toEqual({ kind: "active", facet: contributor.contributor });
            expect(harness.evidence.recorded).toHaveLength(1);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] records a materialization-phase failure and leaves the Scope unattributed",
        { tags: "p0" },
        async () => {
            const harness = crossPlaneHarness();
            const contributor = attribution("workspace:materialization-failure");
            const facet = new PromptContributingFacet(
                activationFacet(contributor.contributor, () => undefined)
            );
            harness.database.run(
                `CREATE TRIGGER fail_prompt_materialization
                 BEFORE INSERT ON workspace_records
                 WHEN NEW.kind = 'promptSection'
                 BEGIN SELECT RAISE(ABORT, 'injected prompt failure'); END`,
                []
            );

            const outcome = await activationFor(harness, contributor, {
                manifest: facet.manifest
            }).activate(
                validatedActivationFacet(facet),
                harness.database,
                { installationId: "installation" },
                { signal: new AbortController().signal }
            );

            expect(outcome.kind).toBe("failed");
            expect(outcome.facet.equals(contributor.contributor)).toBe(true);
            expect(harness.evidence.recorded).toHaveLength(1);
            const failure = harness.evidence.recorded[0];
            if (failure === undefined) throw new TypeError("Expected a recorded install failure");
            expect(failure.phase).toBe(FacetInstallPhase.materialization);
            expect(failure.phase.materializedRecords).toBe(true);
            expect(failure.reason).toContain("injected prompt failure");
            // The partial activation was retired through the attributed set, so the Scope holds
            // nothing for this contribution.
            const remaining = harness.withdrawal.plan(contributor);
            expect(remaining.slots.slots).toEqual([]);
            expect(remaining.slots.entries).toEqual([]);
            expect(remaining.subscriptions).toBe(0);
            expect(remaining.records).toEqual({
                catalogEntries: [],
                ingressEndpoints: [],
                promptSections: [],
                settingsLayers: [],
                surfaces: []
            });
        }
    );

    test(
        "refuses absent provenance and reports materialization plus stop failures",
        { tags: "p1" },
        async () => {
            const contribution = attribution("workspace:activation-failure");
            const raw = activationFacet(
                contribution.contributor,
                () => undefined,
                () => {
                    throw "stop rejected";
                }
            );
            const facet = validatedActivationFacet(raw);
            const emptyPlan = {
                attribution: contribution,
                records: {
                    catalogEntries: [],
                    ingressEndpoints: [],
                    promptSections: [],
                    settingsLayers: [],
                    surfaces: []
                },
                slots: new SlotWithdrawalSet(contribution, [], []),
                subscriptions: 0,
                obligations: []
            };
            const retiredNothing: FacetWithdrawalResult = {
                kind: "retired",
                attribution: contribution,
                records: emptyPlan.records,
                slots: emptyPlan.slots,
                routing: { subscriptions: [], rejected: [] },
                obligations: []
            };
            const evidence = new MemoryInstallEvidence();
            const withdrawal = reaching<FacetWithdrawal<TestWorkspaceTransaction>>({
                plan: () => emptyPlan,
                withdraw: () => retiredNothing
            });
            const missing = new FacetActivation(
                withdrawal,
                reaching<
                    WorkspaceFacetMaterializer<
                        TestWorkspaceTransaction,
                        TestWorkspaceTransaction,
                        TestWorkspaceTransaction
                    >
                >({
                    prepareContribution: () => undefined
                }),
                objectTransaction,
                evidence
            );
            await expect(
                missing.activate(facet, testWorkspaceTransaction, testWorkspaceTransaction, {
                    signal: new AbortController().signal
                })
            ).rejects.toThrow(/requires current package installation provenance/);

            const installation = authenticatedInstallationFixture(
                contribution.contributor.value,
                contribution.package,
                Digest.sha256(FacetManifest.encode(facet.manifest))
            );
            const prepared = {
                reference: new PackageInstallationRef(contribution, installation.packageFacet),
                manifestDigest: installation.manifestDigest,
                materialization: installation.materialization,
                stamp: Object.freeze({})
            };
            const failing = new FacetActivation(
                withdrawal,
                reaching<
                    WorkspaceFacetMaterializer<
                        TestWorkspaceTransaction,
                        TestWorkspaceTransaction,
                        TestWorkspaceTransaction
                    >
                >({
                    prepareContribution: () => prepared,
                    materialize: () => {
                        throw "materialization rejected";
                    }
                }),
                objectTransaction,
                evidence
            );
            await expect(
                failing.activate(facet, testWorkspaceTransaction, testWorkspaceTransaction, {
                    signal: new AbortController().signal
                })
            ).resolves.toMatchObject({
                kind: "failed",
                reason: "materialization rejected; Facet stop failed: stop rejected"
            });
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
    readonly reliance: TestReliance;
    readonly drain: TestDrain<TransactionalSqlite>;
    readonly evidence: MemoryInstallEvidence;
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
    const reliance = new TestReliance();
    const drain = new TestDrain<TransactionalSqlite>();
    const harness: CrossPlaneHarness = {
        database,
        records: database,
        storage: records,
        persistence,
        slots,
        reliance,
        drain,
        evidence: new MemoryInstallEvidence(),
        withdrawal: new FacetWithdrawal(
            slots,
            routing,
            persistence,
            (operation, ...guard) => {
                if (harness.routingFails) throw harness.routingFailure;
                return database.transaction(() => operation(database), ...guard);
            },
            reliance,
            drain
        ),
        routingFails: false,
        routingFailure: new TypeError("Workspace Actor is unreachable")
    };
    return harness;
}

/** What an activation may install against instead of the plain fixture installation. */
interface ActivationOverrides {
    /** The same pin against a changed Scope, which SPEC §4.1 admits a retry under. */
    readonly reorigin?: (origin: ManagedOrigin) => ManagedOrigin;
    /** The manifest the installation authenticates, when the Facet declares contributions. */
    readonly manifest?: FacetManifest;
}

function activationFor(
    harness: CrossPlaneHarness,
    contribution: ContributionAttribution,
    overrides: ActivationOverrides = {}
): FacetActivation<TransactionalSqlite, TransactionalSqlite, { readonly installationId: string }> {
    const manifest =
        overrides.manifest ?? activationFacet(contribution.contributor, () => undefined).manifest;
    const base = authenticatedInstallationFixture(
        contribution.contributor.value,
        contribution.package,
        Digest.sha256(FacetManifest.encode(manifest))
    );
    const provenance = new TestPackageInstallationProvenance<TransactionalSqlite>({
        ...base,
        facet: contribution.contributor,
        packageFacet: contribution.contributor.packageId,
        materialization: overrides.reorigin?.(base.materialization) ?? base.materialization
    });
    const materializer = new WorkspaceFacetMaterializer(
        harness.persistence,
        harness.slots,
        provenance,
        ScopeRef.workspace(tenant, new WorkspaceId("workspace"))
    );
    return new FacetActivation(
        harness.withdrawal,
        materializer,
        (operation, ...guard) =>
            harness.database.transaction(() => operation(harness.database), ...guard),
        harness.evidence
    );
}

/**
 * The retired half of the outcome union. A deferral is its own outcome, so a test that reads
 * a retired result names the obligation that held the withdrawal rather than reading fields
 * off the wrong member.
 */
function retired(outcome: FacetWithdrawalOutcome): FacetWithdrawalResult {
    if (outcome.kind === "retired") return outcome;
    const held = outcome.obligations.map((obligation) =>
        obligation.kind === "reliance" ? obligation.dependent.value : obligation.item.value
    );
    throw new TypeError(`Withdrawal was deferred by ${held.join(", ")}`);
}

/** The same installation one materialization generation later: the same pin, a changed Scope. */
function nextGeneration(origin: ManagedOrigin): ManagedOrigin {
    return new ManagedOrigin({
        tenantId: origin.tenantId,
        deploymentId: origin.deploymentId,
        attestationDigest: origin.attestationDigest,
        blueprintDigest: origin.blueprintDigest,
        packageLockDigest: origin.packageLockDigest,
        configDigest: origin.configDigest,
        generation: origin.generation + 1
    });
}

/**
 * Every Workspace-owned record byte a withdrawal can write, in one comparable snapshot, so a
 * deferral is proved to have written nothing rather than only to have retired nothing.
 */
function workspaceBytes(harness: CrossPlaneHarness): readonly (readonly number[])[] {
    const records = harness.records;
    return [
        ...harness.slots
            .listAllEntries(records)
            .map((slotEntry) => [...SlotEntry.encode(slotEntry)]),
        ...harness.persistence
            .listSubscriptions(records)
            .map((subscription) => [...Subscription.encode(subscription)]),
        ...harness.persistence
            .listCatalogEntries(records)
            .map((catalog) => [...CatalogEntry.encode(catalog)]),
        ...harness.persistence
            .listIngressEndpoints(records)
            .map((endpoint) => [...IngressEndpoint.encode(endpoint)]),
        ...harness.persistence
            .listPromptSections(records)
            .map((section) => [...PromptSection.encode(section)]),
        ...harness.persistence
            .listSettingsLayers(records)
            .map((layer) => [...SettingsLayer.encode(layer)]),
        ...harness.persistence
            .listSurfaceRegistrations(records)
            .map((registration) => [...SurfaceRegistration.encode(registration)])
    ];
}

/** One attributed prompt section, so an exact withdrawal set holds a Workspace record too. */
function contributePromptSection(
    harness: CrossPlaneHarness,
    contribution: ContributionAttribution,
    position: number
): PromptSection {
    const section = new PromptSection(
        `Section ${position}`,
        `Body ${position}`,
        position,
        contribution,
        position
    );
    harness.database.transaction(() =>
        harness.persistence.putPromptSection(harness.records, section)
    );
    return section;
}

function validatedActivationFacet(facet: Facet): CorrespondentFacet {
    const validated = new FacetCorrespondenceValidator().validate([facet.manifest], [facet])
        .facets[0];
    if (validated === undefined) throw new TypeError("Expected validated activation Facet");
    return validated;
}

function objectTransaction<Result>(
    operation: (transaction: TestWorkspaceTransaction) => Result,
    ..._guard: SynchronousResultGuard<Result>
): Result {
    return operation(testWorkspaceTransaction);
}
