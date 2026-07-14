import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { TASK_CONTRIBUTIONS } from "./facet";

export const TASK_ISOLATION = Object.freeze(["provider", "bundled"] as const);

export function createTaskManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: TASK_ISOLATION,
        contributions: TASK_CONTRIBUTIONS
    });
}
