import {
    PackageInstallationProvenancePort,
    consumeAuthenticatedContribution,
    type PreparedPackageContribution
} from "../definition";
import { AgentCoreError } from "../errors";
import { CatalogEntry } from "../facets/catalog-entry";
import { WorkspaceCatalogStore } from "../facets/catalog-entry-store";

/** The declared coordinates a trusted materialization carries. */
export interface CatalogMaterializationInit {
    readonly kind: CatalogEntry["kind"];
    readonly name: string;
    readonly declaration: CatalogEntry["declaration"];
}

/**
 * Materializes a Facet-contributed catalog entry only while the authenticated package
 * installation provenance is current. It never accepts caller-supplied attribution: the
 * one-use `AuthenticatedContribution` minted inside the prepare/apply span is the only
 * source of the record's §4.2 pair, so a forged, replayed, or expired capability refuses
 * the whole materialization and nothing is written.
 */
export class CatalogMaterializer<Read, Transaction, Context> {
    public constructor(
        private readonly catalog: WorkspaceCatalogStore<Transaction>,
        private readonly provenance: PackageInstallationProvenancePort<Read | Transaction, Context>
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
        init: CatalogMaterializationInit
    ): CatalogEntry {
        const entry = this.provenance.withAuthenticatedContribution(
            transaction,
            context,
            prepared.stamp,
            (contribution) => {
                const attribution = consumeAuthenticatedContribution(contribution);
                if (attribution === undefined) {
                    throw new AgentCoreError(
                        "authority.denied",
                        "Catalog materialization requires authenticated contribution provenance"
                    );
                }
                const record = new CatalogEntry(
                    init.kind,
                    init.name,
                    init.declaration,
                    attribution
                );
                this.catalog.contribute(record);
                return record;
            }
        );
        if (entry === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Catalog contributor installation provenance changed before materialization"
            );
        }
        return entry;
    }
}
