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
        // SAFETY: Object.create hands back Revision's prototype without ever running its
        // constructor, so the counterfeit carries no #value brand. Presenting it as a Revision
        // is what lets the test reach the brand check that must refuse it.
        const counterfeit = Object.create(Revision.prototype) as Revision;

        expect(Revision.initial().equals(counterfeit)).toBe(false);
        expect(Revision.initial().equals(foreignComparand(null))).toBe(false);
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
        expect(Revision.initial().equals(foreignComparand(undefined))).toBe(false);
        expect(Revision.initial().equals(foreignComparand(1))).toBe(false);
        expect(Revision.initial().equals(foreignComparand("0"))).toBe(false);
    });
});

/**
 * Presents a comparand `equals` declares it will not receive. Its `#value in other` brand
 * check exists for JavaScript callers who can reach it anyway, so the suite has to cross
 * the declared parameter type to exercise it; this is the one place it does.
 */
function foreignComparand(value: Revision | string | number | null | undefined): Revision {
    // SAFETY: the argument is deliberately not a Revision. It is only ever handed to
    // `equals`, whose brand check must answer false for it rather than throw.
    return value as Revision;
}

function expectOperationalError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ code });
    }
}
