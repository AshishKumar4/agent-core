import AgentCore.Proofs.Safety

/-! Reachability closes only durable mediated transitions; direct transitions preserve state. -/

namespace AgentCore

inductive Reachable : SystemState → Prop
  | initial : Reachable default
  | step {before label after} : Reachable before → MediatedStep before label after → Reachable after

inductive ReachableFrom (initial : SystemState) : SystemState → Prop
  | initial : ReachableFrom initial initial
  | step {before label after} : ReachableFrom initial before →
      MediatedStep before label after → ReachableFrom initial after

inductive Exec : SystemState → List MediatedLabel → SystemState → Prop
  | nil (state) : Exec state [] state
  | cons {start middle finish label labels} :
      MediatedStep start label middle → Exec middle labels finish →
      Exec start (label :: labels) finish

theorem reachable_of_exec {before after labels}
    (reachable : Reachable before) (exec : Exec before labels after) : Reachable after := by
  induction exec with
  | nil => exact reachable
  | cons step rest ih => exact ih (.step reachable step)

theorem mediated_step_preserves_guarded_attempt_admissions {before label after}
    (guarded : AttemptsHaveGuardedAdmission before.effects)
    (step : MediatedStep before label after) :
    AttemptsHaveGuardedAdmission after.effects := by
  cases step with
  | persistIntent ready effectStep => exact effect_step_preserves_guarded_admissions guarded effectStep
  | requestApproval ready required reserved invocation identity digest pending intent approval stored =>
      exact effect_step_preserves_guarded_admissions guarded intent
  | start ready noApproval reserved persisted sound effectStep =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | approvalStart ready reserved persisted available sound effectStep stored =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | approvalContinue ready reserved persisted continuation continuationLookup firstLookup different sound effectStep stored =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | claimItem ready reserved persisted exact effectStep =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | recoverItemClaim ready reserved persisted exact effectStep stored =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | retry ready reserved persisted approval sound effectStep stored =>
      have fresh := retry_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | staleDenied resolution exact intent stale holder observed invocation item denied effectStep stored =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | preReceipt intent effectStep stored exact =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | attemptReceipt attempt exact effectStep stored =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | supersedeReceipt old attempt exact effectStep stored sameAttempt =>
      exact effect_step_preserves_guarded_admissions guarded effectStep
  | audit auditStep => exact guarded
  | event eventStep leases source => exact guarded
  | graph graphStep => exact guarded

theorem mediated_step_preserves_receipt_id_disjointness {before label after}
    (disjoint : ReceiptIdsDisjoint before.effects)
    (step : MediatedStep before label after) : ReceiptIdsDisjoint after.effects := by
  cases step with
  | persistIntent ready effectStep => exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | requestApproval ready required reserved invocation identity digest pending intent approval stored =>
      exact effect_step_preserves_receipt_id_disjointness disjoint intent
  | start ready noApproval reserved persisted sound effectStep =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | approvalStart ready reserved persisted available sound effectStep stored =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | approvalContinue ready reserved persisted continuation continuationLookup firstLookup different sound effectStep stored =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | claimItem ready reserved persisted exact effectStep =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | recoverItemClaim ready reserved persisted exact effectStep stored =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | retry ready reserved persisted approval sound effectStep stored =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | staleDenied resolution exact intent stale holder observed invocation item denied effectStep stored =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | preReceipt intent effectStep stored exact =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | attemptReceipt attempt exact effectStep stored =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | supersedeReceipt old attempt exact effectStep stored sameAttempt =>
      exact effect_step_preserves_receipt_id_disjointness disjoint effectStep
  | audit auditStep => exact disjoint
  | event eventStep leases source => exact disjoint
  | graph graphStep => exact disjoint

theorem reachable_attempts_have_guarded_admission {state} (reachable : Reachable state) :
    AttemptsHaveGuardedAdmission state.effects := by
  induction reachable with
  | initial => intro id attempt lookup; contradiction
  | step reachable transition ih =>
      exact mediated_step_preserves_guarded_attempt_admissions ih transition

theorem reachable_receipt_ids_are_disjoint {state} (reachable : Reachable state) :
    ReceiptIdsDisjoint state.effects := by
  induction reachable with
  | initial => intro id; exact Or.inl rfl
  | step reachable transition ih =>
      exact mediated_step_preserves_receipt_id_disjointness ih transition

theorem reachable_from_preserves_guarded_attempt_admissions {initial state}
    (initialGuarded : AttemptsHaveGuardedAdmission initial.effects)
    (reachable : ReachableFrom initial state) : AttemptsHaveGuardedAdmission state.effects := by
  induction reachable with
  | initial => exact initialGuarded
  | step reachable transition ih =>
      exact mediated_step_preserves_guarded_attempt_admissions ih transition

end AgentCore
