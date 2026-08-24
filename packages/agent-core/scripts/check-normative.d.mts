export type DeclarationOrigin = "sourced" | "synthetic";

export interface StructuralPackageOutput {
    readonly allowedAxioms: readonly string[];
    readonly auditedModules: readonly string[];
    readonly declarations: readonly Record<string, unknown>[];
    readonly designations: readonly Record<string, unknown>[];
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
export function parseOriginMarker(structure: unknown): DeclarationOrigin;
export function generateNormativeLock(): string;
export function checkNormativeLock(options?: { update?: boolean }): void;
