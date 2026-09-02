import SpecCnl.Bridge.Commands

/-!
# Discharging the Commands group (§4.3)

Every hand proposition of the group, proved true of the model. The install-side clauses
read `AgentCore.Cnl.Commands`, which identifies the record an installation added; the
rest read the theorems stated beside `AgentCore.CommandStep` itself.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_COMMAND_COLLISION : Bridge.hand_C13_COMMAND_COLLISION := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨_, _, _, step⟩ scope command isInstall surface declared
    subst isInstall
    cases occupied : before.surfaces scope surface command.name with
    | none => rfl
    | some occupant => exact absurd step (command_surface_collision_rejected declared occupied)
  · intro before label after ⟨_, _, step⟩ scope surface name id stored
    exact command_step_preserves_surface_registration step stored

theorem proved_C13_COMMAND_SUBSCRIPTION_DEFAULTS :
    Bridge.hand_C13_COMMAND_SUBSCRIPTION_DEFAULTS := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨_, _, _, step⟩ scope command isInstall tiers declared empty
    subst isInstall
    subst empty
    exact empty_trust_installation_rejected declared step
  · intro before label after ⟨⟨_, _, isInstall⟩, _, _, step⟩ scope id installed fresh stored
    subst isInstall
    cases command_install_stores_only_the_derived_record step fresh stored
    exact ⟨rfl, rfl, rfl, derived_route_trust_is_nonempty step⟩

theorem proved_C13_COMMAND_INVOCATION_CORRELATION :
    Bridge.hand_C13_COMMAND_INVOCATION_CORRELATION := by
  refine ⟨?_, deriveSubscription_matches_derived_route⟩
  intro before label after ⟨⟨_, _, isInstall⟩, _, _, step⟩ scope id installed fresh stored
  subst isInstall
  cases command_install_stores_only_the_derived_record step fresh stored
  rfl

theorem proved_C13_COMMAND_ARGUMENT_BINDING : Bridge.hand_C13_COMMAND_ARGUMENT_BINDING := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨⟨_, _, isInstall⟩, _⟩ schemas mappings step scope id installed
      fresh stored
    subst isInstall
    exact command_install_records_install_checked_mapping step fresh stored
  · intro before label after ⟨⟨scope, id, arguments, isInvoke⟩, _⟩ schemas mappings safe step
      invocation appended
    subst isInvoke
    obtain ⟨installed, emitted, storedCommand, invokedList, sameScope, sameCommand,
      mappedInput, argumentsValid, inputValid⟩ :=
      invocation_emits_validated_operation_input safe step
    rw [invokedList] at appended
    injection appended with sameRecord _
    subst sameRecord
    refine ⟨installed, arguments, ?_, argumentsValid, mappedInput, inputValid⟩
    rw [sameScope, sameCommand]
    exact storedCommand

end SpecCnl.Proofs
