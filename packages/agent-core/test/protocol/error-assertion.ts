import { expect } from "vitest";
import { AgentCoreError } from "../../src/errors";

type ErrorCode = AgentCoreError["code"] | RegExp;
type ErrorMessage = string | RegExp;

export function expectAgentCoreError(
    operation: () => unknown,
    code: ErrorCode,
    message?: ErrorMessage
): void {
    let failure: unknown;
    try {
        operation();
    } catch (error) {
        failure = error;
    }
    expectAgentCoreErrorValue(failure, code, message);
}

export async function expectAgentCoreRejection(
    operation: Promise<unknown>,
    code: ErrorCode,
    message?: ErrorMessage
): Promise<void> {
    let failure: unknown;
    try {
        await operation;
    } catch (error) {
        failure = error;
    }
    expectAgentCoreErrorValue(failure, code, message);
}

export function expectAgentCoreErrorValue(
    failure: unknown,
    code: ErrorCode,
    message?: ErrorMessage
): void {
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
        code: code instanceof RegExp ? expect.stringMatching(code) : code,
        ...(message === undefined
            ? {}
            : { message: message instanceof RegExp ? expect.stringMatching(message) : message })
    });
}
