import { describe, expect, test } from "vitest";
import { POLICY_IMPACTS } from "../../src/definition";
import type { EnforcementTier, Impact } from "../../src/facets/enforcement";
import {
    claimHonorsEnforcementFloor as handwrittenClaimHonorsFloor,
    enforcementFloor as handwrittenEnforcementFloor
} from "../../src/facets/enforcement";
import {
    claimHonorsEnforcementFloor as generatedClaimHonorsFloor,
    enforcementFloor as generatedEnforcementFloor
} from "../../src/facets/enforcement.generated";

/*
 * `enforcement.generated.ts` is what TSLean lowers from `AgentCore.Facets.Enforcement`, and
 * `AGENT_CORE_ENFORCEMENT=generated` swaps it in for the whole suite. That swap answers "does the
 * twin pass every test the handwritten module passes"; it cannot answer "do the two agree", because
 * only one of them is loaded per run. This suite loads both by path and compares them directly, so
 * the twin is exercised in the ordinary run rather than only in the substituted one.
 *
 * Both are compared against a table of the conditions SPEC §7.2 admits `direct` under, keyed by
 * `Impact` so a new impact fails to compile rather than falling through untested. Deriving the
 * expectation from either implementation would agree with any mutation of it, and deriving it from
 * one to check the other would let a shared mistake pass.
 */

interface Condition {
    readonly turnOwnedSession: boolean;
    readonly sessionFilesystemTarget: boolean;
}

const CONDITIONS: readonly Condition[] = [
    { turnOwnedSession: false, sessionFilesystemTarget: false },
    { turnOwnedSession: false, sessionFilesystemTarget: true },
    { turnOwnedSession: true, sessionFilesystemTarget: false },
    { turnOwnedSession: true, sessionFilesystemTarget: true }
];

// SPEC §7.2: `observe` is always direct; `execute` only inside a Turn-owned Session; `mutate` only
// against that Session's own filesystem; `externalSend`, `delegate` and `administer` never are.
const ADMITS_DIRECT: Record<Impact, (condition: Condition) => boolean> = {
    observe: () => true,
    execute: (condition) => condition.turnOwnedSession,
    mutate: (condition) => condition.turnOwnedSession && condition.sessionFilesystemTarget,
    externalSend: () => false,
    delegate: () => false,
    administer: () => false
};

const specFloor = (impact: Impact, condition: Condition): EnforcementTier =>
    ADMITS_DIRECT[impact](condition) ? "direct" : "mediated";

describe("the TSLean-lowered enforcement twin", () => {
    test(
        "answers SPEC §7.2's floor over the whole impact and session domain",
        { tags: "p0" },
        () => {
            for (const impact of POLICY_IMPACTS) {
                for (const condition of CONDITIONS) {
                    const expected = specFloor(impact, condition);
                    expect(
                        generatedEnforcementFloor(
                            impact,
                            condition.turnOwnedSession,
                            condition.sessionFilesystemTarget
                        )
                    ).toBe(expected);
                    expect(
                        handwrittenEnforcementFloor(
                            impact,
                            condition.turnOwnedSession,
                            condition.sessionFilesystemTarget
                        )
                    ).toBe(expected);
                }
            }
        }
    );

    test(
        "answers SPEC §7.1's claim admission over the whole claim, derived and target domain",
        { tags: "p0" },
        () => {
            // A claim may raise the floor the seam derived and never lower it, so it is admissible
            // exactly when it reaches `direct` nowhere the derived impact does not. Both Turn-owned
            // Session conditions are weighed because a claim recorded once at discovery or install
            // has to stay safe at every later call site.
            for (const sessionFilesystemTarget of [false, true]) {
                const sessions: readonly Condition[] = [
                    { turnOwnedSession: true, sessionFilesystemTarget },
                    { turnOwnedSession: false, sessionFilesystemTarget }
                ];
                for (const claimed of POLICY_IMPACTS) {
                    for (const derived of POLICY_IMPACTS) {
                        const admissible = sessions.every(
                            (condition) =>
                                !ADMITS_DIRECT[claimed](condition) ||
                                ADMITS_DIRECT[derived](condition)
                        );
                        expect(
                            generatedClaimHonorsFloor(claimed, derived, sessionFilesystemTarget)
                        ).toBe(admissible);
                        expect(
                            handwrittenClaimHonorsFloor(claimed, derived, sessionFilesystemTarget)
                        ).toBe(admissible);
                    }
                }
            }
        }
    );

    test("names the escalations SPEC §7.1 turns on", { tags: "p0" }, () => {
        // `observe` is the only impact reaching `direct` under both session conditions, so claiming
        // it against anything else buys a tier the seam denied, while claiming anything else against
        // it is the harmless tightening.
        expect(generatedClaimHonorsFloor("observe", "externalSend", false)).toBe(false);
        expect(generatedClaimHonorsFloor("externalSend", "observe", false)).toBe(true);

        // A Turn-owned Session lets `execute` reach `direct`, so claiming it against `mutate` is
        // refused at exactly the sites where that condition holds — unless the seam's target is the
        // Session's own filesystem, which is the one condition that lets `mutate` reach `direct`
        // too and makes the two claims interchangeable.
        expect(generatedClaimHonorsFloor("execute", "mutate", false)).toBe(false);
        expect(generatedClaimHonorsFloor("mutate", "execute", false)).toBe(true);
        expect(generatedClaimHonorsFloor("execute", "mutate", true)).toBe(true);
        expect(generatedClaimHonorsFloor("mutate", "execute", true)).toBe(true);
    });
});
