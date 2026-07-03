import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { AuthoritySummary, FacetDescription } from "../description";
import { FacetVersion } from "../id";
import { PromptContribution, PromptSection } from "../prompt";

const VERSION = new FacetVersion("1.0.0");
const PROMPT_PRIORITY = 100;

export class McpFacet extends Facet {
    public constructor(context: FacetContext) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "MCP",
            "Describes Model Context Protocol capabilities exposed by configured servers.",
            VERSION,
            AuthoritySummary.scoped("Configured MCP servers may provide tools, resources, and prompts.")
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(
                "MCP",
                "Use this facet for MCP capability descriptors. It does not provide substrate operations by default.",
                PROMPT_PRIORITY
            )
        ]);
    }

}
