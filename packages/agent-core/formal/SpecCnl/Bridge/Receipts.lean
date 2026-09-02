import SpecCnl.Sentences.Receipts

/-!
# Hand propositions and bridges for the §7.4 Receipts group

Each `hand_X` is written directly over `AgentCore` from its rule unit, and each `bridge_X`
is the kernel-checked equivalence to the grammar's composition. What makes them worth
anything is `SpecCnl.Proofs.proved_X`, which shows the hand proposition is true of the
model.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §7.4 `C13-RECEIPT-IMMUTABLE` -/

def hand_C13_RECEIPT_IMMUTABLE : Prop :=
  (∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      EffectStep before label after →
        (∀ id receipt, before.attemptReceipts id = some receipt →
            after.attemptReceipts id = some receipt) ∧
          ∀ id receipt, before.preReceipts id = some receipt →
            after.preReceipts id = some receipt) ∧
    ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ previous next, label = EffectLabel.supersedeReceipt previous next) ∧
        EffectStep before label after) →
      ∀ previous next, label = EffectLabel.supersedeReceipt previous next →
        ∃ record, before.attemptReceipts previous = some record ∧
          record.outcome = AttemptOutcome.indeterminate ∧
          before.supersededBy previous = none

theorem bridge_C13_RECEIPT_IMMUTABLE :
    Sentences.cnl_C13_RECEIPT_IMMUTABLE ↔ hand_C13_RECEIPT_IMMUTABLE := Iff.rfl

/-! ## §7.4 `C13-RECEIPT-FAILURE-ORTHOGONAL` -/

def hand_C13_RECEIPT_FAILURE_ORTHOGONAL : Prop :=
  (∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ id, label = EffectLabel.preReceipt id) ∧ EffectStep before label after) →
      ∀ id, label = EffectLabel.preReceipt id →
        ∃ receipt, after.preReceipts id = some receipt ∧
          after.latestAttempt receipt.invocation receipt.itemIndex = none) ∧
    ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
      ((∃ id, label = EffectLabel.attemptReceipt id) ∧ EffectStep before label after) →
      ∀ id, label = EffectLabel.attemptReceipt id →
        ∃ receipt attempt, after.attemptReceipts id = some receipt ∧
          after.attempts receipt.attempt = some attempt

theorem bridge_C13_RECEIPT_FAILURE_ORTHOGONAL :
    Sentences.cnl_C13_RECEIPT_FAILURE_ORTHOGONAL ↔
      hand_C13_RECEIPT_FAILURE_ORTHOGONAL := Iff.rfl

/-! ## §7.4 `C13-BATCH-OUTCOME-COMPLETE`, `C13-BATCH-OUTCOME-TERMINAL` -/

def hand_C13_BATCH_OUTCOME_COMPLETE : Prop :=
  (∀ (ledger : EffectLedger) (prepared : PreparedInvocation) (left right : BatchOutcome),
      (∃ outcomes, BatchCurrentOutcome ledger prepared outcomes left) →
      (∃ outcomes, BatchCurrentOutcome ledger prepared outcomes right) → left = right) ∧
    ∀ (ledger : EffectLedger) (prepared : PreparedInvocation) (left right : BatchOutcome),
      (∃ outcomes, BatchTerminalOutcome ledger prepared outcomes left) →
      (∃ outcomes, BatchTerminalOutcome ledger prepared outcomes right) → left = right

theorem bridge_C13_BATCH_OUTCOME_COMPLETE :
    Sentences.cnl_C13_BATCH_OUTCOME_COMPLETE ↔ hand_C13_BATCH_OUTCOME_COMPLETE := Iff.rfl

/-! ## §7.4 `C13-AUDIT-ROUTE-BRIDGE` -/

def hand_C13_AUDIT_ROUTE_BRIDGE : Prop :=
  ∀ (before : AuditLog) (label : AuditLabel) (after : AuditLog),
    ((∃ id projection, label = AuditLabel.projectBridge id projection) ∧
      ∃ effects events, AuditStep effects events before label after) →
    ∀ id projection, label = AuditLabel.projectBridge id projection →
      before.entries id = none ∧
        ∃ entry, after.entries id = some entry ∧ entry.cause = none ∧
          ∃ bridged reservation invocation,
            entry.kind = AuditKind.routeProjected bridged reservation invocation

theorem bridge_C13_AUDIT_ROUTE_BRIDGE :
    Sentences.cnl_C13_AUDIT_ROUTE_BRIDGE ↔ hand_C13_AUDIT_ROUTE_BRIDGE := Iff.rfl

/-! ## §7.4 `C13-AUDIT-TELEMETRY-EXCLUDED` -/

def hand_C13_AUDIT_TELEMETRY_EXCLUDED : Prop :=
  (∀ (parent : AuditKind),
      (∀ attempt invocation, parent ≠ AuditKind.attempt attempt invocation) →
      ∀ (child : AuditKind),
        (∃ receipt attempt invocation outcome,
          child = AuditKind.attemptReceipt receipt attempt invocation outcome) →
        ¬ MayCause parent child) ∧
    ∀ (parent : AuditKind),
      (∀ receipt attempt invocation,
        parent ≠ AuditKind.attemptReceipt receipt attempt invocation
          AttemptOutcome.indeterminate) →
      ∀ (child : AuditKind),
        (∃ previous next attempt invocation,
          child = AuditKind.receiptSuperseded previous next attempt invocation) →
        ¬ MayCause parent child

theorem bridge_C13_AUDIT_TELEMETRY_EXCLUDED :
    Sentences.cnl_C13_AUDIT_TELEMETRY_EXCLUDED ↔
      hand_C13_AUDIT_TELEMETRY_EXCLUDED := Iff.rfl

end SpecCnl.Bridge
