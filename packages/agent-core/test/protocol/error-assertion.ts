import { expect } from "vitest";
import { AgentCoreError } from "../../src/errors";

type ErrorCode = AgentCoreError["code"] | RegExp;
type ErrorMessage = string | RegExp;

export function expectAgentCoreError(
    operation: () => void,
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
    cause: unknown,
    code: ErrorCode,
    message?: ErrorMessage
): void {
    expect(cause).toBeInstanceOf(AgentCoreError);
    expect(cause).not.toBeInstanceOf(TypeError);
    const expectedCode = code instanceof RegExp ? expect.stringMatching(code) : code;
    if (message === undefined) {
        expect(cause).toMatchObject({ code: expectedCode });
        return;
    }
    expect(cause).toMatchObject({
        code: expectedCode,
        message: message instanceof RegExp ? expect.stringMatching(message) : message
    });
}
