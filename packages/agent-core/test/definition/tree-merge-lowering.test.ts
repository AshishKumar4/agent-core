import { describe, expect, test } from "vitest";
import {
    OursTreeMergePolicy,
    PerPathTreeMergePolicy,
    TheirsTreeMergePolicy,
    TreeMergePolicy,
    type GeneratedData,
    type TreeMergePolicyData,
    type TreeMergeSide
} from "../../src/definition/generated/tree-merge/AgentCore/Extract/TreeMerge";

/*
 * `src/definition/generated/tree-merge/` is what the TSLean compiler lowers from the Lean
 * module the kernel checks, `formal/AgentCore/Extract/TreeMerge.lean`. SPEC §5.2.1 gives
 * merge resolution three policies and two facts about each: which side's tree a wholesale
 * resolution takes, and whether a path both sides changed is a conflict the operator
 * resolves.
 *
 * The consumer in src/definition/policy.ts reads this through its own record codec; this
 * suite drives the generated surface over its whole domain and decides every answer from
 * the SPEC table, so the two facts stay tied to each other the way §5.2.1 ties them.
 */

interface Resolution {
    readonly side: TreeMergeSide | "none";
    readonly surfacesConflicts: boolean;
}

/** `satisfies` keys this by policy, so a new policy fails to compile rather than going untested. */
const SPEC = {
    ours: { side: "ours", surfacesConflicts: false },
    theirs: { side: "theirs", surfacesConflicts: false },
    // Per path there is no single side to record, which is exactly why it is the policy
    // that can reach a path it has no answer for.
    perPath: { side: "none", surfacesConflicts: true }
} satisfies Record<TreeMergePolicyData, Resolution>;

const POLICIES: readonly TreeMergePolicyData[] = ["ours", "theirs", "perPath"];

const SINGLETON = {
    ours: TreeMergePolicy.ours,
    theirs: TreeMergePolicy.theirs,
    perPath: TreeMergePolicy.perPath
} satisfies Record<TreeMergePolicyData, TreeMergePolicy>;

const NOT_POLICY_DATA: readonly GeneratedData[] = [
    "",
    "Ours",
    "per-path",
    "perpath",
    "mine",
    0,
    1,
    true,
    false,
    null,
    undefined,
    [],
    ["ours"],
    {},
    { kind: "ours" }
];

function resolution(policy: TreeMergePolicy): Resolution {
    const side = policy.side();
    return {
        side: side.kind === "none" ? "none" : side.value,
        surfacesConflicts: policy.surfacesConflicts()
    };
}

describe("the TSLean-generated tree-merge lowering", () => {
    test("names every policy the SPEC table declares", { tags: "p1" }, () => {
        expect([...POLICIES].sort()).toEqual(Object.keys(SPEC).sort());
    });

    test(
        "answers SPEC §5.2.1's whole resolution table for every policy, from every constructor",
        { tags: "p1" },
        () => {
            for (const kind of POLICIES) {
                const named = TreeMergePolicy.from(kind);
                const decoded = TreeMergePolicy.fromData(kind);
                expect(named).toBe(SINGLETON[kind]);
                expect(decoded).toBe(SINGLETON[kind]);
                expect(named.kind).toBe(kind);
                expect(named.toData()).toBe(kind);

                expect(resolution(named)).toEqual(SPEC[kind]);
                expect(resolution(decoded)).toEqual(SPEC[kind]);
            }
        }
    );

    test(
        "surfaces conflicts exactly where no single side answers",
        { tags: "p1" },
        () => {
            // The two facts are one fact in §5.2.1: a wholesale policy has already
            // answered every path by naming a side, so it has no conflict to surface,
            // and the policy that names none is the only one that can. A lowering that
            // let a wholesale policy surface conflicts, or a per-path policy claim a
            // side, would break the tie the SPEC states.
            for (const kind of POLICIES) {
                const policy = TreeMergePolicy.from(kind);
                expect(policy.side().kind === "none").toBe(policy.surfacesConflicts());
            }
            expect(POLICIES.filter((kind) => SPEC[kind].surfacesConflicts)).toEqual(["perPath"]);
        }
    );

    test("decides equality by the policy a value names", { tags: "p1" }, () => {
        for (const left of POLICIES) {
            for (const right of POLICIES) {
                expect(TreeMergePolicy.from(left).equals(TreeMergePolicy.fromData(right))).toBe(
                    left === right
                );
            }
        }
    });

    test("refuses policy data outside the vocabulary", { tags: "p1" }, () => {
        for (const value of NOT_POLICY_DATA) {
            // A merge policy decoded from a name the table does not have would resolve
            // a tree by no stated rule, so every non-member is refused.
            expect(() => TreeMergePolicy.fromData(value)).toThrow(TypeError);
            expect(() => TreeMergePolicy.fromData(value)).toThrow(
                /TreeMergePolicy data must name a constructor/u
            );
        }
    });

    test("seals every lowered case as a frozen value", { tags: "p2" }, () => {
        const cases = [
            new OursTreeMergePolicy(),
            new TheirsTreeMergePolicy(),
            new PerPathTreeMergePolicy()
        ];

        expect(cases.map((policy) => policy.kind)).toEqual(POLICIES);
        for (const policy of cases) {
            expect(Object.isFrozen(policy)).toBe(true);
            expect(resolution(policy)).toEqual(SPEC[policy.kind]);
        }
    });
});
