/**
 * Declarations for `formal-policy.mjs`, so a typed reader shares the one reviewed axiom
 * policy rather than restating it. The list itself stays in the `.mjs` module: a second
 * copy of the allowlist is a second policy, and the gate that reads one would then be
 * checking something the other does not say.
 */

/** The kernel axioms the doctrine reviewed and admits (G-2). */
export const allowedBuiltInAxioms: readonly string[];

export interface FormalAxiomDesignation {
    readonly kind: "claim" | "witness";
    readonly name: string;
}

export function extractAxiomDesignations(source: string): FormalAxiomDesignation[];
