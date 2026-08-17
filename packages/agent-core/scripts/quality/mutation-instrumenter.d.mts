import type { MutationSite } from "./mutation-equivalence.mjs";

export function generatedMutants(file: string, text: string): Promise<MutationSite[]>;
