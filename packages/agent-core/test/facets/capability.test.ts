import { describe, expect, test } from "vitest";
import {
    CapabilitySpec,
    type CapabilityIntent,
    type CapabilitySpecInit,
    type Impact
} from "../../src/facets";

describe("CapabilitySpec authority semantics", () => {
    test("covers requires facet pattern containment", { tags: "p0" }, () => {
        expect(cap("*").covers(cap("acme.mail"))).toBe(true);
        expect(cap("acme.mail").covers(cap("acme.mail"))).toBe(true);
        expect(cap("acme.a").covers(cap("acme.b"))).toBe(false);
        expect(cap("ab").covers(cap("aab"))).toBe(false);
        expect(cap("abc*").covers(cap("abc"))).toBe(true);
        expect(cap("core.*").covers(cap("core.mail"))).toBe(true);
        expect(cap("*yz").covers(cap("*xyz"))).toBe(true);
        expect(cap("a*z").covers(cap("ab*yz"))).toBe(true);
        expect(cap("a*z").covers(cap("a*y"))).toBe(false);
        expect(cap("a*z").covers(cap("b*z"))).toBe(false);
        expect(cap("a*b*c").covers(cap("abc"))).toBe(false);
    });

    test("covers never admits a facet the parent pattern rejects", { tags: "p0" }, () => {
        // Attenuation soundness (§ authority delegation): `covers` gates Grant.canAttenuate,
        // so whenever a parent covers a child, every facet the child admits the parent must
        // admit as well. A prefix/suffix test that ignores their overlap breaks this: `a*a`
        // requires two characters, yet reports that it covers the single-character `a`.
        expect(cap("a*a").covers(cap("a"))).toBe(false);
        expect(cap("aa*aa").covers(cap("aaa"))).toBe(false);
        expect(cap("a*a").covers(cap("aa"))).toBe(true);

        const patterns = ["a", "b", "ab", "aa", "a*", "*a", "a*a", "a*b", "aa*aa", "*", "ab*ab"];
        const values = enumerate("ab", 5);
        for (const parent of patterns) {
            for (const child of patterns) {
                if (!cap(parent).covers(cap(child))) continue;
                for (const facet of values) {
                    if (!cap(child).matches(intent({ facet }))) continue;
                    expect(
                        [parent, child, facet, cap(parent).matches(intent({ facet }))]
                    ).toStrictEqual([parent, child, facet, true]);
                }
            }
        }
    });

    test("matches resists wildcard backtracking blowup", { tags: "p0" }, () => {
        // `facetPattern` arrives through CapabilitySpec.fromData, so a Grant record carries
        // attacker-chosen wildcards into every authorization check. Compiling `^.*a.*a…$`
        // costs O(value^wildcards) on a non-matching value; 18 wildcards did not finish.
        const pattern = "*a".repeat(18) + "b";
        const facet = "a".repeat(60);
        const started = process.hrtime.bigint();
        expect(cap(pattern).matches(intent({ facet }))).toBe(false);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        expect(elapsedMs).toBeLessThan(1000);
    });

    test("covers requires operation and constraint containment", { tags: "p0" }, () => {
        expect(cap("*", { operations: ["read"] }).covers(cap("*"))).toBe(false);
        expect(cap("*").covers(cap("*", { operations: ["write"] }))).toBe(true);
        expect(
            cap("*", { operations: ["read", "write"] }).covers(cap("*", { operations: ["read"] }))
        ).toBe(true);
        expect(
            cap("*", { operations: ["read"] }).covers(
                cap("*", { operations: ["read", "write"] })
            )
        ).toBe(false);

        const constrained = cap("*", { argumentConstraints: { tier: "gold" } });
        expect(constrained.covers(cap("*"))).toBe(false);
        expect(constrained.covers(cap("*", { argumentConstraints: { tier: "silver" } }))).toBe(
            false
        );
        expect(constrained.covers(cap("*", { argumentConstraints: { tier: "gold" } }))).toBe(true);
    });

    test("matches escapes pattern literals and evaluates constraint paths", { tags: "p0" }, () => {
        const dotted = cap("a.b");
        expect(dotted.matches(intent({ facet: "a.b" }))).toBe(true);
        expect(dotted.matches(intent({ facet: "ab" }))).toBe(false);
        expect(dotted.matches(intent({ facet: "axb" }))).toBe(false);

        const nested = cap("*", { argumentConstraints: { "a.b": true } });
        expect(nested.matches(intent({ arguments: { a: { b: true } } }))).toBe(true);
        expect(nested.matches(intent({ arguments: { a: null } }))).toBe(false);
        expect(nested.matches(intent({ arguments: {} }))).toBe(false);

        const numeric = cap("*", { argumentConstraints: { n: 12 } });
        expect(numeric.matches(intent({ arguments: { n: 12 } }))).toBe(true);
        expect(numeric.matches(intent({ arguments: { n: 1 } }))).toBe(false);

        const operated = cap("*", { operations: ["read"] });
        expect(operated.matches(intent({ operation: "read" }))).toBe(true);
        expect(operated.matches(intent({ operation: "write" }))).toBe(false);
    });

    test("constraint paths never traverse into arrays or string properties", { tags: "p0" }, () => {
        const indexed = cap("*", { argumentConstraints: { "a.0": 5 } });
        expect(indexed.matches(intent({ arguments: { a: [5] } }))).toBe(false);
        expect(indexed.matches(intent({ arguments: { a: { "0": 5 } } }))).toBe(true);

        const lengthProbe = cap("*", { argumentConstraints: { "a.length": 2 } });
        expect(lengthProbe.matches(intent({ arguments: { a: "xy" } }))).toBe(false);
        expect(lengthProbe.matches(intent({ arguments: { a: { length: 2 } } }))).toBe(true);
    });

    test("grantsElevation follows delegate and administer impacts", { tags: "p0" }, () => {
        expect(cap("*", { impacts: ["delegate"] }).grantsElevation()).toBe(true);
        expect(cap("*", { impacts: ["administer"] }).grantsElevation()).toBe(true);
        expect(
            cap("*", { impacts: ["observe", "mutate", "externalSend", "execute"] }).grantsElevation()
        ).toBe(false);
    });

    test("equals compares canonical data", { tags: "p0" }, () => {
        expect(cap("core.mail").equals(cap("core.mail"))).toBe(true);
        expect(cap("core.mail").equals(cap("core.chat"))).toBe(false);
        expect(cap("*", { operations: ["read"] }).equals(cap("*"))).toBe(false);
    });

    test("rejects noncanonical construction inputs", { tags: "p1" }, () => {
        expect(() => cap("")).toThrow(/canonical glob/);
        expect(() => cap("bad pattern")).toThrow(/canonical glob/);
        expect(() => cap("*", { operations: [" pad "] })).toThrow(
            "Capability operations must contain canonical nonblank strings"
        );
        expect(() =>
            cap("*", { impacts: ["observe", "bogus"] as unknown as [Impact] })
        ).toThrow("Capability impacts must contain known values");
        expect(() => cap("*", { impacts: ["observe", "observe"] })).toThrow(
            "Capability impacts must be unique"
        );
        expect(() => cap("*", { argumentConstraints: { "!bad": 1 } })).toThrow(
            "Invalid argument constraint path !bad"
        );
    });

    test("fromData enforces the exact capability payload shape", { tags: "p1" }, () => {
        const spec = cap("core.*", {
            operations: ["read"],
            impacts: ["observe", "delegate"],
            argumentConstraints: { tier: "gold" }
        });
        expect(CapabilitySpec.fromData(spec.toData()).equals(spec)).toBe(true);
        expect(CapabilitySpec.decode(CapabilitySpec.encode(spec)).equals(spec)).toBe(true);

        expect(() => CapabilitySpec.fromData({ ...base(), extra: true })).toThrow(
            "Capability spec contains missing or unknown fields"
        );
        expect(() => CapabilitySpec.fromData({ ...base(), impacts: [] })).toThrow(
            "Capability impacts must not be empty"
        );
        expect(() => CapabilitySpec.fromData({ ...base(), impacts: ["bogus"] })).toThrow(
            "Capability impact is invalid"
        );
        expect(() => CapabilitySpec.fromData({ ...base(), facetPattern: 7 })).toThrow(
            "Facet pattern must be a string"
        );
        expect(() => CapabilitySpec.fromData({ ...base(), operations: [7] })).toThrow(
            "Operation 0 must be a string"
        );
    });
});

function cap(facetPattern: string, rest: Partial<CapabilitySpecInit> = {}): CapabilitySpec {
    return new CapabilitySpec({ facetPattern, impacts: ["observe"], ...rest });
}

function enumerate(alphabet: string, maxLength: number): readonly string[] {
    let level = [""];
    const all = [""];
    for (let length = 0; length < maxLength; length += 1) {
        level = level.flatMap((prefix) => [...alphabet].map((symbol) => prefix + symbol));
        all.push(...level);
    }
    return all;
}

function base(): {
    argumentConstraints: Record<string, never>;
    facetPattern: string;
    impacts: string[];
    operations: string[];
} {
    return { argumentConstraints: {}, facetPattern: "*", impacts: ["observe"], operations: [] };
}

function intent(partial: Partial<CapabilityIntent>): CapabilityIntent {
    return {
        facet: "a.b",
        operation: "read",
        impact: "observe",
        arguments: {},
        ...partial
    };
}
