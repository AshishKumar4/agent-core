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
                    manifest: ["unknown" as IsolationMode],
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
            PlacementPolicy.fromData({ allowed: ["dynamic"], backings: {}, trusted: "core.*" as never })
        ).toThrow(/array/);
        expect(() =>
            PlacementPolicy.fromData({ allowed: ["dynamic"], backings: {}, trusted: [1 as never] })
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
        expect(() => new PlacementPolicy(["other" as IsolationMode])).toThrow(/unknown/);

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
                    manifest: ["dynamic", "martian" as IsolationMode],
                    policy: ["dynamic"],
                    substrate: ["dynamic"],
                    trust: ["dynamic"]
                })
        ).toThrow(/Manifest placement source contains an unknown isolation mode/);
        expect(() => new PlacementPolicy(["dynamic", "martian" as IsolationMode])).toThrow(
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
        for (const payload of [null, ["dynamic"], "dynamic"] as JsonValue[]) {
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

function expectPlacementUnavailable(action: () => unknown): void {
    try {
        action();
        throw new Error("Expected placement to be unavailable");
    } catch (error) {
        expect(error).toBeInstanceOf(PlacementUnavailableError);
        expect(error).toMatchObject({ code: "operation.invalid-input" });
    }
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
