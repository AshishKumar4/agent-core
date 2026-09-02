import SpecCnl.Sentences.Claims

/-!
# Hand propositions and bridges for the §7.4 claims group

Each `hand_X` is written directly over `AgentCore` from the rule unit; each `bridge_X`
is the kernel-checked equivalence with the grammar's composition. Every bridge here is
`Iff.rfl`: the composition of the lexicon denotations is definitionally the hand
statement, including the payload triple a claim label carries, which the lifter passes as
a tuple and the condition projects back out.

A bridge says nothing about whether the sentence means what the SPEC prose means. What
makes these load-bearing is `SpecCnl.Proofs.proved_X`, which proves each hand statement is
true of the model.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §7.4 `C13-CLAIM-INITIAL-ATOMIC`, `C13-CLAIM-FUTURE-EXPIRY` -/

def hand_C13_CLAIM_INITIAL_ATOMIC : Prop :=
  ((∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ invocation index now, label = EffectLabel.claimItem invocation index now) ∧
        EffectStep before label after) →
      ∀ invocation index now, label = EffectLabel.claimItem invocation index now →
        before.currentClaim invocation index = none) ∧
    ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ invocation index now, label = EffectLabel.claimItem invocation index now) ∧
        EffectStep before label after) →
      ∀ invocation index now, label = EffectLabel.claimItem invocation index now →
        ∃ claim : ItemClaim, after.currentClaim invocation index = some claim.id ∧
          after.claims claim.id = some claim ∧ now.tick < claim.expiresAt.tick) ∧
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    ((∃ invocation index now, label = EffectLabel.claimItem invocation index now) ∧
      EffectStep before label after) →
    ∀ invocation index now, label = EffectLabel.claimItem invocation index now →
      ∃ (claim : ItemClaim) (prepared : PreparedInvocation),
        before.invocations invocation = some prepared ∧
        ClaimOwnerMatchesPrepared prepared claim.owner ∧
        after.currentClaim invocation index = some claim.id ∧
        after.claims claim.id = some claim

theorem bridge_C13_CLAIM_INITIAL_ATOMIC :
    Sentences.cnl_C13_CLAIM_INITIAL_ATOMIC ↔ hand_C13_CLAIM_INITIAL_ATOMIC := Iff.rfl

/-! ## §7.4 `C13-CLAIM-RECOVERY-NO-ATTEMPT`, `C13-CLAIM-RECOVERY-NEW-OWNER`,
`C13-CLAIM-RECOVERY-FUTURE-EXPIRY`, `C13-CLAIM-RECOVERY-SAME-ORDINAL` -/

def hand_C13_CLAIM_RECOVERY_NO_ATTEMPT : Prop :=
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    ((∃ invocation index now, label = EffectLabel.recoverItemClaim invocation index now) ∧
      EffectStep before label after) →
    ∀ invocation index now, label = EffectLabel.recoverItemClaim invocation index now →
      ∃ (previous replacement : ItemClaim) (prepared : PreparedInvocation),
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
        NoEffectAttemptFor before invocation index previous.ordinal

theorem bridge_C13_CLAIM_RECOVERY_NO_ATTEMPT :
    Sentences.cnl_C13_CLAIM_RECOVERY_NO_ATTEMPT ↔
      hand_C13_CLAIM_RECOVERY_NO_ATTEMPT := Iff.rfl

/-! ## §7.4 `C13-ATTEMPT-ORDINAL-AFTER-FAILURE` -/

def hand_C13_ATTEMPT_ORDINAL_AFTER_FAILURE : Prop :=
  (∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ invocation index now, label = EffectLabel.claimItem invocation index now) ∧
        EffectStep before label after) →
      ∀ invocation index now, label = EffectLabel.claimItem invocation index now →
        ∃ claim : ItemClaim, after.currentClaim invocation index = some claim.id ∧
          after.claims claim.id = some claim ∧
          ((claim.ordinal = 0 ∧ before.latestAttempt invocation index = none ∧
              before.currentReceipt invocation index = none) ∨
            ∃ (previous : AttemptId) (prior : EffectAttempt) (receipt : ReceiptId),
              before.latestAttempt invocation index = some previous ∧
              before.attempts previous = some prior ∧
              claim.ordinal = prior.ordinal + 1 ∧
              before.currentReceipt invocation index =
                some (ItemReceiptRef.attempt receipt) ∧
              AttemptReceiptTerminalFor before previous receipt AttemptOutcome.failed)) ∧
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    ((∃ previous next, label = EffectLabel.retryAttempt previous next) ∧
      EffectStep before label after) →
    ∀ previous next, label = EffectLabel.retryAttempt previous next →
      ∃ (prior : EffectAttempt) (receipt : ReceiptId),
        before.attempts previous = some prior ∧
        AttemptReceiptTerminalFor before previous receipt AttemptOutcome.failed

theorem bridge_C13_ATTEMPT_ORDINAL_AFTER_FAILURE :
    Sentences.cnl_C13_ATTEMPT_ORDINAL_AFTER_FAILURE ↔
      hand_C13_ATTEMPT_ORDINAL_AFTER_FAILURE := Iff.rfl

/-! ## §7.4 `C13-EFFECT-WRITE-AHEAD`, `C13-EFFECT-SUPERSEDING-RECEIPT` -/

def hand_C13_EFFECT_WRITE_AHEAD : Prop :=
  ((∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ receipt, label = EffectLabel.attemptReceipt receipt) ∧
        EffectStep before label after) →
      ∀ receipt, label = EffectLabel.attemptReceipt receipt →
        ∃ (record : AttemptReceipt) (attempt : EffectAttempt),
          after.attemptReceipts receipt = some record ∧
          before.attempts record.attempt = some attempt ∧
          before.latestAttempt attempt.invocation attempt.itemIndex = some record.attempt ∧
          before.currentReceipt attempt.invocation attempt.itemIndex = none) ∧
    ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ previous next, label = EffectLabel.supersedeReceipt previous next) ∧
        EffectStep before label after) →
      ∀ previous next, label = EffectLabel.supersedeReceipt previous next →
        ∃ old : AttemptReceipt, before.attemptReceipts previous = some old ∧
          old.outcome = AttemptOutcome.indeterminate ∧
          before.supersededBy previous = none) ∧
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    ((∃ previous next, label = EffectLabel.supersedeReceipt previous next) ∧
      EffectStep before label after) →
    ∀ previous next, label = EffectLabel.supersedeReceipt previous next →
      ∃ old new : AttemptReceipt, after.attemptReceipts previous = some old ∧
        old.outcome = AttemptOutcome.indeterminate ∧
        after.attemptReceipts next = some new ∧ new.attempt = old.attempt ∧
        new.outcome.Final ∧ new.previous = some previous ∧
        after.supersededBy previous = some next

theorem bridge_C13_EFFECT_WRITE_AHEAD :
    Sentences.cnl_C13_EFFECT_WRITE_AHEAD ↔ hand_C13_EFFECT_WRITE_AHEAD := Iff.rfl

end SpecCnl.Bridge
