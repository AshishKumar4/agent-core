import { describe, expect, test } from "vitest";
import { CompatRange, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("CompatRange", () => {
    test("[core.compat-range] models independent spec and host ranges through its codec", () => {
        const range = new CompatRange("^1.4.0", ">=2 <4");

        expect(range).toEqual({ spec: "^1.4.0", host: ">=2 <4" });
        expect(CompatRange.decode(CompatRange.encode(range)).equals(range)).toBe(true);
        expect(CompatRange.any()).toEqual({ spec: "*", host: "*" });
    });

    test("is runtime immutable", () => {
        const range = new CompatRange("*", "*");

        expect(Object.isFrozen(range)).toBe(true);
        expect(Object.isFrozen(CompatRange.any())).toBe(true);
        expect(() => {
            (range as { spec: string }).spec = "^2";
        }).toThrow(TypeError);
    });

    test("rejects blank, padded, non-string, invalid Unicode, and unknown fields", () => {
        expect(() => new CompatRange("", "*")).toThrow(TypeError);
        expect(() => new CompatRange("*", " ^1")).toThrow(TypeError);
        expect(() => new CompatRange(null as unknown as string, "*")).toThrow(TypeError);
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
            () => new CompatRange(1 as unknown as string, "*"),
            "Spec compatibility range must be a nonblank canonical string"
        );
        expectTypeFailure(
            () => new CompatRange("*", 1 as unknown as string),
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
        expect(range.equals({ host: ">=2 <4", spec: "^1.4.0" } as unknown as CompatRange)).toBe(
            false
        );
        expect(range.equals(null as unknown as CompatRange)).toBe(false);
    });
});

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    expect(action).toThrow(expect.objectContaining({ code }));
}

function expectCodecFailure(
    action: () => unknown,
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
