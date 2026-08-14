import AgentCore.Proofs.Safety
import AgentCore.DistributedPermit

/-!
# Canonical system reachability

Trusted bootstrap establishes the initial authority endowment. Runtime reachability
then includes Actor-local mediation and the distributed permit protocol. Live
authority administration is deliberately absent until its capability-mediated command
path is modeled; raw `AuthorityStep` is not a runtime authorization boundary. Direct
admission remains nondurable.
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
      consumption.permit.nonce = nonce ∧
      exactRequested state.permits consumption.permit.request ∧
      exactIssued state.permits consumption.permit ∧
      consumption.permit.expectation.MatchesAttempt attempt

def TransportRequestsAreExact (state : DistributedSystemState) : Prop :=
  ∀ request, .request request ∈ state.permits.transport →
    exactRequested state.permits request

def TransportPermitsWereIssued (state : DistributedSystemState) : Prop :=
  ∀ permit, .issued permit ∈ state.permits.transport →
    exactIssued state.permits permit

def AuthenticationsWereIssued (state : DistributedSystemState) : Prop :=
  ∀ target nonce authentication,
    state.permits.authentications target nonce = some authentication →
    exactIssued state.permits authentication.permit

def ConsumptionsWereIssued (state : DistributedSystemState) : Prop :=
  ∀ target nonce consumption,
    state.permits.consumptions target nonce = some consumption →
    exactRequested state.permits consumption.permit.request ∧
      exactIssued state.permits consumption.permit

def PermitProtocolIntegrity (state : DistributedSystemState) : Prop :=
  TransportRequestsAreExact state ∧ TransportPermitsWereIssued state ∧
  AuthenticationsWereIssued state ∧ ConsumptionsWereIssued state

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
  | permit (label : PermitLabel)
  deriving DecidableEq, Repr

inductive SystemStep : DistributedSystemState → SystemLabel →
    DistributedSystemState → Prop
  | mediated {before label core'} :
      label.NonAttempt → MediatedStep before.core label core' →
      SystemStep before (.mediated label) { before with core := core' }
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
  | staleDenied resolution exact intent stale holder observed invocation item denied effectStep stored =>
      exact pre_receipt_preserves_attempts effectStep
  | preReceipt intent effectStep stored exact => exact pre_receipt_preserves_attempts effectStep
  | attemptReceipt attempt exact effectStep stored =>
      exact attempt_receipt_preserves_attempts effectStep
  | supersedeReceipt old attempt exact effectStep stored sameAttempt =>
      exact supersede_receipt_preserves_attempts effectStep
  | audit => rfl
  | event => rfl
  | graph => rfl

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
  | request ready fresh => exact guarded
  | forwardRequest requested => exact guarded
  | issue ready fresh expiry => exact guarded
  | issueUnknownBefore => exact guarded
  | emit issued => exact guarded
  | injectMalformed => exact guarded
  | drop split => exact guarded
  | duplicate member => exact guarded
  | reorder permutation => exact guarded
  | authenticate member requested fence => exact guarded
  | consume authenticated requested fence issuedAt expiry unused localStep =>
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
  | request ready fresh => exact disjoint
  | forwardRequest requested => exact disjoint
  | issue ready fresh expiry => exact disjoint
  | issueUnknownBefore => exact disjoint
  | emit issued => exact disjoint
  | injectMalformed => exact disjoint
  | drop split => exact disjoint
  | duplicate member => exact disjoint
  | reorder permutation => exact disjoint
  | authenticate member requested fence => exact disjoint
  | consume authenticated requested fence issuedAt expiry unused localStep =>
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
  | request ready fresh => exact audited
  | forwardRequest requested => exact audited
  | issue ready fresh expiry => exact audited
  | issueUnknownBefore => exact audited
  | emit issued => exact audited
  | injectMalformed => exact audited
  | drop split => exact audited
  | duplicate member => exact audited
  | reorder permutation => exact audited
  | authenticate member requested fence => exact audited
  | consume authenticated requested fence issuedAt expiry unused localStep =>
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
  | request ready fresh => exact issued
  | forwardRequest requested => exact issued
  | @issue issuedRequest observation transported ready fresh expiry =>
      unfold exactIssued at issued
      change before.permits.issuerRecords issuedRequest.expectation.issuer
        issuedRequest.nonce = none at fresh
      change tableSet2 before.permits.issuerRecords issuedRequest.expectation.issuer
        issuedRequest.nonce
        (some (.issued ⟨issuedRequest, before.permits.now⟩))
        permit.expectation.issuer permit.nonce = some (.issued permit)
      by_cases sameIssuer : permit.expectation.issuer = issuedRequest.expectation.issuer
      · by_cases sameNonce : permit.nonce = issuedRequest.nonce
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
  | injectMalformed => exact issued
  | drop split => exact issued
  | duplicate member => exact issued
  | reorder permutation => exact issued
  | authenticate member requested fence => exact issued
  | consume authenticated requested fence issuedAt expiry unused localStep => exact issued
  | consumeUnknownBefore => exact issued
  | restart => exact issued
  | reset => exact issued
  | advanceTime monotone => exact issued
  | advanceFence => exact issued

theorem permit_step_preserves_requested_records {before label after}
    (step : PermitStep before label after) :
    ∀ request, exactRequested before.permits request →
      exactRequested after.permits request := by
  intro request requested
  cases step with
  | @request newRequest observation ready fresh =>
      unfold exactRequested at requested ⊢
      change tableSet2 before.permits.targetRequests newRequest.expectation.target
        newRequest.nonce (some newRequest) request.expectation.target request.nonce = some request
      by_cases sameTarget : request.expectation.target = newRequest.expectation.target
      · by_cases sameNonce : request.nonce = newRequest.nonce
        · rw [sameTarget, sameNonce] at requested
          rw [fresh] at requested
          contradiction
        · rw [tableSet2_other]
          · exact requested
          · exact Or.inr sameNonce
      · rw [tableSet2_other]
        · exact requested
        · exact Or.inl sameTarget
  | forwardRequest exact => exact requested
  | issue transported ready fresh expiry => exact requested
  | issueUnknownBefore => exact requested
  | emit issued => exact requested
  | injectMalformed => exact requested
  | drop split => exact requested
  | duplicate member => exact requested
  | reorder permutation => exact requested
  | authenticate member exact fence => exact requested
  | consume authenticated exact fence issuedAt expiry unused localStep => exact requested
  | consumeUnknownBefore => exact requested
  | restart => exact requested
  | reset => exact requested
  | advanceTime monotone => exact requested
  | advanceFence => exact requested

theorem permit_step_preserves_transport_request_integrity {before label after}
    (integrity : TransportRequestsAreExact before)
    (step : PermitStep before label after) : TransportRequestsAreExact after := by
  have requestedPreserved := permit_step_preserves_requested_records step
  cases step with
  | request ready fresh => exact fun request member => requestedPreserved request (integrity request member)
  | @forwardRequest request requested =>
      intro candidate member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | new
      · exact requestedPreserved candidate (integrity candidate old)
      · cases new
        exact requestedPreserved request requested
  | issue transported ready fresh expiry =>
      exact fun request member => requestedPreserved request (integrity request member)
  | issueUnknownBefore => exact integrity
  | emit issued =>
      intro request member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | impossible
      · exact requestedPreserved request (integrity request old)
      · contradiction
  | injectMalformed =>
      intro request member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | impossible
      · exact requestedPreserved request (integrity request old)
      · contradiction
  | @drop message beforeMessages afterMessages split =>
      intro request member
      apply requestedPreserved request
      apply integrity request
      rw [split]
      simp only [List.mem_append, List.mem_cons]
      simp only [List.mem_append] at member
      rcases member with beforeMember | afterMember
      · exact Or.inl beforeMember
      · exact Or.inr (Or.inr afterMember)
  | @duplicate message member =>
      intro request candidate
      simp only [List.mem_append, List.mem_singleton] at candidate
      rcases candidate with old | copied
      · exact requestedPreserved request (integrity request old)
      · cases copied
        exact requestedPreserved request (integrity request member)
  | reorder permutation =>
      intro request member
      apply requestedPreserved request
      apply integrity request
      exact permutation.mem_iff.mpr member
  | authenticate member requested fence =>
      exact fun request member => requestedPreserved request (integrity request member)
  | consume authenticated requested fence issuedAt expiry unused localStep =>
      exact fun request member => requestedPreserved request (integrity request member)
  | consumeUnknownBefore => exact integrity
  | restart => exact integrity
  | reset => exact integrity
  | advanceTime monotone => exact integrity
  | advanceFence => exact integrity

theorem permit_step_preserves_transport_permit_integrity {before label after}
    (integrity : TransportPermitsWereIssued before)
    (step : PermitStep before label after) : TransportPermitsWereIssued after := by
  have issuedPreserved := permit_step_preserves_issued_records step
  cases step with
  | request ready fresh => exact fun permit member => issuedPreserved permit (integrity permit member)
  | forwardRequest requested =>
      intro permit member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | impossible
      · exact issuedPreserved permit (integrity permit old)
      · contradiction
  | issue transported ready fresh expiry =>
      exact fun permit member => issuedPreserved permit (integrity permit member)
  | issueUnknownBefore => exact integrity
  | @emit permit issued =>
      intro candidate member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | new
      · exact issuedPreserved candidate (integrity candidate old)
      · cases new
        exact issuedPreserved permit issued
  | injectMalformed =>
      intro permit member
      simp only [List.mem_append, List.mem_singleton] at member
      rcases member with old | impossible
      · exact issuedPreserved permit (integrity permit old)
      · contradiction
  | @drop message beforeMessages afterMessages split =>
      intro permit member
      apply issuedPreserved permit
      apply integrity permit
      rw [split]
      simp only [List.mem_append, List.mem_cons]
      simp only [List.mem_append] at member
      rcases member with beforeMember | afterMember
      · exact Or.inl beforeMember
      · exact Or.inr (Or.inr afterMember)
  | @duplicate message member =>
      intro permit candidate
      simp only [List.mem_append, List.mem_singleton] at candidate
      rcases candidate with old | copied
      · exact issuedPreserved permit (integrity permit old)
      · cases copied
        exact issuedPreserved permit (integrity permit member)
  | reorder permutation =>
      intro permit member
      exact issuedPreserved permit (integrity permit (permutation.mem_iff.mpr member))
  | authenticate member requested fence =>
      exact fun permit member => issuedPreserved permit (integrity permit member)
  | consume authenticated requested fence issuedAt expiry unused localStep =>
      exact fun permit member => issuedPreserved permit (integrity permit member)
  | consumeUnknownBefore => exact integrity
  | restart => exact integrity
  | reset => exact integrity
  | advanceTime monotone => exact integrity
  | advanceFence => exact integrity

theorem permit_step_preserves_authentication_integrity {before label after}
    (transportIntegrity : TransportPermitsWereIssued before)
    (integrity : AuthenticationsWereIssued before)
    (step : PermitStep before label after) : AuthenticationsWereIssued after := by
  have issuedPreserved := permit_step_preserves_issued_records step
  cases step with
  | @authenticate permit transported requested fence =>
      intro target nonce authentication lookup
      change tableSet2 before.permits.authentications permit.expectation.target permit.nonce
        (some ⟨permit, before.permits.incarnation permit.expectation.target⟩)
        target nonce = some authentication at lookup
      by_cases sameTarget : target = permit.expectation.target
      · by_cases sameNonce : nonce = permit.nonce
        · subst target
          subst nonce
          simp only [tableSet2_self] at lookup
          cases Option.some.inj lookup
          exact issuedPreserved permit (transportIntegrity permit transported)
        · rw [tableSet2_other] at lookup
          · exact issuedPreserved authentication.permit (integrity target nonce authentication lookup)
          · exact Or.inr sameNonce
      · rw [tableSet2_other] at lookup
        · exact issuedPreserved authentication.permit (integrity target nonce authentication lookup)
        · exact Or.inl sameTarget
  | request ready fresh =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | forwardRequest requested =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | issue transported ready fresh expiry =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | issueUnknownBefore => exact integrity
  | emit issued =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | injectMalformed => exact integrity
  | drop split =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | duplicate member =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | reorder permutation => exact integrity
  | consume authenticated requested fence issuedAt expiry unused localStep =>
      intro target nonce auth lookup
      exact issuedPreserved auth.permit (integrity target nonce auth lookup)
  | consumeUnknownBefore => exact integrity
  | restart => exact integrity
  | reset => exact integrity
  | advanceTime monotone => exact integrity
  | advanceFence => exact integrity

theorem permit_step_preserves_consumption_integrity {before label after}
    (authenticationIntegrity : AuthenticationsWereIssued before)
    (integrity : ConsumptionsWereIssued before)
    (step : PermitStep before label after) : ConsumptionsWereIssued after := by
  have issuedPreserved := permit_step_preserves_issued_records step
  have requestedPreserved := permit_step_preserves_requested_records step
  have preserveEvidence : ∀ target nonce consumption,
      before.permits.consumptions target nonce = some consumption →
      exactRequested after.permits consumption.permit.request ∧
        exactIssued after.permits consumption.permit := by
    intro target nonce consumption lookup
    exact ⟨requestedPreserved _ (integrity target nonce consumption lookup).1,
      issuedPreserved _ (integrity target nonce consumption lookup).2⟩
  cases step with
  | @consume permit attemptId attempt auditId core' observation authenticated requested fence
      issuedAt expiry unused localStep =>
      intro target nonce consumption lookup
      change tableSet2 before.permits.consumptions permit.expectation.target permit.nonce
        (some ⟨permit, attemptId⟩) target nonce = some consumption at lookup
      by_cases sameTarget : target = permit.expectation.target
      · by_cases sameNonce : nonce = permit.nonce
        · subst target
          subst nonce
          simp only [tableSet2_self] at lookup
          cases Option.some.inj lookup
          exact ⟨requestedPreserved _ requested,
            issuedPreserved permit
              (authenticationIntegrity permit.expectation.target permit.nonce
                ⟨permit, before.permits.incarnation permit.expectation.target⟩ authenticated)⟩
        · rw [tableSet2_other] at lookup
          · exact preserveEvidence target nonce consumption lookup
          · exact Or.inr sameNonce
      · rw [tableSet2_other] at lookup
        · exact preserveEvidence target nonce consumption lookup
        · exact Or.inl sameTarget
  | request ready fresh =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | forwardRequest requested =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | issue transported ready fresh expiry =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | issueUnknownBefore => exact integrity
  | emit issued =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | injectMalformed => exact integrity
  | drop split =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | duplicate member =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | reorder permutation => exact integrity
  | authenticate transported requested fence =>
      intro target nonce consumption lookup
      exact preserveEvidence target nonce consumption lookup
  | consumeUnknownBefore => exact integrity
  | restart => exact integrity
  | reset => exact integrity
  | advanceTime monotone => exact integrity
  | advanceFence => exact integrity

theorem permit_step_preserves_protocol_integrity {before label after}
    (integrity : PermitProtocolIntegrity before)
    (step : PermitStep before label after) : PermitProtocolIntegrity after := by
  exact ⟨permit_step_preserves_transport_request_integrity integrity.1 step,
    permit_step_preserves_transport_permit_integrity integrity.2.1 step,
    permit_step_preserves_authentication_integrity integrity.2.1 integrity.2.2.1 step,
    permit_step_preserves_consumption_integrity integrity.2.2.1 integrity.2.2.2 step⟩

theorem permit_step_preserves_attempt_permit_evidence {before label after}
    (authenticationIntegrity : AuthenticationsWereIssued before)
    (evidence : AttemptsHavePermitEvidence before)
    (step : PermitStep before label after) : AttemptsHavePermitEvidence after := by
  have issuedPreserved := permit_step_preserves_issued_records step
  have requestedPreserved := permit_step_preserves_requested_records step
  cases step with
  | request ready fresh =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requested, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ requested, issuedPreserved _ issued, exactMatch⟩
  | forwardRequest requested =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        exactRequest, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ exactRequest, issuedPreserved _ issued, exactMatch⟩
  | issue transported ready fresh expiry =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requested, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ requested, issuedPreserved _ issued, exactMatch⟩
  | issueUnknownBefore => exact evidence
  | emit issued =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requested, oldIssued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ requested, issuedPreserved _ oldIssued, exactMatch⟩
  | injectMalformed => exact evidence
  | drop split =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requested, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ requested, issuedPreserved _ issued, exactMatch⟩
  | duplicate member =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requested, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ requested, issuedPreserved _ issued, exactMatch⟩
  | reorder permutation => exact evidence
  | authenticate transported requested fence =>
      intro id attempt lookup
      obtain ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        exactRequest, issued, exactMatch⟩ := evidence id attempt lookup
      exact ⟨target, nonce, consumption, consumed, attemptId, targetEq, nonceEq,
        requestedPreserved _ exactRequest, issuedPreserved _ issued, exactMatch⟩
  | @consume permit attemptId newAttempt auditId core' observation authenticated requested fence
      issuedAt expiry unused localStep =>
      intro id storedAttempt lookup
      have updated := target_attempt_step_updates_only_exact_attempt localStep
      rw [updated] at lookup
      by_cases sameAttempt : id = attemptId
      · subst id
        rw [tableSet_self] at lookup
        cases Option.some.inj lookup
        obtain ⟨_, exactMatch⟩ := target_attempt_step_stores_exact_attempt localStep
        have issued : exactIssued before.permits permit :=
          authenticationIntegrity permit.expectation.target permit.nonce
            ⟨permit, before.permits.incarnation permit.expectation.target⟩ authenticated
        refine ⟨_, _, ⟨_, _⟩, ?_, rfl, rfl, rfl,
          requestedPreserved _ requested, issuedPreserved _ issued, exactMatch⟩
        exact tableSet2_self ..
      · have oldLookup : before.core.effects.attempts id = some storedAttempt := by
          rw [← tableSet_other before.core.effects.attempts _ id sameAttempt]
          exact lookup
        obtain ⟨oldTarget, oldNonce, consumption, consumed, oldAttemptId, targetEq, nonceEq,
          exactRequest, oldIssued, exactMatch⟩ := evidence id storedAttempt oldLookup
        have differentKey :
            oldTarget ≠ permit.expectation.target ∨ oldNonce ≠ permit.nonce := by
          by_cases sameTarget : oldTarget = permit.expectation.target
          · right
            intro sameNonce
            rw [sameTarget, sameNonce, unused] at consumed
            contradiction
          · exact Or.inl sameTarget
        refine ⟨oldTarget, oldNonce, consumption, ?_, oldAttemptId, targetEq, nonceEq,
          requestedPreserved _ exactRequest, issuedPreserved _ oldIssued, exactMatch⟩
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
  | permit transition => exact permit_step_preserves_guarded_attempt_admissions guarded transition

theorem system_step_preserves_receipt_id_disjointness {before label after}
    (disjoint : ReceiptIdsDisjoint before.core.effects)
    (step : SystemStep before label after) : ReceiptIdsDisjoint after.core.effects := by
  cases step with
  | mediated nonAttempt transition =>
      exact mediated_step_preserves_receipt_id_disjointness disjoint transition
  | permit transition => exact permit_step_preserves_receipt_id_disjointness disjoint transition

theorem system_step_preserves_exact_attempt_audits {before label after}
    (audited : AttemptsHaveExactAudit before.core)
    (step : SystemStep before label after) : AttemptsHaveExactAudit after.core := by
  cases step with
  | mediated nonAttempt transition =>
      exact mediated_step_preserves_exact_attempt_audits audited transition
  | permit transition => exact permit_step_preserves_exact_attempt_audits audited transition

theorem system_step_preserves_protocol_integrity {before label after}
    (integrity : PermitProtocolIntegrity before)
    (step : SystemStep before label after) : PermitProtocolIntegrity after := by
  cases step with
  | mediated nonAttempt transition => exact integrity
  | permit transition => exact permit_step_preserves_protocol_integrity integrity transition

theorem system_step_preserves_attempt_permit_evidence {before label after}
    (protocol : PermitProtocolIntegrity before)
    (evidence : AttemptsHavePermitEvidence before)
    (step : SystemStep before label after) : AttemptsHavePermitEvidence after := by
  cases step with
  | mediated nonAttempt transition =>
      intro id attempt lookup
      apply evidence id attempt
      rw [mediated_nonattempt_preserves_attempts nonAttempt transition] at lookup
      exact lookup
  | permit transition =>
      exact permit_step_preserves_attempt_permit_evidence protocol.2.2.1 evidence transition

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

theorem reachable_permit_protocol_has_historical_issuance {state} (reachable : Reachable state) :
    PermitProtocolIntegrity state := by
  induction reachable with
  | initial genesis =>
      obtain ⟨_, _, permits⟩ := genesis
      constructor
      · intro request member
        rw [permits] at member
        contradiction
      constructor
      · intro permit member
        rw [permits] at member
        contradiction
      constructor
      · intro target nonce authentication lookup
        rw [permits] at lookup
        contradiction
      · intro target nonce consumption lookup
        rw [permits] at lookup
        contradiction
  | step reachable transition ih =>
      exact system_step_preserves_protocol_integrity ih transition

theorem reachable_attempts_have_exact_issued_permits {state} (reachable : Reachable state) :
    AttemptsHavePermitEvidence state := by
  induction reachable with
  | initial genesis =>
      intro id attempt lookup
      have defaultEffects := trusted_genesis_effects_default genesis
      rw [defaultEffects] at lookup
      contradiction
  | step reachable transition ih =>
      exact system_step_preserves_attempt_permit_evidence
        (reachable_permit_protocol_has_historical_issuance reachable) ih transition

theorem reachable_consumption_has_exact_historical_issuance {state target nonce consumption}
    (reachable : Reachable state)
    (consumed : state.permits.consumptions target nonce = some consumption) :
    exactIssued state.permits consumption.permit :=
  ((reachable_permit_protocol_has_historical_issuance reachable).2.2.2
    target nonce consumption consumed).2

theorem reachable_consumption_retains_exact_target_request {state target nonce consumption}
    (reachable : Reachable state)
    (consumed : state.permits.consumptions target nonce = some consumption) :
    exactRequested state.permits consumption.permit.request :=
  ((reachable_permit_protocol_has_historical_issuance reachable).2.2.2
    target nonce consumption consumed).1

theorem reachable_issue_uses_exact_target_request {before after issuer nonce observation}
    (reachable : Reachable before)
    (step : PermitStep before (.issue issuer nonce observation) after) :
    ∃ request,
      .request request ∈ before.permits.transport ∧
      exactRequested before.permits request ∧
      PermitIssueReady (tenantIssueView before issuer) request := by
  cases step with
  | @issue request issuedObservation transported ready fresh expiry =>
      refine ⟨request, transported, ?_, ?_⟩
      · exact (reachable_permit_protocol_has_historical_issuance reachable).1
          request transported
      · simpa using ready

theorem reachable_authentication_uses_historically_issued_transport
    {before after target nonce}
    (reachable : Reachable before)
    (step : PermitStep before (.authenticate target nonce) after) :
    ∃ permit,
      target = permit.expectation.target ∧ nonce = permit.nonce ∧
      exactRequested before.permits permit.request ∧
      exactIssued before.permits permit ∧ exactAuthenticated after.permits permit := by
  obtain ⟨permit, targetEq, nonceEq, transported, requested, authenticated⟩ :=
    authentication_requires_exact_target_request step
  exact ⟨permit, targetEq, nonceEq, requested,
    (reachable_permit_protocol_has_historical_issuance reachable).2.1 permit transported,
    authenticated⟩

theorem reachable_from_preserves_guarded_attempt_admissions {initial state}
    (initialGuarded : AttemptsHaveGuardedAdmission initial.core.effects)
    (reachable : ReachableFrom initial state) :
    AttemptsHaveGuardedAdmission state.core.effects := by
  induction reachable with
  | initial => exact initialGuarded
  | step reachable transition ih =>
      exact system_step_preserves_guarded_attempt_admissions ih transition

end AgentCore
