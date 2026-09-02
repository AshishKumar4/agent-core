import SpecCnl.Bridge.TrustRoute

/-!
# TrustRoute: discharging every hand proposition

Each discharge reads one theorem of the model. The two trust units read
`AgentCore.published_non_self_tier_is_channel_derived`,
`AgentCore.published_self_tier_presents_a_lease_token`, and
`AgentCore.fire_admits_channel_trust`; the three route units read the reserve and project
premise extractions in `AgentCore.Cnl.TrustRoute` and
`AgentCore.target_projection_is_exact_authenticated_reservation_projection`.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_TRUST_HOST_DERIVED : Bridge.hand_C13_TRUST_HOST_DERIVED := by
  refine ⟨?_, ?_⟩
  · intro event ⟨_, _, _, _, _, step, lookup⟩
    exact published_non_self_tier_is_channel_derived step event lookup
  · intro event ⟨_, _, _, _, _, step, lookup⟩
    exact published_self_tier_presents_a_lease_token step event lookup

theorem proved_C13_TRUST_ASSERTION_REJECTION : Bridge.hand_C13_TRUST_ASSERTION_REJECTION := by
  intro _ _ _ ⟨_, step⟩ _ _ _ isFire
  exact fire_admits_channel_trust (isFire ▸ step)

theorem proved_C13_SUBSCRIPTION_AUTHORITY : Bridge.hand_C13_SUBSCRIPTION_AUTHORITY := by
  intro _ _ _ ⟨_, _, _, step⟩ _ isReserve
  exact reservation_authority_matches_tenant_relation (isReserve ▸ step)

theorem proved_C13_ROUTE_SOURCE_OWNED : Bridge.hand_C13_ROUTE_SOURCE_OWNED := by
  intro _ _ _ ⟨_, _, _, step⟩ _ isProject
  exact target_projection_is_exact_authenticated_reservation_projection (isProject ▸ step)

theorem proved_C13_ROUTE_STABLE_INVOCATION : Bridge.hand_C13_ROUTE_STABLE_INVOCATION := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, _, _, step⟩ _ isReserve
    exact reservation_cites_owned_source_event (isReserve ▸ step)
  · intro _ _ _ ⟨_, _, _, step⟩ _ isReserve
    exact reservation_fixes_one_invocation (isReserve ▸ step)

end SpecCnl.Proofs
