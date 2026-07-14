import { AgentCoreError, type AgentCoreErrorCode } from "../errors";

export function definitionError(
    code: Extract<
        AgentCoreErrorCode,
        | "codec.invalid"
        | "operation.invalid-input"
        | "protocol.invalid-state"
        | "protocol.revision-conflict"
    >,
    message: string
): AgentCoreError {
    return new AgentCoreError(code, message);
}

export function corruptDefinition(message: string): AgentCoreError {
    return definitionError("codec.invalid", message);
}

export function invalidDefinition(message: string): AgentCoreError {
    return definitionError("operation.invalid-input", message);
}

export function invalidDefinitionState(message: string): AgentCoreError {
    return definitionError("protocol.invalid-state", message);
}

export function definitionRevisionConflict(message: string): AgentCoreError {
    return definitionError("protocol.revision-conflict", message);
}
