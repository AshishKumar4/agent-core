import SpecCnl.Bridge.RunGraph

/-!
# Discharging the RunGraph group's hand propositions

Every proposition of `SpecCnl.Bridge.RunGraph` is true of `AgentCore` as it stands. The
closure and merge facts are consequences the model implies but never spelled out and live
in `AgentCore.Cnl.RunGraph`; the append-only and undo-selection facts are theorems the
model already proved beside the definitions they are about.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_RUN_GRAPH_CLOSED : Bridge.hand_C13_RUN_GRAPH_CLOSED := by
  refine ⟨⟨?_, ?_⟩, ?_⟩
  · intro _ _ _ ⟨_, _, _, _, step⟩ _ _ _ isAppend
    exact (append_requires_owned_branch_and_closed_parents (isAppend ▸ step)).2
  · intro _ _ _ ⟨_, _, _, _, step⟩ _ _ _ isAppend
    exact (append_requires_owned_branch_and_closed_parents (isAppend ▸ step)).1
  · intro _ _ _ ⟨_, _, _, _, step⟩ _ _ _ isSpawn
    exact spawn_child_root_is_unparented (isSpawn ▸ step)

theorem proved_C13_RUN_DISTINCTION_REPRESENTABLE :
    Bridge.hand_C13_RUN_DISTINCTION_REPRESENTABLE := by
  refine ⟨?_, ?_⟩
  · intro _ label _ ⟨isMergeAppend, _, _, _, step⟩ _ _ _ isAppend
    subst isAppend
    obtain ⟨_, _, _, _, _, labelEq, isMerge⟩ := isMergeAppend
    obtain ⟨rfl, rfl, rfl⟩ := GraphLabel.append.inj labelEq
    exact merge_append_names_two_distinct_current_heads step isMerge
  · intro _ label _ ⟨isMergeAppend, _, _, _, step⟩ _ _ _ isAppend
    subst isAppend
    obtain ⟨_, _, _, _, _, labelEq, isMerge⟩ := isMergeAppend
    obtain ⟨rfl, rfl, rfl⟩ := GraphLabel.append.inj labelEq
    exact merge_append_parents_carry_commit_pins step isMerge

theorem proved_C13_RUN_UNDO_REDO : Bridge.hand_C13_RUN_UNDO_REDO := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, _, _, step⟩ _ _ present
    exact graph_step_preserves_commits step present
  · intro _ _ _ ⟨_, _, _, _, step⟩ _ _ _ isAppend _ _ isUndo
    exact (undo_selects_effective_state (isAppend ▸ step) isUndo).2

end SpecCnl.Proofs
