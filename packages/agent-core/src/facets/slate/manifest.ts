import { JsonSchema } from "../../core";
import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { SLATE_CONTRIBUTIONS, SLATE_ISOLATION } from "./facet";

export const SLATE_ENVIRONMENT_BINDING = "environment";
export const SLATE_CONFIG_CONSTRAINT = new JsonSchema({
    type: "object",
    properties: {
        backendIsolation: { const: "dynamic" },
        ambientAuthority: { const: false }
    },
    required: ["backendIsolation", "ambientAuthority"]
});

export function createSlateManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: SLATE_ISOLATION,
        contributions: SLATE_CONTRIBUTIONS,
        requiredBindings: [SLATE_ENVIRONMENT_BINDING],
        configConstraint: SLATE_CONFIG_CONSTRAINT
    });
}
