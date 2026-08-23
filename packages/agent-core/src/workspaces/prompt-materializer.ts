import {
    PackageInstallationProvenancePort,
    consumeAuthenticatedContribution,
    type PreparedPackageContribution
} from "../definition";
import { AgentCoreError } from "../errors";
import { PromptContribution, WorkspacePromptSectionStore, type PromptSection } from "../facets";

/**
 * Materializes a Facet's `prompt` contribution into attributed prompt-assembly sections only
 * while the authenticated package installation provenance is current (SPEC §4.2). It never
 * accepts caller-supplied attribution: the section records' `FacetRef` and `PackagePin` come
 * from the one-use capability this provenance port minted over the installation evidence,
 * which is what makes a materialized section's attribution trustworthy and its §4.1
 * withdrawal query exact. A structurally forged capability has no minted identity, a spent
 * stamp resolves nothing, and installation drift between prepare and apply refuses the
 * materialization rather than attributing sections to stale evidence.
 */
export class WorkspacePromptMaterializer<State, Context> {
    public constructor(
        private readonly store: WorkspacePromptSectionStore<unknown>,
        private readonly provenance: PackageInstallationProvenancePort<State, Context>
    ) {}

    public prepareContribution(
        read: State,
        context: Context
    ): PreparedPackageContribution | undefined {
        return this.provenance.prepareContribution(read, context);
    }

    public materializeSections(
        read: State,
        context: Context,
        prepared: PreparedPackageContribution,
        contribution: PromptContribution
    ): readonly PromptSection[] {
        const revision = this.provenance.withAuthenticatedContribution(
            read,
            context,
            prepared.stamp,
            (authenticated) => {
                const attribution = consumeAuthenticatedContribution(authenticated);
                if (attribution === undefined) {
                    throw new AgentCoreError(
                        "authority.denied",
                        "Prompt section materialization requires authenticated contribution provenance"
                    );
                }
                return this.store.contribute(attribution, [...contribution.sections]);
            }
        );
        if (revision === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Prompt contribution installation provenance changed before materialization"
            );
        }
        // The apply proof held the installation fixed between prepare and apply, so the
        // prepared reference names the exact contributor whose sections were just written.
        return this.store.sectionsOf(prepared.reference.attribution.contributor);
    }
}
