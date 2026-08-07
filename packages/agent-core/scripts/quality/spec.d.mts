export interface SpecRequirement {
    readonly id: string;
    readonly owner: string;
    readonly text: string;
    readonly digest: string;
}

export interface SpecAtom extends SpecRequirement {
    readonly reviewed: boolean;
    readonly occurrences: number;
}

export interface NormativeMap {
    readonly authoritativeOutsideSection13: readonly string[];
}

export function specRequirements(path?: string): Promise<SpecRequirement[]>;
export function specAtoms(source: string, normativeMap: NormativeMap): SpecAtom[];
export function profileLabels(source: string): string[];
