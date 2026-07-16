// @ts-nocheck
import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { WEB_CONTRIBUTIONS } from "./facet";

export const WEB_ISOLATION = Object.freeze(["provider"] as const);

export function createWebManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: WEB_ISOLATION,
        contributions: WEB_CONTRIBUTIONS
    });
}
