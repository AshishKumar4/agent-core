import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { SHELL_CONTRIBUTIONS } from "./facet";

export const SHELL_ISOLATION = Object.freeze(["provider", "bundled"] as const);
export const SHELL_REQUIRED_BINDING = "env.fs";

export function createShellManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: SHELL_ISOLATION,
        contributions: SHELL_CONTRIBUTIONS,
        requiredBindings: [SHELL_REQUIRED_BINDING]
    });
}
