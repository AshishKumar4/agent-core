import { PackageInstallationProvenancePort, type PreparedPackageContribution } from "../definition";
import { AgentCoreError } from "../errors";
import type { IngressEndpointMaterializationInit } from "./ingress-endpoint";
import type { WorkspaceIngressEndpointStore } from "./ingress-store";
import type { IngressEndpoint } from "./ingress-endpoint";

/**
 * Materializes a Facet-contributed ingress endpoint only while the authenticated package
 * installation provenance is current. It never accepts caller-supplied attribution: the
 * attribution pair is derived inside the provenance callback and consumed by the store.
 */
export class WorkspaceIngressEndpointMaterializer<Read, Transaction, Context> {
    public constructor(
        private readonly store: WorkspaceIngressEndpointStore<Transaction>,
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
        init: IngressEndpointMaterializationInit
    ): IngressEndpoint {
        const endpoint = this.provenance.withAuthenticatedContribution(
            transaction,
            context,
            prepared.stamp,
            (contribution) =>
                this.store.materializeIngressEndpoint(transaction, contribution, init)
        );
        if (endpoint === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Ingress endpoint contributor installation provenance changed before materialization"
            );
        }
        return endpoint;
    }
}
