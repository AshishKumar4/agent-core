import { isBoolean } from "../src/platform-value.js";

describe("isBoolean", () => {
    test("narrows exactly the two boolean primitives", { tags: "p2" }, () => {
        expect(isBoolean(true)).toBe(true);
        expect(isBoolean(false)).toBe(true);
    });

    /**
     * The predicate exists to stop a runtime value at a trust boundary, so the values a
     * boolean is routinely conflated with are the behavior under test: every one of them
     * would satisfy a truthiness check and none of them is a boolean.
     */
    test("refuses every value a boolean is conflated with", { tags: "p2" }, () => {
        const neighbours: readonly unknown[] = [
            0,
            1,
            Number.NaN,
            "true",
            "false",
            "",
            null,
            undefined,
            {},
            [],
            isBoolean
        ];

        expect(neighbours.filter(isBoolean)).toEqual([]);
    });
});
