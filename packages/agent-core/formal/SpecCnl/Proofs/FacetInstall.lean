import SpecCnl.Bridge.FacetInstall

/-!
# FacetInstall: discharging every hand proposition

Written against `AgentCore`. Each discharge names the model theorem it rests on, so what
the bridge is worth is exactly what those theorems say.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_FACET_REF_CANONICAL : Bridge.hand_C13_FACET_REF_CANONICAL :=
  fun _ _ _ _ _ _ freeOne freeTwo joined =>
    pair_key_injective_of_free_left freeOne freeTwo joined

theorem proved_C13_FACET_SLOT_AUTHORITY : Bridge.hand_C13_FACET_SLOT_AUTHORITY :=
  fun _ _ _ _ _ step => authorized_contribution_carries_admission step

theorem proved_C13_FACET_DISPOSAL : Bridge.hand_C13_FACET_DISPOSAL :=
  fun _ _ _ step _ _ stored closed => closed_session_is_terminal step stored closed

theorem proved_C13_FACET_INSTALL_VERIFICATION :
    Bridge.hand_C13_FACET_INSTALL_VERIFICATION := by
  refine ⟨⟨fun _ valid => (valid_placement_is_declared_and_trusted valid).1,
    fun _ valid => (valid_placement_is_declared_and_trusted valid).2⟩, ?_⟩
  intro _ _ _ ⟨_, _, step⟩ _ isContribute
  exact contribution_names_a_declared_slot (isContribute ▸ step)

theorem proved_C13_FACET_CONTRIBUTION_ATTRIBUTION :
    Bridge.hand_C13_FACET_CONTRIBUTION_ATTRIBUTION := by
  refine ⟨⟨?_, ?_⟩, ?_⟩
  · intro _ _ _ ⟨_, step⟩ origins
    exact slot_step_preserves_origin_exclusivity origins step
  · intro _ _ _ ⟨_, _, step⟩ _ isContribute
    exact contribution_requires_unclaimed_entry_id (isContribute ▸ step)
  · intro _ _ _ ⟨⟨_, isRecontribute⟩, _, step⟩
    exact congrArg SlotLedger.entries
      (recontribution_is_stored_identity (isRecontribute ▸ step)).1

end SpecCnl.Proofs
