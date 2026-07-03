import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { AuthoritySummary, FacetDescription } from "../description";
import { FacetVersion } from "../id";
import { PromptContribution, PromptSection } from "../prompt";

const VERSION = new FacetVersion("1.0.0");
const PROMPT_PRIORITY = 100;

export class ApprovalGatewayFacet extends Facet {
    public constructor(context: FacetContext) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Approval gateway",
            "Describes approval and policy boundaries for guarded actions.",
            VERSION,
            AuthoritySummary.scoped("Runtime policy decides whether guarded actions may proceed.")
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(
                "Approval gateway",
                "Use this facet for approval and policy descriptors. It does not provide substrate operations by default.",
                PROMPT_PRIORITY
            )
        ]);
    }

}
