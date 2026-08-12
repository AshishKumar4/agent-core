/**
 * The kernel's `AgentCoreErrorCode` is a closed union with no model-provider case, so
 * the harness owns its own stable taxonomy for the one failure domain it introduces.
 */
export type HarnessErrorCode =
    | "model.unavailable"
    | "model.rejected"
    | "model.malformed-response"
    | "model.unknown-tool"
    | "transcript.invalid"
    | "loop.step-budget-exhausted";

export class HarnessError extends Error {
    public constructor(
        public readonly code: HarnessErrorCode,
        message: string
    ) {
        super(message);
        this.name = "HarnessError";
    }
}
