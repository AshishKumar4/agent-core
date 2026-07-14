import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { FILESYSTEM_CONTRIBUTIONS } from "./facet";

export const FILESYSTEM_ISOLATION = Object.freeze(["provider", "bundled"] as const);

export function createFilesystemManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: FILESYSTEM_ISOLATION,
        contributions: FILESYSTEM_CONTRIBUTIONS
    });
}
