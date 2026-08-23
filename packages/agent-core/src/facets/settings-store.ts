import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { JsonSchema, Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import type { ContributionAttribution } from "./attribution";
import { compareText, type FacetData } from "./data";
import type { SettingsLayerId } from "./id";
import { equalBytes } from "./record-map";
import { SettingsLayer, SettingsLayerOrigin } from "./settings";

/**
 * The settings layers one Workspace Actor retires for one withdrawing contribution
 * (SPEC §4.1). The set matches the complete immutable FacetRef and PackagePin pair, so
 * another release of the same Facet remains live.
 */
export class SettingsWithdrawalSet {
    public readonly layers: readonly SettingsLayerId[];

    public constructor(
        public readonly attribution: ContributionAttribution,
        layers: readonly SettingsLayerId[]
    ) {
        this.layers = Object.freeze([...layers]);
        Object.freeze(this);
    }
}

/**
 * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): the durable plane holding one Scope's
 * materialized settings layers — the per-Facet fragments whose merge composes the platform
 * config schema. The store holds the attributed layers only; the merged view is derived on
 * every read (`composedSchema`) rather than stored beside them, so no second copy of it can
 * drift from the records that produce it.
 */
export abstract class WorkspaceSettingsStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadLayer(
        transaction: Transaction,
        id: SettingsLayerId
    ): SettingsLayer | undefined;
    /**
     * The layer occupying a contribution's §4.2 position, or none. It is a separate lookup
     * from `loadLayer` because the two answer different questions: an id answers whether a
     * particular record is stored, an origin answers what a new contribution supersedes.
     */
    public abstract loadLayerAt(
        transaction: Transaction,
        origin: SettingsLayerOrigin
    ): SettingsLayer | undefined;
    public abstract insertLayer(transaction: Transaction, layer: SettingsLayer): void;
    public abstract retireLayer(transaction: Transaction, id: SettingsLayerId): void;
    public abstract listLayers(transaction: Transaction): readonly SettingsLayer[];

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    /** The stored layers in their deterministic precedence order (see `layerPrecedence`). */
    public layers(): readonly SettingsLayer[] {
        return this.transaction((transaction) =>
            [...this.listLayers(transaction)].sort(layerPrecedence)
        );
    }

    /**
     * SPEC §4.2: a position holds at most one layer per contributor per ordinal. Because
     * the layer id digests exactly the declared fields, re-materializing the same
     * contribution from the same release is the same record and changes nothing, while a
     * changed fragment or a later release supersedes its predecessor inside this one
     * transaction rather than accreting beside it.
     */
    public contribute(layer: SettingsLayer): Revision {
        return this.transaction((transaction) => {
            const superseded = this.loadLayerAt(transaction, layer.origin);
            if (superseded !== undefined) {
                if (equalBytes(SettingsLayer.encode(superseded), SettingsLayer.encode(layer))) {
                    return this.loadRevision(transaction);
                }
                this.retireLayer(transaction, superseded.id);
            }
            this.insertLayer(transaction, layer);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * Computes the withdrawal set from the complete immutable attribution. Decoding every
     * stored layer is the query: unreadable attribution makes the set incomputable, so the
     * caller refuses rather than withdrawing a partial result.
     */
    public withdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): SettingsWithdrawalSet {
        return new SettingsWithdrawalSet(
            attribution,
            this.listLayers(transaction)
                .filter((layer) => layer.attribution.equals(attribution))
                .map((layer) => layer.id)
        );
    }

    /** Retires one release's settings layers inside the caller's control transaction. */
    public retireWithdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): boolean {
        const set = this.withdrawalSet(transaction, attribution);
        if (set.layers.length === 0) return false;
        for (const id of set.layers) this.retireLayer(transaction, id);
        return true;
    }

    public withdraw(attribution: ContributionAttribution): Revision {
        return this.transaction((transaction) => {
            if (!this.retireWithdrawalSet(transaction, attribution)) {
                return this.loadRevision(transaction);
            }
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * The §4.2 merged platform config schema derived from the stored layers. Precedence is
     * the definition plane's existing canonical policy — fragments ordered by the source
     * release's package ID in canonical text order, exactly as `composeConfigSchema`
     * orders releases — extended below package granularity by contributor and declared
     * ordinal so two Facets of one package still compose deterministically. The result is
     * computed from the records on every call: nothing here stores it, so a withdrawal is
     * visible to the very next read.
     */
    public composedSchema(base: JsonSchema): JsonSchema {
        // Insertion order over an explicit key list, because property order is part of the
        // derived view's determinism.
        const groupOrder: string[] = [];
        const fragmentsByGroup: { [groupId: string]: FacetData[] } = {};
        for (const layer of this.layers()) {
            const groupId = layer.attribution.package.id.value;
            const fragments = fragmentsByGroup[groupId];
            if (fragments === undefined) {
                groupOrder.push(groupId);
                fragmentsByGroup[groupId] = [layer.schema.document];
            } else {
                fragments.push(layer.schema.document);
            }
        }
        const properties: { [name: string]: FacetData } = {};
        for (const groupId of groupOrder) {
            const fragments = fragmentsByGroup[groupId]!;
            properties[groupId] =
                fragments.length > 1 ? { allOf: fragments } : fragments[0]!;
        }
        return new JsonSchema({
            allOf: [
                base.document,
                {
                    additionalProperties: false,
                    properties,
                    required: groupOrder,
                    type: "object"
                }
            ]
        });
    }

    /**
     * The origin exclusivity §4.2 requires, enforced where every implementation shares it.
     * A storage primitive that admitted a second layer at one origin would make
     * supersession unobservable, so the refusal belongs to the seam rather than to each
     * store.
     */
    protected requireFreeOrigin(transaction: Transaction, layer: SettingsLayer): void {
        const occupant = this.loadLayerAt(transaction, layer.origin);
        if (occupant !== undefined && !occupant.id.equals(layer.id)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Settings position ${occupant.origin.ordinal} is held by ${occupant.origin.contributor.value}`
            );
        }
    }
}

/**
 * Layer precedence: the source release's package ID first, then the contributing Facet,
 * then the declaration order within one Facet's manifest. All three keys are canonical
 * text compared with the definition plane's own ordering policy.
 */
function layerPrecedence(left: SettingsLayer, right: SettingsLayer): number {
    const leftPackage = left.attribution.package.id.value;
    const rightPackage = right.attribution.package.id.value;
    if (leftPackage !== rightPackage) return compareText(leftPackage, rightPackage);
    const leftContributor = left.attribution.contributor.value;
    const rightContributor = right.attribution.contributor.value;
    if (leftContributor !== rightContributor) {
        return compareText(leftContributor, rightContributor);
    }
    return left.ordinal - right.ordinal;
}
