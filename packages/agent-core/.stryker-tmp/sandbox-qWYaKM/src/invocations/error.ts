// @ts-nocheck
import { AgentCoreError } from "../errors";

export type InvocationFailure =
    | "audit.append-conflict"
    | "audit.cause-mismatch"
    | "audit.evidence-mismatch"
    | "audit.invalid-root"
    | "audit.missing-cause"
    | "state.invalid-transition"
    | "store.duplicate-record"
    | "store.missing-evidence";

export class InvocationError extends AgentCoreError {
    public constructor(
        public readonly failure: InvocationFailure,
        message: string
    ) {
        super("invocation.invalid", message);
        this.name = "InvocationError";
    }
}

export function invocationError(failure: InvocationFailure, message: string): InvocationError {
    return new InvocationError(failure, message);
}
