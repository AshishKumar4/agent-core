export type DeclarationOrigin = "sourced" | "synthetic";
export type StructuralValue =
    | null
    | boolean
    | number
    | string
    | readonly StructuralValue[]
    | { readonly [key: string]: StructuralValue };

export interface StructuralDeclaration {
    readonly name: string;
    readonly structure: readonly StructuralValue[];
}

export interface StructuralDesignation {
    readonly axioms: readonly string[];
    readonly closure: readonly string[];
    readonly kind: string;
    readonly name: string;
    readonly type: StructuralValue;
}

export interface StructuralPackageOutput {
    readonly allowedAxioms: readonly string[];
    readonly auditedModules: readonly string[];
    readonly declarations: readonly StructuralDeclaration[];
    readonly designations: readonly StructuralDesignation[];
    readonly encoding: "agent-core-lean-structure-sourced-closure";
}

export const structuralPackageKeys: readonly [
    "auditedModules",
    "allowedAxioms",
    "declarations",
    "designations",
    "encoding"
];
export const originMarkers: readonly ["sourced", "synthetic"];

export function parseStructuralPackageLine(
    line: string,
    location: string
): StructuralPackageOutput;
export function structuralPackage(source: string): StructuralPackageOutput;
export function parseOriginMarker(structure: readonly StructuralValue[]): DeclarationOrigin;
export function generateNormativeLock(): string;
export function checkNormativeLock(options?: { update?: boolean }): void;
