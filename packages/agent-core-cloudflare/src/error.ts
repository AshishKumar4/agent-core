import { AgentCoreError, type AgentCoreErrorCode } from "@agent-core/core";

export type CloudflareOperationalErrorCode = Extract<
    AgentCoreErrorCode,
    | "authority.denied"
    | "codec.invalid"
    | "invocation.invalid"
    | "operation.invalid-input"
    | "operation.invalid-output"
    | "protocol.invalid-state"
    | "protocol.revision-conflict"
    | "run.invalid-state"
>;

/** A thrown JavaScript value captured at the exact call boundary that produced it. */
export interface CloudflareCapturedCause {
    readonly value: unknown;
}

/** Maps substrate failures into the shared AgentCoreError taxonomy. */
export interface CloudflareErrorPort {
    raise(
        code: CloudflareOperationalErrorCode,
        message: string,
        cause?: CloudflareCapturedCause
    ): never;
}

export function operationalFailure(
    errors: CloudflareErrorPort,
    code: CloudflareOperationalErrorCode,
    message: string,
    cause?: CloudflareCapturedCause
): never {
    throw operationalError(errors, code, message, cause);
}

/**
 * The same mapping as `operationalFailure`, returned instead of raised, for the batch
 * seams that must report a per-entry cause without failing their whole batch.
 */
export function operationalError(
    errors: CloudflareErrorPort,
    code: CloudflareOperationalErrorCode,
    message: string,
    cause?: CloudflareCapturedCause
): AgentCoreError {
    try {
        errors.raise(code, message, cause);
    } catch (error) {
        if (error instanceof AgentCoreError && error.code === code) return error;
    }
    const failure = new AgentCoreError(code, message);
    if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause.value });
    return failure;
}
