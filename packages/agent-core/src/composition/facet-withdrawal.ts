import type { SynchronousResultGuard } from "../actors";
import { AgentCoreError } from "../errors";
import type {
    CatalogEntryId,
    ContributionAttribution,
    FacetLifecycleContext,
    FacetRef,
    PromptSectionId,
    SettingsLayerId,
    SlotWithdrawalSet,
    SurfaceId,
    WorkspaceSlotStore
} from "../facets";
import type { ValidatedFacetRuntime } from "../operations";
import type { InvocationId } from "../invocations";
import type {
    IngressEndpointId,
    RoutingWithdrawal,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal
} from "../workspaces";
import type { ManagedOrigin, PreparedPackageContribution } from "../definition";
import { FacetInstallFailure, FacetInstallPhase } from "../definition";
import type { WorkspaceFacetMaterializer } from "./workspace-facet-materializer";

type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

/** Opens one synchronous control transaction for the owning Workspace Actor. */
export interface ControlTransaction<Transaction> {
    <Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
}

export interface WorkspaceContributionWithdrawalSet {
    readonly catalogEntries: readonly CatalogEntryId[];
    readonly ingressEndpoints: readonly IngressEndpointId[];
    readonly promptSections: readonly PromptSectionId[];
    readonly settingsLayers: readonly SettingsLayerId[];
    readonly surfaces: readonly SurfaceId[];
}

/**
 * SPEC §4.1: what stands between a withdrawal and its completion. A `reliance` obligation
 * holds the withdrawal before it begins — an active Facet reached this exact provider
 * through a resolved `BindingRequirement`, so retiring its records now would compose
 * against state no Blueprint declares. A `drain` obligation stands after it began — an
 * Invocation item admitted against the Facet is frozen intent and still settles. Neither
 * is a rejection and neither is silent: the withdrawal reports them and completes when the
 * set is empty.
 */
export type FacetWithdrawalObligation =
    | { readonly kind: "reliance"; readonly dependent: FacetRef }
    | { readonly kind: "drain"; readonly item: InvocationId };

export interface FacetWithdrawalPlan {
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly subscriptions: number;
    readonly obligations: readonly FacetWithdrawalObligation[];
}

export interface FacetWithdrawalResult {
    readonly kind: "retired";
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly routing: RoutingWithdrawal;
    /** Empty exactly when the withdrawal is complete. */
    readonly obligations: readonly FacetWithdrawalObligation[];
}

/** A withdrawal held before it began: nothing was written and nothing was rejected. */
export interface FacetWithdrawalDeferral {
    readonly kind: "deferred";
    readonly attribution: ContributionAttribution;
    readonly obligations: readonly FacetWithdrawalObligation[];
}

export type FacetWithdrawalOutcome = FacetWithdrawalResult | FacetWithdrawalDeferral;

/**
 * SPEC §4.1: the Facets an active resolved `BindingRequirement` points at this exact
 * provider from. `FacetRuntimeHost` answers it; reliance is keyed on the exact `FacetRef`
 * a dependent reached, never on the capability name it asked for.
 */
export interface FacetRelianceQuery {
    reliedUponBy(provider: FacetRef): readonly FacetRef[];
}

/**
 * SPEC §4.1: the admitted Invocation items whose `PreparedInvocationHeader` target names
 * the withdrawing Facet, and whether each has reached a terminal current Receipt. The set
 * is closed at the transaction that begins the withdrawal, because that transaction stops
 * admitting Invocations against the Facet.
 */
export abstract class FacetInvocationDrainPort<Transaction> {
    public abstract admitted(transaction: Transaction, facet: FacetRef): readonly InvocationId[];
    public abstract terminal(transaction: Transaction, item: InvocationId): boolean;
}

/**
 * SPEC §4.1: every Workspace-owned record of one exact contribution is queried and retired
 * in one Workspace Actor transaction. The attribution includes both FacetRef and PackagePin;
 * another release of the same Facet is outside the set.
 */
export class FacetWithdrawal<Transaction> {
    public constructor(
        private readonly slots: WorkspaceSlotStore<Transaction>,
        private readonly routing: WorkspaceRoutingWithdrawal<Transaction>,
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly transaction: ControlTransaction<Transaction>,
        private readonly reliance: FacetRelianceQuery,
        private readonly drain: FacetInvocationDrainPort<Transaction>
    ) {}

    public plan(attribution: ContributionAttribution): FacetWithdrawalPlan {
        try {
            return this.transaction((transaction) =>
                this.planInTransaction(transaction, attribution)
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            return this.controlFailure(error instanceof Error ? error : String(error));
        }
    }

    /**
     * SPEC §4.1. A reliance obligation holds the withdrawal before it begins: nothing is
     * written, nothing is rejected, and the obligation discharges when the last relying
     * Facet goes inactive. Once no reliance stands the withdrawal begins in one transaction
     * — that transaction stops admitting Invocations against the Facet, which closes the
     * drain set — and reports the admitted items that have not yet reached a terminal
     * Receipt. It is complete exactly when it reports no obligation.
     */
    public withdraw(attribution: ContributionAttribution): FacetWithdrawalOutcome {
        try {
            return this.transaction((transaction) => {
                const planned = this.planInTransaction(transaction, attribution);
                const held = planned.obligations.filter(
                    (obligation) => obligation.kind === "reliance"
                );
                if (held.length > 0) {
                    return Object.freeze({
                        kind: "deferred" as const,
                        attribution,
                        obligations: Object.freeze(held)
                    });
                }
                const routing = this.routing.retire(transaction, attribution);
                this.slots.retireWithdrawalSet(transaction, attribution);
                this.retireRecords(transaction, planned.records);
                return Object.freeze({
                    kind: "retired" as const,
                    attribution,
                    records: planned.records,
                    slots: planned.slots,
                    routing,
                    obligations: planned.obligations
                });
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            return this.controlFailure(error instanceof Error ? error : String(error));
        }
    }

    private planInTransaction(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): FacetWithdrawalPlan {
        try {
            const slots = this.slots.withdrawalSet(transaction, attribution);
            this.slots.requireWithdrawable(transaction, slots);
            const records = this.contributedRecords(transaction, attribution);
            return Object.freeze({
                attribution,
                records,
                slots,
                subscriptions: this.routing.contributed(transaction, attribution).length,
                obligations: this.obligations(transaction, attribution.contributor)
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Withdrawal set is not computable from Workspace records: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * The pending set, computed inside the caller's transaction so a withdrawal never reads
     * one state and writes against another. Reliance is listed first because it holds the
     * withdrawal before it begins, while a drain obligation only stands after it began.
     */
    private obligations(
        transaction: Transaction,
        facet: FacetRef
    ): readonly FacetWithdrawalObligation[] {
        const held = this.reliance
            .reliedUponBy(facet)
            .map((dependent) => ({ kind: "reliance" as const, dependent }));
        const draining = this.drain
            .admitted(transaction, facet)
            .filter((item) => !this.drain.terminal(transaction, item))
            .map((item) => ({ kind: "drain" as const, item }));
        return Object.freeze([...held, ...draining].map((obligation) => Object.freeze(obligation)));
    }

    private contributedRecords(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): WorkspaceContributionWithdrawalSet {
        return Object.freeze({
            catalogEntries: Object.freeze(
                this.persistence
                    .listContributedCatalogEntries(transaction, attribution)
                    .map((entry) => entry.id)
            ),
            ingressEndpoints: Object.freeze(
                this.persistence
                    .listContributedIngressEndpoints(transaction, attribution)
                    .map((endpoint) => endpoint.id)
            ),
            promptSections: Object.freeze(
                this.persistence
                    .listContributedPromptSections(transaction, attribution)
                    .map((section) => section.id)
            ),
            settingsLayers: Object.freeze(
                this.persistence
                    .listContributedSettingsLayers(transaction, attribution)
                    .map((layer) => layer.id)
            ),
            surfaces: Object.freeze(
                this.persistence
                    .listContributedSurfaceRegistrations(transaction, attribution)
                    .map((registration) => registration.descriptor.id)
            )
        });
    }

    private retireRecords(
        transaction: Transaction,
        records: WorkspaceContributionWithdrawalSet
    ): void {
        for (const id of records.catalogEntries) {
            this.persistence.retireCatalogEntry(transaction, id);
        }
        for (const id of records.ingressEndpoints) {
            this.persistence.retireIngressEndpoint(transaction, id);
        }
        for (const id of records.promptSections) {
            this.persistence.retirePromptSection(transaction, id);
        }
        for (const id of records.settingsLayers) {
            this.persistence.retireSettingsLayer(transaction, id);
        }
        for (const id of records.surfaces) {
            this.persistence.retireSurfaceRegistration(transaction, id);
        }
    }
    private controlFailure(error: Error | string): never {
        throw new AgentCoreError(
            "protocol.invalid-state",
            `Withdrawal set is not computable from the Workspace Actor transaction: ${error instanceof Error ? error.message : error}`
        );
    }
}

/**
 * SPEC §4.1: the durable record of a failed install, and the query a retry consults. It is
 * definition-plane state with one owning Actor, so the write is its own at-least-once,
 * idempotency-keyed transaction rather than a second writer inside the Workspace's.
 */
export interface FacetInstallEvidencePort {
    record(failure: FacetInstallFailure): void;
    refusals(
        attribution: ContributionAttribution,
        materialization: ManagedOrigin
    ): readonly FacetInstallFailure[];
}

export type FacetActivationOutcome =
    | { readonly kind: "active"; readonly facet: FacetRef }
    | { readonly kind: "failed"; readonly facet: FacetRef; readonly reason: string };

export class FacetActivation<Transaction, Read, Context> {
    public constructor(
        private readonly withdrawal: FacetWithdrawal<Transaction>,
        private readonly materializer: WorkspaceFacetMaterializer<Transaction, Read, Context>,
        private readonly transaction: ControlTransaction<Transaction>,
        private readonly evidence: FacetInstallEvidencePort
    ) {}

    public async activate(
        facet: CorrespondentFacet,
        read: Read,
        materializationContext: Context,
        lifecycleContext: FacetLifecycleContext
    ): Promise<FacetActivationOutcome> {
        const prepared = this.materializer.prepareContribution(read, materializationContext);
        if (prepared === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Facet activation requires current package installation provenance"
            );
        }
        const contributor = prepared.reference.attribution.contributor;
        if (!facet.ref.equals(contributor)) {
            this.materializer.discard(prepared);
            throw new AgentCoreError(
                "authority.denied",
                "Facet activation provenance names another Facet"
            );
        }
        const attribution = prepared.reference.attribution;
        const before = this.withdrawal.plan(attribution);
        if (
            before.slots.slots.length > 0 ||
            before.slots.entries.length > 0 ||
            before.subscriptions > 0 ||
            contributionRecordCount(before.records) > 0
        ) {
            this.materializer.discard(prepared);
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Facet ${contributor.value} still holds materialized contributions; retire them before activating`
            );
        }
        // SPEC §4.1: a failed Facet is not retried against the same unchanged Scope. The
        // ManagedOrigin the installation authenticated under names that Scope exactly — the
        // Tenant, deployment, attestation, Blueprint, lock, config and generation — so a
        // later materialization generation is a different Scope and is admitted.
        const refused = this.evidence.refusals(attribution, prepared.materialization);
        if (refused.length > 0) {
            this.materializer.discard(prepared);
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Facet ${contributor.value} failed to install against this Scope and is not retried: ${refused.map((failure) => failure.reason).join("; ")}`
            );
        }
        try {
            await facet.start(lifecycleContext);
        } catch (error) {
            this.materializer.discard(prepared);
            return this.failed(
                facet,
                prepared,
                FacetInstallPhase.start,
                error instanceof Error ? error : String(error),
                lifecycleContext
            );
        }
        try {
            this.transaction((transaction) =>
                this.materializer.materialize(transaction, materializationContext, prepared, facet)
            );
        } catch (error) {
            return this.failed(
                facet,
                prepared,
                FacetInstallPhase.materialization,
                error instanceof Error ? error : String(error),
                lifecycleContext
            );
        }
        return Object.freeze({ kind: "active", facet: contributor });
    }

    /**
     * SPEC §4.1: the partial activation is retired through the same attributed withdrawal
     * set a withdrawal computes, and the outcome is recorded as a typed failed install
     * rather than as a live Facet. Only a materialization-phase failure can have left
     * records, because contribution records publish only after `start` completes.
     */
    private async failed(
        facet: CorrespondentFacet,
        prepared: PreparedPackageContribution,
        phase: FacetInstallPhase,
        failure: Error | string,
        context: FacetLifecycleContext
    ): Promise<FacetActivationOutcome> {
        let reason = failure instanceof Error ? failure.message : failure;
        try {
            await facet.stop(context);
        } catch (error) {
            const stopReason = error instanceof Error ? error.message : String(error);
            reason = `${reason}; Facet stop failed: ${stopReason}`;
        }
        if (phase.materializedRecords) {
            this.withdrawal.withdraw(prepared.reference.attribution);
        }
        this.evidence.record(
            new FacetInstallFailure({
                attribution: prepared.reference.attribution,
                packageFacet: prepared.reference.packageFacet,
                manifestDigest: prepared.manifestDigest,
                materialization: prepared.materialization,
                phase,
                reason
            })
        );
        return Object.freeze({ kind: "failed", facet: facet.ref, reason });
    }
}

function contributionRecordCount(records: WorkspaceContributionWithdrawalSet): number {
    return (
        records.catalogEntries.length +
        records.ingressEndpoints.length +
        records.promptSections.length +
        records.settingsLayers.length +
        records.surfaces.length
    );
}
