export interface SpecRequirement {
    readonly id: string;
    readonly owner: string;
    readonly text: string;
    readonly digest: string;
}

export interface SpecAtom extends SpecRequirement {
    readonly sourceDigest: string;
    readonly reviewed: boolean;
    readonly occurrences: number;
}

export interface SpecAnchor {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

export interface SpecVisibleBlock {
    readonly start: number;
    readonly end: number;
    readonly source: string;
    readonly prose: string;
    readonly rendered: string;
    readonly inlineCodeRanges: readonly (readonly [number, number])[];
}

export interface SpecUnit extends SpecVisibleBlock {
    readonly anchors: string[];
}

export interface UnsupportedSpecBlock extends SpecUnit {
    readonly kind: string;
}

export interface SpecHeading extends SpecUnit {
    readonly depth: number;
}

export interface SpecSection {
    readonly id: string;
    readonly depth: number;
    readonly start: number;
    readonly bodyStart: number;
    readonly end: number;
}

export interface CanonicalSpec {
    readonly source: string;
    readonly requirements: SpecRequirement[];
    readonly atoms: SpecAtom[];
    readonly anchors: SpecAnchor[];
    readonly units: SpecUnit[];
    readonly unsupportedBlocks: UnsupportedSpecBlock[];
    readonly visibleBlocks: SpecVisibleBlock[];
    readonly inlineCodePlaceholder: string;
    readonly headings: SpecHeading[];
    readonly sections: SpecSection[];
    readonly normativeSections: readonly string[];
    readonly normativeKeywords: readonly string[];
}

export function canonicalSpec(path?: string): Promise<CanonicalSpec>;
export function specRequirements(path?: string): Promise<SpecRequirement[]>;
export function compareSectionIds(left: string, right: string): number;
