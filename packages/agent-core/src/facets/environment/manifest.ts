import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { ENVIRONMENT_CONTRIBUTIONS } from "./facet";

export const ENVIRONMENT_ISOLATION = Object.freeze(["provider"] as const);
export const ENVIRONMENT_PROVIDER_BINDING = "environment.provider";

export function createEnvironmentManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: ENVIRONMENT_ISOLATION,
        contributions: ENVIRONMENT_CONTRIBUTIONS,
        requiredBindings: [ENVIRONMENT_PROVIDER_BINDING]
    });
}
