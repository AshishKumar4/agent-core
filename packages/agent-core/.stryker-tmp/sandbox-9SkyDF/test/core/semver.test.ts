// @ts-nocheck
import { describe, expect, test } from "vitest";
import { SemVer, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("SemVer", () => {
    test("parses and renders the complete SemVer 2.0.0 form", () => {
        const version = new SemVer("12.3.4-alpha.1+linux.x64");

        expect(version).toMatchObject({ major: 12, minor: 3, patch: 4 });
        expect(version.prerelease).toEqual(["alpha", "1"]);
        expect(version.build).toEqual(["linux", "x64"]);
        expect(version.toString()).toBe("12.3.4-alpha.1+linux.x64");
        expect(new SemVer(12, 3, 4, ["alpha", "1"], ["linux", "x64"]).equals(version)).toBe(true);
    });

    test("implements the SemVer precedence sequence", () => {
        const ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0"
        ].map((value) => new SemVer(value));

        for (let index = 1; index < ordered.length; index += 1) {
            expect(ordered[index - 1]!.compare(ordered[index]!)).toBeLessThan(0);
        }
        expect(new SemVer("1.0.0+one").compare(new SemVer("1.0.0+two"))).toBe(0);
        expect(
            new SemVer("1.0.0-999999999999999999999999998").compare(
                new SemVer("1.0.0-999999999999999999999999999")
            )
        ).toBeLessThan(0);
    });

    test("compares release and prerelease boundaries symmetrically", () => {
        expect(SemVer.parse("1.2.3").toString()).toBe("1.2.3");
        expect(new SemVer(1, 2, 3).toString()).toBe("1.2.3");
        expect(new SemVer(1, 2, 3, [], ["build"]).toString()).toBe("1.2.3+build");
        expect(new SemVer(1, 2, 3, ["rc"], []).toString()).toBe("1.2.3-rc");

        for (const [lower, higher] of [
            ["1.0.0", "2.0.0"],
            ["1.1.0", "1.2.0"],
            ["1.1.1", "1.1.2"],
            ["1.0.0-alpha", "1.0.0"],
            ["1.0.0-alpha", "1.0.0-alpha.1"],
            ["1.0.0-2", "1.0.0-3"],
            ["1.0.0-2", "1.0.0-beta"],
            ["1.0.0-alpha", "1.0.0-beta"]
        ] as const) {
            expect(new SemVer(lower).compare(new SemVer(higher))).toBeLessThan(0);
            expect(new SemVer(higher).compare(new SemVer(lower))).toBeGreaterThan(0);
        }
        expect(new SemVer("1.0.0-alpha").compare(new SemVer("1.0.0-alpha"))).toBe(0);
    });

    test("rejects noncanonical, unsafe, and malformed runtime versions", () => {
        for (const value of ["1", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "v1.2.3"]) {
            expect(() => new SemVer(value)).toThrow(TypeError);
        }
        expect(() => new SemVer(`${Number.MAX_SAFE_INTEGER}0.0.0`)).toThrow(TypeError);
        expect(() => new SemVer(-1, 0, 0)).toThrow(TypeError);
        expect(() => new SemVer(1, 2, 3, null as unknown as string[])).toThrow(TypeError);
        expect(() => new SemVer(1, 2, 3, [1 as unknown as string])).toThrow(TypeError);
        expect(() => new SemVer(null as unknown as string)).toThrow(TypeError);
        expect(() => new SemVer(1, undefined as unknown as number, 3)).toThrow(TypeError);
    });

    test("rejects a non-string parse input without coercion", () => {
        expect(() => SemVer.parse(1 as unknown as string)).toThrow(
            new TypeError("Semantic version must follow SemVer 2.0.0")
        );
    });

    test("copies and deeply freezes identifier arrays", () => {
        const prerelease = ["rc", "1"];
        const build = ["linux"];
        const version = new SemVer(1, 2, 3, prerelease, build);
        prerelease.push("changed");
        build.push("changed");

        expect(version.prerelease).toEqual(["rc", "1"]);
        expect(version.build).toEqual(["linux"]);
        expect(Object.isFrozen(version)).toBe(true);
        expect(Object.isFrozen(version.prerelease)).toBe(true);
        expect(Object.isFrozen(version.build)).toBe(true);
    });

    test("[core.semver] round-trips deterministically through its strict codec", () => {
        const version = new SemVer("2.7.1-rc.3+build.9");
        const first = SemVer.encode(version);

        expect(SemVer.encode(SemVer.decode(first))).toEqual(first);
        expect(SemVer.decode(first).equals(version)).toBe(true);
        expectCodecError(
            () =>
                SemVer.decode(
                    encodeCanonicalJson({
                        kind: "core.semver",
                        payload: { extra: true, value: "1.2.3" },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                SemVer.decode(
                    encodeCanonicalJson({
                        kind: "core.semver",
                        payload: { value: "1.2.3" },
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });
});

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    let failure: unknown;
    try {
        action();
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code });
}
