import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { AuthoritySummary, FacetDescription } from "../description";
import { FacetVersion } from "../id";
import { PromptContribution, PromptSection } from "../prompt";

const VERSION = new FacetVersion("1.0.0");
const PROMPT_PRIORITY = 100;

export class WebFacet extends Facet {
    public constructor(context: FacetContext) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Web",
            "Describes substrate-provided web retrieval and navigation capabilities.",
            VERSION,
            AuthoritySummary.scoped("External web resources may influence retrieved content.")
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(
                "Web",
                "Use this facet for web capability descriptors. It does not provide substrate operations by default.",
                PROMPT_PRIORITY
            )
        ]);
    }

}
