import AgentCore.Proofs.Safety

/-!
# Canonical system reachability

Trusted bootstrap establishes the initial authority endowment. Runtime reachability
then closes only durable mediated transitions; raw authority mutations are deliberately
not runtime `SystemStep`s because they are not yet capability-gated in the abstract
authority model. Direct admission remains nondurable and does not change state.
-/

namespace AgentCore

inductive BootstrapStep : SystemState → AuthorityLedger.AuthorityLabel → SystemState → Prop
  | issueGrant {state id authority'} :
      AuthorityLedger.AuthorityStep state.authority (.issueGrant id) authority' →
      BootstrapStep state (.issueGrant id) { state with authority := authority' }
  | bind {state id authority'} :
      AuthorityLedger.AuthorityStep state.authority (.bind id) authority' →
      BootstrapStep state (.bind id) { state with authority := authority' }
  | resolve {state resolution authority'} :
      AuthorityLedger.AuthorityStep state.authority (.resolve resolution) authority' →
      BootstrapStep state (.resolve resolution) { state with authority := authority' }

inductive BootstrapExec : SystemState → List AuthorityLedger.AuthorityLabel → SystemState → Prop
  | nil (state) : BootstrapExec state [] state
  | cons {start middle finish label labels} :
      BootstrapStep start label middle → BootstrapExec middle labels finish →
      BootstrapExec start (label :: labels) finish

def TrustedGenesis (state : SystemState) : Prop :=
  ∃ labels, BootstrapExec default labels state

def AttemptsHaveExactAudit (state : SystemState) : Prop :=
  ∀ id attempt, state.effects.attempts id = some attempt →
    ∃ audit entry,
      state.audit.entries audit = some entry ∧
      entry.kind = .attempt id attempt.invocation ∧
      entry.cause = some attempt.auditCause

theorem bootstrap_step_preserves_effects {before label after}
    (step : BootstrapStep before label after) : after.effects = before.effects := by
  cases step <;> rfl

theorem bootstrap_exec_preserves_effects {before labels after}
    (exec : BootstrapExec before labels after) : after.effects = before.effects := by
  induction exec with
  | nil => rfl
  | cons step _ ih => exact ih.trans (bootstrap_step_preserves_effects step)

theorem trusted_genesis_effects_default {state} (genesis : TrustedGenesis state) :
    state.effects = (default : SystemState).effects := by
  obtain ⟨_, exec⟩ := genesis
  exact bootstrap_exec_preserves_effects exec

inductive SystemLabel where
  | mediated (label : MediatedLabel)
  deriving DecidableEq, Repr

inductive SystemStep : SystemState → SystemLabel → SystemState → Prop
  | mediated {before label after} :
      MediatedStep before label after → SystemStep before (.mediated label) after

inductive Reachable : SystemState → Prop
  | initial {state} : TrustedGenesis state → Reachable state
  | step {before label after} : Reachable before →
      SystemStep before label after → Reachable after

inductive ReachableFrom (initial : SystemState) : SystemState → Prop
  | initial : ReachableFrom initial initial
  | step {before label after} : ReachableFrom initial before →
      SystemStep before label after → ReachableFrom initial after

inductive Exec : SystemState → List SystemLabel → SystemState → Prop
  | nil (state) : Exec state [] state
  | cons {start middle finish label labels} :
      SystemStep start label middle → Exec middle labels finish →
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

private theorem exact_attempt_audits_after_atomic_insert
    {before : SystemState} {effects' : EffectLedger} {audit' : AuditLog}
    {newId : AttemptId} {newAttempt : EffectAttempt} {invocation : InvocationId}
    {auditId : AuditId}
    (audited : AttemptsHaveExactAudit before)
    (stored : effects'.attempts newId = some newAttempt)
    (otherUnchanged : ∀ id, id ≠ newId → effects'.attempts id = before.effects.attempts id)
    (auditAppend : AttemptAuditAppend effects' before.events before.audit newId invocation
      auditId audit') :
    ∀ id record, effects'.attempts id = some record →
      ∃ audit entry, audit'.entries audit = some entry ∧
        entry.kind = .attempt id record.invocation ∧ entry.cause = some record.auditCause := by
  obtain ⟨newEntry, appendStep, newLookup, newKind⟩ := auditAppend
  intro id record lookup
  by_cases same : id = newId
  · subst id
    rw [stored] at lookup
    cases Option.some.inj lookup
    obtain ⟨auditedRecord, exactEntry, attemptLookup, auditLookup, exactKind, invocationEq,
      cause⟩ := attempt_audit_append_is_exact
      ⟨newEntry, appendStep, newLookup, newKind⟩
    rw [stored] at attemptLookup
    cases Option.some.inj attemptLookup
    rw [newLookup] at auditLookup
    cases Option.some.inj auditLookup
    exact ⟨auditId, newEntry, newLookup, by simpa [invocationEq] using exactKind, cause⟩
  · have oldAttempt : before.effects.attempts id = some record := by
      rw [← otherUnchanged id same]
      exact lookup
    obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record oldAttempt
    exact ⟨oldAudit, oldEntry, audit_step_preserves_existing_entry appendStep oldLookup,
      oldKind, oldCause⟩

theorem mediated_step_preserves_exact_attempt_audits {before label after}
    (audited : AttemptsHaveExactAudit before)
    (step : MediatedStep before label after) : AttemptsHaveExactAudit after := by
  cases step with
  | persistIntent ready effectStep =>
      have unchanged := persist_intent_preserves_attempts effectStep
      simpa [AttemptsHaveExactAudit, unchanged] using audited
  | requestApproval ready required reserved invocation identity digest pending intent approval stored =>
      have unchanged := persist_intent_preserves_attempts intent
      simpa [AttemptsHaveExactAudit, unchanged] using audited
  | start ready noApproval reserved persisted sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, different]
  | approvalStart ready reserved persisted available sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, different]
  | approvalContinue ready reserved persisted continuation continuationLookup firstLookup different sound
      effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id idDifferent
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, idDifferent]
  | retry ready reserved persisted approval sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addRetryAttempt, EffectLedger.addAttempt,
        EffectLedger.recordAdmission, tableSet, different]
  | staleDenied resolution exact intent stale holder observed invocation item denied effectStep stored auditAppend =>
      obtain ⟨_, _, _, appendStep, _, _, _⟩ := auditAppend
      intro id record lookup
      have unchanged := pre_receipt_preserves_attempts effectStep
      have oldAttempt : before.effects.attempts id = some record := by simpa [unchanged] using lookup
      obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record oldAttempt
      exact ⟨oldAudit, oldEntry, audit_step_preserves_existing_entry appendStep oldLookup,
        oldKind, oldCause⟩
  | preReceipt intent effectStep stored exact auditAppend =>
      obtain ⟨_, _, _, appendStep, _, _, _⟩ := auditAppend
      intro id record lookup
      have unchanged := pre_receipt_preserves_attempts effectStep
      have oldAttempt : before.effects.attempts id = some record := by simpa [unchanged] using lookup
      obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record oldAttempt
      exact ⟨oldAudit, oldEntry, audit_step_preserves_existing_entry appendStep oldLookup,
        oldKind, oldCause⟩
  | attemptReceipt attempt exact effectStep stored auditAppend =>
      obtain ⟨_, _, _, appendStep, _, _, _⟩ := auditAppend
      intro id record lookup
      have unchanged := attempt_receipt_preserves_attempts effectStep
      have oldAttempt : before.effects.attempts id = some record := by simpa [unchanged] using lookup
      obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record oldAttempt
      exact ⟨oldAudit, oldEntry, audit_step_preserves_existing_entry appendStep oldLookup,
        oldKind, oldCause⟩
  | supersedeReceipt old attempt exact effectStep stored sameAttempt auditAppend =>
      obtain ⟨_, _, middle, _, _, _, _, _, _, _, firstStep, _, _, _, secondStep, _, _, _⟩ :=
        auditAppend
      intro id record lookup
      have unchanged := supersede_receipt_preserves_attempts effectStep
      have oldAttempt : before.effects.attempts id = some record := by simpa [unchanged] using lookup
      obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record oldAttempt
      exact ⟨oldAudit, oldEntry,
        audit_step_preserves_existing_entry secondStep
          (audit_step_preserves_existing_entry firstStep oldLookup), oldKind, oldCause⟩
  | audit auditStep =>
      intro id record lookup
      obtain ⟨oldAudit, oldEntry, oldLookup, oldKind, oldCause⟩ := audited id record lookup
      exact ⟨oldAudit, oldEntry, audit_step_preserves_existing_entry auditStep oldLookup,
        oldKind, oldCause⟩
  | claimItem ready reserved persisted exact effectStep =>
      have unchanged := claim_item_preserves_attempts effectStep
      simpa [AttemptsHaveExactAudit, unchanged] using audited
  | recoverItemClaim ready reserved persisted exact effectStep current stored =>
      have unchanged := recover_item_claim_preserves_attempts effectStep
      simpa [AttemptsHaveExactAudit, unchanged] using audited
  | event eventStep leases source => exact audited
  | graph graphStep => exact audited

theorem system_step_preserves_guarded_attempt_admissions {before label after}
    (guarded : AttemptsHaveGuardedAdmission before.effects)
    (step : SystemStep before label after) :
    AttemptsHaveGuardedAdmission after.effects := by
  cases step with
  | mediated transition =>
      exact mediated_step_preserves_guarded_attempt_admissions guarded transition

theorem system_step_preserves_receipt_id_disjointness {before label after}
    (disjoint : ReceiptIdsDisjoint before.effects)
    (step : SystemStep before label after) : ReceiptIdsDisjoint after.effects := by
  cases step with
  | mediated transition =>
      exact mediated_step_preserves_receipt_id_disjointness disjoint transition

theorem system_step_preserves_exact_attempt_audits {before label after}
    (audited : AttemptsHaveExactAudit before)
    (step : SystemStep before label after) : AttemptsHaveExactAudit after := by
  cases step with
  | mediated transition => exact mediated_step_preserves_exact_attempt_audits audited transition

theorem reachable_attempts_have_guarded_admission {state} (reachable : Reachable state) :
    AttemptsHaveGuardedAdmission state.effects := by
  induction reachable with
  | initial genesis =>
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_guarded_attempt_admissions ih transition

theorem reachable_receipt_ids_are_disjoint {state} (reachable : Reachable state) :
    ReceiptIdsDisjoint state.effects := by
  induction reachable with
  | initial genesis =>
      rw [trusted_genesis_effects_default genesis]
      intro id
      exact Or.inl rfl
  | step reachable transition ih =>
      exact system_step_preserves_receipt_id_disjointness ih transition

theorem reachable_attempts_have_exact_audits {state} (reachable : Reachable state) :
    AttemptsHaveExactAudit state := by
  induction reachable with
  | initial genesis =>
      unfold AttemptsHaveExactAudit
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_exact_attempt_audits ih transition

theorem reachable_from_preserves_guarded_attempt_admissions {initial state}
    (initialGuarded : AttemptsHaveGuardedAdmission initial.effects)
    (reachable : ReachableFrom initial state) : AttemptsHaveGuardedAdmission state.effects := by
  induction reachable with
  | initial => exact initialGuarded
  | step reachable transition ih =>
      exact system_step_preserves_guarded_attempt_admissions ih transition

end AgentCore
