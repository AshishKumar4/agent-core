import { describe, expect, test } from "vitest";
import { CompatRange, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

/** A range's own fields without their readonly modifier, so a write can be attempted. */
interface WritableCompatRange {
    spec: string;
}

/** The public fields of a range, carried by a value that never ran the constructor. */
interface CompatRangeFields {
    readonly spec: string;
    readonly host: string;
}

describe("CompatRange", () => {
    test("[core.compat-range] models independent spec and host ranges through its codec", { tags: "p1" }, () => {
        const range = new CompatRange("^1.4.0", ">=2 <4");

        expect(range).toEqual({ spec: "^1.4.0", host: ">=2 <4" });
        expect(CompatRange.decode(CompatRange.encode(range)).equals(range)).toBe(true);
        expect(CompatRange.any()).toEqual({ spec: "*", host: "*" });
    });

    test("is runtime immutable", { tags: "p0" }, () => {
        const range = new CompatRange("*", "*");
        const writable: WritableCompatRange = range;

        expect(Object.isFrozen(range)).toBe(true);
        expect(Object.isFrozen(CompatRange.any())).toBe(true);
        expect(() => {
            writable.spec = "^2";
        }).toThrow(TypeError);
    });

    test("rejects blank, padded, non-string, invalid Unicode, and unknown fields", { tags: "p2" }, () => {
        expect(() => new CompatRange("", "*")).toThrow(TypeError);
        expect(() => new CompatRange("*", " ^1")).toThrow(TypeError);
        expect(() => new CompatRange(candidateRange(null), "*")).toThrow(TypeError);
        expect(() => new CompatRange("*", "\ud800")).toThrow(TypeError);
        expectCodecError(
            () =>
                CompatRange.decode(
                    encodeCanonicalJson({
                        kind: "core.compat-range",
                        payload: { host: "*", optional: true, spec: "*" },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
    });

    test("reports range validation and payload failures verbatim", { tags: "p1" }, () => {
        expectTypeFailure(
            () => new CompatRange(candidateRange(1), "*"),
            "Spec compatibility range must be a nonblank canonical string"
        );
        expectTypeFailure(
            () => new CompatRange("*", candidateRange(1)),
            "Host compatibility range must be a nonblank canonical string"
        );
        for (const payload of [null, { host: 1, spec: "*" }, { host: "*", spec: 1 }, ["*", "*"]]) {
            expectCodecFailure(
                () =>
                    CompatRange.decode(
                        encodeCanonicalJson({
                            kind: "core.compat-range",
                            payload,
                            version: { major: 1, minor: 0 }
                        })
                    ),
                "codec.invalid",
                "Compatibility range payload is malformed"
            );
        }
    });

    test("compares spec and host independently", { tags: "p1" }, () => {
        const range = new CompatRange("^1.4.0", ">=2 <4");

        expect(range.equals(new CompatRange("^1.4.0", ">=2 <4"))).toBe(true);
        expect(range.equals(new CompatRange("^1.5.0", ">=2 <4"))).toBe(false);
        expect(range.equals(new CompatRange("^1.4.0", ">=3 <4"))).toBe(false);
        expect(range.equals(candidateComparand({ host: ">=2 <4", spec: "^1.4.0" }))).toBe(false);
        expect(range.equals(candidateComparand(null))).toBe(false);
    });
});

/**
 * Offers a value where the constructor declares a range string. Deciding is the guard's
 * job — blank, padded, lone-surrogate, and non-string values must all be rejected — so
 * the suite has to be able to offer what the declaration excludes.
 */
function candidateRange(value: string | number | null): string {
    // SAFETY: the value is a candidate, not a proven range. It reaches the constructor only
    // so `requireRange` can reject it; nothing here reads it as a string.
    return value as string;
}

/**
 * Presents a comparand `equals` declares it will not receive: a structural twin that never
 * ran the constructor, or no range at all. Its `instanceof` check exists for exactly
 * those, so reaching it means crossing the declared parameter type.
 */
function candidateComparand(value: CompatRangeFields | null): CompatRange {
    // SAFETY: the argument is deliberately not a CompatRange. It reaches `equals` only so
    // the instanceof check can answer false for it.
    return value as CompatRange;
}

function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
    expect(action).toThrow(expect.objectContaining({ code }));
}

function expectCodecFailure(
    action: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentCoreError);
    expect(thrown).toMatchObject({ code, message });
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
