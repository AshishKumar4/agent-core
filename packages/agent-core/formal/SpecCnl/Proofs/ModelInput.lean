import SpecCnl.Bridge.ModelInput

/-!
# ModelInput: discharging the hand proposition

The one discharge reduces to `AgentCore.Cnl.ModelInput`, which states the positive form
of `AgentCore.missing_content_resolution_rejected` as a consequence of the two existing
resolve constructors.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_TURN_MODEL_INPUT_RETENTION_LOSS :
    Bridge.hand_C13_TURN_MODEL_INPUT_RETENTION_LOSS := by
  intro _ _ _ ⟨_, step⟩ _ _ isResolve
  exact content_resolution_requires_retained_content (isResolve ▸ step)

end SpecCnl.Proofs
