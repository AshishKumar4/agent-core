import { describe, expect, test } from "vitest";
import {
    InvocationId,
    immutableReference,
    requireArray,
    requireCanonicalText,
    requireDate,
    requireExactObject,
    requireNonnegativeInteger,
    requireNullableDate,
    requireNullableString,
    requireObject,
    requireSafeInteger,
    requireString,
    validDate,
    sameJson
} from "../../src/invocations";

describe("invocation codec helpers", () => {
    test("decodes optional, numeric, array, and structural values exactly", () => {
        const object = {
            absent: null,
            array: [1, "two"],
            date: "1970-01-01T00:00:01.000Z",
            integer: 3,
            text: "value"
        } as const;
        expect(requireNullableString(object, "absent")).toBeUndefined();
        expect(requireNullableString(object, "text")).toBe("value");
        expect(requireSafeInteger(object, "integer")).toBe(3);
        expect(requireNullableDate(object, "absent")).toBeUndefined();
        expect(requireNullableDate(object, "date")?.getTime()).toBe(1000);
        expect(requireArray(object, "array")).toEqual([1, "two"]);
        expect(sameJson({ a: 1 }, { a: 1 })).toBe(true);
        expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    });

    test.each([
        ["object", () => requireObject(null, "value")],
        ["exact object", () => requireExactObject({}, ["required"], "value")],
        ["string", () => requireString({ value: 1 }, "value")],
        ["nullable string", () => requireNullableString({ value: false }, "value")],
        ["safe integer", () => requireSafeInteger({ value: 1.5 }, "value")],
        ["nonnegative integer", () => requireNonnegativeInteger({ value: -1 }, "value")],
        ["canonical date", () => requireDate({ value: "not-a-date" }, "value")],
        ["array", () => requireArray({ value: "not-array" }, "value")],
        ["canonical text", () => requireCanonicalText(" padded ", "value")],
        ["valid Date", () => validDate(new Date(Number.NaN), "value")]
    ])("rejects malformed %s values", (_name, operation) => {
        expect(operation).toThrow(TypeError);
    });

    test("rejects primitive objects, non-canonical dates, and empty text", { tags: "p1" }, () => {
        expect(() => requireObject("text", "value")).toThrow(TypeError);
        expect(() => requireDate({ value: "2026-07-20" }, "value")).toThrow(TypeError);
        expect(() => requireCanonicalText("", "value")).toThrow(TypeError);
    });

    test("compares canonical encodings beyond shared byte prefixes", { tags: "p1" }, () => {
        expect(sameJson(1, 12)).toBe(false);
        expect(sameJson(12, 1)).toBe(false);
    });

    test("freezes exact identifier references and rejects derived classes", { tags: "p1" }, () => {
        const id = new InvocationId("codec-identifier");
        expect(immutableReference(id)).toBe(id);
        expect(Object.isFrozen(id)).toBe(true);
        class DerivedInvocationId extends InvocationId {}
        expect(() => immutableReference(new DerivedInvocationId("derived-identifier"))).toThrow(
            /exact context classes/
        );
    });

    test("accepts array and null-prototype structural references", { tags: "p1" }, () => {
        const items = [1, ["nested"]];
        expect(immutableReference(items)).toBe(items);
        expect(Object.isFrozen(items)).toBe(true);
        expect(Object.isFrozen(items[1])).toBe(true);
        const bare: { value?: number } = Object.create(null);
        bare.value = 1;
        expect(immutableReference(bare)).toBe(bare);
        expect(Object.isFrozen(bare)).toBe(true);
    });

    test("rejects symbol keys and ghost property descriptors", { tags: "p1" }, () => {
        expect(() => immutableReference({ [Symbol("hidden")]: 1 })).toThrow(/symbol keys/);
        const ghost = new Proxy(
            {},
            {
                ownKeys: () => ["ghost"],
                getOwnPropertyDescriptor: () => undefined
            }
        );
        expect(() => immutableReference(ghost)).toThrow(/accessors/);
    });

    test("deep-freezes structural references and rejects cycles", () => {
        const value = { nested: { value: 1 } };
        expect(immutableReference(value)).toBe(value);
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.nested)).toBe(true);
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        expect(() => immutableReference(cyclic)).toThrow(/cycles/);
        expect(() => immutableReference(new Date())).toThrow(/immutable codec values/);
        expect(() =>
            immutableReference({
                get value() {
                    return "dynamic";
                }
            })
        ).toThrow(/accessors/);
        expect(() => immutableReference(() => "dynamic")).toThrow(/functions/);
        class MutablePrototype {
            public value = "mutable";
        }
        expect(() => immutableReference(new MutablePrototype())).toThrow(/data-only prototypes/);
    });
});
