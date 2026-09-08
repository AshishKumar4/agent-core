import { describe, expect, test } from "vitest";
import { POLICY_IMPACTS } from "../../src/definition";
import {
    Impact,
    claimHonorsEnforcementFloor,
    enforcementFloor,
    requireBoolean,
    type EnforcementTier,
    type GeneratedData
} from "../../src/facets/generated/enforcement/AgentCore/Facets/Enforcement";
import { malformed } from "../helpers/malformed";

/*
 * `src/facets/generated/enforcement/` is what the TSLean compiler lowers from the Lean
 * module the kernel checks, `formal/AgentCore/Facets/Enforcement.lean`. It was a twin beside
 * a handwritten module once; the cutover made it the one live implementation, so this
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
        "[C13-FACET-IMPACT-BOUNDARY] answers SPEC §7.2's floor over the whole impact and session domain",
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
        "[C13-FACET-IMPACT-BOUNDARY] answers SPEC §7.1's claim admission over the whole claim, derived and target domain",
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

    test(
        "[C13-FACET-IMPACT-BOUNDARY] fails closed for an impact the vocabulary does not name",
        { tags: "p0" },
        () => {
            // The lowering ends `admitsDirect` in a bare `return false`, which answers for
            // `administer` and for every name outside the vocabulary too. The own-filesystem
            // `mutate` exception is the only conditional direct branch a `mutate`-shaped name
            // could reach, so a spelling that reached it would buy the tier §7.2 denies.
            const unnamed = malformed<Impact>("mutate.session");
            for (const condition of CONDITIONS) {
                expect(
                    enforcementFloor(
                        unnamed,
                        condition.turnOwnedSession,
                        condition.sessionFilesystemTarget
                    )
                ).toBe("mediated");
            }

            // A claim that admits `direct` nowhere honors every floor; a derived impact that
            // admits it nowhere refuses every claim that does, the own-filesystem `mutate`
            // included.
            expect(claimHonorsEnforcementFloor(unnamed, "administer", true)).toBe(true);
            expect(claimHonorsEnforcementFloor("observe", unnamed, true)).toBe(false);
            expect(claimHonorsEnforcementFloor("mutate", unnamed, true)).toBe(false);
            expect(claimHonorsEnforcementFloor("mutate", unnamed, false)).toBe(true);
        }
    );

    test(
        "[C13-FACET-IMPACT-BOUNDARY] decodes exactly SPEC §7.1's impact vocabulary and refuses anything else",
        { tags: "p1" },
        () => {
            for (const impact of POLICY_IMPACTS) {
                expect(Impact.fromData(impact)).toBe(impact);
                // What a manifest declares arrives as data, so the decoded impact has to
                // reach the same floor the literal does at every session condition.
                for (const condition of CONDITIONS) {
                    expect(
                        enforcementFloor(
                            Impact.fromData(impact),
                            condition.turnOwnedSession,
                            condition.sessionFilesystemTarget
                        )
                    ).toBe(specFloor(impact, condition));
                }
            }

            // An impact the vocabulary does not name is refused rather than defaulted:
            // defaulting it to the weakest name would hand a seam the tier §7.2 denies,
            // and defaulting it to the strongest would mediate work no policy declared.
            const unnamed: readonly GeneratedData[] = [
                "",
                "Observe",
                "mutate.session",
                "read",
                0,
                1,
                true,
                null,
                undefined,
                [],
                ["observe"],
                {},
                { impact: "observe" }
            ];
            for (const value of unnamed) {
                expect(() => Impact.fromData(value)).toThrow(TypeError);
                expect(() => Impact.fromData(value)).toThrow(/must name a Impact/u);
            }
        }
    );

    test(
        "[C13-FACET-IMPACT-BOUNDARY] refuses a session condition that is not a boolean",
        { tags: "p1" },
        () => {
            // The session conditions cross the same data boundary as the impact, and
            // both of them gate `direct`. A guard that coerced would read `1`, `"false"`
            // or `{}` as a Turn-owned Session and lower a mediated floor to direct,
            // which is the one escalation §7.2 has no recovery from.
            for (const value of [0, 1, -1, "", "true", "false", null, undefined, [], {}]) {
                expect(() => requireBoolean(value, "turnOwnedSession")).toThrow(TypeError);
                expect(() => requireBoolean(value, "turnOwnedSession")).toThrow(
                    /turnOwnedSession must be a boolean/u
                );
            }

            for (const condition of CONDITIONS) {
                const turnOwnedSession = requireBoolean(
                    condition.turnOwnedSession,
                    "turnOwnedSession"
                );
                const sessionFilesystemTarget = requireBoolean(
                    condition.sessionFilesystemTarget,
                    "sessionFilesystemTarget"
                );
                expect(turnOwnedSession).toBe(condition.turnOwnedSession);
                expect(sessionFilesystemTarget).toBe(condition.sessionFilesystemTarget);
                expect(enforcementFloor("execute", turnOwnedSession, sessionFilesystemTarget)).toBe(
                    specFloor("execute", condition)
                );
            }
        }
    );
});
