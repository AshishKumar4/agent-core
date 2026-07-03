import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { AuthoritySummary, FacetDescription } from "../description";
import { FacetVersion } from "../id";
import { PromptContribution, PromptSection } from "../prompt";

const VERSION = new FacetVersion("1.0.0");
const PROMPT_PRIORITY = 100;

export class SelfFacet extends Facet {
    public constructor(context: FacetContext) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Self",
            "Describes the agent identity and substrate-neutral runtime capabilities.",
            VERSION,
            AuthoritySummary.none()
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(
                "Self",
                "Use this facet for agent identity and capability descriptors. It does not provide substrate operations by default.",
                PROMPT_PRIORITY
            )
        ]);
    }

}
