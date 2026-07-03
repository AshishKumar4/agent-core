export class PromptSection {
    public constructor(
        public readonly title: string,
        public readonly body: string,
        public readonly priority: number
    ) {
        if (!Number.isSafeInteger(priority)) {
            throw new TypeError("Prompt priority must be a safe integer");
        }
    }
}

export class PromptContribution {
    public readonly sections: readonly PromptSection[];

    public constructor(sections: readonly PromptSection[]) {
        this.sections = Object.freeze([...sections]);
    }

    public static empty(): PromptContribution {
        return emptyPromptContribution;
    }

    public static of(sections: readonly PromptSection[]): PromptContribution {
        return new PromptContribution(sections);
    }

    public merge(other: PromptContribution): PromptContribution {
        return new PromptContribution([...this.sections, ...other.sections]);
    }
}

const emptyPromptContribution = new PromptContribution([]);
