import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { SELF_CONTRIBUTIONS } from "./facet";

export const SELF_ISOLATION = Object.freeze(["bundled"] as const);

export function createSelfManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: SELF_ISOLATION,
        contributions: SELF_CONTRIBUTIONS
    });
}
