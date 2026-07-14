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
});

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    expect(action).toThrow(expect.objectContaining({ code }));
}
