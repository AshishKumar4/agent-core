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
import type {
    IngressEndpointId,
    RoutingWithdrawal,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal
} from "../workspaces";
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

export interface FacetWithdrawalPlan {
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly subscriptions: number;
}

export interface FacetWithdrawalResult {
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly routing: RoutingWithdrawal;
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
        private readonly transaction: ControlTransaction<Transaction>
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

    public withdraw(attribution: ContributionAttribution): FacetWithdrawalResult {
        try {
            return this.transaction((transaction) => {
                const planned = this.planInTransaction(transaction, attribution);
                const routing = this.routing.retire(transaction, attribution);
                this.slots.retireWithdrawalSet(transaction, attribution);
                this.retireRecords(transaction, planned.records);
                return Object.freeze({
                    attribution,
                    records: planned.records,
                    slots: planned.slots,
                    routing
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
                subscriptions: this.routing.contributed(transaction, attribution).length
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Withdrawal set is not computable from Workspace records: ${error instanceof Error ? error.message : String(error)}`
            );
        }
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

export type FacetActivationOutcome =
    | { readonly kind: "active"; readonly facet: FacetRef }
    | { readonly kind: "failed"; readonly facet: FacetRef; readonly reason: string };

export class FacetActivation<Transaction, Read, Context> {
    public constructor(
        private readonly withdrawal: FacetWithdrawal<Transaction>,
        private readonly materializer: WorkspaceFacetMaterializer<Transaction, Read, Context>,
        private readonly transaction: ControlTransaction<Transaction>
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
        const before = this.withdrawal.plan(prepared.reference.attribution);
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
        try {
            await facet.start(lifecycleContext);
        } catch (error) {
            this.materializer.discard(prepared);
            return this.failed(
                facet,
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
                error instanceof Error ? error : String(error),
                lifecycleContext
            );
        }
        return Object.freeze({ kind: "active", facet: contributor });
    }

    private async failed(
        facet: CorrespondentFacet,
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
