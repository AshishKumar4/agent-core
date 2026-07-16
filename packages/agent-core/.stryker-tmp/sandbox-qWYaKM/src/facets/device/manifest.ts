// @ts-nocheck
import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { DEVICE_CONTRIBUTIONS } from "./facet";

export const DEVICE_ISOLATION = Object.freeze(["provider"] as const);
export const DEVICE_ENVIRONMENT_BINDING = "environment";

export function createDeviceManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: DEVICE_ISOLATION,
        contributions: DEVICE_CONTRIBUTIONS,
        requiredBindings: [DEVICE_ENVIRONMENT_BINDING]
    });
}
