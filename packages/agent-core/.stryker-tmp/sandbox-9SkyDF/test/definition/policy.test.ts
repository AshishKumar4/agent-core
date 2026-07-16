// @ts-nocheck
import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import type { Impact } from "../../src/facets";
import {
    POLICY_IMPACTS,
    PolicySet,
    enforcementFloor,
    evaluatePolicy,
    mergePolicySets,
    type EnforcementTier
} from "../../src/definition/policy";
import {
    PLACEMENT_PREFERENCE,
    PlacementPolicy,
    PlacementUnavailableError,
    selectPlacement
} from "../../src/definition/placement";

describe("pure policy floors", () => {
    test("implements the exact impact and Turn-owned session floor", () => {
        for (const turnOwnedSession of [false, true]) {
            for (const impact of POLICY_IMPACTS) {
                const expected =
                    impact === "observe" || (impact === "execute" && turnOwnedSession)
                        ? "direct"
                        : "mediated";
                expect(enforcementFloor(impact, turnOwnedSession)).toBe(expected);
            }
        }
    });

    test("never lowers a floor across every impact, placement, and policy tier", () => {
        for (const impact of POLICY_IMPACTS) {
            for (const turnOwnedSession of [false, true]) {
                for (const placement of PLACEMENT_PREFERENCE) {
                    for (const requested of [undefined, "direct", "mediated"] as const) {
                        const policy = new PolicySet({
                            tiers: requested === undefined ? {} : { [impact]: requested }
                        });
                        const decision = evaluatePolicy({
                            impact,
                            turnOwnedSession,
                            placement,
                            policies: [policy]
                        });
                        const expected = maximumTier(
                            enforcementFloor(impact, turnOwnedSession),
                            requested ?? "direct",
                            placement === "bundled" ? "direct" : "mediated"
                        );
                        expect(decision).toEqual({ approvalRequired: false, tier: expected });
                    }
                }
            }
        }
    });

    test("[C13-POLICY-MEDIATION-FLOOR] raises every non-bundled direct call without changing placement", () => {
        for (const placement of ["dynamic", "provider"] as const) {
            const selection = selectPlacement({
                manifest: PLACEMENT_PREFERENCE,
                policy: [placement],
                substrate: PLACEMENT_PREFERENCE,
                trust: PLACEMENT_PREFERENCE
            });
            const decision = evaluatePolicy({
                impact: "observe",
                turnOwnedSession: true,
                placement: selection.selected
            });

            expect(selection.selected).toBe(placement);
            expect(decision.tier).toBe("mediated");
        }
    });
});

describe("monotone policy composition", () => {
    test("[C13-POLICY-APPROVAL-FLOOR] ORs positive approval requirements and cannot remove package, profile, or ancestor requirements", () => {
        const packagePolicy = new PolicySet({
            approvals: ["observe"],
            tiers: { execute: "mediated" }
        });
        const profilePolicy = new PolicySet({ approvals: ["mutate"] });
        const ancestorPolicy = new PolicySet({ approvals: ["externalSend"] });
        const attemptedRelaxation = new PolicySet({
            approvals: [],
            tiers: { execute: "direct" }
        });
        const merged = mergePolicySets([
            packagePolicy,
            profilePolicy,
            ancestorPolicy,
            attemptedRelaxation
        ]);

        expect(merged.approvals).toEqual(["observe", "mutate", "externalSend"]);
        expect(merged.tierFor("execute")).toBe("mediated");
        for (const impact of merged.approvals) {
            expect(
                evaluatePolicy({
                    impact,
                    turnOwnedSession: true,
                    placement: "bundled",
                    policies: [packagePolicy, profilePolicy, ancestorPolicy, attemptedRelaxation]
                })
            ).toEqual({ approvalRequired: true, tier: "mediated" });
        }
    });

    test("[C13-POLICY-DIRECT-ESCALATION] intersects placement policies and cannot broaden an ancestor constraint", () => {
        const packagePolicy = new PolicySet({
            placement: new PlacementPolicy(["dynamic", "provider", "bundled"])
        });
        const ancestorPolicy = new PolicySet({
            placement: new PlacementPolicy(["dynamic", "provider"])
        });
        const attemptedBroadening = new PolicySet({
            placement: new PlacementPolicy(["provider", "bundled"])
        });

        expect(
            mergePolicySets([packagePolicy, ancestorPolicy, attemptedBroadening]).placement.allowed
        ).toEqual(["provider"]);
        expect(() =>
            mergePolicySets([
                new PolicySet({ placement: new PlacementPolicy(["dynamic"]) }),
                new PolicySet({ placement: new PlacementPolicy(["bundled"]) })
            ])
        ).toThrow(PlacementUnavailableError);
    });
});

describe("policy declaration codec", () => {
    test("[definition.policy-set] canonicalizes immutable declarative data and round-trips byte deterministically", () => {
        const approvals: Impact[] = ["administer", "observe"];
        const tiers: Partial<Record<Impact, EnforcementTier>> = {
            administer: "mediated",
            observe: "direct"
        };
        const policy = new PolicySet({
            approvals,
            tiers,
            placement: new PlacementPolicy(["bundled", "dynamic"])
        });
        approvals.pop();
        tiers.observe = "mediated";

        expect(policy.approvals).toEqual(["observe", "administer"]);
        expect(policy.tiers).toEqual({ observe: "direct", administer: "mediated" });
        expect(policy.placement.allowed).toEqual(["dynamic", "bundled"]);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.tiers)).toBe(true);
        expect(Object.isFrozen(policy.approvals)).toBe(true);

        const encoded = PolicySet.encode(policy);
        expect(PolicySet.encode(PolicySet.decode(encoded))).toEqual(encoded);
    });

    test("makes approval removal unrepresentable and rejects malformed codec data", () => {
        expect(() => new PolicySet({ approvals: ["observe", "observe"] })).toThrow(/unique/);
        expect(() => new PolicySet({ tiers: { observe: "lower" as EnforcementTier } })).toThrow(
            /tier/
        );

        const policy = new PolicySet({ approvals: ["observe"] });
        const envelope = requireObject(decodeCanonicalJson(PolicySet.encode(policy)));
        const payload = requireObject(envelope["payload"]!);
        expectCodecError(
            () =>
                PolicySet.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, approvals: { observe: false } }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                PolicySet.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, removeApprovals: ["observe"] }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                PolicySet.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });
});

function maximumTier(...tiers: readonly EnforcementTier[]): EnforcementTier {
    return tiers.includes("mediated") ? "mediated" : "direct";
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
