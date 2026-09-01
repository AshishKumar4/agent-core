import { describe, expect, test } from "vitest";
import { POLICY_IMPACTS } from "../../src/definition";
import {
    claimHonorsEnforcementFloor,
    enforcementFloor,
    type EnforcementTier,
    type Impact
} from "../../src/facets/generated/AgentCore/Facets/Enforcement";

/*
 * `src/facets/generated/` is what the TSLean compiler lowers from the Lean module the
 * kernel checks, `formal/AgentCore/Facets/Enforcement.lean`. It was a twin beside a
 * handwritten module once; the cutover made it the one live implementation, so this
 * suite is the contract's proof against the generated artifact itself: the SPEC table,
 * not either implementation, decides every answer.
 *
 * Both are compared against a table of the conditions SPEC §7.2 admits `direct` under, keyed by
 * `Impact` so a new impact fails to compile rather than falling through untested. Deriving the
 * expectation from the implementation would agree with any mutation of it.
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

/** `satisfies` keys this by `Impact`, so a new impact fails to compile rather than going untested. */
type SpecAdmission = Record<Impact, (condition: Condition) => boolean>;

// SPEC §7.2: `observe` is always direct; `execute` only inside a Turn-owned Session; `mutate` only
// against that Session's own filesystem; `externalSend`, `delegate` and `administer` never are.
const ADMITS_DIRECT = {
    observe: (_condition: Condition): boolean => true,
    execute: (condition: Condition): boolean => condition.turnOwnedSession,
    mutate: (condition: Condition): boolean =>
        condition.turnOwnedSession && condition.sessionFilesystemTarget,
    externalSend: (_condition: Condition): boolean => false,
    delegate: (_condition: Condition): boolean => false,
    administer: (_condition: Condition): boolean => false
} satisfies SpecAdmission;

const specFloor = (impact: Impact, condition: Condition): EnforcementTier =>
    ADMITS_DIRECT[impact](condition) ? "direct" : "mediated";

describe("the TSLean-generated enforcement floor", () => {
    test(
        "answers SPEC §7.2's floor over the whole impact and session domain",
        { tags: "p0" },
        () => {
            for (const impact of POLICY_IMPACTS) {
                for (const condition of CONDITIONS) {
                    expect(
                        enforcementFloor(
                            impact,
                            condition.turnOwnedSession,
                            condition.sessionFilesystemTarget
                        )
                    ).toBe(specFloor(impact, condition));
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
                            claimHonorsEnforcementFloor(claimed, derived, sessionFilesystemTarget)
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
        expect(claimHonorsEnforcementFloor("observe", "externalSend", false)).toBe(false);
        expect(claimHonorsEnforcementFloor("externalSend", "observe", false)).toBe(true);

        // A Turn-owned Session lets `execute` reach `direct`, so claiming it against `mutate` is
        // refused at exactly the sites where that condition holds — unless the seam's target is the
        // Session's own filesystem, which is the one condition that lets `mutate` reach `direct`
        // too and makes the two claims interchangeable.
        expect(claimHonorsEnforcementFloor("execute", "mutate", false)).toBe(false);
        expect(claimHonorsEnforcementFloor("mutate", "execute", false)).toBe(true);
        expect(claimHonorsEnforcementFloor("execute", "mutate", true)).toBe(true);
        expect(claimHonorsEnforcementFloor("mutate", "execute", true)).toBe(true);
    });
});
