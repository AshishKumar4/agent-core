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
    test("uses the concrete identifier type and exact text as identity", () => {
        const id = new FirstId("same");

        expect(id.value).toBe("same");
        expect(id.toString()).toBe("same");
        expect(id.equals(new FirstId("same"))).toBe(true);
        expect(id.equals(new FirstId("different"))).toBe(false);
        expect(id.equals(new SecondId("same"))).toBe(false);
    });

    test("rejects invalid runtime text without coercion", () => {
        for (const value of ["", "x".repeat(257), "\ud800", "\udc00", 1, null]) {
            expect(() => new FirstId(value as string)).toThrow(TypeError);
        }
        expect(() => new FirstId("\ud83d\ude00")).not.toThrow();
    });

    test("does not accept prototype counterfeits as equal identifiers", () => {
        const id = new FirstId("id");
        const counterfeit = Object.create(FirstId.prototype) as FirstId;

        expect(id.equals(counterfeit)).toBe(false);
        expect(id.equals(null as unknown as TextId)).toBe(false);
    });

    test("captures nominal type independently of mutable constructor properties", () => {
        const id = new FirstId("id");
        const same = new FirstId("id");
        Object.defineProperty(id, "constructor", { value: SecondId });
        Object.defineProperty(same, "constructor", { value: SecondId });

        expect(id.equals(same)).toBe(true);
        expect(id.equals(new SecondId("id"))).toBe(false);
        expect(id.equals(new FirstChildId("id"))).toBe(false);
    });
});
