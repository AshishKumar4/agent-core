// @ts-nocheck
import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { MEMORY_CONTRIBUTIONS } from "./facet";

export const MEMORY_ISOLATION = Object.freeze(["provider", "bundled"] as const);

export function createMemoryManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: MEMORY_ISOLATION,
        contributions: MEMORY_CONTRIBUTIONS
    });
}
