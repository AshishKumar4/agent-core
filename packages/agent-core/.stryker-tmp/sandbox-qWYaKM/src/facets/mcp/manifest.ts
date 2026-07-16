// @ts-nocheck
import { JsonSchema } from "../../core";
import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { MCP_CONTRIBUTIONS } from "./facet";

export const MCP_ISOLATION = Object.freeze(["provider", "bundled"] as const);
export const MCP_PARENT_BINDING = "mcp.server";
export const MCP_CONFIG_CONSTRAINT = new JsonSchema({
    type: "object",
    properties: {
        remote: { type: "boolean" },
        maximumPrompts: { type: "integer", minimum: 1, maximum: 32 },
        maximumPromptBytes: { type: "integer", minimum: 1, maximum: 262144 }
    },
    required: ["remote", "maximumPrompts", "maximumPromptBytes"],
    additionalProperties: false
});

export function createMcpManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: MCP_ISOLATION,
        contributions: MCP_CONTRIBUTIONS,
        requiredBindings: [MCP_PARENT_BINDING],
        configConstraint: MCP_CONFIG_CONSTRAINT
    });
}
