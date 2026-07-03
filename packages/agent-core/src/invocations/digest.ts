import { createHash } from "node:crypto";
import { isFacetDataMap, type FacetData } from "../facets/data";
import { Digest } from "../record";

/**
 * Approval and revalidation digests are collision-resistant (SPEC §7.3): approvals
 * bind to this digest, so anything weaker than SHA-256 would let crafted arguments
 * satisfy an approval issued for benign ones.
 */
export function digestFacetData(value: FacetData): Digest {
    const hash = createHash("sha256").update(stableFacetData(value)).digest("hex");
    return new Digest(`facet:${hash}`);
}

function stableFacetData(value: FacetData): string {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(stableFacetData).join(",")}]`;
    }

    if (!isFacetDataMap(value)) {
        throw new TypeError("Facet data digest requires valid Facet data");
    }

    const entries = Object.keys(value)
        .sort()
        .map(key => {
            const child = value[key];
            if (child === undefined) {
                throw new TypeError("Facet data object contained an undefined value");
            }

            return `${JSON.stringify(key)}:${stableFacetData(child)}`;
        });

    return `{${entries.join(",")}}`;
}
