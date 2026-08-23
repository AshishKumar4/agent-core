import type { EquivalenceEntry } from "./mutation-equivalence.mjs";

export function sourceAreas(): string[];
export function mutationTestFiles(): string[];
export function mutationFingerprint(area: string, register?: readonly EquivalenceEntry[]): string;
export function mutationRunKey(area: string, register?: readonly EquivalenceEntry[]): string;
