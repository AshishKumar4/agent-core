import { describe, expect, test } from "vitest";
import { AgentCoreError, invariant } from "../../src/errors";

describe("AgentCoreError", () => {
    test("carries its exact code, message, and name", { tags: "p1" }, () => {
        const error = new AgentCoreError("authority.denied", "grant is not held");
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("authority.denied");
        expect(error.message).toBe("grant is not held");
        expect(error.name).toBe("AgentCoreError");
        expect(String(error)).toBe("AgentCoreError: grant is not held");
    });

    test("invariant throws the coded error exactly when its condition fails", { tags: "p1" }, () => {
        expect(() => invariant(false, "lease.invalid", "lease expired")).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "lease.invalid",
                message: "lease expired"
            })
        );
        expect(() => invariant(true, "lease.invalid", "lease expired")).not.toThrow();
    });
});
