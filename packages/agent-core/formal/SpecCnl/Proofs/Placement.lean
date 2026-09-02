import SpecCnl.Bridge.Placement

/-!
# Discharging the §9.2, §7.2, and §3.5 placement propositions

Each theorem proves its hand proposition true of the model. The model consequences these
lean on are stated and proved in `AgentCore.Cnl.Placement`, beside the definitions they
read, rather than here: a discharge that projected `DirectReady`'s components by index
would silently follow that definition's shape instead of naming the fact it needs.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_PLACEMENT_INTERSECTION : Bridge.hand_C13_PLACEMENT_INTERSECTION := by
  refine ⟨⟨fun _ valid => chosen_placement_selects_an_admissible_mode valid, ?_⟩, ?_⟩
  · intro _ ⟨valid, last⟩ _ unbundled
    exact bundled_choice_excludes_earlier_modes valid last unbundled
  · intro _ ⟨valid, chosen⟩ _ isDynamic
    rw [isDynamic]
    exact provider_choice_excludes_dynamic_mode valid chosen

theorem proved_C13_PLACEMENT_UNTRUSTED_BUNDLED :
    Bridge.hand_C13_PLACEMENT_UNTRUSTED_BUNDLED :=
  fun _ unbundled impact sessionScoped intercepted =>
    unbundled_placement_is_never_direct unbundled impact sessionScoped intercepted

theorem proved_C13_POLICY_DIRECT_COLOCATION : Bridge.hand_C13_POLICY_DIRECT_COLOCATION :=
  ⟨⟨fun _ _ _ step => direct_admission_selects_bundled_placement step,
      fun _ _ _ step => direct_admission_uses_exact_turn_lease step⟩,
    fun _ _ _ step => direct_admission_is_nondurable step⟩

theorem proved_C13_POLICY_MEDIATION_FLOOR : Bridge.hand_C13_POLICY_MEDIATION_FLOOR :=
  ⟨⟨fun _ _ _ step => direct_admission_observes_only step,
      fun _ _ _ step => direct_admission_requires_no_approval step⟩,
    fun _ _ _ step => direct_admission_has_no_applicable_interceptor step⟩

theorem proved_C13_POLICY_EPOCH_RECHECK : Bridge.hand_C13_POLICY_EPOCH_RECHECK :=
  ⟨fun _ _ _ ready => mediated_admission_compares_current_path_epochs ready,
    fun _ _ _ _ _ ready domain =>
      mediated_admission_matches_open_reservation_epoch ready domain⟩

theorem proved_C13_CONFIG_SECRET_CUSTODY : Bridge.hand_C13_CONFIG_SECRET_CUSTODY := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ _ _ isResolve
    obtain ⟨custody, lookup, _, endpoint, _⟩ :=
      secret_resolution_requires_current_custody (isResolve ▸ step)
    exact ⟨custody, lookup, endpoint⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ _ _ isResolve
    obtain ⟨custody, lookup, binding, _, _⟩ :=
      secret_resolution_requires_current_custody (isResolve ▸ step)
    exact ⟨custody, lookup, binding⟩

end SpecCnl.Proofs
