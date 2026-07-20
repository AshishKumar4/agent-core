import type { TestPriority } from "./test-priority-evidence.mjs";

export type { TestPriority } from "./test-priority-evidence.mjs";

export interface PriorityCounts {
    readonly p0: number;
    readonly p1: number;
    readonly p2: number;
}

export interface PriorityEvidenceCounts extends PriorityCounts {
    readonly unclassified: number;
}

export function discoverPriorityTestFiles(): Promise<Record<TestPriority, string[]>>;

export function validatePriorityLanes(lanes: Record<TestPriority, unknown>): PriorityCounts;

export function validatePriorityEvidence(
    fullReport: unknown,
    lanes: Record<TestPriority, unknown>,
    stage: "building" | "final"
): PriorityEvidenceCounts;
