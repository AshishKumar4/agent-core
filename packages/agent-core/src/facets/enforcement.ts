// `Impact` and `EnforcementTier` are lowered from `AgentCore.Facets.Enforcement`'s
// inductives, so the generated module is their one declaration and this module re-exports
// it rather than restating it. A second copy here would drift in precisely the direction
// the twin exists to rule out: substitution swaps the two implementations at runtime, where
// a type is already erased, so a vocabulary that disagreed between them would fail no test.
import type { EnforcementTier, Impact } from "./enforcement.generated";

export type { EnforcementTier, Impact };

/**
 * SPEC §7.2's enforcement floor: `observe` is always direct; `execute` is direct only
 * inside a Turn-owned Session; `mutate` is direct only against that Session's own
 * filesystem; every other case — `externalSend`, `delegate`, `administer`, and any
 * `mutate`/`execute` outside those conditions — is mediated. Lives at the facets layer
 * (not `definition`, which imports `Impact` from here) so both the definition plane's
 * PolicySet evaluation and a facet profile deriving its own seam-bound impact (§7.1,
 * `claimHonorsEnforcementFloor` below) share one computation instead of each
 * reimplementing it.
 *
 * This module is the substitution point for `enforcement.generated.ts`, which the TSLean
 * compiler lowers from `AgentCore.Facets.Enforcement` and which exports this same surface.
 * Neither implementation is authoritative: the suite runs against either so the two can be
 * compared. Only the implementations are written twice; the vocabulary above is not.
 */
export function enforcementFloor(
    impact: Impact,
    turnOwnedSession: boolean,
    sessionFilesystemTarget: boolean
): EnforcementTier {
    if (
        impact === "observe" ||
        (impact === "execute" && turnOwnedSession) ||
        (impact === "mutate" && turnOwnedSession && sessionFilesystemTarget)
    ) {
        return "direct";
    }
    return "mediated";
}

/**
 * SPEC §7.1 (C13-POLICY-IMPACT-BOUNDARY): the host derives an Operation's impact from
 * the seam its request crosses, never from what the callee declares about itself; a
 * callee's own claim may replace the derived impact only when it never admits a floor
 * (§7.2) the derived impact would have mediated. Checked across both Turn-owned-Session
 * conditions because a claim recorded once (typically at discovery or install time) has
 * to hold safe for every call site it is later used at, regardless of which condition
 * holds there. `sessionFilesystemTarget` is fixed per caller: pass `false` for a seam
 * whose target is never a Turn-owned Session's own filesystem — a discovered,
 * externally configured endpoint, for instance — and thread the real value through for
 * a seam that can legitimately have one.
 */
export function claimHonorsEnforcementFloor(
    claimed: Impact,
    derived: Impact,
    sessionFilesystemTarget: boolean
): boolean {
    return [true, false].every(
        (turnOwnedSession) =>
            enforcementFloor(claimed, turnOwnedSession, sessionFilesystemTarget) !== "direct" ||
            enforcementFloor(derived, turnOwnedSession, sessionFilesystemTarget) === "direct"
    );
}
