// @ts-nocheck
import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("Revision", () => {
    test("increments without mutating the prior value", () => {
        const initial = Revision.initial();
        const next = initial.next();

        expect(initial.value).toBe(0);
        expect(next.value).toBe(1);
        expect(initial.equals(next)).toBe(false);
        expect(new Revision(1).equals(next)).toBe(true);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(Object.isFrozen(next)).toBe(true);
    });

    test("rejects unsafe revisions and overflow", () => {
        for (const value of [
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1
        ]) {
            expect(() => new Revision(value)).toThrow(TypeError);
        }
        expectOperationalError(
            () => new Revision(Number.MAX_SAFE_INTEGER).next(),
            "protocol.revision-conflict"
        );
    });

    test("rejects prototype counterfeits during equality", () => {
        const counterfeit = Object.create(Revision.prototype) as Revision;

        expect(Revision.initial().equals(counterfeit)).toBe(false);
        expect(Revision.initial().equals(null as unknown as Revision)).toBe(false);
    });
});

function expectOperationalError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}
