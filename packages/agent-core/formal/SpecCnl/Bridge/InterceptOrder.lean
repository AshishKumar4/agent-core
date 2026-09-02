import SpecCnl.Sentences.InterceptOrder

namespace SpecCnl.Bridge

open AgentCore

/-! ## §4.4 `C13-INTERCEPTOR-DOMAIN-CONFINEMENT` -/

def hand_C13_INTERCEPTOR_DOMAIN_CONFINEMENT : Prop :=
  ∀ (question : InterceptionQuestion), question.Foreign → ¬ question.Admits

theorem bridge_C13_INTERCEPTOR_DOMAIN_CONFINEMENT :
    Sentences.cnl_C13_INTERCEPTOR_DOMAIN_CONFINEMENT ↔
      hand_C13_INTERCEPTOR_DOMAIN_CONFINEMENT := by
  unfold Sentences.cnl_C13_INTERCEPTOR_DOMAIN_CONFINEMENT
    hand_C13_INTERCEPTOR_DOMAIN_CONFINEMENT qEvery qNoObj
  constructor
  · intro claim question foreign admitted
    exact claim question foreign question.contribution trivial ⟨rfl, admitted⟩
  · intro claim question foreign contribution _ admitted
    exact claim question foreign admitted.2

/-! ## §4.4 `C13-INTERCEPTOR-POST-PREPARATION` -/

def hand_C13_INTERCEPTOR_POST_PREPARATION : Prop :=
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    EffectStep before label after →
      ∀ invocation prepared, before.invocations invocation = some prepared →
        after.invocations invocation = some prepared

theorem bridge_C13_INTERCEPTOR_POST_PREPARATION :
    Sentences.cnl_C13_INTERCEPTOR_POST_PREPARATION ↔
      hand_C13_INTERCEPTOR_POST_PREPARATION := Iff.rfl

/-! ## §4.4 `C13-INTERCEPTOR-MODE-FIDELITY` -/

def hand_C13_INTERCEPTOR_MODE_FIDELITY : Prop :=
  (∀ (before : InterceptionState) (contribution : InterceptorContribution)
      (after : InterceptionState),
      (contribution.mode = .gate ∧
        ∃ behave rest, before.pending = contribution :: rest ∧
          InterceptStep behave before after) →
        after.value = before.value) ∧
    ∀ (gating : InterceptorContribution), gating.mode = .gate →
      ∀ (rewriting : InterceptorContribution), rewriting.mode = .rewrite →
        ¬ InterceptorOrder gating rewriting

theorem bridge_C13_INTERCEPTOR_MODE_FIDELITY :
    Sentences.cnl_C13_INTERCEPTOR_MODE_FIDELITY ↔
      hand_C13_INTERCEPTOR_MODE_FIDELITY := Iff.rfl

/-! ## §4.4 `C13-INTERCEPTOR-REPLAY` -/

def hand_C13_INTERCEPTOR_REPLAY : Prop :=
  ∀ (before : InterceptionState) (behave : InterceptorBehavior)
      (after : InterceptionState),
    InterceptStep behave before after →
      replayInterceptions before.input before.trace = some before.value →
        replayInterceptions after.input after.trace = some after.value

theorem bridge_C13_INTERCEPTOR_REPLAY :
    Sentences.cnl_C13_INTERCEPTOR_REPLAY ↔ hand_C13_INTERCEPTOR_REPLAY := Iff.rfl

/-! ## §4.4 `C13-INTERCEPTOR-TURN-HOSTED` -/

def hand_C13_INTERCEPTOR_TURN_HOSTED : Prop :=
  ∀ (question : InterceptionQuestion)
      (candidates left right : List InterceptorContribution),
    ((∃ cut, AdmittedSchedule question.granted question.domainOf question.site cut left) ∧
      (∀ contribution, contribution ∈ candidates ↔ contribution ∈ left)) →
    ((∃ cut, AdmittedSchedule question.granted question.domainOf question.site cut right) ∧
      (∀ contribution, contribution ∈ candidates ↔ contribution ∈ right)) →
    left = right

theorem bridge_C13_INTERCEPTOR_TURN_HOSTED :
    Sentences.cnl_C13_INTERCEPTOR_TURN_HOSTED ↔ hand_C13_INTERCEPTOR_TURN_HOSTED := Iff.rfl

end SpecCnl.Bridge
