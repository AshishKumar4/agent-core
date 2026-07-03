import type { FacetSet, PromptSection } from "../facets";

class PromptAssemblyEntry {
    public constructor(
        public readonly section: PromptSection,
        public readonly index: number
    ) {
    }
}

export class AgentPrompt {
    public readonly sections: readonly PromptSection[];

    public constructor(sections: readonly PromptSection[]) {
        this.sections = Object.freeze([...sections]);
    }

    public static empty(): AgentPrompt {
        return emptyAgentPrompt;
    }

    public static fromFacets(facets: FacetSet): AgentPrompt {
        const entries = facets.prompt().sections.map(
            (section, index) => new PromptAssemblyEntry(section, index)
        );
        const ordered = entries.toSorted((left, right) => {
            const priority = right.section.priority - left.section.priority;

            if (priority !== 0) {
                return priority;
            }

            return left.index - right.index;
        });

        return new AgentPrompt(ordered.map(entry => entry.section));
    }

    public render(): string {
        return this.sections
            .map(section => `## ${section.title}\n${section.body}`)
            .join("\n\n");
    }
}

const emptyAgentPrompt = new AgentPrompt([]);
