export type Impact = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";

export type EnforcementTier = "direct" | "mediated";

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
 * Neither is authoritative: the suite runs against either so the two can be compared.
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
