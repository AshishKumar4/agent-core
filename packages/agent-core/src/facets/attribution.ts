import { PackagePin } from "../definition-references";
import type { FacetData, FacetDataMap } from "./data";
import { requireString } from "./data";
import { FacetRef } from "./id";

/** The two declared fields an attributed record absorbs into its own payload. */
export interface ContributionAttributionFields {
    readonly contributor: FacetData;
    readonly package: FacetData;
}

/**
 * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): the pair every record a contribution
 * materializes into carries — the exact Facet that contributed it and the release the
 * contribution was read from. It is one value object rather than two loose fields so that
 * every attributed record spells the pair the same way on the wire and the withdrawal
 * query of §4.1 reads one shape across record kinds.
 */
export class ContributionAttribution {
    /** The field names an attributed record's own declared fields absorb. */
    public static readonly fields: readonly string[] = Object.freeze(["contributor", "package"]);

    public readonly contributor: FacetRef;
    public readonly package: PackagePin;

    public constructor(contributor: FacetRef, pin: PackagePin) {
        // Totality is the load-bearing claim: a record whose attribution cannot be
        // constructed is refused here rather than materialized unattributed.
        if (!(contributor instanceof FacetRef) || !(pin instanceof PackagePin)) {
            throw new TypeError(
                "A materialized contribution carries its contributing FacetRef and source PackagePin"
            );
        }
        this.contributor = contributor;
        this.package = pin;
        Object.freeze(this);
    }

    public static decodeFields(object: FacetDataMap, subject: string): ContributionAttribution {
        const pin = object["package"];
        if (pin === undefined) {
            throw new TypeError(`${subject} carries no source Package pin`);
        }
        return new ContributionAttribution(
            new FacetRef(requireString(object["contributor"], `${subject} contributor`)),
            PackagePin.fromData(pin)
        );
    }

    public equals(other: ContributionAttribution): boolean {
        return this.contributor.equals(other.contributor) && this.package.equals(other.package);
    }

    public encodeFields(): ContributionAttributionFields {
        return { contributor: this.contributor.value, package: this.package.toData() };
    }
}
