import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import type { Impact, IsolationMode } from "../../src/facets";
import {
    POLICY_IMPACTS,
    PolicySet,
    TreeMergePolicy,
    enforcementFloor,
    evaluatePolicy,
    mergePolicySets,
    type EnforcementTier,
    type EnforcementTierOverrides,
    type PolicyEvaluationInput
} from "../../src/definition/policy";
import {
    PLACEMENT_PREFERENCE,
    PlacementPolicy,
    PlacementUnavailableError,
    selectPlacement
} from "../../src/definition/placement";
import { forged, requireObject } from "./record-data";

describe("pure policy floors", () => {
    test(
        "[C13-POLICY-DIRECT-COLOCATION] permits direct only for bundled co-location",
        { tags: "p0" },
        () => {
            for (const placement of PLACEMENT_PREFERENCE) {
                expect(
                    evaluatePolicy({
                        impact: "observe",
                        turnOwnedSession: true,
                        sessionFilesystemTarget: false,
                        placement
                    }).tier
                ).toBe(placement === "bundled" ? "direct" : "mediated");
            }
        }
    );

    test("implements the exact impact and Turn-owned session floor", { tags: "p0" }, () => {
        for (const turnOwnedSession of [false, true]) {
            for (const sessionFilesystemTarget of [false, true]) {
                for (const impact of POLICY_IMPACTS) {
                    const expected =
                        impact === "observe" ||
                        (impact === "execute" && turnOwnedSession) ||
                        (impact === "mutate" && turnOwnedSession && sessionFilesystemTarget)
                            ? "direct"
                            : "mediated";
                    expect(
                        enforcementFloor(impact, turnOwnedSession, sessionFilesystemTarget)
                    ).toBe(expected);
                }
            }
        }
    });

    test(
        "[C13-POLICY-MEDIATION-FLOOR] never lowers a floor across every impact, placement, and policy tier",
        { tags: "p0" },
        () => {
            for (const impact of POLICY_IMPACTS) {
                for (const turnOwnedSession of [false, true]) {
                    for (const sessionFilesystemTarget of [false, true]) {
                        for (const placement of PLACEMENT_PREFERENCE) {
                            for (const requested of [undefined, "direct", "mediated"] as const) {
                                const policy = new PolicySet({
                                    placement: PlacementPolicy.all(),
                                    tiers: requested === undefined ? {} : { [impact]: requested }
                                });
                                const decision = evaluatePolicy({
                                    impact,
                                    turnOwnedSession,
                                    sessionFilesystemTarget,
                                    placement,
                                    policies: [policy]
                                });
                                const expected = maximumTier(
                                    enforcementFloor(
                                        impact,
                                        turnOwnedSession,
                                        sessionFilesystemTarget
                                    ),
                                    requested ?? "direct",
                                    placement === "bundled" ? "direct" : "mediated"
                                );
                                expect(decision).toEqual({
                                    approvalRequired: false,
                                    tier: expected
                                });
                            }
                        }
                    }
                }
            }
        }
    );

    test(
        "[C13-POLICY-MEDIATION-FLOOR] [C13-POLICY-DIRECT-COLOCATION] admits direct exactly where SPEC §7.2 does over every impact, session, placement, tier, and approval",
        { tags: "p0" },
        () => {
            for (const impact of POLICY_IMPACTS) {
                for (const turnOwnedSession of [false, true]) {
                    for (const sessionFilesystemTarget of [false, true]) {
                        for (const placement of PLACEMENT_PREFERENCE) {
                            for (const requested of [undefined, "direct", "mediated"] as const) {
                                for (const approvals of [[], [impact]] as const) {
                                    const decision = evaluatePolicy({
                                        impact,
                                        turnOwnedSession,
                                        sessionFilesystemTarget,
                                        placement,
                                        policies: [
                                            new PolicySet({
                                                placement: PlacementPolicy.all(),
                                                approvals,
                                                tiers:
                                                    requested === undefined
                                                        ? {}
                                                        : { [impact]: requested }
                                            })
                                        ]
                                    });
                                    const approvalRequired = approvals.length > 0;
                                    expect(decision).toEqual({
                                        approvalRequired,
                                        tier:
                                            specAdmitsDirect(
                                                impact,
                                                turnOwnedSession,
                                                sessionFilesystemTarget
                                            ) &&
                                            placement === "bundled" &&
                                            requested !== "mediated" &&
                                            !approvalRequired
                                                ? "direct"
                                                : "mediated"
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    );

    test(
        "[C13-POLICY-MEDIATION-FLOOR] [C13-POLICY-APPROVAL-FLOOR] refuses every hostile attempt to buy a direct mutate off the Session's own filesystem",
        { tags: "p0" },
        () => {
            const ownFilesystem = {
                impact: "mutate",
                turnOwnedSession: true,
                sessionFilesystemTarget: true,
                placement: "bundled"
            } as const satisfies PolicyEvaluationInput;
            const askDirect = new PolicySet({
                placement: PlacementPolicy.all(),
                tiers: { mutate: "direct" }
            });

            // The one cell §7.2 admits, stated first so no refusal below is vacuous.
            expect(evaluatePolicy(ownFilesystem)).toEqual({
                approvalRequired: false,
                tier: "direct"
            });

            // Policy raises and never lowers: asking for direct buys nothing once either half
            // of the attestation is withdrawn, and asking for mediated gives up the one cell.
            expect(evaluatePolicy({ ...ownFilesystem, policies: [askDirect] }).tier).toBe("direct");
            for (const withdrawn of [
                { sessionFilesystemTarget: false },
                { turnOwnedSession: false },
                { turnOwnedSession: false, sessionFilesystemTarget: false }
            ]) {
                expect(
                    evaluatePolicy({ ...ownFilesystem, ...withdrawn, policies: [askDirect] }).tier
                ).toBe("mediated");
            }
            expect(
                evaluatePolicy({
                    ...ownFilesystem,
                    policies: [
                        new PolicySet({
                            placement: PlacementPolicy.all(),
                            tiers: { mutate: "mediated" }
                        })
                    ]
                }).tier
            ).toBe("mediated");

            // The exception is about `mutate` on that filesystem and carries no other impact:
            // an unowned execute stays mediated however the filesystem fact is attested, and
            // the three impacts §7.2 never admits stay mediated in the admitted cell itself.
            expect(
                evaluatePolicy({ ...ownFilesystem, impact: "execute", turnOwnedSession: false })
                    .tier
            ).toBe("mediated");
            for (const impact of ["externalSend", "delegate", "administer"] as const) {
                expect(
                    evaluatePolicy({ ...ownFilesystem, impact, policies: [askDirect] }).tier
                ).toBe("mediated");
            }

            // Co-location governs the exception like every other direct floor (§7.2 lines
            // 2824-2828).
            for (const placement of ["dynamic", "provider"] as const) {
                expect(evaluatePolicy({ ...ownFilesystem, placement }).tier).toBe("mediated");
            }

            // An approval raises the admitted cell and stays required there, because §7.2 gives
            // it nowhere to be recorded on the direct path; an approval on another impact
            // leaves the cell alone.
            expect(
                evaluatePolicy({
                    ...ownFilesystem,
                    policies: [
                        new PolicySet({ placement: PlacementPolicy.all(), approvals: ["mutate"] })
                    ]
                })
            ).toEqual({ approvalRequired: true, tier: "mediated" });
            expect(
                evaluatePolicy({
                    ...ownFilesystem,
                    policies: [
                        new PolicySet({ placement: PlacementPolicy.all(), approvals: ["observe"] })
                    ]
                })
            ).toEqual({ approvalRequired: false, tier: "direct" });

            // A name the vocabulary does not carry must reach nothing: the own-filesystem
            // branch is the only conditional direct answer a `mutate`-shaped name could fall
            // into, so the floor answers mediated rather than falling through to it.
            expect(
                evaluatePolicy({ ...ownFilesystem, impact: forged<Impact>("mutate.session") })
            ).toEqual({ approvalRequired: false, tier: "mediated" });
        }
    );

    test(
        "[C13-POLICY-MEDIATION-FLOOR] raises every non-bundled direct call without changing placement",
        { tags: "p0" },
        () => {
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
                    sessionFilesystemTarget: false,
                    placement: selection.selected
                });

                expect(selection.selected).toBe(placement);
                expect(decision.tier).toBe("mediated");
            }
        }
    );
});

describe("monotone policy composition", () => {
    test(
        "takes the minimum finite direct-revocation window across governing policies",
        { tags: "p1" },
        () => {
            const merged = mergePolicySets([
                new PolicySet({
                    placement: PlacementPolicy.all(),
                    maxDirectRevocationWindowMs: 500
                }),
                new PolicySet({
                    placement: PlacementPolicy.all(),
                    maxDirectRevocationWindowMs: 20
                }),
                new PolicySet({ placement: PlacementPolicy.all() })
            ]);

            expect(merged.maxDirectRevocationWindowMs).toBe(20);
            expect(
                mergePolicySets([new PolicySet({ placement: PlacementPolicy.all() })])
                    .maxDirectRevocationWindowMs
            ).toBeUndefined();
            for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
                expect(
                    () =>
                        new PolicySet({
                            placement: PlacementPolicy.all(),
                            maxDirectRevocationWindowMs: value
                        })
                ).toThrow(/finite non-negative safe integer/);
            }
        }
    );

    test("merges tiers monotonically regardless of policy order", { tags: "p0" }, () => {
        const direct = new PolicySet({
            placement: PlacementPolicy.all(),
            tiers: { execute: "direct" }
        });
        const mediated = new PolicySet({
            placement: PlacementPolicy.all(),
            tiers: { execute: "mediated" }
        });

        expect(mergePolicySets([direct, mediated]).tierFor("execute")).toBe("mediated");
        expect(mergePolicySets([mediated, direct]).tierFor("execute")).toBe("mediated");
        expect(mergePolicySets([direct]).tierFor("execute")).toBe("direct");
        expect(
            mergePolicySets([direct, new PolicySet({ placement: PlacementPolicy.all() })]).tierFor(
                "execute"
            )
        ).toBe("direct");
        expect(mergePolicySets([direct]).tierFor("observe")).toBeUndefined();
    });

    test(
        "takes the minimum revocation window regardless of order and accepts zero",
        { tags: "p1" },
        () => {
            expect(
                mergePolicySets([
                    new PolicySet({
                        placement: PlacementPolicy.all(),
                        maxDirectRevocationWindowMs: 20
                    }),
                    new PolicySet({
                        placement: PlacementPolicy.all(),
                        maxDirectRevocationWindowMs: 500
                    })
                ]).maxDirectRevocationWindowMs
            ).toBe(20);
            expect(
                new PolicySet({ placement: PlacementPolicy.all(), maxDirectRevocationWindowMs: 0 })
                    .maxDirectRevocationWindowMs
            ).toBe(0);
        }
    );

    test("returns the canonical empty policy for an empty merge", { tags: "p1" }, () => {
        expect(mergePolicySets([])).toBe(PolicySet.empty());
    });

    test(
        "[C13-POLICY-APPROVAL-FLOOR] ORs positive approval requirements and cannot remove package, profile, or ancestor requirements",
        { tags: "p0" },
        () => {
            const packagePolicy = new PolicySet({
                placement: PlacementPolicy.all(),
                approvals: ["observe"],
                tiers: { execute: "mediated" }
            });
            const profilePolicy = new PolicySet({
                placement: PlacementPolicy.all(),
                approvals: ["mutate"]
            });
            const ancestorPolicy = new PolicySet({
                placement: PlacementPolicy.all(),
                approvals: ["externalSend"]
            });
            const attemptedRelaxation = new PolicySet({
                placement: PlacementPolicy.all(),
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
                        sessionFilesystemTarget: false,
                        placement: "bundled",
                        policies: [
                            packagePolicy,
                            profilePolicy,
                            ancestorPolicy,
                            attemptedRelaxation
                        ]
                    })
                ).toEqual({ approvalRequired: true, tier: "mediated" });
            }
        }
    );

    test(
        "[C13-POLICY-DIRECT-ESCALATION] intersects placement policies and cannot broaden an ancestor constraint",
        { tags: "p0" },
        () => {
            const packagePolicy = new PolicySet({
                placement: new PlacementPolicy(["dynamic", "provider", "bundled"], ["*"])
            });
            const ancestorPolicy = new PolicySet({
                placement: new PlacementPolicy(["dynamic", "provider"], ["*"])
            });
            const attemptedBroadening = new PolicySet({
                placement: new PlacementPolicy(["provider", "bundled"], ["*"])
            });

            expect(
                mergePolicySets([packagePolicy, ancestorPolicy, attemptedBroadening]).placement
                    .allowed
            ).toEqual(["provider"]);
            expect(() =>
                mergePolicySets([
                    new PolicySet({ placement: new PlacementPolicy(["dynamic"], ["*"]) }),
                    new PolicySet({ placement: new PlacementPolicy(["bundled"], ["*"]) })
                ])
            ).toThrow(PlacementUnavailableError);

            // The narrowed chain is what makes co-location impossible, and a call that
            // cannot be co-located is mediated even where nothing else asks for it: the
            // floor for observe is direct and the package asked for direct.
            const merged = mergePolicySets([packagePolicy, ancestorPolicy, attemptedBroadening]);
            for (const placement of merged.placement.allowed) {
                expect(
                    evaluatePolicy({
                        impact: "observe",
                        turnOwnedSession: true,
                        sessionFilesystemTarget: false,
                        placement,
                        policies: [
                            new PolicySet({
                                placement: PlacementPolicy.all(),
                                tiers: { observe: "direct" }
                            })
                        ]
                    })
                ).toEqual({ approvalRequired: false, tier: "mediated" });
            }
        }
    );
});

describe("policy declaration codec", () => {
    test(
        "[definition.policy-set] decodes the direct-revocation window as a bounded number and rejects other shapes",
        { tags: "p1" },
        () => {
            const bounded = PolicySet.decode(
                PolicySet.encode(
                    new PolicySet({
                        placement: PlacementPolicy.all(),
                        maxDirectRevocationWindowMs: 250
                    })
                )
            );
            expect(bounded.maxDirectRevocationWindowMs).toBe(250);

            const unbounded = PolicySet.decode(
                PolicySet.encode(new PolicySet({ placement: PlacementPolicy.all() }))
            );
            expect(unbounded.maxDirectRevocationWindowMs).toBeUndefined();

            expect(() =>
                PolicySet.fromData({
                    approvals: [],
                    maxDirectRevocationWindowMs: "250",
                    placement: { allowed: ["bundled"], backings: {}, trusted: ["*"] },
                    tiers: {},
                    treeMerge: null
                })
            ).toThrow(/revocation window is invalid/);
        }
    );

    test(
        "[definition.policy-set] canonicalizes immutable declarative data and round-trips byte deterministically",
        { tags: "p0" },
        () => {
            const approvals: Impact[] = ["administer", "observe"];
            const tiers = {
                administer: "mediated",
                observe: "direct"
            } satisfies EnforcementTierOverrides;
            const policy = new PolicySet({
                approvals,
                tiers,
                placement: new PlacementPolicy(["bundled", "dynamic"], ["*"])
            });
            approvals.pop();

            expect(policy.approvals).toEqual(["observe", "administer"]);
            expect(policy.tiers).not.toBe(tiers);
            expect(policy.tiers).toEqual({ observe: "direct", administer: "mediated" });
            expect(policy.placement.allowed).toEqual(["dynamic", "bundled"]);
            expect(Object.isFrozen(policy)).toBe(true);
            expect(Object.isFrozen(policy.tiers)).toBe(true);
            expect(Object.isFrozen(policy.approvals)).toBe(true);

            const encoded = PolicySet.encode(policy);
            expect(PolicySet.encode(PolicySet.decode(encoded))).toEqual(encoded);
        }
    );

    test("rejects invalid impacts placements and non-object payloads", { tags: "p2" }, () => {
        const payload = {
            approvals: [],
            maxDirectRevocationWindowMs: null,
            placement: {
                allowed: ["dynamic", "provider", "bundled"],
                backings: {},
                trusted: ["*"]
            },
            tiers: {},
            treeMerge: null
        };

        expect(() => PolicySet.fromData({ ...payload, approvals: ["bogus"] })).toThrow(
            "Policy approvals is invalid"
        );
        expect(() => PolicySet.fromData({ ...payload, tiers: null })).toThrow(
            "Policy tiers must be an object"
        );
        expect(() =>
            PolicySet.fromData({ ...payload, tiers: forged<JsonValue>(undefined) })
        ).toThrow("Policy tiers must be an object");
        expect(() => PolicySet.fromData(null)).toThrow("Policy set must be an object");
        expect(() => PolicySet.fromData([])).toThrow("Policy set must be an object");
        expect(() => PolicySet.fromData("payload")).toThrow("Policy set must be an object");
        expect(() => PolicySet.fromData(forged<JsonValue>(undefined))).toThrow(
            "Policy set must be an object"
        );
        expect(() =>
            evaluatePolicy({
                impact: "observe",
                turnOwnedSession: false,
                sessionFilesystemTarget: false,
                placement: forged<IsolationMode>("hostile")
            })
        ).toThrow("Policy placement is invalid");
    });

    test(
        "makes approval removal unrepresentable and rejects malformed codec data",
        { tags: "p0" },
        () => {
            expect(
                () =>
                    new PolicySet({
                        placement: PlacementPolicy.all(),
                        approvals: ["observe", "observe"]
                    })
            ).toThrow(/unique/);
            expect(
                () =>
                    new PolicySet({
                        placement: PlacementPolicy.all(),
                        tiers: { observe: forged<EnforcementTier>("lower") }
                    })
            ).toThrow(/tier/);

            const policy = new PolicySet({
                placement: PlacementPolicy.all(),
                approvals: ["observe"]
            });
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
                            version: { major: 4, minor: 0 }
                        })
                    ),
                "codec.unknown-major"
            );
        }
    );

    test(
        "[definition.policy-set] declares a tree merge setting or declares none, never a silent one",
        { tags: "p1" },
        () => {
            for (const policy of [
                TreeMergePolicy.ours,
                TreeMergePolicy.theirs,
                TreeMergePolicy.perPath
            ]) {
                const decoded = PolicySet.decode(
                    PolicySet.encode(
                        new PolicySet({ placement: PlacementPolicy.all(), treeMerge: policy })
                    )
                );
                expect(decoded.treeMerge?.equals(policy)).toBe(true);
            }

            expect(TreeMergePolicy.ours.side()).toEqual({ kind: "some", value: "ours" });
            expect(TreeMergePolicy.theirs.side()).toEqual({ kind: "some", value: "theirs" });
            expect(TreeMergePolicy.perPath.side()).toEqual({ kind: "none" });
            expect(TreeMergePolicy.ours.surfacesConflicts()).toBe(false);
            expect(TreeMergePolicy.theirs.surfacesConflicts()).toBe(false);
            expect(TreeMergePolicy.perPath.surfacesConflicts()).toBe(true);

            // Omission is the declaration that this platform never merges over one shared
            // Environment. It must survive a round trip as absence rather than acquire a
            // default, because the merge rule refuses on absence.
            const omitted = PolicySet.decode(
                PolicySet.encode(new PolicySet({ placement: PlacementPolicy.all() }))
            );
            expect(omitted.treeMerge).toBeUndefined();
            expect(requireObject(PolicySet.empty().toData())["treeMerge"]).toBeNull();

            expect(() => TreeMergePolicy.fromData("mine")).toThrow(
                /TreeMergePolicy data must name a constructor/
            );
        }
    );

    test(
        "[definition.policy-set] freezes every tree merge singleton the codec tuples reach",
        { tags: "p1" },
        () => {
            // The PolicySet codec reaches these three, and so do the Blueprint, managed
            // state, Actor plan, materialization plan and rollout codecs that carry a
            // PolicySet, so a decoded policy hands out the same shared instances. A mutable
            // one would let one holder rewrite every other holder's setting.
            for (const policy of [
                TreeMergePolicy.ours,
                TreeMergePolicy.theirs,
                TreeMergePolicy.perPath
            ]) {
                expect(Object.isFrozen(policy)).toBe(true);
                expect(() => {
                    Object.defineProperty(policy, "kind", { value: "tampered" });
                }).toThrow(TypeError);
                expect(TreeMergePolicy.fromData(policy.toData())).toBe(policy);
            }
            expect(TreeMergePolicy.ours.kind).toBe("ours");
            expect(TreeMergePolicy.perPath.kind).toBe("perPath");
        }
    );
});

function maximumTier(...tiers: readonly EnforcementTier[]): EnforcementTier {
    return tiers.includes("mediated") ? "mediated" : "direct";
}

/*
 * SPEC §7.2 lines 2830-2833 state the floor as a table: "`observe` → direct; on a Turn-owned
 * Session (§4.5), `execute` and `mutate` whose target is that Session's own filesystem →
 * direct; every other `execute` and `mutate`, plus `externalSend`, `delegate`, and
 * `administer` → mediated." Lines 2847-2849 state the `mutate` exception from the other side:
 * "`mutate` against anything else — a platform record, another facet, a shared or
 * longer-lived Session — keeps its mediated floor".
 *
 * This is that table transcribed, so the sweep above answers to the SPEC rather than to
 * `enforcementFloor`. An expectation read out of the floor agrees with every mutation of the
 * floor, including one that widened the own-filesystem exception to every `mutate` — which is
 * the divergence `AgentCore.Kernel.Facets.mutate_floor_gap` records against the model's
 * `AgentCore.defaultTier` — or one that narrowed the exception away.
 */
function specAdmitsDirect(
    impact: Impact,
    turnOwnedSession: boolean,
    sessionFilesystemTarget: boolean
): boolean {
    return (
        impact === "observe" ||
        (impact === "execute" && turnOwnedSession) ||
        (impact === "mutate" && turnOwnedSession && sessionFilesystemTarget)
    );
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
