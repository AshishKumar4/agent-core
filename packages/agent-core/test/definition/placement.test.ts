import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import type { IsolationMode } from "../../src/facets";
import { PackageId } from "../../src/definition/id";
import {
    PLACEMENT_PREFERENCE,
    PlacementInput,
    PlacementPolicy,
    PlacementSelection,
    PlacementUnavailableError,
    selectPlacement,
    trustPlacementModes
} from "../../src/definition/placement";
import { forged, requireObject } from "./record-data";

describe("four-set placement", () => {
    test("[C13-PLACEMENT-INTERSECTION] matches the exact reference intersection and preference for all 8^4 source combinations", { tags: "p1" }, () => {
        let combinations = 0;
        for (let manifest = 0; manifest < 8; manifest += 1) {
            for (let policy = 0; policy < 8; policy += 1) {
                for (let substrate = 0; substrate < 8; substrate += 1) {
                    for (let trust = 0; trust < 8; trust += 1) {
                        combinations += 1;
                        const sources = {
                            manifest: subset(manifest),
                            policy: subset(policy),
                            substrate: subset(substrate),
                            trust: subset(trust)
                        };
                        const expected = PLACEMENT_PREFERENCE.find(
                            (mode) =>
                                sources.manifest.includes(mode) &&
                                sources.policy.includes(mode) &&
                                sources.substrate.includes(mode) &&
                                sources.trust.includes(mode)
                        );

                        if (expected === undefined) {
                            expectPlacementUnavailable(() => selectPlacement(sources));
                            continue;
                        }

                        const selection = selectPlacement(sources);
                        expect(selection.selected).toBe(expected);
                        expect(selection.manifest).toEqual(canonical(sources.manifest));
                        expect(selection.policy).toEqual(canonical(sources.policy));
                        expect(selection.substrate).toEqual(canonical(sources.substrate));
                        expect(selection.trust).toEqual(canonical(sources.trust));
                    }
                }
            }
        }
        expect(combinations).toBe(8 ** 4);
    });

    test("[C13-PLACEMENT-EMPTY] reports every empty source and a disjoint intersection as typed unavailability", { tags: "p1" }, () => {
        for (const source of ["manifest", "policy", "substrate", "trust"] as const) {
            expectPlacementUnavailable(
                () =>
                    new PlacementInput({
                        manifest: ["dynamic"],
                        policy: ["dynamic"],
                        substrate: ["dynamic"],
                        trust: ["dynamic"],
                        [source]: []
                    })
            );
        }
        expectPlacementUnavailable(() =>
            selectPlacement({
                manifest: ["dynamic"],
                policy: ["provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"]
            })
        );
    });

    test("rejects duplicate and unknown modes instead of silently changing a source set", { tags: "p1" }, () => {
        for (const source of ["manifest", "policy", "substrate", "trust"] as const) {
            expect(
                () =>
                    new PlacementInput({
                        manifest: ["dynamic"],
                        policy: ["dynamic"],
                        substrate: ["dynamic"],
                        trust: ["dynamic"],
                        [source]: ["dynamic", "dynamic"]
                    })
            ).toThrow(/unique/);
        }
        expect(
            () =>
                new PlacementInput({
                    manifest: [forged<IsolationMode>("unknown")],
                    policy: ["dynamic"],
                    substrate: ["dynamic"],
                    trust: ["dynamic"]
                })
        ).toThrow(/unknown/);
    });

    test("[C13-PLACEMENT-UNTRUSTED-BUNDLED] derives trust admissibility without ever admitting bundled for untrusted packages", { tags: "p0" }, () => {
        expect(trustPlacementModes(true)).toEqual(["dynamic", "provider", "bundled"]);
        expect(trustPlacementModes(false)).toEqual(["dynamic", "provider"]);
        expect(trustPlacementModes(false)).not.toContain("bundled");
    });

    test("[C13-PLACEMENT-UNTRUSTED-BUNDLED] a Blueprint's placement policy derives trust from its own glob patterns", { tags: "p0" }, () => {
        const policy = new PlacementPolicy(PLACEMENT_PREFERENCE, ["core.*", "exact-name"]);
        expect(policy.trusts(new PackageId("core.chat"))).toBe(true);
        expect(policy.trusts(new PackageId("core.deploy.nested"))).toBe(true);
        expect(policy.trusts(new PackageId("exact-name"))).toBe(true);
        expect(policy.trusts(new PackageId("exact-name-suffixed"))).toBe(false);
        expect(policy.trusts(new PackageId("acme.deploy"))).toBe(false);
        expect(policy.trustedModes(new PackageId("core.chat"))).toEqual([
            "dynamic",
            "provider",
            "bundled"
        ]);
        expect(policy.trustedModes(new PackageId("acme.deploy"))).toEqual(["dynamic", "provider"]);
        expect(policy.trustedModes(new PackageId("acme.deploy"))).not.toContain("bundled");
    });
});

describe("placement policy trust patterns", () => {
    test("[definition.placement-policy] canonicalizes trust patterns, sorted and deduplicated", { tags: "p1" }, () => {
        const trusted = ["zeta.*", "alpha.*"];
        const policy = new PlacementPolicy(PLACEMENT_PREFERENCE, trusted);
        trusted.push("mutated");

        expect(policy.trusted).toEqual(["alpha.*", "zeta.*"]);
        expect(Object.isFrozen(policy.trusted)).toBe(true);
        const encoded = PlacementPolicy.encode(policy);
        expect(PlacementPolicy.encode(PlacementPolicy.decode(encoded))).toEqual(encoded);
    });

    test(
        "matches wildcard-heavy trust patterns without backtracking",
        { tags: "p0", timeout: 1_000 },
        () => {
            const policy = new PlacementPolicy(["dynamic"], [`${"*a".repeat(12)}b`]);

            expect(policy.trusts(new PackageId("a".repeat(48)))).toBe(false);
        }
    );

    test("does not match a fragment of a Unicode scalar value", { tags: "p0" }, () => {
        const packageId = new PackageId("x😀y");
        const cases = [
            { pattern: `*\ud83d*`, expected: false },
            { pattern: `*\ude00*`, expected: false },
            { pattern: `*😀*`, expected: true },
            { pattern: `x\ud83d*`, expected: false },
            { pattern: `*\ude00y`, expected: false }
        ];

        for (const { pattern, expected } of cases) {
            expect(new PlacementPolicy(["dynamic"], [pattern]).trusts(packageId)).toBe(expected);
        }
    });

    test("defaults trust to everything so callers that only restrict `allowed` are unaffected", { tags: "p1" }, () => {
        expect(new PlacementPolicy(["dynamic"]).trusted).toEqual(["*"]);
        expect(PlacementPolicy.all().trusted).toEqual(["*"]);
    });

    test("rejects a malformed, duplicate, or non-array trust pattern list", { tags: "p1" }, () => {
        expect(() => new PlacementPolicy(["dynamic"], ["core.*", "core.*"])).toThrow(/unique/);
        expect(() => new PlacementPolicy(["dynamic"], [""])).toThrow(/nonblank canonical string/);
        expect(() => new PlacementPolicy(["dynamic"], [" core.*"])).toThrow(
            /nonblank canonical string/
        );
        expect(() =>
            PlacementPolicy.fromData({ allowed: ["dynamic"], backings: {}, trusted: forged<readonly string[]>("core.*") })
        ).toThrow(/array/);
        expect(() =>
            PlacementPolicy.fromData({ allowed: ["dynamic"], backings: {}, trusted: [forged<string>(1)] })
        ).toThrow(/nonblank canonical string/);
    });

    test("[definition.placement-policy] requires the trusted field explicitly, with no implicit wire default", { tags: "p1" }, () => {
        expect(() => PlacementPolicy.fromData({ allowed: ["dynamic"] })).toThrow(
            /missing or unknown fields/
        );
    });
});

describe("placement policy declaration", () => {
    test("[definition.placement-policy] canonicalizes immutable modes and round-trips its strict codec", { tags: "p0" }, () => {
        const allowed: IsolationMode[] = ["bundled", "dynamic"];
        const policy = new PlacementPolicy(allowed);
        allowed.pop();

        expect(policy.allowed).toEqual(["dynamic", "bundled"]);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.allowed)).toBe(true);
        const encoded = PlacementPolicy.encode(policy);
        expect(PlacementPolicy.encode(PlacementPolicy.decode(encoded))).toEqual(encoded);
    });

    test("[C13-ADV-EMPTY-PLACEMENT] rejects empty, duplicate, unknown, and unknown codec fields", { tags: "p1" }, () => {
        expectPlacementUnavailable(() => new PlacementPolicy([]));
        expect(() => new PlacementPolicy(["dynamic", "dynamic"])).toThrow(/unique/);
        expect(() => new PlacementPolicy([forged<IsolationMode>("other")])).toThrow(/unknown/);

        const policy = new PlacementPolicy(["provider"]);
        const envelope = requireObject(decodeCanonicalJson(PlacementPolicy.encode(policy)));
        const payload = requireObject(envelope["payload"]!);
        expectCodecError(
            () =>
                PlacementPolicy.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, fallback: "bundled" }
                    })
                ),
            "codec.invalid"
        );
    });
});

describe("placement adversarial boundaries", () => {
    test("rejects a selection missing from any single admissible source", { tags: "p1" }, () => {
        for (const source of ["manifest", "policy", "substrate", "trust"] as const) {
            const input = new PlacementInput({
                manifest: ["dynamic", "provider"],
                policy: ["dynamic", "provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"],
                [source]: ["dynamic"]
            });
            expect(() => new PlacementSelection(input, "provider")).toThrow(
                /Selected placement must belong to every admissible source/
            );
        }
        expect(
            new PlacementSelection(
                new PlacementInput({
                    manifest: ["dynamic", "provider"],
                    policy: ["dynamic", "provider"],
                    substrate: ["dynamic", "provider"],
                    trust: ["dynamic", "provider"]
                }),
                "provider"
            ).selected
        ).toBe("provider");
    });

    test("rejects mixed known and unknown isolation modes", { tags: "p1" }, () => {
        expect(
            () =>
                new PlacementInput({
                    manifest: ["dynamic", forged<IsolationMode>("martian")],
                    policy: ["dynamic"],
                    substrate: ["dynamic"],
                    trust: ["dynamic"]
                })
        ).toThrow(/Manifest placement source contains an unknown isolation mode/);
        expect(() => new PlacementPolicy(["dynamic", forged<IsolationMode>("martian")])).toThrow(
            /Placement policy contains an unknown isolation mode/
        );
    });

    test("names placement unavailability and each empty source subject", { tags: "p2" }, () => {
        try {
            new PlacementPolicy([]);
            throw new Error("Expected placement to be unavailable");
        } catch (error) {
            expect(error).toBeInstanceOf(PlacementUnavailableError);
            expect(error).toMatchObject({
                name: "PlacementUnavailableError",
                message: "Placement policy must not be empty"
            });
        }
        const subjects = [
            ["manifest", /Manifest placement source must not be empty/],
            ["policy", /Policy placement source must not be empty/],
            ["substrate", /Substrate placement source must not be empty/],
            ["trust", /Trust placement source must not be empty/]
        ] as const;
        for (const [source, message] of subjects) {
            expect(
                () =>
                    new PlacementInput({
                        manifest: ["dynamic"],
                        policy: ["dynamic"],
                        substrate: ["dynamic"],
                        trust: ["dynamic"],
                        [source]: []
                    })
            ).toThrow(message);
        }
    });

    test("rejects non-object placement policy payloads with the object subject", { tags: "p1" }, () => {
        const malformedPayloads: readonly JsonValue[] = [null, ["dynamic"], "dynamic"];
        for (const payload of malformedPayloads) {
            expect(() => PlacementPolicy.fromData(payload)).toThrow(
                /Placement policy must be an object/
            );
        }
    });

    test("rejects unknown declared modes with the modes subject", { tags: "p1" }, () => {
        expect(() =>
            PlacementPolicy.fromData({ allowed: ["martian"], backings: {}, trusted: ["*"] })
        ).toThrow(/Placement policy modes contains an unknown isolation mode/);
    });
});

function subset(mask: number): IsolationMode[] {
    return PLACEMENT_PREFERENCE.filter((_mode, index) => (mask & (1 << index)) !== 0);
}

function canonical(modes: readonly IsolationMode[]): readonly IsolationMode[] {
    return PLACEMENT_PREFERENCE.filter((mode) => modes.includes(mode));
}

function expectPlacementUnavailable(action: () => void): void {
    try {
        action();
        throw new Error("Expected placement to be unavailable");
    } catch (error) {
        expect(error).toBeInstanceOf(PlacementUnavailableError);
        expect(error).toMatchObject({ code: "operation.invalid-input" });
    }
}


function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
