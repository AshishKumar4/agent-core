// @ts-nocheck
import { FacetPackageId, FacetRef } from "./id";

export class PackageInstallationRef {
    public constructor(
        public readonly facet: FacetRef,
        public readonly packageFacet: FacetPackageId
    ) {
        if (!(facet instanceof FacetRef) || !(packageFacet instanceof FacetPackageId)) {
            throw new TypeError(
                "Package installation reference requires canonical Facet identities"
            );
        }
        Object.freeze(this);
    }
}
