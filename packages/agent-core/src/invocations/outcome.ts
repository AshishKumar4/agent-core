import type { Receipt } from "./receipt";

export type BatchOutcome =
    "succeeded" | "partiallySucceeded" | "failed" | "denied" | "cancelled" | "indeterminate";

export type TerminalBatchOutcome = Exclude<BatchOutcome, "indeterminate">;

export function deriveBatchOutcome(
    itemCount: number,
    receipts: readonly (Receipt | undefined)[]
): BatchOutcome | undefined {
    requireReceiptSlots(itemCount, receipts);
    if (!isCompleteReceipts(receipts)) return undefined;
    const outcomes = receipts.map((receipt) => receipt.outcome);
    if (outcomes.includes("indeterminate")) return "indeterminate";
    if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
    if (outcomes.includes("succeeded")) return "partiallySucceeded";
    if (outcomes.includes("failed")) return "failed";
    if (outcomes.includes("cancelledPreEffect")) return "cancelled";
    return "denied";
}

function isCompleteReceipts(
    receipts: readonly (Receipt | undefined)[]
): receipts is readonly Receipt[] {
    return receipts.every((receipt) => receipt !== undefined);
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
