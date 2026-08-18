import { describe, expect, test } from "vitest";
import { matchesGlob } from "../../src/facets";

describe("stored glob matching", () => {
    test("preserves whole-string Unicode matching without regular-expression backtracking", () => {
        const patterns = words(["a", ".", "*", "😀", "\ud83d", "\ude00"], 3);
        const values = words(["a", ".", "😀", "\ud83d", "\ude00"], 3);

        for (const pattern of patterns) {
            for (const value of values) {
                expect(matchesGlob(pattern, value)).toBe(referenceMatch(pattern, value));
            }
        }
    });
});

function referenceMatch(pattern: string, value: string): boolean {
    const expression = pattern
        .split("*")
        .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
    return new RegExp(`^${expression}$`, "u").test(value);
}

function words(alphabet: readonly string[], maximumLength: number): string[] {
    let frontier = [""];
    const result = [...frontier];
    for (let length = 1; length <= maximumLength; length += 1) {
        frontier = frontier.flatMap((prefix) => alphabet.map((symbol) => `${prefix}${symbol}`));
        result.push(...frontier);
    }
    return result;
}
