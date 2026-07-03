import { ObservedOperation, SpanOutcome } from "../observability";
import type { OperationContext } from "./context";

export type FailureCode = (error: unknown) => string;

export function observeOperation<Result>(
    context: OperationContext,
    operation: ObservedOperation,
    execute: () => Result,
    failureCode: FailureCode
): Result {
    const span = context.start(operation);

    try {
        const result = execute();
        span.end(SpanOutcome.succeeded());
        return result;
    } catch (error) {
        span.end(SpanOutcome.failed(failureCode(error)));
        throw error;
    }
}

export async function observeOperationAsync<Result>(
    context: OperationContext,
    operation: ObservedOperation,
    execute: () => Promise<Result>,
    failureCode: FailureCode
): Promise<Result> {
    const span = context.start(operation);

    try {
        const result = await execute();
        span.end(SpanOutcome.succeeded());
        return result;
    } catch (error) {
        span.end(SpanOutcome.failed(failureCode(error)));
        throw error;
    }
}
