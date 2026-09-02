import SpecCnl.Bridge.InterceptOrder

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_INTERCEPTOR_DOMAIN_CONFINEMENT :
    Bridge.hand_C13_INTERCEPTOR_DOMAIN_CONFINEMENT :=
  fun _ foreign => foreign_question_never_intercepts foreign

theorem proved_C13_INTERCEPTOR_POST_PREPARATION :
    Bridge.hand_C13_INTERCEPTOR_POST_PREPARATION :=
  fun _ _ _ step _ _ stored => effect_step_preserves_prepared_invocations step stored

theorem proved_C13_INTERCEPTOR_MODE_FIDELITY :
    Bridge.hand_C13_INTERCEPTOR_MODE_FIDELITY := by
  refine ⟨?_, ?_⟩
  · intro before contribution after firing
    obtain ⟨gate, behave, rest, pending, step⟩ := firing
    exact gate_firing_preserves_value pending gate step
  · intro gating gate rewriting rewrite precedes
    exact absurd (rewrite_precedes_every_gate rewrite gate)
      (interceptor_order_asymm precedes)

theorem proved_C13_INTERCEPTOR_REPLAY : Bridge.hand_C13_INTERCEPTOR_REPLAY :=
  fun _ _ _ step consistent => intercept_step_preserves_replay_consistency step consistent

theorem proved_C13_INTERCEPTOR_TURN_HOSTED :
    Bridge.hand_C13_INTERCEPTOR_TURN_HOSTED := by
  intro question candidates left right leftEvidence rightEvidence
  obtain ⟨leftAtCut, leftMembers⟩ := leftEvidence
  obtain ⟨_, leftAdmitted⟩ := leftAtCut
  obtain ⟨leftOrdered, _⟩ := leftAdmitted
  obtain ⟨rightAtCut, rightMembers⟩ := rightEvidence
  obtain ⟨_, rightAdmitted⟩ := rightAtCut
  obtain ⟨rightOrdered, _⟩ := rightAdmitted
  apply ordered_schedule_unique leftOrdered rightOrdered
  intro contribution
  exact (leftMembers contribution).symm.trans (rightMembers contribution)

end SpecCnl.Proofs
