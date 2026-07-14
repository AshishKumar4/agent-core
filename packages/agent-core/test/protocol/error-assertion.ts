import { expect } from "vitest";
import { AgentCoreError } from "../../src/errors";

export function expectAgentCoreError(
    operation: () => unknown,
    code: AgentCoreError["code"] | RegExp
): void {
    let failure: unknown;
    try {
        operation();
    } catch (error) {
        failure = error;
    }
    expectAgentCoreErrorValue(failure, code);
}

export function expectAgentCoreErrorValue(
    failure: unknown,
    code: AgentCoreError["code"] | RegExp
): void {
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
        code: code instanceof RegExp ? expect.stringMatching(code) : code
    });
}
