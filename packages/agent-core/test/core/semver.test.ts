import { describe, expect, test } from "vitest";
import { SemVer, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";

describe("SemVer", () => {
    test("parses and renders the complete SemVer 2.0.0 form", { tags: "p1" }, () => {
        const version = new SemVer("12.3.4-alpha.1+linux.x64");

        expect(version).toMatchObject({ major: 12, minor: 3, patch: 4 });
        expect(version.prerelease).toEqual(["alpha", "1"]);
        expect(version.build).toEqual(["linux", "x64"]);
        expect(version.toString()).toBe("12.3.4-alpha.1+linux.x64");
        expect(new SemVer(12, 3, 4, ["alpha", "1"], ["linux", "x64"]).equals(version)).toBe(true);
    });

    test("implements the SemVer precedence sequence", { tags: "p1" }, () => {
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

    test("compares release and prerelease boundaries symmetrically", { tags: "p1" }, () => {
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

    test("rejects noncanonical, unsafe, and malformed runtime versions", { tags: "p2" }, () => {
        for (const value of ["1", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "v1.2.3"]) {
            expect(() => new SemVer(value)).toThrow(TypeError);
        }
        expect(() => new SemVer(`${Number.MAX_SAFE_INTEGER}0.0.0`)).toThrow(TypeError);
        expect(() => new SemVer(-1, 0, 0)).toThrow(TypeError);
        expect(() => new SemVer(1, 2, 3, candidateIdentifiers(null))).toThrow(TypeError);
        expect(() => new SemVer(1, 2, 3, candidateIdentifiers([1]))).toThrow(TypeError);
        expect(() => new SemVer(candidateVersion(null))).toThrow(TypeError);
        expect(() => new SemVer(1, candidateComponent(undefined), 3)).toThrow(TypeError);
    });

    test("rejects a non-string parse input without coercion", { tags: "p2" }, () => {
        expect(() => SemVer.parse(candidateVersion(1))).toThrow(
            new TypeError("Semantic version must follow SemVer 2.0.0")
        );
    });

    test("copies and deeply freezes identifier arrays", { tags: "p0" }, () => {
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

    test("[core.semver] round-trips deterministically through its strict codec", { tags: "p0" }, () => {
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

    test("reports every version construction failure verbatim", { tags: "p1" }, () => {
        const components = "Semantic version requires major, minor, and patch components";

        expectTypeFailure(() => new SemVer("nope"), "Semantic version must follow SemVer 2.0.0");
        expectTypeFailure(() => new SemVer(1, candidateComponent(undefined), 3), components);
        expectTypeFailure(() => new SemVer(1, 2, candidateComponent(undefined)), components);
        expectTypeFailure(
            () => new SemVer(-1, 0, 0),
            "Semantic version major must be a non-negative safe integer"
        );
        expectTypeFailure(
            () => new SemVer(1.5, 0, 0),
            "Semantic version major must be a non-negative safe integer"
        );
        expectTypeFailure(
            () => new SemVer(0, -1, 0),
            "Semantic version minor must be a non-negative safe integer"
        );
        expectTypeFailure(
            () => new SemVer(0, 0, 1.5),
            "Semantic version patch must be a non-negative safe integer"
        );
        expect(new SemVer(0, 0, 0).toString()).toBe("0.0.0");
    });

    test("[core.semver] reports malformed payloads verbatim", { tags: "p1" }, () => {
        for (const payload of [null, { value: 1 }, { extra: true, value: "1.2.3" }, ["1.2.3"]]) {
            expectCodecFailure(
                () =>
                    SemVer.decode(
                        encodeCanonicalJson({
                            kind: "core.semver",
                            payload,
                            version: { major: 1, minor: 0 }
                        })
                    ),
                "codec.invalid",
                "Semantic version payload is malformed"
            );
        }
    });

    test("classifies prerelease identifiers by their whole text", { tags: "p1" }, () => {
        for (const [left, right, expected] of [
            ["1.0.0-b1", "1.0.0-a2", 1],
            ["1.0.0-a2", "1.0.0-b1", -1],
            ["1.0.0-0a", "1.0.0-11", 1],
            ["1.0.0-11", "1.0.0-0a", -1],
            ["1.0.0-0b", "1.0.0-1a", -1],
            ["1.0.0-1a", "1.0.0-0b", 1],
            ["1.0.0-12", "1.0.0-a", -1],
            ["1.0.0-a", "1.0.0-12", 1],
            ["1.0.0-9", "1.0.0--a", -1],
            ["1.0.0--a", "1.0.0-9", 1]
        ] as const) {
            expect(Math.sign(new SemVer(left).compare(new SemVer(right)))).toBe(expected);
        }
    });
});

/**
 * Offers a value where SemVer declares a version string. Deciding is the parser's job, so
 * the suite has to be able to offer what the declaration excludes.
 */
function candidateVersion(value: string | number | null): string {
    // SAFETY: the value is a candidate, not a proven version. It reaches SemVer only so the
    // pattern check can reject it; nothing here reads it as a string.
    return value as string;
}

/**
 * Offers a value where SemVer declares a major, minor, or patch component. Deciding is the
 * safe-integer validator's job.
 */
function candidateComponent(value: number | undefined): number {
    // SAFETY: an absent component is exactly what the validator must name and reject, and
    // the declared parameter type is what keeps it out of typed call sites.
    return value as number;
}

/**
 * Offers a value where SemVer declares prerelease or build identifiers. Deciding is the
 * identifier validator's job, which is why non-string entries have to be reachable.
 */
function candidateIdentifiers(
    value: readonly string[] | readonly number[] | null
): readonly string[] {
    // SAFETY: the entries are candidates, not proven identifiers. They reach SemVer only so
    // the identifier validator can reject the list.
    return value as readonly string[];
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

function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
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
