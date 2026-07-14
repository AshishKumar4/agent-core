export interface SpecRequirement {
    readonly id: string;
    readonly owner: string;
    readonly text: string;
    readonly digest: string;
}

export function specRequirements(path?: string): Promise<SpecRequirement[]>;
