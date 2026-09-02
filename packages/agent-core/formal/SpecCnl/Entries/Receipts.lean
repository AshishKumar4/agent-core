import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Vocabulary for §7.4 Receipt lineage, batch outcomes, and audit exclusions

Three paradigms.

* **The effect ledger** already contributes `every effect step`, `attempt immutability`,
  and `disjoint receipt ids`. This section adds the three label-restricted families §7.4
  distinguishes — a pre-effect Receipt, the first record of an attempt chain, and a
  supersession — with one lifter per label constructor and the conditions themselves.
* **The derived batch outcome** is a state-relative relation from a prepared Invocation to
  an aggregate. The item-outcome list `AgentCore.BatchCurrentOutcome` also takes is bound
  existentially in the denotation, because it is determined by the ledger and the
  Invocation: see `AgentCore.item_current_outcome_is_unique`.
* **Audit kinds** are related by `AgentCore.MayCause`, which is a relation on kinds alone.
  It is reachable as a transitive verb between two individuals, so the object determiners
  the grammar already has express which kinds are refused as the cause of a Receipt record.

Entry ids are prefixed so that they cannot collide with the concurrently authored
claims-side vocabulary over the same ledger, which owns the `claim` prefixes.
-/

namespace SpecCnl.Entries.Receipts

def entries : List LexEntry :=
  [ /- ## Receipt lineage over the effect ledger -/
    { id := "receipt.recorded.receipt.immutability"
      surface := "recorded receipt immutability"
      category := "PR[AgentCore.EffectLedger]"
      denotation :=
        "fun before after => " ++
        "(∀ id receipt, AgentCore.EffectLedger.attemptReceipts before id = some receipt → " ++
        "AgentCore.EffectLedger.attemptReceipts after id = some receipt) ∧ " ++
        "(∀ id receipt, AgentCore.EffectLedger.preReceipts before id = some receipt → " ++
        "AgentCore.EffectLedger.preReceipts after id = some receipt)" },
    { id := "every.receipt.chain.supersession"
      surface := "every receipt chain supersession"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ previous next, label = AgentCore.EffectLabel.supersedeReceipt previous next) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.receipt.prior"
      surface := "for the prior receipt"
      category :=
        "ST[AgentCore.EffectLedger,AgentCore.ReceiptId]" ++
        "\\ST[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label => ∀ previous next, " ++
        "label = AgentCore.EffectLabel.supersedeReceipt previous next → cond before previous" },
    { id := "receipt.an.indeterminate.chain.head"
      surface := "an indeterminate chain head"
      category := "ST[AgentCore.EffectLedger,AgentCore.ReceiptId]"
      denotation :=
        "fun ledger id => ∃ record, " ++
        "AgentCore.EffectLedger.attemptReceipts ledger id = some record ∧ " ++
        "AgentCore.AttemptReceipt.outcome record = AgentCore.AttemptOutcome.indeterminate ∧ " ++
        "AgentCore.EffectLedger.supersededBy ledger id = none" },
    { id := "every.receipt.pre.effect"
      surface := "every pre effect receipt"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id, label = AgentCore.EffectLabel.preReceipt id) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.receipt.recorded.receipt"
      surface := "for the recorded receipt"
      category :=
        "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.EffectLabel.preReceipt id → cond before id after" },
    { id := "receipt.an.item.without.a.recorded.attempt"
      surface := "an item without a recorded attempt"
      category := "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]"
      denotation :=
        "fun _ id after => ∃ receipt, " ++
        "AgentCore.EffectLedger.preReceipts after id = some receipt ∧ " ++
        "AgentCore.EffectLedger.latestAttempt after " ++
        "(AgentCore.PreEffectReceipt.invocation receipt) " ++
        "(AgentCore.PreEffectReceipt.itemIndex receipt) = none" },
    { id := "every.receipt.first.attempt"
      surface := "every first attempt receipt"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id, label = AgentCore.EffectLabel.attemptReceipt id) ∧ " ++
        "AgentCore.EffectStep before label after" },
    { id := "for.the.receipt.recorded.attempt.receipt"
      surface := "for the recorded attempt receipt"
      category :=
        "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]" ++
        "\\PO[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.EffectLabel.attemptReceipt id → cond before id after" },
    { id := "receipt.an.existing.attempt"
      surface := "an existing attempt"
      category := "PX[AgentCore.EffectLedger,AgentCore.ReceiptId]"
      denotation :=
        "fun _ id after => ∃ receipt attempt, " ++
        "AgentCore.EffectLedger.attemptReceipts after id = some receipt ∧ " ++
        "AgentCore.EffectLedger.attempts after " ++
        "(AgentCore.AttemptReceipt.attempt receipt) = some attempt" },
    /- ## Derived batch outcomes -/
    { id := "receipt.the.derived.batch.outcome"
      surface := "the derived batch outcome"
      category :=
        "RE[AgentCore.EffectLedger,AgentCore.PreparedInvocation,AgentCore.BatchOutcome]"
      denotation :=
        "fun ledger prepared aggregate => ∃ outcomes, " ++
        "AgentCore.BatchCurrentOutcome ledger prepared outcomes aggregate" },
    { id := "receipt.the.terminal.batch.outcome"
      surface := "the terminal batch outcome"
      category :=
        "RE[AgentCore.EffectLedger,AgentCore.PreparedInvocation,AgentCore.BatchOutcome]"
      denotation :=
        "fun ledger prepared aggregate => ∃ outcomes, " ++
        "AgentCore.BatchTerminalOutcome ledger prepared outcomes aggregate" },
    /- ## The cross-Actor bridge root in the audit log -/
    { id := "receipt.every.route.projection.bridge"
      surface := "every route projection bridge"
      category := "TR[AgentCore.AuditLog,AgentCore.AuditLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id projection, label = AgentCore.AuditLabel.projectBridge id projection) ∧ " ++
        "∃ effects events, AgentCore.AuditStep effects events before label after" },
    { id := "receipt.for.the.bridge.entry"
      surface := "for the bridge entry"
      category :=
        "PX[AgentCore.AuditLog,AgentCore.AuditId]" ++
        "\\PO[AgentCore.AuditLog,AgentCore.AuditLabel]"
      denotation :=
        "fun cond before label after => ∀ id projection, " ++
        "label = AgentCore.AuditLabel.projectBridge id projection → cond before id after" },
    { id := "receipt.a.fresh.cause.free.bridge.root"
      surface := "a fresh cause free bridge root"
      category := "PX[AgentCore.AuditLog,AgentCore.AuditId]"
      denotation :=
        "fun before id after => " ++
        "AgentCore.AuditLog.entries before id = none ∧ " ++
        "∃ entry, AgentCore.AuditLog.entries after id = some entry ∧ " ++
        "AgentCore.AuditEntry.cause entry = none ∧ " ++
        "∃ projection reservation invocation, AgentCore.AuditEntry.kind entry = " ++
        "AgentCore.AuditKind.routeProjected projection reservation invocation" },
    /- ## Which audit kinds may cause a Receipt record -/
    { id := "receipt.causes"
      surface := "causes"
      category := "(NP[AgentCore.AuditKind]\\S)/NP[AgentCore.AuditKind]"
      denotation := "fun child parent => AgentCore.MayCause parent child" },
    { id := "receipt.non.attempt.audit.kind"
      surface := "non attempt audit kind"
      category := "CN[AgentCore.AuditKind]"
      denotation :=
        "fun kind => ∀ attempt invocation, " ++
        "kind ≠ AgentCore.AuditKind.attempt attempt invocation" },
    { id := "receipt.attempted.outcome.kind"
      surface := "attempted outcome kind"
      category := "CN[AgentCore.AuditKind]"
      denotation :=
        "fun kind => ∃ receipt attempt invocation outcome, " ++
        "kind = AgentCore.AuditKind.attemptReceipt receipt attempt invocation outcome" },
    { id := "receipt.non.indeterminate.audit.kind"
      surface := "non indeterminate audit kind"
      category := "CN[AgentCore.AuditKind]"
      denotation :=
        "fun kind => ∀ receipt attempt invocation, " ++
        "kind ≠ AgentCore.AuditKind.attemptReceipt receipt attempt invocation " ++
        "AgentCore.AttemptOutcome.indeterminate" },
    { id := "receipt.receipt.supersession.kind"
      surface := "receipt supersession kind"
      category := "CN[AgentCore.AuditKind]"
      denotation :=
        "fun kind => ∃ previous next attempt invocation, " ++
        "kind = AgentCore.AuditKind.receiptSuperseded previous next attempt invocation" } ]

end SpecCnl.Entries.Receipts
