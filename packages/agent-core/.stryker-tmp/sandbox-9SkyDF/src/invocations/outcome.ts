// @ts-nocheck
import type { Receipt } from "./receipt";

export type BatchOutcome =
    "succeeded" | "partiallySucceeded" | "failed" | "denied" | "cancelled" | "indeterminate";

export type TerminalBatchOutcome = Exclude<BatchOutcome, "indeterminate">;

export function deriveBatchOutcome(
    itemCount: number,
    receipts: readonly (Receipt | undefined)[]
): BatchOutcome | undefined {
    requireReceiptSlots(itemCount, receipts);
    if (receipts.some((receipt) => receipt === undefined)) return undefined;
    const complete = receipts as readonly Receipt[];
    const outcomes = complete.map((receipt) => receipt.outcome);
    if (outcomes.includes("indeterminate")) return "indeterminate";
    if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
    if (outcomes.includes("succeeded")) return "partiallySucceeded";
    if (outcomes.includes("failed")) return "failed";
    if (outcomes.includes("cancelledPreEffect")) return "cancelled";
    return "denied";
}

function requireReceiptSlots(itemCount: number, receipts: readonly (Receipt | undefined)[]): void {
    if (!Number.isSafeInteger(itemCount) || itemCount <= 0 || receipts.length !== itemCount) {
        throw new TypeError("Batch outcome requires one Receipt slot per nonempty invocation item");
    }
}

export function terminalBatchOutcome(
    outcome: BatchOutcome | undefined
): TerminalBatchOutcome | undefined {
    return outcome === undefined || outcome === "indeterminate" ? undefined : outcome;
}
