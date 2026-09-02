import AgentCore.Events

/-!
# Consequences of the existing effect model the controlled language needs

Every theorem here is a consequence of `AgentCore.EffectStep` exactly as it stands: each
is proved by case analysis on one step constructor and reads only premises that
constructor already carries. No definition changes, so no step becomes admissible that was
not, and nothing an existing proof relies on moves.

The four statements are the §7.4 claim and evidence facts the controlled language needs
and the model had not spelled out: the compare-and-set guard on claiming, the ordinal a
claim may take, the attempt evidence an attempt Receipt is written on, and the recorded
shape of a supersession.
-/

namespace AgentCore

/-- **Claiming is a compare-and-set over `(InvocationId, itemIndex)`.** A claim step is
admitted only where the item holds no current claim, which is §7.4's "at most one live
claim" rule read as the precondition the model enforces rather than as a property of a
state. -/
theorem claim_requires_unclaimed_item {before after : EffectLedger}
    {invocation : InvocationId} {index : Nat} {now : Time}
    (step : EffectStep before (.claimItem invocation index now) after) :
    before.currentClaim invocation index = none := by
  cases step with
  | claimItem _ _ _ _ _ _ noCurrentClaim => exact noCurrentClaim

/-- **A claim takes ordinal zero on a never-attempted item, or exactly the ordinal after an
attempt whose current Receipt is a final failure.** This is `ClaimOrdinalAvailable` read
off the claim the step records and restated over the label's own Invocation and item
index: the §7.4 rule that a new ordinal is claimed only after the prior ordinal's `failed`
Receipt. -/
theorem claim_ordinal_is_initial_or_follows_failure {before after : EffectLedger}
    {invocation : InvocationId} {index : Nat} {now : Time}
    (step : EffectStep before (.claimItem invocation index now) after) :
    ∃ claim : ItemClaim, after.currentClaim invocation index = some claim.id ∧
      after.claims claim.id = some claim ∧
      ((claim.ordinal = 0 ∧ before.latestAttempt invocation index = none ∧
          before.currentReceipt invocation index = none) ∨
        ∃ (previous : AttemptId) (prior : EffectAttempt) (receipt : ReceiptId),
          before.latestAttempt invocation index = some previous ∧
          before.attempts previous = some prior ∧
          claim.ordinal = prior.ordinal + 1 ∧
          before.currentReceipt invocation index = some (ItemReceiptRef.attempt receipt) ∧
          AttemptReceiptTerminalFor before previous receipt .failed) := by
  cases step with
  | claimItem _ _ _ ordinal _ _ _ =>
      rcases ordinal with ⟨initial, latest, current⟩ |
        ⟨previous, prior, receipt, latest, attemptLookup, _, _, advance, current, failed⟩
      · exact ⟨_, by simp [EffectLedger.setClaim], by simp [EffectLedger.setClaim],
          .inl ⟨initial, latest, current⟩⟩
      · exact ⟨_, by simp [EffectLedger.setClaim], by simp [EffectLedger.setClaim],
          .inr ⟨previous, prior, receipt, latest, attemptLookup, advance, current, failed⟩⟩

/-- **An attempt Receipt is written on recorded attempt evidence.** The attempt it names is
already in the ledger, it is the item's latest attempt, and the item holds no current
Receipt yet. This is the recorded half of §7.4's write-ahead rule: the model has no effect
boundary, so what it can state is that the Receipt cannot exist without the attempt
record. -/
theorem attempt_receipt_requires_recorded_latest_attempt {before after : EffectLedger}
    {id : ReceiptId} (step : EffectStep before (.attemptReceipt id) after) :
    ∃ (record : AttemptReceipt) (attempt : EffectAttempt),
      after.attemptReceipts id = some record ∧
      before.attempts record.attempt = some attempt ∧
      before.latestAttempt attempt.invocation attempt.itemIndex = some record.attempt ∧
      before.currentReceipt attempt.invocation attempt.itemIndex = none := by
  cases step with
  | firstAttemptReceipt _ _ attemptLookup latest current _ =>
      exact ⟨_, _, by simp [EffectLedger.addAttemptReceipt], attemptLookup, latest, current⟩

/-- **A supersession records a same-attempt final Receipt over its indeterminate
predecessor.** The post-state holds both records: the predecessor is still the
`indeterminate` Receipt it was, the successor names the same attempt, is final, points back
at the predecessor, and the predecessor is indexed as superseded by it. Supersession writes
only the successor, so reading both off the post-state loses nothing; that a predecessor is
superseded at most once is the separate precondition
`AgentCore.supersession_at_most_once` rests on. -/
theorem superseding_receipt_is_recorded_same_attempt_final {before after : EffectLedger}
    {previous next : ReceiptId}
    (step : EffectStep before (.supersedeReceipt previous next) after) :
    ∃ old new : AttemptReceipt,
      after.attemptReceipts previous = some old ∧
      old.outcome = AttemptOutcome.indeterminate ∧
      after.attemptReceipts next = some new ∧ new.attempt = old.attempt ∧
      new.outcome.Final ∧ new.previous = some previous ∧
      after.supersededBy previous = some next := by
  cases step with
  | supersedeAttemptReceipt fresh _ oldLookup sameAttempt indeterminate _ previousField final _ _ =>
      have distinct : previous ≠ next := by
        intro same
        rw [same, fresh] at oldLookup
        contradiction
      refine ⟨_, _, ?_, indeterminate, tableSet_self .., sameAttempt.symm, final, previousField,
        tableSet_self ..⟩
      exact Eq.trans (tableSet_other _ _ _ distinct _) oldLookup

end AgentCore
