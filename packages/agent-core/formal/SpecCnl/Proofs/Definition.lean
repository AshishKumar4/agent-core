import SpecCnl.Bridge.Definition

/-!
# Definition: discharging every hand proposition

Written against `AgentCore`. Each discharge names the model theorem it rests on, so what
the bridge is worth is exactly what those theorems say: `reconcile_is_stored_identity` and
`materialize_step_preserves_installed_mapping` for the two convergence clauses,
`installed_name_has_unique_subscription` — the `AgentCore/Cnl` restatement of
`materialized_automation_has_unique_firing_subscription` off the template record — for the
third, and `migration_requires_valid_target_pins` for both halves of the pinned closure.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_BLUEPRINT_CONVERGENCE : Bridge.hand_C13_BLUEPRINT_CONVERGENCE := by
  refine ⟨⟨?_, ?_⟩, ?_⟩
  · intro _ _ _ ⟨⟨_, _, isReconcile⟩, step⟩
    have identity := (reconcile_is_stored_identity (isReconcile ▸ step)).1
    exact ⟨congrArg MaterializerLedger.installed identity,
      congrArg MaterializerLedger.routing identity⟩
  · intro _ _ _ step _ _ _ installed
    exact materialize_step_preserves_installed_mapping step installed
  · intro _ _ _ _ _ left right
    exact installed_name_has_unique_subscription left right

theorem proved_C13_PACKAGE_DEPENDENCY_DECLARED :
    Bridge.hand_C13_PACKAGE_DEPENDENCY_DECLARED := by
  have closure : ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      (∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run id expected commit, label = GraphLabel.migrate run id expected commit →
        ∀ pins operation receipt,
          commit.kind = RunCommitKind.migration pins operation receipt →
            pins.packageClosure ≠ [] ∧
              (pins.packageClosure.map PackagePin.package).Nodup := by
    intro _ _ _ ⟨_, _, _, step⟩ _ _ _ _ isMigrate pins operation receipt kind
    obtain ⟨_, _, _, _, _, declaredKind, valid⟩ :=
      migration_requires_valid_target_pins (isMigrate ▸ step)
    rw [kind] at declaredKind
    obtain ⟨rfl, _, _⟩ := RunCommitKind.migration.inj declaredKind
    obtain ⟨_, nonempty, unique⟩ := valid
    exact ⟨nonempty, unique⟩
  refine ⟨?_, ?_⟩
  · intro before label after step run id expected commit isMigrate pins operation receipt kind
    exact (closure before label after step run id expected commit isMigrate pins operation
      receipt kind).1
  · intro before label after step run id expected commit isMigrate pins operation receipt kind
    exact (closure before label after step run id expected commit isMigrate pins operation
      receipt kind).2

end SpecCnl.Proofs
