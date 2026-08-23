import { PackageInstallationProvenancePort, type PreparedPackageContribution } from "../definition";
import { AgentCoreError } from "../errors";
import { WorkspacePersistence, type SubscriptionMaterializationInit } from "./persistence";
import { Subscription } from "./subscription";

/**
 * Materializes a Facet-contributed Subscription only while the authenticated package
 * installation provenance is current. It never accepts caller-supplied attribution.
 */
export class WorkspaceSubscriptionMaterializer<Read, Transaction, Context> {
    public constructor(
        private readonly persistence: WorkspacePersistence<Transaction>,
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
        init: SubscriptionMaterializationInit
    ): Subscription {
        const subscription = this.provenance.withAuthenticatedContribution(
            transaction,
            context,
            prepared.stamp,
            (contribution) =>
                this.persistence.materializeSubscription(transaction, contribution, init)
        );
        if (subscription === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Subscription contributor installation provenance changed before materialization"
            );
        }
        return subscription;
    }
}
