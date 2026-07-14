export type AgentCoreErrorCode =
    | "actor.closed"
    | "actor.stale-callback"
    | "authority.denied"
    | "binding.invalid"
    | "codec.invalid"
    | "codec.unknown-major"
    | "content.invalid-range"
    | "content.not-found"
    | "environment.closed-session"
    | "environment.invalid-session"
    | "environment.stale-session"
    | "facet.inactive"
    | "invocation.invalid"
    | "lease.invalid"
    | "operation.invalid-input"
    | "operation.invalid-output"
    | "operation.missing"
    | "protocol.duplicate"
    | "protocol.invalid-envelope"
    | "protocol.invalid-state"
    | "protocol.revision-conflict"
    | "run.invalid-state"
    | "slate.invalid-version"
    | "slate.unpublished"
    | "subscription.invalid"
    | "turn.invalid-state";

export class AgentCoreError extends Error {
    public constructor(
        public readonly code: AgentCoreErrorCode,
        message: string
    ) {
        super(message);
        this.name = "AgentCoreError";
    }
}

export function invariant(
    condition: boolean,
    code: AgentCoreErrorCode,
    message: string
): asserts condition {
    if (!condition) {
        throw new AgentCoreError(code, message);
    }
}
