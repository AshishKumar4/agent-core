import { describe, expect, test } from "vitest";
import {
    isJsonObject,
    isMember,
    isNonempty,
    isObjectRecord,
    requireNonempty,
    type JsonValue
} from "../../src/core";

const VOCABULARY = Object.freeze(["observe", "mutate", "administer"] as const);

describe("shared narrowing primitives", () => {
    test("separates JSON objects from the rest of the JSON value space", { tags: "p0" }, () => {
        expect(isJsonObject({ field: 1 })).toBe(true);
        expect(isJsonObject({})).toBe(true);
        expect(isJsonObject([])).toBe(false);
        expect(isJsonObject([{ field: 1 }])).toBe(false);
        expect(isJsonObject(null)).toBe(false);
        expect(isJsonObject(undefined)).toBe(false);
        expect(isJsonObject("object")).toBe(false);
        expect(isJsonObject(0)).toBe(false);
        expect(isJsonObject(false)).toBe(false);
    });

    test(
        "narrows an untrusted value to a property bag without trusting its members",
        { tags: "p0" },
        () => {
            const value: unknown = { field: () => undefined };

            expect(isObjectRecord(value)).toBe(true);
            expect(isObjectRecord([])).toBe(false);
            expect(isObjectRecord(null)).toBe(false);
            expect(isObjectRecord("record")).toBe(false);
        }
    );

    test("admits a vocabulary member and rejects everything else", { tags: "p0" }, () => {
        expect(isMember(VOCABULARY, "observe")).toBe(true);
        expect(isMember(VOCABULARY, "administer")).toBe(true);
        expect(isMember(VOCABULARY, "escalate")).toBe(false);
        expect(isMember(VOCABULARY, "")).toBe(false);
    });

    test("rejects a non-string candidate rather than comparing it", { tags: "p0" }, () => {
        for (const candidate of [0, 1, true, null, undefined, {}, ["observe"]]) {
            expect(isMember(VOCABULARY, candidate)).toBe(false);
        }
        // The candidate is the untrusted half, so the verdict must not rest on
        // membership alone: a vocabulary that carries a non-string still admits no
        // non-string candidate.
        const polluted = Object.freeze([0, "observe"] as unknown as readonly string[]);

        expect(isMember(polluted, 0)).toBe(false);
        expect(isMember(polluted, "observe")).toBe(true);
    });

    test("carries emptiness into the type of a sequence", { tags: "p1" }, () => {
        expect(isNonempty([1])).toBe(true);
        expect(isNonempty([])).toBe(false);
        expect(requireNonempty(["only"], "Subject")).toEqual(["only"]);
    });

    test("names the subject when a sequence it required is empty", { tags: "p1" }, () => {
        expect(() => requireNonempty([], "Built-in Role impacts")).toThrow(
            new TypeError("Built-in Role impacts must not be empty")
        );
    });

    test("returns the same sequence it was given", { tags: "p2" }, () => {
        const values: readonly JsonValue[] = Object.freeze(["first", "second"]);

        expect(requireNonempty(values, "Subject")).toBe(values);
    });
});
