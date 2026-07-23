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
