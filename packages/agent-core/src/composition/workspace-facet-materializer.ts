import { Digest, Revision, encodeCanonicalJson } from "../core";
import {
    PackageInstallationProvenancePort,
    consumeAuthenticatedContribution,
    type LoadedBlueprint,
    type ManagedOrigin,
    type PreparedPackageContribution
} from "../definition";
import { AgentCoreError } from "../errors";
import {
    Automation,
    CatalogEntry,
    Command,
    ContributionAttribution,
    FacetManifest,
    IngressDeclaration,
    InstalledSlot,
    OperationDescriptor,
    PayloadMapping,
    PromptContribution,
    PromptSection,
    SettingsLayer,
    SlotDeclaration,
    SlotEntry,
    SurfaceDescriptor,
    SurfaceRegistration,
    commandAutomation,
    type WorkspaceSlotStore
} from "../facets";
import type { ScopeRef } from "../identity";
import { FacetCorrespondenceValidator, type ValidatedFacetRuntime } from "../operations";
import { SubscriptionId } from "../interaction-references";
import {
    IngressEndpoint,
    IngressEndpointId,
    WorkspacePersistence,
    type SubscriptionMaterializationInit
} from "../workspaces";
import type { ControlTransaction } from "./facet-withdrawal";

type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

export interface WorkspaceFacetMaterializationResult {
    readonly attribution: ContributionAttribution;
    readonly catalogEntries: number;
    readonly ingressEndpoints: number;
    readonly promptSections: number;
    readonly settingsLayers: number;
    readonly slotDeclarations: number;
    readonly slotEntries: number;
    readonly subscriptions: number;
    readonly surfaces: number;
}

interface DerivedContributionRecords {
    readonly catalogs: readonly CatalogEntry[];
    readonly ingress: readonly IngressEndpoint[];
    readonly prompts: readonly PromptSection[];
    readonly settings: readonly SettingsLayer[];
    readonly slots: readonly InstalledSlot[];
    readonly entries: readonly SlotEntry[];
    readonly subscriptions: readonly SubscriptionMaterializationInit[];
    readonly surfaces: readonly SurfaceRegistration[];
}

/**
 * Materializes one started Facet's complete manifest through the Workspace Actor's real
 * primitive stores. Installation provenance is rechecked and consumed inside the caller's
 * synchronous transaction; every record either commits together or the transaction rolls
 * them all back.
 */

export class WorkspacePackageFacetMaterialization<Transaction, Read, Context, Loaded> {
    public constructor(
        private readonly facetMaterializer: WorkspaceFacetMaterializer<Transaction, Read, Context>,
        private readonly transaction: ControlTransaction<Transaction>,
        private readonly read: Read,
        private readonly contextFor: (facet: CorrespondentFacet) => Context
    ) {}

    public materialize(
        _loaded: LoadedBlueprint<Loaded>,
        facets: readonly CorrespondentFacet[]
    ): void {
        const prepared: {
            readonly contribution: PreparedPackageContribution;
            readonly facet: CorrespondentFacet;
        }[] = [];
        try {
            for (const facet of facets) {
                const contribution = this.facetMaterializer.prepareContribution(
                    this.read,
                    this.contextFor(facet)
                );
                if (contribution === undefined) {
                    throw new AgentCoreError(
                        "authority.denied",
                        `Facet ${facet.ref.value} has no current installation provenance`
                    );
                }
                prepared.push({ contribution, facet });
            }
            this.transaction((transaction) => {
                for (const entry of prepared) {
                    this.facetMaterializer.materialize(
                        transaction,
                        this.contextFor(entry.facet),
                        entry.contribution,
                        entry.facet
                    );
                }
            });
        } finally {
            for (const entry of prepared) {
                this.facetMaterializer.discard(entry.contribution);
            }
        }
    }
}

export class WorkspaceFacetMaterializer<Transaction, Read, Context> {
    public constructor(
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly slots: WorkspaceSlotStore<Transaction>,
        private readonly provenance: PackageInstallationProvenancePort<Read | Transaction, Context>,
        private readonly scope: ScopeRef
    ) {}

    public prepareContribution(
        read: Read,
        context: Context
    ): PreparedPackageContribution | undefined {
        return this.provenance.prepareContribution(read, context);
    }

    public materialize(
        transaction: Transaction,
        context: Context,
        prepared: PreparedPackageContribution,
        facet: CorrespondentFacet
    ): WorkspaceFacetMaterializationResult {
        FacetCorrespondenceValidator.require(facet);
        const result = this.provenance.withAuthenticatedContribution(
            transaction,
            context,
            prepared.stamp,
            (token) => {
                const attribution = consumeAuthenticatedContribution(token);
                if (attribution === undefined) {
                    throw new AgentCoreError(
                        "authority.denied",
                        "Facet materialization requires authenticated contribution provenance"
                    );
                }
                this.requireExactInstallation(facet, prepared, attribution);
                const desired = deriveContributionRecords(
                    facet,
                    attribution,
                    prepared.materialization,
                    this.scope
                );
                this.reconcile(transaction, attribution, desired);
                return freezeResult(attribution, desired);
            }
        );
        if (result === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Facet installation provenance changed before materialization"
            );
        }
        return result;
    }
    public discard(prepared: PreparedPackageContribution): void {
        this.provenance.discardPreparedContribution(prepared.stamp);
    }

    private requireExactInstallation(
        facet: CorrespondentFacet,
        prepared: PreparedPackageContribution,
        attribution: ContributionAttribution
    ): void {
        if (
            !facet.ref.equals(attribution.contributor) ||
            !facet.ref.packageId.equals(facet.manifest.id) ||
            !prepared.reference.attribution.equals(attribution) ||
            !prepared.reference.packageFacet.equals(facet.manifest.id) ||
            !prepared.manifestDigest.equals(Digest.sha256(FacetManifest.encode(facet.manifest)))
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Facet instance, manifest, and authenticated installation do not match"
            );
        }
    }

    private reconcile(
        transaction: Transaction,
        attribution: ContributionAttribution,
        desired: DerivedContributionRecords
    ): void {
        const contributor = attribution.contributor;
        retireAbsent(
            this.persistence
                .listCatalogEntries(transaction)
                .filter((entry) => entry.attribution?.contributor.equals(contributor) === true),
            desired.catalogs,
            (record) => record.id.value,
            (record) => this.persistence.retireCatalogEntry(transaction, record.id)
        );
        retireAbsent(
            this.persistence
                .listIngressEndpoints(transaction)
                .filter(
                    (endpoint) => endpoint.contribution?.contributor.equals(contributor) === true
                ),
            desired.ingress,
            (record) => record.id.value,
            (record) => this.persistence.retireIngressEndpoint(transaction, record.id)
        );
        retireAbsent(
            this.persistence
                .listPromptSections(transaction)
                .filter((section) => section.attribution.contributor.equals(contributor)),
            desired.prompts,
            (record) => record.id.value,
            (record) => this.persistence.retirePromptSection(transaction, record.id)
        );
        retireAbsent(
            this.persistence
                .listSettingsLayers(transaction)
                .filter((layer) => layer.attribution.contributor.equals(contributor)),
            desired.settings,
            (record) => record.id.value,
            (record) => this.persistence.retireSettingsLayer(transaction, record.id)
        );
        retireAbsent(
            this.persistence
                .listSurfaceRegistrations(transaction)
                .filter((registration) => registration.attribution.contributor.equals(contributor)),
            desired.surfaces,
            (record) => record.descriptor.id.value,
            (record) =>
                this.persistence.retireSurfaceRegistration(transaction, record.descriptor.id)
        );
        const desiredSubscriptionIds = new Set(
            desired.subscriptions.map((subscription) => subscription.id.value)
        );
        for (const subscription of this.persistence
            .listSubscriptions(transaction)
            .filter((candidate) => candidate.contribution?.contributor.equals(contributor))) {
            if (!desiredSubscriptionIds.has(subscription.id.value)) {
                this.persistence.retireSubscription(transaction, subscription);
            }
        }
        let slotChanged = retireAbsent(
            this.slots
                .listSlots(transaction)
                .filter((slot) => slot.attribution.contributor.equals(contributor)),
            desired.slots,
            (record) => record.declaration.name.value,
            (record) => this.slots.retireSlot(transaction, record.declaration.name)
        );
        slotChanged =
            retireAbsent(
                this.slots
                    .listAllEntries(transaction)
                    .filter((entry) => entry.attribution.contributor.equals(contributor)),
                desired.entries,
                (record) => record.id.value,
                (record) => this.slots.retireEntry(transaction, record.id)
            ) || slotChanged;

        for (const slot of desired.slots) {
            slotChanged = putSlot(transaction, this.slots, slot) || slotChanged;
        }
        for (const entry of desired.entries) {
            slotChanged = putSlotEntry(transaction, this.slots, entry) || slotChanged;
        }
        if (slotChanged) {
            this.slots.saveRevision(transaction, this.slots.loadRevision(transaction).next());
        }
        for (const record of desired.catalogs)
            this.persistence.putCatalogEntry(transaction, record);
        for (const record of desired.prompts)
            this.persistence.putPromptSection(transaction, record);
        for (const record of desired.settings)
            this.persistence.putSettingsLayer(transaction, record);
        for (const record of desired.surfaces) {
            this.persistence.putSurfaceRegistration(transaction, record);
        }
        for (const record of desired.ingress) {
            this.persistence.putManagedIngressEndpoint(transaction, record);
        }
        for (const init of desired.subscriptions) {
            this.persistence.putManagedSubscription(transaction, attribution, init);
        }
    }
}

function deriveContributionRecords(
    facet: CorrespondentFacet,
    attribution: ContributionAttribution,
    materialization: ManagedOrigin,
    scope: ScopeRef
): DerivedContributionRecords {
    const catalogs: CatalogEntry[] = [];
    const ingress: IngressEndpoint[] = [];
    const prompts: PromptSection[] = [];
    const settings: SettingsLayer[] = [];
    const slots: InstalledSlot[] = [];
    const entries: SlotEntry[] = [];
    const subscriptions: SubscriptionMaterializationInit[] = [];
    const surfaces: SurfaceRegistration[] = [];
    let promptPosition = 0;

    for (const contribution of facet.manifest.contributions.entries) {
        for (const [ordinal, value] of contribution.entries.entries()) {
            switch (contribution.slot.value) {
                case "automations":
                    subscriptions.push(
                        subscriptionInit(
                            attribution,
                            materialization,
                            "automations",
                            ordinal,
                            Automation.fromData(value)
                        )
                    );
                    break;
                case "commands": {
                    const command = Command.fromData(value);
                    catalogs.push(new CatalogEntry("command", command.name, command, attribution));
                    subscriptions.push(
                        subscriptionInit(
                            attribution,
                            materialization,
                            "commands",
                            ordinal,
                            commandAutomation(command)
                        )
                    );
                    break;
                }
                case "ingress": {
                    const declared = IngressDeclaration.fromData(value);
                    ingress.push(
                        new IngressEndpoint({
                            id: new IngressEndpointId(
                                derivedId(
                                    "ingress",
                                    attribution,
                                    materialization,
                                    ordinal,
                                    declared.path
                                )
                            ),
                            revision: Revision.initial(),
                            scope,
                            declared,
                            contribution: attribution
                        })
                    );
                    break;
                }
                case "operations": {
                    const operation = OperationDescriptor.fromData(value);
                    catalogs.push(
                        new CatalogEntry("operation", operation.name.value, operation, attribution)
                    );
                    break;
                }
                case "prompt":
                    for (const prompt of PromptContribution.fromData(value).sections) {
                        prompts.push(
                            new PromptSection(
                                prompt.title,
                                prompt.body,
                                prompt.priority,
                                attribution,
                                promptPosition
                            )
                        );
                        promptPosition += 1;
                    }
                    break;
                case "settings":
                    settings.push(new SettingsLayer(attribution, ordinal, value));
                    break;
                case "slots":
                    slots.push(new InstalledSlot(SlotDeclaration.fromData(value), attribution));
                    break;
                case "surfaces":
                    surfaces.push(
                        new SurfaceRegistration(SurfaceDescriptor.fromData(value), attribution)
                    );
                    break;
                case "events":
                case "interceptors":
                    break;
                default:
                    entries.push(new SlotEntry(contribution.slot, attribution, ordinal, value));
                    break;
            }
        }
    }
    return {
        catalogs: Object.freeze(catalogs),
        ingress: Object.freeze(ingress),
        prompts: Object.freeze(prompts),
        settings: Object.freeze(settings),
        slots: Object.freeze(slots),
        entries: Object.freeze(entries),
        subscriptions: Object.freeze(subscriptions),
        surfaces: Object.freeze(surfaces)
    };
}

function subscriptionInit(
    attribution: ContributionAttribution,
    materialization: ManagedOrigin,
    slot: string,
    ordinal: number,
    automation: Automation
): SubscriptionMaterializationInit {
    return {
        id: new SubscriptionId(
            derivedId(slot, attribution, materialization, ordinal, automation.target.value)
        ),
        source: automation.source,
        target: automation.target,
        mapping: automation.mapping ?? PayloadMapping.identity,
        dedupe: automation.dedupe ?? "event",
        authority: {
            kind: automation.authority ?? "initiator",
            binding: automation.binding
        }
    };
}

function derivedId(
    kind: string,
    attribution: ContributionAttribution,
    materialization: ManagedOrigin,
    ordinal: number,
    identity: string
): string {
    return Digest.sha256(
        encodeCanonicalJson({
            ...attribution.encodeFields(),
            materialization: materialization.toData(),
            identity,
            kind,
            ordinal
        })
    ).value;
}

function retireAbsent<Record>(
    current: readonly Record[],
    desired: readonly Record[],
    key: (record: Record) => string,
    retire: (record: Record) => void
): boolean {
    const desiredKeys = new Set(desired.map(key));
    let changed = false;
    for (const record of current) {
        if (desiredKeys.has(key(record))) continue;
        retire(record);
        changed = true;
    }
    return changed;
}

function putSlot<Transaction>(
    transaction: Transaction,
    store: WorkspaceSlotStore<Transaction>,
    desired: InstalledSlot
): boolean {
    const current = store.loadSlot(transaction, desired.declaration.name);
    if (current !== undefined) {
        if (!current.attribution.contributor.equals(desired.attribution.contributor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Slot ${desired.declaration.name.value} belongs to another contributor`
            );
        }
        if (sameBytes(InstalledSlot.encode(current), InstalledSlot.encode(desired))) {
            return false;
        }
        store.retireSlot(transaction, current.declaration.name);
    }
    store.insertSlot(transaction, desired);
    return true;
}

function putSlotEntry<Transaction>(
    transaction: Transaction,
    store: WorkspaceSlotStore<Transaction>,
    desired: SlotEntry
): boolean {
    const current = store.loadEntryAt(transaction, desired.origin);
    if (current !== undefined) {
        if (!current.attribution.contributor.equals(desired.attribution.contributor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Slot entry origin belongs to another contributor"
            );
        }
        if (sameBytes(SlotEntry.encode(current), SlotEntry.encode(desired))) {
            return false;
        }
        store.retireEntry(transaction, current.id);
    }
    store.insertEntry(transaction, desired);
    return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function freezeResult(
    attribution: ContributionAttribution,
    records: DerivedContributionRecords
): WorkspaceFacetMaterializationResult {
    return Object.freeze({
        attribution,
        catalogEntries: records.catalogs.length,
        ingressEndpoints: records.ingress.length,
        promptSections: records.prompts.length,
        settingsLayers: records.settings.length,
        slotDeclarations: records.slots.length,
        slotEntries: records.entries.length,
        subscriptions: records.subscriptions.length,
        surfaces: records.surfaces.length
    });
}
