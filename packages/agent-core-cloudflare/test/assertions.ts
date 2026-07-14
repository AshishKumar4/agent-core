import { AgentCoreError } from "@agent-core/core";
import type { CloudflareOperationalErrorCode } from "../src/index.js";

export function expectOperationalFailure(
    operation: () => unknown,
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
