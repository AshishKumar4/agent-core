import { AgentCoreError } from "@agent-core/core";
import type { CloudflareOperationalErrorCode } from "../src/index.js";

export function expectOperationalFailure(
    operation: () => void,
    code: CloudflareOperationalErrorCode
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
        return;
    }
    throw new TypeError(`Expected operational failure ${code}`);
}

/**
 * Hands a seam the input its own type forbids. Refusing malformed input is part of a
 * seam's contract, and the only way to reach that behavior is to build a value the
 * checker would otherwise refuse to construct. Naming the conversion here keeps it out
 * of the calls under test, which stay ordinary typed calls with their real arity and
 * their real result.
 */
export function malformedInput<Contract, Value>(value: Value): Contract {
    // @ts-expect-error The helper deliberately violates Contract only for adversarial
    // public-boundary tests whose assertion requires that value to be rejected.
    return value;
}
