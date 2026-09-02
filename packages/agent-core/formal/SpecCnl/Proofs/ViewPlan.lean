import SpecCnl.Bridge.ViewPlan

/-!
# Discharging the ViewPlan group's hand proposition

Every clause is a theorem about `AgentCore.View` as it stands. The revision gate and the
stream count are the model's own results beside the definitions they are about; the
patched-successor fact is the consequence `AgentCore.Cnl.ViewPlan` states, so this
discharge names it rather than unfolding `applyDelta` here and following that definition's
shape.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_VIEW_NO_LIVE_STATE : Bridge.hand_C13_VIEW_NO_LIVE_STATE :=
  ⟨⟨fun _ _ _ applied => apply_requires_matching_revision applied,
      fun _ _ _ applied => view_apply_is_the_patched_successor applied⟩,
    fun _ _ _ replayed => replay_revision replayed⟩

end SpecCnl.Proofs
