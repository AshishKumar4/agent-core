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
            expect(() => new FirstId(value as string)).toThrow(TypeError);
        }
        expect(() => new FirstId("\ud83d\ude00")).not.toThrow();
    });

    test("does not accept prototype counterfeits as equal identifiers", { tags: "p0" }, () => {
        const id = new FirstId("id");
        const counterfeit = Object.create(FirstId.prototype) as FirstId;

        expect(id.equals(counterfeit)).toBe(false);
        expect(id.equals(null as unknown as TextId)).toBe(false);
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

        expect(id.equals(undefined as unknown as TextId)).toBe(false);
        expect(id.equals("id" as unknown as TextId)).toBe(false);
        expect(id.equals(1 as unknown as TextId)).toBe(false);
    });
});

function expectTypeFailure(action: () => unknown, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}
