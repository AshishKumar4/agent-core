import AgentCore.Events
import AgentCore.Interceptors

/-!
# Consequences of the existing interceptor and effect model the controlled language needs

These are consequences of existing step relations; they add no transition, state, or
interceptor declaration to the model.
-/

namespace AgentCore

/-- A step whose pending head is a declared gate preserves the value in flight, including
both forms of scoped refusal. -/
theorem gate_firing_preserves_value {behave : InterceptorBehavior}
    {before after : InterceptionState} {contribution : InterceptorContribution}
    {rest : List InterceptorContribution}
    (pending : before.pending = contribution :: rest)
    (gate : contribution.mode = .gate)
    (step : InterceptStep behave before after) :
    after.value = before.value := by
  cases step with
  | @proceed head tail output _ statePending _ fidelity =>
      rw [pending] at statePending
      obtain ⟨sameHead, _⟩ := List.cons.inj statePending
      exact fidelity (sameHead ▸ gate)
  | block _ _ _ => rfl
  | gateRewriteRefused _ _ _ _ _ => rfl

/-- Replay consistency is an invariant of one interceptor step: if a recorded trace
replays to the current value before the step, the successor's recorded trace replays to
its successor value. -/
theorem intercept_step_preserves_replay_consistency {behave : InterceptorBehavior}
    {before after : InterceptionState} (step : InterceptStep behave before after)
    (consistent : replayInterceptions before.input before.trace = some before.value) :
    replayInterceptions after.input after.trace = some after.value := by
  cases step with
  | @proceed contribution rest output _ _ _ _ =>
      exact replay_matches_chain.mpr
        (transformation_chain_snoc (replay_matches_chain.mp consistent))
  | block _ _ _ => exact consistent
  | gateRewriteRefused _ _ _ _ _ => exact consistent


/-- A fresh-key table insert never changes an entry that was already present. -/
private theorem tableSet_preserves {α β : Type} [DecidableEq α]
    {table : α → Option β} {key candidate : α} {value found : β}
    (fresh : table key = none) (stored : table candidate = some found) :
    tableSet table key value candidate = some found := by
  by_cases same : candidate = key
  · rw [same, fresh] at stored
    simp at stored
  · rw [tableSet_other _ _ _ same]
    exact stored

/-- An effect-ledger step cannot replace a PreparedInvocation that was already persisted. -/
theorem effect_step_preserves_prepared_invocations {before after : EffectLedger}
    {label : EffectLabel} {invocation : InvocationId} {prepared : PreparedInvocation}
    (step : EffectStep before label after)
    (stored : before.invocations invocation = some prepared) :
    after.invocations invocation = some prepared := by
  cases step <;> first
    | exact stored
    | exact tableSet_preserves (by assumption) stored

end AgentCore
