import { ContributionAttribution } from "./attribution";
import { FacetPackageId } from "./id";

/**
 * The authenticated installation a materializing host reads a contribution under. It
 * carries the §4.2 attribution rather than a bare FacetRef, so a host that cannot name
 * both the contributing Facet and the release it was read from cannot build one — which
 * is what makes refusal, not unattributed materialization, the only other outcome.
 */
export class PackageInstallationRef {
    public constructor(
        public readonly attribution: ContributionAttribution,
        public readonly packageFacet: FacetPackageId
    ) {
        if (
            !(attribution instanceof ContributionAttribution) ||
            !(packageFacet instanceof FacetPackageId)
        ) {
            throw new TypeError(
                "Package installation reference requires canonical Facet identities"
            );
        }
        Object.freeze(this);
    }
}
