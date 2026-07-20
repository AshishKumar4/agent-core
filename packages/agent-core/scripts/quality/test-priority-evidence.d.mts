export type TestPriority = "p0" | "p1" | "p2";

export const TEST_PRIORITIES: readonly TestPriority[];

export function requireNonP2ConformanceEvidence(
    requirement: string,
    selectors: readonly string[],
    classified: Record<TestPriority, readonly string[]>
): void;
