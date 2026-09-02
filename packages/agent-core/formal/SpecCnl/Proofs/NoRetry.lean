import SpecCnl.Bridge.NoRetry

/-!
# Discharging the NoRetry group's hand proposition

`SpecCnl.Bridge.hand_C13_TURN_NO_RETRY` is true of `AgentCore` as it stands. Both halves
are consequences of the closed graph label set that the model implies but never spelled
out, and they live in `AgentCore.Cnl.NoRetry`.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_TURN_NO_RETRY : Bridge.hand_C13_TURN_NO_RETRY := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, _, _, step⟩ _ _ recorded terminal
    exact graph_step_preserves_terminal_turns step recorded terminal
  · intro _ _ _ ⟨_, _, _, _, step⟩ _ isStart
    exact turn_start_lease_is_initial_and_admits_nothing (isStart ▸ step)

end SpecCnl.Proofs
