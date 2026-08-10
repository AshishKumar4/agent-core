import AgentCore.Proofs.Safety
import AgentCore.DistributedPermit

/-!
# Canonical system reachability

Trusted bootstrap establishes the initial authority endowment. Runtime reachability
then includes authority administration and the distributed permit protocol. Attempt
admission is absent from the generic mediated branch: only the target-local permit
consume transition may append an attempt. Direct admission remains nondurable.
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

def TrustedGenesis (state : DistributedSystemState) : Prop :=
  ∃ labels, BootstrapExec default labels state.core ∧
    state.permits = (default : PermitProtocolState)

def AttemptsHaveExactAudit (state : SystemState) : Prop :=
  ∀ id attempt, state.effects.attempts id = some attempt →
    ∃ audit entry,
      state.audit.entries audit = some entry ∧
      entry.kind = .attempt id attempt.invocation ∧
      entry.cause = some attempt.auditCause

def AttemptsHavePermitEvidence (state : DistributedSystemState) : Prop :=
  ∀ id attempt, state.core.effects.attempts id = some attempt →
    ∃ target nonce consumption,
      state.permits.consumptions target nonce = some consumption ∧
      consumption.attempt = id ∧ consumption.permit.expectation.target = target ∧
      consumption.permit.nonce = nonce ∧ exactIssued state.permits consumption.permit ∧
      consumption.permit.expectation.MatchesAttempt attempt

theorem bootstrap_step_preserves_effects {before label after}
    (step : BootstrapStep before label after) : after.effects = before.effects := by
  cases step <;> rfl

theorem bootstrap_exec_preserves_effects {before labels after}
    (exec : BootstrapExec before labels after) : after.effects = before.effects := by
  induction exec with
  | nil => rfl
  | cons step _ ih => exact ih.trans (bootstrap_step_preserves_effects step)

theorem trusted_genesis_effects_default {state} (genesis : TrustedGenesis state) :
    state.core.effects = (default : SystemState).effects := by
  obtain ⟨_, exec, _⟩ := genesis
  exact bootstrap_exec_preserves_effects exec

def MediatedLabel.NonAttempt : MediatedLabel → Prop
  | .start .. | .approvalStart .. | .approvalContinue .. | .retry .. => False
  | _ => True

inductive SystemLabel where
  | mediated (label : MediatedLabel)
  | authority (label : AuthorityLedger.AuthorityLabel)
  | rematerialize (membership : Membership) (role : Role)
  | permit (label : PermitLabel)
  deriving DecidableEq, Repr

inductive SystemStep : DistributedSystemState → SystemLabel →
    DistributedSystemState → Prop
  | mediated {before label core'} :
      label.NonAttempt → MediatedStep before.core label core' →
      SystemStep before (.mediated label) { before with core := core' }
  | authority {before label authority'} :
      AuthorityLedger.AuthorityStep before.core.authority label authority' →
      SystemStep before (.authority label)
        { before with core := { before.core with authority := authority' } }
  | rematerialize {before membership role authority'} :
      MaterializationStep before.core.authority membership role authority' →
      SystemStep before (.rematerialize membership role)
        { before with core := { before.core with authority := authority' } }
  | permit {before label after} :
      PermitStep before label after → SystemStep before (.permit label) after

inductive Reachable : DistributedSystemState → Prop
  | initial {state} : TrustedGenesis state → Reachable state
  | step {before label after} : Reachable before →
      SystemStep before label after → Reachable after

inductive ReachableFrom (initial : DistributedSystemState) : DistributedSystemState → Prop
  | initial : ReachableFrom initial initial
  | step {before label after} : ReachableFrom initial before →
      SystemStep before label after → ReachableFrom initial after

inductive Exec : DistributedSystemState → List SystemLabel → DistributedSystemState → Prop
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

theorem mediated_nonattempt_preserves_attempts {before label after}
    (nonAttempt : label.NonAttempt) (step : MediatedStep before label after) :
    after.effects.attempts = before.effects.attempts := by
  cases step with
  | persistIntent ready effectStep => exact persist_intent_preserves_attempts effectStep
  | requestApproval ready required reserved invocation identity digest pending intent approval stored =>
      exact persist_intent_preserves_attempts intent
  | start => simp [MediatedLabel.NonAttempt] at nonAttempt
  | approvalStart => simp [MediatedLabel.NonAttempt] at nonAttempt
  | approvalContinue => simp [MediatedLabel.NonAttempt] at nonAttempt
  | retry => simp [MediatedLabel.NonAttempt] at nonAttempt
  | claimItem ready reserved persisted exact effectStep =>
      exact claim_item_preserves_attempts effectStep
  | recoverItemClaim ready reserved persisted exact effectStep stored =>
      exact recover_item_claim_preserves_attempts effectStep
  | staleDenied resolution exact intent stale holder observed invocation item denied effectStep stored auditAppend =>
      exact pre_receipt_preserves_attempts effectStep
  | preReceipt intent effectStep stored exact auditAppend =>
      exact pre_receipt_preserves_attempts effectStep
  | attemptReceipt attempt exact effectStep stored auditAppend =>
      exact attempt_receipt_preserves_attempts effectStep
  | supersedeReceipt old attempt exact effectStep stored sameAttempt auditAppend =>
      exact supersede_receipt_preserves_attempts effectStep
  | audit auditStep => rfl
  | event eventStep leases source => rfl
  | graph graphStep => rfl

theorem target_attempt_step_preserves_guarded_admissions
    {before expectation now attemptId attempt auditId after}
    (guarded : AttemptsHaveGuardedAdmission before.effects)
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    AttemptsHaveGuardedAdmission after.effects := by
  cases step with
  | first localReady claimReady noApproval reserved persisted claimStored exactMatch sound effectStep stored auditAppend =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | approvalFirst localReady claimReady reserved persisted available claimStored exactMatch sound effectStep stored auditAppend =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | approvalContinue localReady claimReady reserved persisted continues continuationLookup valid different
      claimStored exactMatch sound effectStep stored auditAppend =>
      have fresh := first_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded
  | retry localReady claimReady reserved persisted approval claimStored exactMatch sound effectStep stored auditAppend =>
      have fresh := retry_attempt_requires_fresh_id effectStep
      change before.effects.attempts _ = none at fresh
      apply effect_step_preserves_guarded_admissions _ effectStep
      exact recordAdmission_preserves_guarded_admissions fresh guarded

theorem target_attempt_step_preserves_receipt_id_disjointness
    {before expectation now attemptId attempt auditId after}
    (disjoint : ReceiptIdsDisjoint before.effects)
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    ReceiptIdsDisjoint after.effects := by
  cases step with
  | first localReady claimReady noApproval reserved persisted claimStored exactMatch sound effectStep stored auditAppend =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | approvalFirst localReady claimReady reserved persisted available claimStored exactMatch sound effectStep stored auditAppend =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | approvalContinue localReady claimReady reserved persisted continues continuationLookup valid different
      claimStored exactMatch sound effectStep stored auditAppend =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint
  | retry localReady claimReady reserved persisted approval claimStored exactMatch sound effectStep stored auditAppend =>
      apply effect_step_preserves_receipt_id_disjointness _ effectStep
      simpa [ReceiptIdsDisjoint, EffectLedger.recordAdmission] using disjoint

theorem target_attempt_step_preserves_exact_attempt_audits
    {before expectation now attemptId attempt auditId after}
    (audited : AttemptsHaveExactAudit before)
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    AttemptsHaveExactAudit after := by
  cases step with
  | first localReady claimReady noApproval reserved persisted claimStored exactMatch sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, different]
  | approvalFirst localReady claimReady reserved persisted available claimStored exactMatch sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, different]
  | approvalContinue localReady claimReady reserved persisted continues continuationLookup valid different
      claimStored exactMatch sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id idDifferent
      cases effectStep
      simp [EffectLedger.addAttempt, EffectLedger.recordAdmission, tableSet, idDifferent]
  | retry localReady claimReady reserved persisted approval claimStored exactMatch sound effectStep stored auditAppend =>
      apply exact_attempt_audits_after_atomic_insert audited stored ?_ auditAppend
      intro id different
      cases effectStep
      simp [EffectLedger.addRetryAttempt, EffectLedger.addAttempt,
        EffectLedger.recordAdmission, tableSet, different]

theorem permit_step_preserves_guarded_attempt_admissions {before label after}
    (guarded : AttemptsHaveGuardedAdmission before.core.effects)
    (step : PermitStep before label after) :
    AttemptsHaveGuardedAdmission after.core.effects := by
  cases step with
  | issue ready fresh expiry => exact guarded
  | issueUnknownBefore => exact guarded
  | emit issued => exact guarded
  | inject => exact guarded
  | drop split => exact guarded
  | duplicate member => exact guarded
  | reorder permutation => exact guarded
  | authenticate member issued fence => exact guarded
  | consume issued authenticated fence issuedAt expiry unused localStep =>
      exact target_attempt_step_preserves_guarded_admissions guarded localStep
  | consumeUnknownBefore => exact guarded
  | restart => exact guarded
  | reset => exact guarded
  | advanceTime monotone => exact guarded
  | advanceFence => exact guarded

theorem permit_step_preserves_receipt_id_disjointness {before label after}
    (disjoint : ReceiptIdsDisjoint before.core.effects)
    (step : PermitStep before label after) : ReceiptIdsDisjoint after.core.effects := by
  cases step with
  | issue ready fresh expiry => exact disjoint
  | issueUnknownBefore => exact disjoint
  | emit issued => exact disjoint
  | inject => exact disjoint
  | drop split => exact disjoint
  | duplicate member => exact disjoint
  | reorder permutation => exact disjoint
  | authenticate member issued fence => exact disjoint
  | consume issued authenticated fence issuedAt expiry unused localStep =>
      exact target_attempt_step_preserves_receipt_id_disjointness disjoint localStep
  | consumeUnknownBefore => exact disjoint
  | restart => exact disjoint
  | reset => exact disjoint
  | advanceTime monotone => exact disjoint
  | advanceFence => exact disjoint

theorem permit_step_preserves_exact_attempt_audits {before label after}
    (audited : AttemptsHaveExactAudit before.core)
    (step : PermitStep before label after) : AttemptsHaveExactAudit after.core := by
  cases step with
  | issue ready fresh expiry => exact audited
  | issueUnknownBefore => exact audited
  | emit issued => exact audited
  | inject => exact audited
  | drop split => exact audited
  | duplicate member => exact audited
  | reorder permutation => exact audited
  | authenticate member issued fence => exact audited
  | consume issued authenticated fence issuedAt expiry unused localStep =>
      exact target_attempt_step_preserves_exact_attempt_audits audited localStep
  | consumeUnknownBefore => exact audited
  | restart => exact audited
  | reset => exact audited
  | advanceTime monotone => exact audited
  | advanceFence => exact audited

theorem permit_step_preserves_issued_records {before label after}
    (step : PermitStep before label after) :
    ∀ permit, exactIssued before.permits permit → exactIssued after.permits permit := by
  intro permit issued
  cases step with
  | @issue issuedExpectation issuedNonce expiresAt observation ready fresh expiry =>
      unfold exactIssued at issued
      change tableSet2 before.permits.issuerRecords issuedExpectation.issuer issuedNonce
        (some (.issued ⟨issuedExpectation, issuedNonce, before.permits.now, expiresAt⟩))
        permit.expectation.issuer permit.nonce = some (.issued permit)
      by_cases sameIssuer : permit.expectation.issuer = issuedExpectation.issuer
      · by_cases sameNonce : permit.nonce = issuedNonce
        · rw [sameIssuer, sameNonce] at issued
          rw [fresh] at issued
          contradiction
        · rw [tableSet2_other]
          · exact issued
          · exact Or.inr sameNonce
      · rw [tableSet2_other]
        · exact issued
        · exact Or.inl sameIssuer
  | issueUnknownBefore => exact issued
  | emit emitted => exact issued
  | inject => exact issued
  | drop split => exact issued
  | duplicate member => exact issued
  | reorder permutation => exact issued
  | authenticate member exact fence => exact issued
  | consume exact authenticated fence issuedAt expiry unused localStep => exact issued
  | consumeUnknownBefore => exact issued
  | restart => exact issued
  | reset => exact issued
  | advanceTime monotone => exact issued
  | advanceFence => exact issued

theorem permit_step_preserves_attempt_permit_evidence {before label after}
    (evidence : AttemptsHavePermitEvidence before)
    (step : PermitStep before label after) : AttemptsHavePermitEvidence after := by
  have issuedPreserved := permit_step_preserves_issued_records step
  cases step with
  | issue ready fresh expiry =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq, issued,
        exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        issuedPreserved consumption.permit issued, exactMatch⟩
  | issueUnknownBefore => exact evidence
  | emit issued => exact evidence
  | inject => exact evidence
  | drop split => exact evidence
  | duplicate member => exact evidence
  | reorder permutation => exact evidence
  | authenticate member issued fence => exact evidence
  | @consume permit attemptId newAttempt auditId core' observation issued authenticated fence
      issuedAt expiry unused localStep =>
      intro id storedAttempt lookup
      have updated := target_attempt_step_updates_only_exact_attempt localStep
      rw [updated] at lookup
      by_cases sameAttempt : id = attemptId
      · subst id
        rw [tableSet_self] at lookup
        cases Option.some.inj lookup
        obtain ⟨_, exactMatch⟩ := target_attempt_step_stores_exact_attempt localStep
        refine ⟨_, _, ⟨_, _⟩, ?_, rfl, rfl, rfl, ?_, exactMatch⟩
        · exact tableSet2_self ..
        · exact issued
      · have oldLookup : before.core.effects.attempts id = some storedAttempt := by
          rw [← tableSet_other before.core.effects.attempts _ id sameAttempt]
          exact lookup
        obtain ⟨oldTarget, oldNonce, consumption, consumed, attemptId, targetEq, nonceEq,
          oldIssued, exactMatch⟩ := evidence id storedAttempt oldLookup
        have differentKey :
            oldTarget ≠ permit.expectation.target ∨ oldNonce ≠ permit.nonce := by
          by_cases sameTarget : oldTarget = permit.expectation.target
          · right
            intro sameNonce
            rw [sameTarget, sameNonce, unused] at consumed
            contradiction
          · exact Or.inl sameTarget
        refine ⟨oldTarget, oldNonce, consumption, ?_, attemptId, targetEq, nonceEq,
          oldIssued, exactMatch⟩
        exact (tableSet2_other before.permits.consumptions _ _ _ oldTarget oldNonce
          differentKey).trans consumed
  | consumeUnknownBefore => exact evidence
  | restart => exact evidence
  | reset => exact evidence
  | advanceTime monotone => exact evidence
  | advanceFence => exact evidence

theorem system_step_preserves_guarded_attempt_admissions {before label after}
    (guarded : AttemptsHaveGuardedAdmission before.core.effects)
    (step : SystemStep before label after) :
    AttemptsHaveGuardedAdmission after.core.effects := by
  cases step with
  | mediated nonAttempt transition =>
      exact mediated_step_preserves_guarded_attempt_admissions guarded transition
  | authority transition => exact guarded
  | rematerialize transition => exact guarded
  | permit transition => exact permit_step_preserves_guarded_attempt_admissions guarded transition

theorem system_step_preserves_receipt_id_disjointness {before label after}
    (disjoint : ReceiptIdsDisjoint before.core.effects)
    (step : SystemStep before label after) : ReceiptIdsDisjoint after.core.effects := by
  cases step with
  | mediated nonAttempt transition =>
      exact mediated_step_preserves_receipt_id_disjointness disjoint transition
  | authority transition => exact disjoint
  | rematerialize transition => exact disjoint
  | permit transition => exact permit_step_preserves_receipt_id_disjointness disjoint transition

theorem system_step_preserves_exact_attempt_audits {before label after}
    (audited : AttemptsHaveExactAudit before.core)
    (step : SystemStep before label after) : AttemptsHaveExactAudit after.core := by
  cases step with
  | mediated nonAttempt transition =>
      exact mediated_step_preserves_exact_attempt_audits audited transition
  | authority transition => exact audited
  | rematerialize transition => exact audited
  | permit transition => exact permit_step_preserves_exact_attempt_audits audited transition

theorem system_step_preserves_attempt_permit_evidence {before label after}
    (evidence : AttemptsHavePermitEvidence before)
    (step : SystemStep before label after) : AttemptsHavePermitEvidence after := by
  cases step with
  | mediated nonAttempt transition =>
      intro id attempt lookup
      apply evidence id attempt
      rw [mediated_nonattempt_preserves_attempts nonAttempt transition] at lookup
      exact lookup
  | authority transition => exact evidence
  | rematerialize transition => exact evidence
  | permit transition =>
      exact permit_step_preserves_attempt_permit_evidence evidence transition

theorem reachable_attempts_have_guarded_admission {state} (reachable : Reachable state) :
    AttemptsHaveGuardedAdmission state.core.effects := by
  induction reachable with
  | initial genesis =>
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_guarded_attempt_admissions ih transition

theorem reachable_receipt_ids_are_disjoint {state} (reachable : Reachable state) :
    ReceiptIdsDisjoint state.core.effects := by
  induction reachable with
  | initial genesis =>
      rw [trusted_genesis_effects_default genesis]
      intro id
      exact Or.inl rfl
  | step reachable transition ih =>
      exact system_step_preserves_receipt_id_disjointness ih transition

theorem reachable_attempts_have_exact_audits {state} (reachable : Reachable state) :
    AttemptsHaveExactAudit state.core := by
  induction reachable with
  | initial genesis =>
      unfold AttemptsHaveExactAudit
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_exact_attempt_audits ih transition

theorem reachable_attempts_have_exact_issued_permits {state} (reachable : Reachable state) :
    AttemptsHavePermitEvidence state := by
  induction reachable with
  | initial genesis =>
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_attempt_permit_evidence ih transition

theorem reachable_from_preserves_guarded_attempt_admissions {initial state}
    (initialGuarded : AttemptsHaveGuardedAdmission initial.core.effects)
    (reachable : ReachableFrom initial state) :
    AttemptsHaveGuardedAdmission state.core.effects := by
  induction reachable with
  | initial => exact initialGuarded
  | step reachable transition ih =>
      exact system_step_preserves_guarded_attempt_admissions ih transition

end AgentCore
