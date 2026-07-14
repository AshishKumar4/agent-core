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
>;

/** Maps substrate failures into the shared AgentCoreError taxonomy. */
export interface CloudflareErrorPort {
    raise(code: CloudflareOperationalErrorCode, message: string, cause?: unknown): never;
}

export function operationalFailure(
    errors: CloudflareErrorPort,
    code: CloudflareOperationalErrorCode,
    message: string,
    cause?: unknown
): never {
    try {
        return errors.raise(code, message, cause);
    } catch (error) {
        if (error instanceof AgentCoreError && error.code === code) throw error;
        const failure = new AgentCoreError(code, message);
        if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause });
        throw failure;
    }
}
