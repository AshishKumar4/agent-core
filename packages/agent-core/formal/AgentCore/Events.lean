import AgentCore.Materialization

/-!
# Exact item effects, derived batch outcomes, trusted Events, and routing

Attempts are immutable and keyed to one prepared item. Pre-effect receipts are distinct
from attempt receipts. Attempt supersession is same-attempt, indeterminate-to-final,
and one-time. Retry ordinals require the previous attempt's final failure. Batch outcome
is derived only when every item is terminal and is never stored as a Receipt.
-/

namespace AgentCore

structure EffectAttempt where
  invocation : InvocationId
  itemIndex : Nat
  ordinal : Nat
  claim : ItemClaimId
  auditCause : AuditId
  key : ItemKey
  token : Option LeaseToken
  startedAt : Time
  deriving DecidableEq, Repr

inductive PreEffectOutcome where | denied | cancelled deriving DecidableEq, Repr
inductive AttemptOutcome where | succeeded | failed | indeterminate deriving DecidableEq, Repr
def AttemptOutcome.Final : AttemptOutcome → Prop | .indeterminate => False | _ => True
inductive ItemOutcome where | succeeded | failed | denied | cancelled | indeterminate
  deriving DecidableEq, Repr

structure PreEffectReceipt where
  invocation : InvocationId
  itemIndex : Nat
  outcome : PreEffectOutcome
  deriving DecidableEq, Repr

structure AttemptReceipt where
  attempt : AttemptId
  outcome : AttemptOutcome
  previous : Option ReceiptId
  deriving DecidableEq, Repr

inductive ItemReceiptRef where
  | preEffect (receipt : ReceiptId)
  | attempt (receipt : ReceiptId)
  deriving DecidableEq, Repr

inductive ItemClaimOwner where
  | executor (token : LeaseToken) (worker : ClaimWorkerId)
  | system (actor : ActorRef) (worker : ClaimWorkerId)
  deriving DecidableEq, Repr

def ItemClaimOwner.worker : ItemClaimOwner → ClaimWorkerId
  | .executor _ worker | .system _ worker => worker

def ItemClaimOwner.token : ItemClaimOwner → Option LeaseToken
  | .executor token _ => some token
  | .system _ _ => none

structure ItemClaim where
  id : ItemClaimId
  invocation : InvocationId
  itemIndex : Nat
  ordinal : Nat
  owner : ItemClaimOwner
  expiresAt : Time
  deriving DecidableEq, Repr

structure AttemptAdmission where
  identity : InvocationIdentity
  principal : PrincipalRef
  scope : Scope
  resolution : ResolutionId
  deriving DecidableEq, Repr

structure EffectLedger where
  invocations : InvocationId → Option PreparedInvocation
  attempts : AttemptId → Option EffectAttempt
  admissions : AttemptId → Option AttemptAdmission
  claims : ItemClaimId → Option ItemClaim
  currentClaim : InvocationId → Nat → Option ItemClaimId
  preReceipts : ReceiptId → Option PreEffectReceipt
  attemptReceipts : ReceiptId → Option AttemptReceipt
  latestAttempt : InvocationId → Nat → Option AttemptId
  currentReceipt : InvocationId → Nat → Option ItemReceiptRef
  supersededBy : ReceiptId → Option ReceiptId

instance : Inhabited EffectLedger where
  default := ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none, fun _ _ => none,
    fun _ => none, fun _ => none, fun _ _ => none, fun _ _ => none, fun _ => none⟩

def PreparedItemAt (prepared : PreparedInvocation) (index : Nat) (item : PreparedItem) : Prop :=
  prepared.items[index]? = some item

def NoEffectAttemptFor (ledger : EffectLedger) (invocation : InvocationId) (index : Nat) : Prop :=
  ∀ id attempt, ledger.attempts id = some attempt →
    attempt.invocation ≠ invocation ∨ attempt.itemIndex ≠ index

def AttemptMatches (prepared : PreparedInvocation) (attempt : EffectAttempt) : Prop :=
  ∃ item, PreparedItemAt prepared attempt.itemIndex item ∧ attempt.key = item.key ∧
    match prepared.header.lease, attempt.token with
    | none, none => True
    | some expected, some actual => actual = expected
    | _, _ => False

def AdmissionMatchesAttempt (admission : AttemptAdmission) (prepared : PreparedInvocation)
    (attempt : EffectAttempt) : Prop :=
  admission.identity = prepared.identity ∧
  admission.principal = prepared.header.authority.principal ∧
  AttemptMatches prepared attempt

def AttemptReceiptTerminalFor (ledger : EffectLedger) (attempt : AttemptId)
    (receipt : ReceiptId) (outcome : AttemptOutcome) : Prop :=
  ∃ record, ledger.attemptReceipts receipt = some record ∧ record.attempt = attempt ∧
    record.outcome = outcome ∧ outcome.Final

def ClaimOwnsAttempt (claim : ItemClaim) (attempt : EffectAttempt) : Prop :=
  claim.id = attempt.claim ∧ claim.invocation = attempt.invocation ∧
  claim.itemIndex = attempt.itemIndex ∧ claim.ordinal = attempt.ordinal ∧
  claim.owner.token = attempt.token

def ClaimOwnerMatchesPrepared (prepared : PreparedInvocation) (owner : ItemClaimOwner) : Prop :=
  match prepared.header.lease, owner with
  | some expected, .executor actual _ => actual = expected
  | none, .system actor _ => actor = domainOwner prepared.header.domain
  | _, _ => False

def ClaimOrdinalAvailable (ledger : EffectLedger) (claim : ItemClaim) : Prop :=
  (claim.ordinal = 0 ∧ ledger.latestAttempt claim.invocation claim.itemIndex = none ∧
    ledger.currentReceipt claim.invocation claim.itemIndex = none) ∨
  ∃ previous prior receipt,
    ledger.latestAttempt claim.invocation claim.itemIndex = some previous ∧
    ledger.attempts previous = some prior ∧
    prior.invocation = claim.invocation ∧ prior.itemIndex = claim.itemIndex ∧
    claim.ordinal = prior.ordinal + 1 ∧
    ledger.currentReceipt claim.invocation claim.itemIndex = some (.attempt receipt) ∧
    AttemptReceiptTerminalFor ledger previous receipt .failed

def EffectLedger.addAttempt (ledger : EffectLedger) (id : AttemptId)
    (attempt : EffectAttempt) : EffectLedger := {
  ledger with
  attempts := tableSet ledger.attempts id attempt
  latestAttempt := fun invocation index =>
    if invocation = attempt.invocation ∧ index = attempt.itemIndex then some id
    else ledger.latestAttempt invocation index
}

def EffectLedger.recordAdmission (ledger : EffectLedger) (id : AttemptId)
    (admission : AttemptAdmission) : EffectLedger :=
  { ledger with admissions := tableSet ledger.admissions id admission }

def EffectLedger.setClaim (ledger : EffectLedger) (claim : ItemClaim) : EffectLedger :=
  { ledger with
    claims := tableSet ledger.claims claim.id claim
    currentClaim := fun invocation index =>
      if invocation = claim.invocation ∧ index = claim.itemIndex then some claim.id
      else ledger.currentClaim invocation index }

def EffectLedger.addRetryAttempt (ledger : EffectLedger) (id : AttemptId)
    (attempt : EffectAttempt) : EffectLedger := {
  ledger.addAttempt id attempt with
  currentReceipt := fun invocation index =>
    if invocation = attempt.invocation ∧ index = attempt.itemIndex then none
    else ledger.currentReceipt invocation index
}

def EffectLedger.addPreReceipt (ledger : EffectLedger) (id : ReceiptId)
    (receipt : PreEffectReceipt) : EffectLedger := {
  ledger with
  preReceipts := tableSet ledger.preReceipts id receipt
  currentReceipt := fun invocation index =>
    if invocation = receipt.invocation ∧ index = receipt.itemIndex then some (.preEffect id)
    else ledger.currentReceipt invocation index
}

def EffectLedger.addAttemptReceipt (ledger : EffectLedger) (id : ReceiptId)
    (receipt : AttemptReceipt) (attempt : EffectAttempt) : EffectLedger := {
  ledger with
  attemptReceipts := tableSet ledger.attemptReceipts id receipt
  currentReceipt := fun invocation index =>
    if invocation = attempt.invocation ∧ index = attempt.itemIndex then some (.attempt id)
    else ledger.currentReceipt invocation index
  currentClaim := fun invocation index =>
    if receipt.outcome = .indeterminate then ledger.currentClaim invocation index
    else if invocation = attempt.invocation ∧ index = attempt.itemIndex then none
    else ledger.currentClaim invocation index
}

def EffectLedger.supersedeAttemptReceipt (ledger : EffectLedger) (id previous : ReceiptId)
    (receipt : AttemptReceipt) (attempt : EffectAttempt) : EffectLedger := {
  ledger with
  attemptReceipts := tableSet ledger.attemptReceipts id receipt
  currentReceipt := fun invocation index =>
    if invocation = attempt.invocation ∧ index = attempt.itemIndex then some (.attempt id)
    else ledger.currentReceipt invocation index
  supersededBy := tableSet ledger.supersededBy previous id
  currentClaim := fun invocation index =>
    if receipt.outcome = .indeterminate then ledger.currentClaim invocation index
    else if invocation = attempt.invocation ∧ index = attempt.itemIndex then none
    else ledger.currentClaim invocation index
}

inductive EffectLabel where
  | persistIntent (invocation : InvocationId)
  | claimItem (invocation : InvocationId) (index : Nat) (now : Time)
  | recoverItemClaim (invocation : InvocationId) (index : Nat) (now : Time)
  | firstAttempt (attempt : AttemptId)
  | retryAttempt (previous next : AttemptId)
  | preReceipt (receipt : ReceiptId)
  | attemptReceipt (receipt : ReceiptId)
  | supersedeReceipt (previous next : ReceiptId)
  deriving DecidableEq, Repr

inductive EffectStep : EffectLedger → EffectLabel → EffectLedger → Prop
  | persistIntent {ledger prepared} :
      ledger.invocations prepared.header.invocation = none →
      EffectStep ledger (.persistIntent prepared.header.invocation) {
       ledger with invocations := tableSet ledger.invocations prepared.header.invocation prepared }
  | claimItem {ledger prepared item claim now} :
      ledger.invocations claim.invocation = some prepared →
      PreparedItemAt prepared claim.itemIndex item →
      ClaimOwnerMatchesPrepared prepared claim.owner → ClaimOrdinalAvailable ledger claim →
      now.tick < claim.expiresAt.tick →
      ledger.claims claim.id = none →
      ledger.currentClaim claim.invocation claim.itemIndex = none →
      EffectStep ledger (.claimItem claim.invocation claim.itemIndex now) (ledger.setClaim claim)
  | recoverItemClaim {ledger previous replacement prepared now} :
      ledger.claims previous.id = some previous →
      ledger.currentClaim previous.invocation previous.itemIndex = some previous.id →
      ledger.invocations previous.invocation = some prepared →
      ClaimOwnerMatchesPrepared prepared previous.owner →
      ClaimOwnerMatchesPrepared prepared replacement.owner →
      ledger.claims replacement.id = none → replacement.id ≠ previous.id →
      previous.expiresAt.tick ≤ now.tick →
      replacement.invocation = previous.invocation →
      replacement.itemIndex = previous.itemIndex → replacement.ordinal = previous.ordinal →
      replacement.owner.worker ≠ previous.owner.worker → now.tick < replacement.expiresAt.tick →
      NoEffectAttemptFor ledger previous.invocation previous.itemIndex →
      EffectStep ledger (.recoverItemClaim previous.invocation previous.itemIndex now)
        (ledger.setClaim replacement)
  | firstAttempt {ledger id attempt prepared} :
      ledger.attempts id = none → ledger.invocations attempt.invocation = some prepared →
      (∃ admission, ledger.admissions id = some admission ∧
        AdmissionMatchesAttempt admission prepared attempt) →
      AttemptMatches prepared attempt → attempt.ordinal = 0 →
      (∃ claim, ledger.claims attempt.claim = some claim ∧
        ledger.currentClaim attempt.invocation attempt.itemIndex = some attempt.claim ∧
        ClaimOwnsAttempt claim attempt ∧
        attempt.startedAt.tick < claim.expiresAt.tick) →
      ledger.latestAttempt attempt.invocation attempt.itemIndex = none →
      ledger.currentReceipt attempt.invocation attempt.itemIndex = none →
      EffectStep ledger (.firstAttempt id) (ledger.addAttempt id attempt)
  | retryAttempt {ledger previous next prior attempt prepared priorReceipt claim} :
      ledger.attempts next = none → ledger.attempts previous = some prior →
      ledger.latestAttempt prior.invocation prior.itemIndex = some previous →
      ledger.currentReceipt prior.invocation prior.itemIndex = some (.attempt priorReceipt) →
      AttemptReceiptTerminalFor ledger previous priorReceipt .failed →
      ledger.invocations prior.invocation = some prepared →
      (∃ admission, ledger.admissions next = some admission ∧
        AdmissionMatchesAttempt admission prepared attempt) →
      AttemptMatches prepared attempt →
      attempt.invocation = prior.invocation → attempt.itemIndex = prior.itemIndex →
      attempt.ordinal = prior.ordinal + 1 →
      ledger.claims attempt.claim = some claim →
      ledger.currentClaim attempt.invocation attempt.itemIndex = some attempt.claim →
      ClaimOwnsAttempt claim attempt → attempt.startedAt.tick < claim.expiresAt.tick →
      EffectStep ledger (.retryAttempt previous next)
        (ledger.addRetryAttempt next attempt)
  | preReceipt {ledger id receipt prepared} :
      ledger.preReceipts id = none → ledger.attemptReceipts id = none →
      ledger.invocations receipt.invocation = some prepared →
      (∃ item, PreparedItemAt prepared receipt.itemIndex item) →
      ledger.currentClaim receipt.invocation receipt.itemIndex = none →
      ledger.latestAttempt receipt.invocation receipt.itemIndex = none →
      ledger.currentReceipt receipt.invocation receipt.itemIndex = none →
      EffectStep ledger (.preReceipt id) (ledger.addPreReceipt id receipt)
  | firstAttemptReceipt {ledger id receipt attempt} :
      ledger.attemptReceipts id = none → ledger.preReceipts id = none →
      ledger.attempts receipt.attempt = some attempt →
      ledger.latestAttempt attempt.invocation attempt.itemIndex = some receipt.attempt →
      ledger.currentReceipt attempt.invocation attempt.itemIndex = none →
      receipt.previous = none →
      EffectStep ledger (.attemptReceipt id) (ledger.addAttemptReceipt id receipt attempt)
  | supersedeAttemptReceipt {ledger previous next beforeReceipt receipt attempt} :
      ledger.attemptReceipts next = none → ledger.preReceipts next = none →
      ledger.attemptReceipts previous = some beforeReceipt →
      beforeReceipt.attempt = receipt.attempt → beforeReceipt.outcome = .indeterminate →
      ledger.supersededBy previous = none → receipt.previous = some previous →
      receipt.outcome.Final → ledger.attempts receipt.attempt = some attempt →
      ledger.currentReceipt attempt.invocation attempt.itemIndex = some (.attempt previous) →
      EffectStep ledger (.supersedeReceipt previous next)
        (ledger.supersedeAttemptReceipt next previous receipt attempt)

def ItemCurrentOutcome (ledger : EffectLedger) (invocation : InvocationId) (index : Nat)
    (outcome : ItemOutcome) : Prop :=
  match ledger.currentReceipt invocation index with
  | some (.preEffect receipt) => ∃ record, ledger.preReceipts receipt = some record ∧
      ledger.latestAttempt invocation index = none ∧
      record.invocation = invocation ∧ record.itemIndex = index ∧
      ((record.outcome = .denied ∧ outcome = .denied) ∨
       (record.outcome = .cancelled ∧ outcome = .cancelled))
  | some (.attempt receipt) => ∃ record attempt,
      ledger.attemptReceipts receipt = some record ∧ ledger.attempts record.attempt = some attempt ∧
      ledger.latestAttempt invocation index = some record.attempt ∧
      attempt.invocation = invocation ∧ attempt.itemIndex = index ∧
      ((record.outcome = .succeeded ∧ outcome = .succeeded) ∨
       (record.outcome = .failed ∧ outcome = .failed) ∨
       (record.outcome = .indeterminate ∧ outcome = .indeterminate))
  | none => False

inductive BatchOutcome where
  | succeeded | failed | denied | cancelled | indeterminate | partiallySucceeded
  deriving DecidableEq, Repr

def deriveBatchOutcome (outcomes : List ItemOutcome) : Option BatchOutcome :=
  if outcomes.isEmpty then none
  else if outcomes.contains .indeterminate then some .indeterminate
  else if outcomes.all (· == .succeeded) then some .succeeded
  else if outcomes.contains .succeeded then some .partiallySucceeded
  else if outcomes.contains .failed then some .failed
  else if outcomes.contains .cancelled then some .cancelled
  else some .denied

def BatchTerminalOutcome (ledger : EffectLedger) (prepared : PreparedInvocation)
    (outcomes : List ItemOutcome) (aggregate : BatchOutcome) : Prop :=
  outcomes.length = prepared.items.length ∧
  (∀ index outcome, outcomes[index]? = some outcome →
    ItemCurrentOutcome ledger prepared.header.invocation index outcome) ∧
  deriveBatchOutcome outcomes = some aggregate ∧ aggregate ≠ .indeterminate

def BatchCurrentOutcome (ledger : EffectLedger) (prepared : PreparedInvocation)
    (outcomes : List ItemOutcome) (aggregate : BatchOutcome) : Prop :=
  outcomes.length = prepared.items.length ∧
  (∀ index outcome, outcomes[index]? = some outcome →
    ItemCurrentOutcome ledger prepared.header.invocation index outcome) ∧
  deriveBatchOutcome outcomes = some aggregate

def AttemptsHaveGuardedAdmission (ledger : EffectLedger) : Prop :=
  ∀ id attempt, ledger.attempts id = some attempt →
    ∃ admission prepared,
      ledger.admissions id = some admission ∧
      ledger.invocations attempt.invocation = some prepared ∧
      AdmissionMatchesAttempt admission prepared attempt

theorem recordAdmission_preserves_guarded_admissions {ledger : EffectLedger} {id admission}
    (fresh : ledger.attempts id = none) (guarded : AttemptsHaveGuardedAdmission ledger) :
    AttemptsHaveGuardedAdmission (ledger.recordAdmission id admission) := by
  intro existing attempt lookup
  obtain ⟨priorAdmission, prepared, admissionLookup, intent, matchEvidence⟩ :=
    guarded existing attempt lookup
  change ledger.attempts existing = some attempt at lookup
  refine ⟨priorAdmission, prepared, ?_, intent, matchEvidence⟩
  simp only [EffectLedger.recordAdmission, tableSet]
  split
  · rename_i same
    subst existing
    rw [fresh] at lookup
    contradiction
  · exact admissionLookup

theorem effect_step_preserves_guarded_admissions {before after label}
    (guarded : AttemptsHaveGuardedAdmission before) (step : EffectStep before label after) :
    AttemptsHaveGuardedAdmission after := by
  cases step with
  | persistIntent fresh =>
      intro id attempt lookup
      obtain ⟨admission, prepared, admissionLookup, intent, matchEvidence⟩ :=
        guarded id attempt lookup
      refine ⟨admission, prepared, admissionLookup, ?_, matchEvidence⟩
      simp only [tableSet]
      split
      · rename_i same
        rw [same] at intent
        rw [fresh] at intent
        contradiction
      · exact intent
  | claimItem intent item owner ordinal future unclaimed noCurrentClaim => exact guarded
  | recoverItemClaim lookup current intent previousOwner replacementOwner fresh freshId expired
      invocation index ordinal worker future noAttempt =>
      exact guarded
  | firstAttempt fresh intent admitted matchEvidence ordinal claim noAttempt noReceipt =>
      intro id attempt lookup
      simp only [EffectLedger.addAttempt, tableSet] at lookup
      split at lookup
      · rename_i same
        subst id
        cases lookup
        obtain ⟨admission, admissionLookup, admissionMatches⟩ := admitted
        exact ⟨admission, _, admissionLookup, intent, admissionMatches⟩
      · exact guarded id attempt lookup
  | retryAttempt fresh prior latest current failed intent admitted matchEvidence invocation index ordinal
      claimLookup currentClaim owns future =>
      intro id attempt lookup
      simp only [EffectLedger.addRetryAttempt, EffectLedger.addAttempt, tableSet] at lookup
      split at lookup
      · rename_i same
        subst id
        cases lookup
        obtain ⟨admission, admissionLookup, admissionMatches⟩ := admitted
        refine ⟨admission, _, admissionLookup, ?_, admissionMatches⟩
        simpa [invocation] using intent
      · exact guarded id attempt lookup
  | preReceipt fresh otherFresh intent item noAttempt noReceipt => exact guarded
  | firstAttemptReceipt fresh otherFresh attempt latest current previous => exact guarded
  | supersedeAttemptReceipt fresh otherFresh old sameAttempt indeterminate unused previous final attempt current =>
      exact guarded

theorem retry_requires_prior_final_failure {before after : EffectLedger}
    {previous next : AttemptId}
    (step : EffectStep before (.retryAttempt previous next) after) :
    ∃ (prior : EffectAttempt) (receipt : ReceiptId), before.attempts previous = some prior ∧
      AttemptReceiptTerminalFor before previous receipt .failed := by
  cases step with
  | retryAttempt fresh priorLookup latest current failed intent admitted matchEvidence sameInvocation sameItem ordinal
      future =>
      exact ⟨_, _, priorLookup, failed⟩

theorem first_attempt_requires_fresh_id {before after : EffectLedger} {id : AttemptId}
    (step : EffectStep before (.firstAttempt id) after) : before.attempts id = none := by
  cases step
  assumption

theorem first_attempt_uses_exact_current_claim {before after : EffectLedger} {id : AttemptId}
    (step : EffectStep before (.firstAttempt id) after) :
    ∃ attempt claim,
      after.attempts id = some attempt ∧ before.claims attempt.claim = some claim ∧
      before.currentClaim attempt.invocation attempt.itemIndex = some attempt.claim ∧
      ClaimOwnsAttempt claim attempt ∧ attempt.startedAt.tick < claim.expiresAt.tick := by
  cases step with
  | firstAttempt fresh intent admitted matched ordinal exactClaim latest current =>
      obtain ⟨claim, claimLookup, currentClaim, owns, future⟩ := exactClaim
      exact ⟨_, claim, by simp [EffectLedger.addAttempt], claimLookup, currentClaim, owns, future⟩

theorem retry_attempt_requires_fresh_id {before after : EffectLedger}
    {previous next : AttemptId}
    (step : EffectStep before (.retryAttempt previous next) after) :
    before.attempts next = none := by
  cases step
  assumption

theorem persist_intent_preserves_attempts {before after : EffectLedger}
    {invocation : InvocationId}
    (step : EffectStep before (.persistIntent invocation) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem claim_item_preserves_attempts {before after : EffectLedger}
    {invocation : InvocationId} {index : Nat} {now : Time}
    (step : EffectStep before (.claimItem invocation index now) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem recover_item_claim_preserves_attempts {before after : EffectLedger}
    {invocation : InvocationId} {index : Nat} {now : Time}
    (step : EffectStep before (.recoverItemClaim invocation index now) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem pre_receipt_preserves_attempts {before after : EffectLedger} {receipt : ReceiptId}
    (step : EffectStep before (.preReceipt receipt) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem attempt_receipt_preserves_attempts {before after : EffectLedger} {receipt : ReceiptId}
    (step : EffectStep before (.attemptReceipt receipt) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem supersede_receipt_preserves_attempts {before after : EffectLedger}
    {previous next : ReceiptId}
    (step : EffectStep before (.supersedeReceipt previous next) after) :
    after.attempts = before.attempts := by
  cases step
  rfl

theorem retry_uses_exact_current_claim_and_advances_ordinal {before after : EffectLedger}
    {previous next : AttemptId}
    (step : EffectStep before (.retryAttempt previous next) after) :
    ∃ prior retry claim,
      before.attempts previous = some prior ∧ after.attempts next = some retry ∧
      retry.ordinal = prior.ordinal + 1 ∧
      after.latestAttempt prior.invocation prior.itemIndex = some next ∧
      after.currentReceipt prior.invocation prior.itemIndex = none ∧
      before.claims retry.claim = some claim ∧
      before.currentClaim retry.invocation retry.itemIndex = some retry.claim ∧
      ClaimOwnsAttempt claim retry ∧ retry.startedAt.tick < claim.expiresAt.tick := by
  cases step with
  | retryAttempt fresh priorLookup latest current failed intent admitted matchEvidence sameInvocation sameItem ordinal
      claimLookup currentClaim owns future =>
      refine ⟨_, _, _, priorLookup, ?_, ordinal, ?_, ?_, ?_, ?_, owns, future⟩
      · simp [EffectLedger.addRetryAttempt, EffectLedger.addAttempt]
      · simp [EffectLedger.addRetryAttempt, EffectLedger.addAttempt, sameInvocation, sameItem]
      · simp [EffectLedger.addRetryAttempt, sameInvocation, sameItem]
      · simpa [sameInvocation, sameItem] using claimLookup
      · simpa [sameInvocation, sameItem] using currentClaim

theorem supersession_is_same_attempt_once {before after : EffectLedger}
    {previous next : ReceiptId}
    (step : EffectStep before (.supersedeReceipt previous next) after) :
    ∃ old new : AttemptReceipt,
      before.attemptReceipts previous = some old ∧ old.attempt = new.attempt ∧
      old.outcome = .indeterminate ∧ before.supersededBy previous = none ∧
      after.supersededBy previous = some next ∧ new.outcome.Final := by
  cases step with
  | supersedeAttemptReceipt fresh disjoint oldLookup sameAttempt indeterminate unused previousField final
      attemptLookup current =>
      exact ⟨_, _, oldLookup, sameAttempt, indeterminate, unused, tableSet_self .., final⟩

theorem supersession_at_most_once {ledger after : EffectLedger}
    {previous next newer : ReceiptId}
    (already : ledger.supersededBy previous = some next) :
    ¬ EffectStep ledger (.supersedeReceipt previous newer) after := by
  intro step
  cases step with
  | supersedeAttemptReceipt _ _ _ _ _ unused _ _ _ _ => rw [already] at unused; contradiction

theorem first_attempt_receipt_clears_only_final_claim
    {before after : EffectLedger} {id : ReceiptId}
    (step : EffectStep before (.attemptReceipt id) after) :
    ∃ receipt attempt,
      after.attemptReceipts id = some receipt ∧
      before.attempts receipt.attempt = some attempt ∧
      (receipt.outcome.Final →
        after.currentClaim attempt.invocation attempt.itemIndex = none) ∧
      (receipt.outcome = .indeterminate →
        after.currentClaim attempt.invocation attempt.itemIndex =
          before.currentClaim attempt.invocation attempt.itemIndex) := by
  cases step with
  | firstAttemptReceipt fresh disjoint attemptLookup latest current previous =>
      refine ⟨_, _, by simp [EffectLedger.addAttemptReceipt], attemptLookup, ?_, ?_⟩
      · intro final
        simp only [EffectLedger.addAttemptReceipt]
        split
        · rename_i indeterminate
          simp [AttemptOutcome.Final, indeterminate] at final
        · simp
      · intro indeterminate
        simp [EffectLedger.addAttemptReceipt, indeterminate]

theorem superseding_final_receipt_clears_claim
    {before after : EffectLedger} {previous next : ReceiptId}
    (step : EffectStep before (.supersedeReceipt previous next) after) :
    ∃ receipt attempt,
      after.attemptReceipts next = some receipt ∧
      before.attempts receipt.attempt = some attempt ∧ receipt.outcome.Final ∧
      after.currentClaim attempt.invocation attempt.itemIndex = none := by
  cases step with
  | supersedeAttemptReceipt fresh disjoint old sameAttempt indeterminate unused previousField final
      attemptLookup current =>
      refine ⟨_, _, by simp [EffectLedger.supersedeAttemptReceipt], attemptLookup, final, ?_⟩
      simp only [EffectLedger.supersedeAttemptReceipt]
      split
      · rename_i indeterminateOutcome
        simp [AttemptOutcome.Final, indeterminateOutcome] at final
      · simp

def ReceiptIdsDisjoint (ledger : EffectLedger) : Prop :=
  ∀ id, ledger.preReceipts id = none ∨ ledger.attemptReceipts id = none

theorem effect_step_preserves_receipt_id_disjointness {before after label}
    (disjoint : ReceiptIdsDisjoint before) (step : EffectStep before label after) :
    ReceiptIdsDisjoint after := by
  cases step with
  | persistIntent fresh => exact disjoint
  | claimItem intent item owner ordinal future unclaimed noCurrentClaim => exact disjoint
  | recoverItemClaim lookup current intent previousOwner replacementOwner fresh freshId expired
      invocation index ordinal worker future noAttempt =>
      exact disjoint
  | firstAttempt fresh intent admitted matchEvidence ordinal claim noAttempt noReceipt =>
      simpa [ReceiptIdsDisjoint, EffectLedger.addAttempt] using disjoint
  | retryAttempt fresh prior latest current failed intent admitted matchEvidence invocation index ordinal
      claimLookup currentClaim owns future =>
      simpa [ReceiptIdsDisjoint, EffectLedger.addRetryAttempt, EffectLedger.addAttempt] using disjoint
  | preReceipt fresh otherFresh intent item noAttempt noReceipt =>
      intro id
      simp only [EffectLedger.addPreReceipt, tableSet]
      split <;> simp_all [ReceiptIdsDisjoint]
  | firstAttemptReceipt fresh otherFresh attempt latest current previous =>
      intro id
      simp only [EffectLedger.addAttemptReceipt, tableSet]
      split <;> simp_all [ReceiptIdsDisjoint]
  | supersedeAttemptReceipt fresh otherFresh old sameAttempt indeterminate unused previous final attempt current =>
      intro id
      simp only [EffectLedger.supersedeAttemptReceipt, tableSet]
      split <;> simp_all [ReceiptIdsDisjoint]

theorem pre_receipt_id_cannot_be_reused_for_attempt {ledger after id record}
    (used : ledger.preReceipts id = some record) :
    ¬ EffectStep ledger (.attemptReceipt id) after := by
  intro step
  cases step with
  | firstAttemptReceipt fresh otherFresh attempt latest current previous =>
      rw [used] at otherFresh
      contradiction

theorem claim_records_future_expiry {before after invocation index now}
    (step : EffectStep before (.claimItem invocation index now) after) :
    ∃ claim, after.currentClaim invocation index = some claim.id ∧
      after.claims claim.id = some claim ∧ now.tick < claim.expiresAt.tick := by
  cases step with
  | claimItem intent item owner ordinal future unclaimed noCurrentClaim =>
      exact ⟨_, by simp [EffectLedger.setClaim], by simp [EffectLedger.setClaim], future⟩

theorem claim_uses_exact_prepared_owner {before after invocation index now}
    (step : EffectStep before (.claimItem invocation index now) after) :
    ∃ claim prepared,
      before.invocations invocation = some prepared ∧
      ClaimOwnerMatchesPrepared prepared claim.owner ∧
      after.currentClaim invocation index = some claim.id ∧
      after.claims claim.id = some claim := by
  cases step with
  | claimItem intent item owner ordinal future unclaimed noCurrentClaim =>
      exact ⟨_, _, intent, owner, by simp [EffectLedger.setClaim],
        by simp [EffectLedger.setClaim]⟩

theorem abandoned_claim_recovery_preserves_ordinal_without_attempt
    {before after invocation index now}
    (step : EffectStep before (.recoverItemClaim invocation index now) after) :
    ∃ previous replacement prepared,
      before.currentClaim invocation index = some previous.id ∧
      before.claims previous.id = some previous ∧
      before.invocations invocation = some prepared ∧
      ClaimOwnerMatchesPrepared prepared previous.owner ∧
      ClaimOwnerMatchesPrepared prepared replacement.owner ∧
      after.currentClaim invocation index = some replacement.id ∧
      after.claims replacement.id = some replacement ∧ replacement.id ≠ previous.id ∧
      previous.expiresAt.tick ≤ now.tick ∧ now.tick < replacement.expiresAt.tick ∧
      replacement.ordinal = previous.ordinal ∧
      replacement.owner.worker ≠ previous.owner.worker ∧
      NoEffectAttemptFor before invocation index := by
  cases step with
  | recoverItemClaim lookup current intent previousOwner replacementOwner fresh freshId expired
      sameInvocation sameIndex sameOrdinal newWorker future noAttempt =>
      refine ⟨_, _, _, ?_, lookup, ?_, previousOwner, replacementOwner, ?_, ?_, freshId,
        expired, future, sameOrdinal, newWorker, noAttempt⟩
      · simpa [sameInvocation, sameIndex] using current
      · simpa [sameInvocation] using intent
      · simp [EffectLedger.setClaim, sameInvocation, sameIndex]
      · simp [EffectLedger.setClaim]

theorem mixed_terminal_batch_is_partial {ledger : EffectLedger}
    {prepared : PreparedInvocation}
    (length : prepared.items.length = 2)
    (firstTerminal : ItemCurrentOutcome ledger prepared.header.invocation 0 .succeeded)
    (secondTerminal : ItemCurrentOutcome ledger prepared.header.invocation 1 .failed) :
    BatchTerminalOutcome ledger prepared [.succeeded, .failed] .partiallySucceeded := by
  refine ⟨by simp [length], ?_, rfl, by decide⟩
  intro index outcome lookup
  cases index with
  | zero =>
      simp at lookup
      subst outcome
      exact firstTerminal
  | succ index =>
      cases index with
      | zero =>
          simp at lookup
          subst outcome
          exact secondTerminal
      | succ index => simp at lookup

theorem indeterminate_batch_is_current_not_terminal {ledger : EffectLedger}
    {prepared : PreparedInvocation}
    (length : prepared.items.length = 1)
    (current : ItemCurrentOutcome ledger prepared.header.invocation 0 .indeterminate) :
    BatchCurrentOutcome ledger prepared [.indeterminate] .indeterminate ∧
      ¬ BatchTerminalOutcome ledger prepared [.indeterminate] .indeterminate := by
  constructor
  · refine ⟨by simp [length], ?_, rfl⟩
    intro index outcome lookup
    cases index with
    | zero => simp at lookup; subst outcome; exact current
    | succ index => simp at lookup
  · intro terminal
    exact terminal.2.2.2 rfl

inductive EventKind where | input | invocationCompleted | callback deriving DecidableEq, Repr

structure Event where
  tenant : TenantId
  owner : ActorRef
  kind : EventKind
  key : String
  provenance : Provenance
  assertedTier : Option TrustTier
  leaseToken : Option LeaseToken
  acceptedTier : TrustTier
  deriving DecidableEq, Repr

inductive RouteAuthority where
  | sameTenant (source : AuthoritySource)
  | crossTenant (source : AuthoritySource) (crossTenantBinding : BindingId)
  deriving DecidableEq, Repr

def RouteAuthority.source : RouteAuthority → AuthoritySource
  | .sameTenant source | .crossTenant source _ => source

structure RouteReservation where
  invocation : InvocationId
  sourceOwner : ActorRef
  targetOwner : ActorRef
  targetTurn : Option TurnId
  sourceEvent : EventId
  sourceAudit : AuditId
  authority : RouteAuthority
  projection : ProjectionId
  projectionDigest : StructuralDigest
  deriving DecidableEq, Repr

structure RouteProjection where
  reservation : ReservationId
  targetOwner : ActorRef
  authenticated : Bool
  digest : StructuralValue
  targetLocalCause : Option AuditId
  projectedAt : Time
  deriving DecidableEq, Repr

inductive RouteDeliveryOutcome where | succeeded | failed | cancelled deriving DecidableEq, Repr
structure RouteDelivery where
  reservation : ReservationId
  targetTurn : Option TurnId
  outcome : RouteDeliveryOutcome
  auditCause : AuditId
  deriving DecidableEq, Repr

structure EventStore where
  events : EventId → Option Event
  reservations : ReservationId → Option RouteReservation
  reservationFor : InvocationId → Option ReservationId
  projections : ProjectionId → Option RouteProjection
  projectionFor : ReservationId → Option ProjectionId
  deliveries : ReservationId → Option RouteDelivery

instance : Inhabited EventStore where
  default := ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none,
    fun _ => none, fun _ => none⟩

def HostDerivedTrust (leases : TurnId → Option TurnLease) (now : Time) (event : Event) : Prop :=
  match event.acceptedTier with
  | .self => ∃ token lease, event.leaseToken = some token ∧ leases token.turn = some lease ∧
      lease.Admits token now
  | tier => event.leaseToken = none ∧ tier = deriveChannelTrust event.provenance

inductive EventLabel where
  | publish (event : EventId) | reserve (reservation : ReservationId)
  | project (projection : ProjectionId) | deliver (reservation : ReservationId)
  deriving DecidableEq, Repr

inductive EventStep (leases : TurnId → Option TurnLease) (now : Time) :
    EventStore → EventLabel → EventStore → Prop
  | publish {store id event} :
      store.events id = none → actorTenantOf event.owner = event.tenant →
      event.assertedTier = none → HostDerivedTrust leases now event →
      EventStep leases now store (.publish id) { store with events := tableSet store.events id event }
  | reserveSameTenant {store id reservation event source} :
      store.reservations id = none → store.reservationFor reservation.invocation = none →
      store.events reservation.sourceEvent = some event → event.owner = reservation.sourceOwner →
      reservation.authority = .sameTenant source →
      actorTenantOf reservation.sourceOwner = actorTenantOf reservation.targetOwner →
      EventStep leases now store (.reserve id) {
        store with
        reservations := tableSet store.reservations id reservation
        reservationFor := tableSet store.reservationFor reservation.invocation id
      }
  | reserveCrossTenant {store id reservation event source binding} :
      store.reservations id = none → store.reservationFor reservation.invocation = none →
      store.events reservation.sourceEvent = some event → event.owner = reservation.sourceOwner →
      reservation.authority = .crossTenant source binding →
      actorTenantOf reservation.sourceOwner ≠ actorTenantOf reservation.targetOwner →
      EventStep leases now store (.reserve id) {
        store with
        reservations := tableSet store.reservations id reservation
        reservationFor := tableSet store.reservationFor reservation.invocation id
      }
  | project {store id projection reservation} :
      store.projections id = none → store.reservations projection.reservation = some reservation →
      id = reservation.projection → store.projectionFor projection.reservation = none →
      projection.digest = reservation.projectionDigest →
      projection.targetOwner = reservation.targetOwner → projection.authenticated = true →
      EventStep leases now store (.project id)
        { store with
          projections := tableSet store.projections id projection
          projectionFor := tableSet store.projectionFor projection.reservation id }
  | deliver {store reservationId delivery reservation} :
      store.deliveries reservationId = none → store.reservations reservationId = some reservation →
      delivery.reservation = reservationId → delivery.targetTurn = reservation.targetTurn →
      EventStep leases now store (.deliver reservationId)
        { store with deliveries := tableSet store.deliveries reservationId delivery }

theorem accepted_self_has_live_exact_lease {leases now before after id}
    (step : EventStep leases now before (.publish id) after) :
    ∀ event, after.events id = some event → event.acceptedTier = .self →
      ∃ token lease, event.leaseToken = some token ∧ leases token.turn = some lease ∧
        lease.Admits token now := by
  cases step with
  | publish fresh owner noAssertion trust =>
      intro event lookup self
      change tableSet before.events id _ id = some event at lookup
      rw [tableSet_self] at lookup
      cases Option.some.inj lookup
      unfold HostDerivedTrust at trust
      rw [self] at trust
      exact trust

theorem stale_or_fabricated_token_cannot_self {leases : TurnId → Option TurnLease}
    {now : Time} {event : Event} {token : LeaseToken}
    (tokenField : event.leaseToken = some token)
    (invalid : ∀ lease, leases token.turn = some lease → ¬ lease.Admits token now) :
    ¬ HostDerivedTrust leases now { event with acceptedTier := .self } := by
  intro trust
  unfold HostDerivedTrust at trust
  obtain ⟨actual, lease, field, lookup, admits⟩ := trust
  rw [tokenField] at field
  cases Option.some.inj field
  exact invalid lease lookup admits

theorem published_event_has_no_asserted_tier {leases now before after id}
    (step : EventStep leases now before (.publish id) after) :
    ∃ event, after.events id = some event ∧ event.assertedTier = none := by
  cases step with
  | publish fresh owner noAssertion trust =>
      exact ⟨_, tableSet_self .., noAssertion⟩

theorem asserted_tier_publish_rejected {leases now before after id event tier}
    (stored : after.events id = some event) (asserted : event.assertedTier = some tier) :
    ¬ EventStep leases now before (.publish id) after := by
  intro step
  obtain ⟨published, lookup, noAssertion⟩ := published_event_has_no_asserted_tier step
  rw [stored] at lookup
  cases Option.some.inj lookup
  rw [asserted] at noAssertion
  contradiction

theorem target_projection_is_exact_authenticated_reservation_projection {leases now before after id}
    (step : EventStep leases now before (.project id) after) :
    ∃ projection reservation,
      after.projections id = some projection ∧
      before.reservations projection.reservation = some reservation ∧
      id = reservation.projection ∧ projection.digest = reservation.projectionDigest ∧
      after.projectionFor projection.reservation = some id ∧
      projection.targetOwner = reservation.targetOwner ∧ projection.authenticated = true := by
  cases step with
  | project fresh reservationLookup exactProjection unique exactDigest target authenticated =>
      exact ⟨_, _, tableSet_self .., reservationLookup, exactProjection, exactDigest,
        tableSet_self .., target, authenticated⟩

def RoutesTerminal (store : EventStore) (invocation : InvocationId) : Prop :=
  ∀ reservationId, store.reservationFor invocation = some reservationId →
    ∃ delivery, store.deliveries reservationId = some delivery

end AgentCore
