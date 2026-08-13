import { describe, expect, test } from "vitest";
import { TextId } from "../../src/core";

class FirstId extends TextId {
    public constructor(value: string) {
        super(value, "First ID");
    }
}

class SecondId extends TextId {
    public constructor(value: string) {
        super(value, "Second ID");
    }
}

class FirstChildId extends FirstId {}

describe("TextId", () => {
    test("uses the concrete identifier type and exact text as identity", { tags: "p1" }, () => {
        const id = new FirstId("same");

        expect(id.value).toBe("same");
        expect(id.toString()).toBe("same");
        expect(id.equals(new FirstId("same"))).toBe(true);
        expect(id.equals(new FirstId("different"))).toBe(false);
        expect(id.equals(new SecondId("same"))).toBe(false);
    });

    test("rejects invalid runtime text without coercion", { tags: "p1" }, () => {
        for (const value of ["", "x".repeat(257), "\ud800", "\udc00", 1, null]) {
            // SAFETY: the constructor declares a string, so the non-strings in this list can
            // only reach it through the assertion \u2014 and reaching it is the test, because the
            // length and scalar-value checks must reject them instead of coercing.
            expect(() => new FirstId(value as string)).toThrow(TypeError);
        }
        expect(() => new FirstId("\ud83d\ude00")).not.toThrow();
    });

    test("does not accept prototype counterfeits as equal identifiers", { tags: "p0" }, () => {
        const id = new FirstId("id");
        // SAFETY: Object.create hands back FirstId's prototype without ever running its
        // constructor, so the counterfeit carries no #value brand. Presenting it as a FirstId
        // is what lets the test reach the brand check that must refuse it.
        const counterfeit = Object.create(FirstId.prototype) as FirstId;

        expect(id.equals(counterfeit)).toBe(false);
        expect(id.equals(foreignComparand(null))).toBe(false);
    });

    test("captures nominal type independently of mutable constructor properties", { tags: "p0" }, () => {
        const id = new FirstId("id");
        const same = new FirstId("id");
        Object.defineProperty(id, "constructor", { value: SecondId });
        Object.defineProperty(same, "constructor", { value: SecondId });

        expect(id.equals(same)).toBe(true);
        expect(id.equals(new SecondId("id"))).toBe(false);
        expect(id.equals(new FirstChildId("id"))).toBe(false);
    });

    test("admits the exact maximum length and names the identifier", { tags: "p1" }, () => {
        const longest = "x".repeat(256);

        expect(new FirstId(longest).value).toBe(longest);
        expectTypeFailure(
            () => new FirstId("x".repeat(257)),
            "First ID must contain between 1 and 256 characters"
        );
        expectTypeFailure(
            () => new SecondId(""),
            "Second ID must contain between 1 and 256 characters"
        );
    });

    test("rejects absent comparands without probing brand slots", { tags: "p1" }, () => {
        const id = new FirstId("id");

        expect(id.equals(foreignComparand(undefined))).toBe(false);
        expect(id.equals(foreignComparand("id"))).toBe(false);
        expect(id.equals(foreignComparand(1))).toBe(false);
    });
});

/**
 * Presents a value `equals` declares it will not receive. The brand check exists for
 * JavaScript callers who can reach it anyway, so the suite has to cross the declared
 * parameter type to exercise it; this is the one place it does.
 */
function foreignComparand(value: TextId | string | number | null | undefined): TextId {
    // SAFETY: the argument is deliberately not a TextId. It is only ever handed to
    // `equals`, whose `#value in other` check must answer false for it rather than throw.
    return value as TextId;
}

function expectTypeFailure(action: () => void, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}
