import type { FacetData } from "./data";
import {
    DataRecordCodec,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireSafeInteger,
    requireString
} from "./data";

export class Prompt {
    public constructor(
        public readonly title: string,
        public readonly body: string,
        public readonly priority: number
    ) {
        requireNonblank(title, "Prompt title");
        requireNonblank(body, "Prompt body");
        if (!Number.isSafeInteger(priority)) {
            throw new TypeError("Prompt priority must be a safe integer");
        }
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): Prompt {
        const object = requireDataObject(payload, "Prompt");
        requireExactFields(object, ["body", "priority", "title"]);
        return new Prompt(
            requireString(object["title"], "Prompt title"),
            requireString(object["body"], "Prompt body"),
            requireSafeInteger(object["priority"], "Prompt priority")
        );
    }

    public static encode(prompt: Prompt): Uint8Array {
        return promptCodec.encode(prompt);
    }

    public static decode(bytes: Uint8Array): Prompt {
        return promptCodec.decode(bytes);
    }

    public toData(): FacetData {
        return { body: this.body, priority: this.priority, title: this.title };
    }
}

const promptCodec = new DataRecordCodec(
    "facet.prompt",
    (prompt: Prompt) => prompt.toData(),
    (payload) => Prompt.fromData(payload)
);

export class PromptContribution {
    public readonly sections: readonly Prompt[];

    public constructor(sections: readonly Prompt[]) {
        const ordered = [...sections].sort(comparePrompts);
        this.sections = Object.freeze(ordered);
        Object.freeze(this);
    }

    public static empty(): PromptContribution {
        return emptyPromptContribution;
    }

    public static encode(contribution: PromptContribution): Uint8Array {
        return promptContributionCodec.encode(contribution);
    }

    public static decode(bytes: Uint8Array): PromptContribution {
        return promptContributionCodec.decode(bytes);
    }

    public toData(): FacetData {
        return this.sections.map((section) => section.toData());
    }
}

const promptContributionCodec = new DataRecordCodec(
    "facet.prompt-contribution",
    (contribution: PromptContribution) => contribution.toData(),
    (payload) =>
        new PromptContribution(requireArray(payload, "Prompt contribution").map(Prompt.fromData))
);

function comparePrompts(left: Prompt, right: Prompt): number {
    return (
        left.priority - right.priority ||
        compareText(left.title, right.title) ||
        compareText(left.body, right.body)
    );
}

const emptyPromptContribution = new PromptContribution([]);
