import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("Revision", () => {
    test("increments without mutating the prior value", { tags: "p0" }, () => {
        const initial = Revision.initial();
        const next = initial.next();

        expect(initial.value).toBe(0);
        expect(next.value).toBe(1);
        expect(initial.equals(next)).toBe(false);
        expect(new Revision(1).equals(next)).toBe(true);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(Object.isFrozen(next)).toBe(true);
    });

    test("rejects unsafe revisions and overflow", { tags: "p0" }, () => {
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

    test("rejects prototype counterfeits during equality", { tags: "p0" }, () => {
        const counterfeit = Object.create(Revision.prototype) as Revision;

        expect(Revision.initial().equals(counterfeit)).toBe(false);
        expect(Revision.initial().equals(null as unknown as Revision)).toBe(false);
    });

    test("recognizes only brands minted by the exact Revision class", { tags: "p0" }, () => {
        class DerivedRevision extends Revision {}

        expect(Revision.isExact(Revision.initial())).toBe(true);
        expect(Revision.isExact(new Revision(7))).toBe(true);
        expect(Revision.isExact(new DerivedRevision(1))).toBe(false);
        expect(Revision.isExact(Object.create(Revision.prototype))).toBe(false);
        expect(Revision.isExact({ value: 0 })).toBe(false);
        expect(Revision.isExact(null)).toBe(false);
        expect(Revision.isExact(0)).toBe(false);
    });

    test("rejects absent comparands without probing brand slots", { tags: "p1" }, () => {
        expect(Revision.initial().equals(undefined as unknown as Revision)).toBe(false);
        expect(Revision.initial().equals(1 as unknown as Revision)).toBe(false);
        expect(Revision.initial().equals("0" as unknown as Revision)).toBe(false);
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
