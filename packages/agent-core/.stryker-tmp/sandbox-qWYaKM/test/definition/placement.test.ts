// @ts-nocheck
import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import type { IsolationMode } from "../../src/facets";
import {
    PLACEMENT_PREFERENCE,
    PlacementInput,
    PlacementPolicy,
    PlacementUnavailableError,
    selectPlacement,
    trustPlacementModes
} from "../../src/definition/placement";

describe("four-set placement", () => {
    test("[C13-PLACEMENT-INTERSECTION] matches the exact reference intersection and preference for all 8^4 source combinations", () => {
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

    test("[C13-PLACEMENT-EMPTY] reports every empty source and a disjoint intersection as typed unavailability", () => {
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

    test("rejects duplicate and unknown modes instead of silently changing a source set", () => {
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

    test("[C13-PLACEMENT-UNTRUSTED-BUNDLED] derives trust admissibility without ever admitting bundled for untrusted packages", () => {
        expect(trustPlacementModes(true)).toEqual(["dynamic", "provider", "bundled"]);
        expect(trustPlacementModes(false)).toEqual(["dynamic", "provider"]);
        expect(trustPlacementModes(false)).not.toContain("bundled");
    });
});

describe("placement policy declaration", () => {
    test("[definition.placement-policy] canonicalizes immutable modes and round-trips its strict codec", () => {
        const allowed: IsolationMode[] = ["bundled", "dynamic"];
        const policy = new PlacementPolicy(allowed);
        allowed.pop();

        expect(policy.allowed).toEqual(["dynamic", "bundled"]);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.allowed)).toBe(true);
        const encoded = PlacementPolicy.encode(policy);
        expect(PlacementPolicy.encode(PlacementPolicy.decode(encoded))).toEqual(encoded);
    });

    test("[C13-ADV-EMPTY-PLACEMENT] rejects empty, duplicate, unknown, and unknown codec fields", () => {
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
