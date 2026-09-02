import SpecCnl.Grammar
import SpecCnl.Parse

/-!
# Claims: the §7.4 vocabulary of item claims, ordinals, and effect evidence

Five label families of one ledger — `AgentCore.EffectLedger` — with the lifters that scope
a condition under each one and the payload conditions themselves. The ledger already has
`every.effect.step`, `attempt.immutability`, and `disjoint.receipt.ids` in the base
lexicon; those are reused unchanged and nothing here re-declares them.

Entry ids are the surface with spaces replaced by dots, prefixed into the claims
namespace (`claim.`, `every.claim`, `for.the.claim`), because a second group is authoring
over this same ledger concurrently and the lexicon refuses a duplicate id or a duplicate
(surface, category) pair.

Two lifters here are worth reading before the conditions:

* `for.the.claimed.item` and `for.the.claim.recovery` key a payload-indexed postcondition
  on the whole triple a claim label carries, so the condition can compare a recorded
  claim's expiry against the time the label states.
* `for.the.claim.receipt.supersession` applies its state-relative relation to the
  **post**-state. A supersession writes only the successor Receipt, so the predecessor's
  record is unchanged there and both Receipts are readable off one state; the one-time half
  of the rule is a precondition and is carried by a separate clause.
-/

namespace SpecCnl.Entries.Claims

/-- The payload a claim label carries: the Invocation, the item index, and the stated time.
Category type arguments are single identifiers, so the triple that
`AgentCore.EffectLabel.claimItem` and `AgentCore.EffectLabel.recoverItemClaim` carry needs
a name. This is the same lexicon bookkeeping as `SpecCnl.CommitTable`, not model content:
it introduces no constant a denotation reads. -/
abbrev ClaimSite := AgentCore.InvocationId × Nat × AgentCore.Time

def entries : List LexEntry :=
    -- §7.4 the initial claim: the compare-and-set guard, the recorded expiry, the owner
  [ { id := "every.claim.step"
      surface := "every claim step"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ invocation index now, " ++
        "label = AgentCore.EffectLabel.claimItem invocation index now) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.claim"
      surface := "for the claim"
      category :=
        "RE[AgentCore.EffectLedger,AgentCore.InvocationId,Nat]" ++
        "\\ST[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label => ∀ invocation index now, " ++
        "label = AgentCore.EffectLabel.claimItem invocation index now → " ++
        "cond before invocation index" },
    { id := "claim.an.unclaimed.item"
      surface := "an unclaimed item"
      category := "RE[AgentCore.EffectLedger,AgentCore.InvocationId,Nat]"
      denotation :=
        "fun ledger invocation index => " ++
        "AgentCore.EffectLedger.currentClaim ledger invocation index = none" },
    { id := "for.the.claimed.item"
      surface := "for the claimed item"
      category :=
        "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label after => ∀ invocation index now, " ++
        "label = AgentCore.EffectLabel.claimItem invocation index now → " ++
        "cond before (invocation, index, now) after" },
    { id := "claim.a.future.claim.expiry"
      surface := "a future claim expiry"
      category := "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]"
      denotation :=
        "fun _ site after => ∃ claim, " ++
        "AgentCore.EffectLedger.currentClaim after site.1 site.2.1 = " ++
        "some (AgentCore.ItemClaim.id claim) ∧ " ++
        "AgentCore.EffectLedger.claims after (AgentCore.ItemClaim.id claim) = some claim ∧ " ++
        "AgentCore.Time.tick site.2.2 < " ++
        "AgentCore.Time.tick (AgentCore.ItemClaim.expiresAt claim)" },
    { id := "claim.an.exact.prepared.owner"
      surface := "an exact prepared owner"
      category := "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]"
      denotation :=
        "fun before site after => ∃ claim prepared, " ++
        "AgentCore.EffectLedger.invocations before site.1 = some prepared ∧ " ++
        "AgentCore.ClaimOwnerMatchesPrepared prepared (AgentCore.ItemClaim.owner claim) ∧ " ++
        "AgentCore.EffectLedger.currentClaim after site.1 site.2.1 = " ++
        "some (AgentCore.ItemClaim.id claim) ∧ " ++
        "AgentCore.EffectLedger.claims after (AgentCore.ItemClaim.id claim) = some claim" },
    -- §7.4 abandoned-claim recovery
    { id := "every.claim.recovery"
      surface := "every claim recovery"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ invocation index now, " ++
        "label = AgentCore.EffectLabel.recoverItemClaim invocation index now) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.claim.recovery"
      surface := "for the claim recovery"
      category :=
        "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label after => ∀ invocation index now, " ++
        "label = AgentCore.EffectLabel.recoverItemClaim invocation index now → " ++
        "cond before (invocation, index, now) after" },
    { id := "claim.a.recovered.claim"
      surface := "a recovered claim"
      category := "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]"
      denotation :=
        "fun before site after => ∃ previous replacement prepared, " ++
        "AgentCore.EffectLedger.currentClaim before site.1 site.2.1 = " ++
        "some (AgentCore.ItemClaim.id previous) ∧ " ++
        "AgentCore.EffectLedger.claims before (AgentCore.ItemClaim.id previous) = " ++
        "some previous ∧ " ++
        "AgentCore.EffectLedger.invocations before site.1 = some prepared ∧ " ++
        "AgentCore.ClaimOwnerMatchesPrepared prepared " ++
        "(AgentCore.ItemClaim.owner previous) ∧ " ++
        "AgentCore.ClaimOwnerMatchesPrepared prepared " ++
        "(AgentCore.ItemClaim.owner replacement) ∧ " ++
        "AgentCore.EffectLedger.currentClaim after site.1 site.2.1 = " ++
        "some (AgentCore.ItemClaim.id replacement) ∧ " ++
        "AgentCore.EffectLedger.claims after (AgentCore.ItemClaim.id replacement) = " ++
        "some replacement ∧ " ++
        "AgentCore.ItemClaim.id replacement ≠ AgentCore.ItemClaim.id previous ∧ " ++
        "AgentCore.Time.tick (AgentCore.ItemClaim.expiresAt previous) ≤ " ++
        "AgentCore.Time.tick site.2.2 ∧ " ++
        "AgentCore.Time.tick site.2.2 < " ++
        "AgentCore.Time.tick (AgentCore.ItemClaim.expiresAt replacement) ∧ " ++
        "AgentCore.ItemClaim.ordinal replacement = AgentCore.ItemClaim.ordinal previous ∧ " ++
        "AgentCore.ItemClaimOwner.worker (AgentCore.ItemClaim.owner replacement) ≠ " ++
        "AgentCore.ItemClaimOwner.worker (AgentCore.ItemClaim.owner previous) ∧ " ++
        "AgentCore.NoEffectAttemptFor before site.1 site.2.1 " ++
        "(AgentCore.ItemClaim.ordinal previous)" },
    -- §7.4 the ordinal a claim may take, and the retry that appends its attempt
    { id := "claim.an.advanced.failed.ordinal"
      surface := "an advanced failed ordinal"
      category := "PX[AgentCore.EffectLedger,SpecCnl.Entries.Claims.ClaimSite]"
      denotation :=
        "fun before site after => ∃ claim, " ++
        "AgentCore.EffectLedger.currentClaim after site.1 site.2.1 = " ++
        "some (AgentCore.ItemClaim.id claim) ∧ " ++
        "AgentCore.EffectLedger.claims after (AgentCore.ItemClaim.id claim) = some claim ∧ " ++
        "((AgentCore.ItemClaim.ordinal claim = 0 ∧ " ++
        "AgentCore.EffectLedger.latestAttempt before site.1 site.2.1 = none ∧ " ++
        "AgentCore.EffectLedger.currentReceipt before site.1 site.2.1 = none) ∨ " ++
        "∃ previous prior receipt, " ++
        "AgentCore.EffectLedger.latestAttempt before site.1 site.2.1 = some previous ∧ " ++
        "AgentCore.EffectLedger.attempts before previous = some prior ∧ " ++
        "AgentCore.ItemClaim.ordinal claim = AgentCore.EffectAttempt.ordinal prior + 1 ∧ " ++
        "AgentCore.EffectLedger.currentReceipt before site.1 site.2.1 = " ++
        "some (AgentCore.ItemReceiptRef.attempt receipt) ∧ " ++
        "AgentCore.AttemptReceiptTerminalFor before previous receipt " ++
        "AgentCore.AttemptOutcome.failed)" },
    { id := "every.claim.retry"
      surface := "every claim retry"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ previous next, label = AgentCore.EffectLabel.retryAttempt previous next) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.claim.retry"
      surface := "for the claim retry"
      category :=
        "ST[AgentCore.EffectLedger,AgentCore.AttemptId]" ++
        "\\ST[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label => ∀ previous next, " ++
        "label = AgentCore.EffectLabel.retryAttempt previous next → cond before previous" },
    { id := "claim.a.prior.failed.receipt"
      surface := "a prior failed receipt"
      category := "ST[AgentCore.EffectLedger,AgentCore.AttemptId]"
      denotation :=
        "fun ledger previous => ∃ prior receipt, " ++
        "AgentCore.EffectLedger.attempts ledger previous = some prior ∧ " ++
        "AgentCore.AttemptReceiptTerminalFor ledger previous receipt " ++
        "AgentCore.AttemptOutcome.failed" },
    -- §7.4 recorded effect evidence: the attempt a Receipt is written on, and supersession
    { id := "every.claim.attempt.receipt"
      surface := "every attempt receipt"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ receipt, label = AgentCore.EffectLabel.attemptReceipt receipt) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.claim.attempt.receipt"
      surface := "for the attempt receipt"
      category :=
        "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label after => ∀ receipt, " ++
        "label = AgentCore.EffectLabel.attemptReceipt receipt → cond before receipt after" },
    { id := "claim.a.recorded.prior.attempt"
      surface := "a recorded prior attempt"
      category := "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]"
      denotation :=
        "fun before id after => ∃ record attempt, " ++
        "AgentCore.EffectLedger.attemptReceipts after id = some record ∧ " ++
        "AgentCore.EffectLedger.attempts before " ++
        "(AgentCore.AttemptReceipt.attempt record) = some attempt ∧ " ++
        "AgentCore.EffectLedger.latestAttempt before " ++
        "(AgentCore.EffectAttempt.invocation attempt) " ++
        "(AgentCore.EffectAttempt.itemIndex attempt) = " ++
        "some (AgentCore.AttemptReceipt.attempt record) ∧ " ++
        "AgentCore.EffectLedger.currentReceipt before " ++
        "(AgentCore.EffectAttempt.invocation attempt) " ++
        "(AgentCore.EffectAttempt.itemIndex attempt) = none" },
    { id := "every.claim.receipt.supersession"
      surface := "every receipt supersession"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ previous next, " ++
        "label = AgentCore.EffectLabel.supersedeReceipt previous next) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.claim.superseded.receipt"
      surface := "for the superseded receipt"
      category :=
        "ST[AgentCore.EffectLedger,AgentCore.ReceiptId]" ++
        "\\ST[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label => ∀ previous next, " ++
        "label = AgentCore.EffectLabel.supersedeReceipt previous next → " ++
        "cond before previous" },
    { id := "claim.an.unsuperseded.indeterminate.receipt"
      surface := "an unsuperseded indeterminate receipt"
      category := "ST[AgentCore.EffectLedger,AgentCore.ReceiptId]"
      denotation :=
        "fun ledger previous => ∃ old, " ++
        "AgentCore.EffectLedger.attemptReceipts ledger previous = some old ∧ " ++
        "AgentCore.AttemptReceipt.outcome old = " ++
        "AgentCore.AttemptOutcome.indeterminate ∧ " ++
        "AgentCore.EffectLedger.supersededBy ledger previous = none" },
    { id := "for.the.claim.receipt.supersession"
      surface := "for the receipt supersession"
      category :=
        "RE[AgentCore.EffectLedger,AgentCore.ReceiptId,AgentCore.ReceiptId]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond _ label after => ∀ previous next, " ++
        "label = AgentCore.EffectLabel.supersedeReceipt previous next → " ++
        "cond after previous next" },
    { id := "claim.a.same.attempt.final.receipt"
      surface := "a same attempt final receipt"
      category := "RE[AgentCore.EffectLedger,AgentCore.ReceiptId,AgentCore.ReceiptId]"
      denotation :=
        "fun ledger previous next => ∃ old new, " ++
        "AgentCore.EffectLedger.attemptReceipts ledger previous = some old ∧ " ++
        "AgentCore.AttemptReceipt.outcome old = " ++
        "AgentCore.AttemptOutcome.indeterminate ∧ " ++
        "AgentCore.EffectLedger.attemptReceipts ledger next = some new ∧ " ++
        "AgentCore.AttemptReceipt.attempt new = AgentCore.AttemptReceipt.attempt old ∧ " ++
        "AgentCore.AttemptOutcome.Final (AgentCore.AttemptReceipt.outcome new) ∧ " ++
        "AgentCore.AttemptReceipt.previous new = some previous ∧ " ++
        "AgentCore.EffectLedger.supersededBy ledger previous = some next" } ]

end SpecCnl.Entries.Claims
