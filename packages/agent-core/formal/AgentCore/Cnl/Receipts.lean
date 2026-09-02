import AgentCore.Audit

/-!
# Consequences of the existing receipt, batch-outcome, and audit-cause model

Everything here follows from definitions that already exist: `AgentCore.EffectStep` with
its two receipt tables, `AgentCore.ItemCurrentOutcome` with the two derived batch-outcome
relations, `AgentCore.AuditStep`'s projection bridge, and `AgentCore.MayCause`. No
definition gains a premise, loses one, or changes shape.

Two shape decisions are worth stating, because they are why the controlled sentences over
this domain read as they do.

* **Receipt lineage is stated per step.** The model has no reachability predicate for
  `EffectLedger`, so a whole-trace claim about receipt records has nothing to range over.
  A per-step preservation claim composes along any trace and is what the constructors
  actually justify.
* **The derived batch outcome is stated as a function of the ledger and the prepared
  Invocation.** `BatchCurrentOutcome` and `BatchTerminalOutcome` also take the item-outcome
  list, but that list is determined: `item_current_outcome_is_unique` pins each position,
  so the aggregate is unique once the ledger and the Invocation are fixed.
-/

namespace AgentCore

/-- A fresh-key insert never disturbs an entry that is already present. -/
private theorem receiptTableSet_preserves {α β : Type} [DecidableEq α]
    {table : α → Option β} {key candidate : α} {value found : β}
    (fresh : table key = none) (stored : table candidate = some found) :
    tableSet table key value candidate = some found := by
  by_cases same : candidate = key
  · rw [same, fresh] at stored
    simp at stored
  · rw [tableSet_other _ _ _ same]
    exact stored

/-! ## Recorded Receipts are never updated or deleted -/

/-- **A recorded attempt Receipt survives every effect step.** Both steps that write
`attemptReceipts` — the first record of a chain and a supersession — write at an id their
own premise proved absent, so no step overwrites or deletes a stored attempt Receipt. -/
theorem effect_step_preserves_attempt_receipts {before after : EffectLedger}
    {label : EffectLabel} (step : EffectStep before label after)
    {id : ReceiptId} {receipt : AttemptReceipt}
    (stored : before.attemptReceipts id = some receipt) :
    after.attemptReceipts id = some receipt := by
  cases step <;> first
    | exact stored
    | exact receiptTableSet_preserves (by assumption) stored

/-- **A recorded pre-effect Receipt survives every effect step.** `preReceipt` is the only
step that writes `preReceipts`, and its first premise proves the id absent. -/
theorem effect_step_preserves_pre_receipts {before after : EffectLedger}
    {label : EffectLabel} (step : EffectStep before label after)
    {id : ReceiptId} {receipt : PreEffectReceipt}
    (stored : before.preReceipts id = some receipt) :
    after.preReceipts id = some receipt := by
  cases step <;> first
    | exact stored
    | exact receiptTableSet_preserves (by assumption) stored

/-- **Only an unsuperseded indeterminate chain head may be superseded.** Read off
`supersession_is_same_attempt_once`: the id a supersession names already carries an attempt
Receipt whose outcome is `indeterminate`, and nothing has superseded it yet — so a final
Receipt is never superseded and no head is superseded twice. -/
theorem supersession_requires_indeterminate_chain_head {before after : EffectLedger}
    {previous next : ReceiptId}
    (step : EffectStep before (.supersedeReceipt previous next) after) :
    ∃ record, before.attemptReceipts previous = some record ∧
      record.outcome = .indeterminate ∧ before.supersededBy previous = none := by
  obtain ⟨old, _, oldLookup, _, indeterminate, unused, _, _⟩ :=
    supersession_is_same_attempt_once step
  exact ⟨old, oldLookup, indeterminate, unused⟩

/-! ## Which Receipt variant an item has answers whether an effect was attempted -/

/-- **A recorded pre-effect Receipt names an item with no attempt.** The `preReceipt` step
requires the item to have no latest attempt and records no attempt of its own, so in the
successor state the Receipt it wrote still names an unattempted item. This is the model's
form of "a PreEffectReceipt says no EffectAttempt exists". -/
theorem pre_receipt_records_item_without_attempt {before after : EffectLedger}
    {id : ReceiptId} (step : EffectStep before (.preReceipt id) after) :
    ∃ receipt, after.preReceipts id = some receipt ∧
      after.latestAttempt receipt.invocation receipt.itemIndex = none := by
  cases step with
  | preReceipt fresh otherFresh intent item noClaim noAttempt noReceipt =>
      exact ⟨_, tableSet_self .., noAttempt⟩

/-- **A recorded attempt Receipt references an existing EffectAttempt.** The step requires
the attempt to be stored and writes no attempt table, so the Receipt it wrote still
references a stored attempt in the successor state: "an AttemptReceipt says one does". -/
theorem attempt_receipt_records_existing_attempt {before after : EffectLedger}
    {id : ReceiptId} (step : EffectStep before (.attemptReceipt id) after) :
    ∃ receipt attempt, after.attemptReceipts id = some receipt ∧
      after.attempts receipt.attempt = some attempt := by
  cases step with
  | firstAttemptReceipt fresh otherFresh attemptLookup latest current previous =>
      exact ⟨_, _, tableSet_self .., attemptLookup⟩

/-! ## The derived batch outcome assigns one value -/

/-- **An item has at most one current outcome.** `ItemCurrentOutcome` reads the item's
current Receipt reference and then that record's own outcome field. Every lookup on the way
is a function and every outcome field has one value, so the item outcome it admits is
determined rather than chosen. -/
theorem item_current_outcome_is_unique {ledger : EffectLedger} {invocation : InvocationId}
    {index : Nat} {left right : ItemOutcome}
    (first : ItemCurrentOutcome ledger invocation index left)
    (second : ItemCurrentOutcome ledger invocation index right) : left = right := by
  unfold ItemCurrentOutcome at first second
  revert first second
  cases ledger.currentReceipt invocation index with
  | none => intro absent _; exact False.elim absent
  | some reference =>
      cases reference with
      | preEffect receipt =>
          intro first second
          obtain ⟨record, recordLookup, _, _, _, leftOutcome⟩ := first
          obtain ⟨other, otherLookup, _, _, _, rightOutcome⟩ := second
          have same : record = other := Option.some.inj (recordLookup.symm.trans otherLookup)
          subst same
          revert leftOutcome rightOutcome
          cases record.outcome <;> intro leftOutcome rightOutcome <;> simp_all
      | attempt receipt =>
          intro first second
          obtain ⟨record, _, recordLookup, _, _, _, _, leftOutcome⟩ := first
          obtain ⟨other, _, otherLookup, _, _, _, _, rightOutcome⟩ := second
          have same : record = other := Option.some.inj (recordLookup.symm.trans otherLookup)
          subst same
          revert leftOutcome rightOutcome
          cases record.outcome <;> intro leftOutcome rightOutcome <;> simp_all

/-- Two lists of equal length whose entries agree position by position are equal. -/
private theorem list_eq_of_pointwise {α : Type} {left right : List α}
    (length : left.length = right.length)
    (pointwise : ∀ (index : Nat) (x y : α),
      left[index]? = some x → right[index]? = some y → x = y) :
    left = right := by
  induction left generalizing right with
  | nil =>
      cases right with
      | nil => rfl
      | cons _ _ => simp at length
  | cons head tail shorter =>
      cases right with
      | nil => simp at length
      | cons otherHead otherTail =>
          have heads : head = otherHead :=
            pointwise 0 head otherHead (by simp) (by simp)
          have tails : tail = otherTail := by
            refine shorter (by simpa using length) ?_
            intro index x y leftLookup rightLookup
            exact pointwise (index + 1) x y (by simpa using leftLookup)
              (by simpa using rightLookup)
          rw [heads, tails]

/-- **The derived BatchOutcome is a function of the ledger and the prepared Invocation.**
Two derivations for one Invocation agree: the item-outcome list is pinned position by
position by `item_current_outcome_is_unique`, and `deriveBatchOutcome` is a function of
that list, so the first matching derivation rule cannot yield two aggregates. -/
theorem derived_batch_outcome_is_unique {ledger : EffectLedger}
    {prepared : PreparedInvocation} {left right : BatchOutcome}
    (first : ∃ outcomes, BatchCurrentOutcome ledger prepared outcomes left)
    (second : ∃ outcomes, BatchCurrentOutcome ledger prepared outcomes right) :
    left = right := by
  obtain ⟨leftOutcomes, leftLength, leftItems, leftDerived⟩ := first
  obtain ⟨rightOutcomes, rightLength, rightItems, rightDerived⟩ := second
  have same : leftOutcomes = rightOutcomes := by
    refine list_eq_of_pointwise (leftLength.trans rightLength.symm) ?_
    intro index x y leftLookup rightLookup
    exact item_current_outcome_is_unique (leftItems index x leftLookup)
      (rightItems index y rightLookup)
  rw [same] at leftDerived
  exact Option.some.inj (leftDerived.symm.trans rightDerived)

/-- **A TerminalBatchOutcome is a function of the same two things.** It is the derived
outcome with the indeterminate aggregate excluded, so it inherits the uniqueness above. -/
theorem terminal_batch_outcome_is_unique {ledger : EffectLedger}
    {prepared : PreparedInvocation} {left right : BatchOutcome}
    (first : ∃ outcomes, BatchTerminalOutcome ledger prepared outcomes left)
    (second : ∃ outcomes, BatchTerminalOutcome ledger prepared outcomes right) :
    left = right := by
  obtain ⟨leftOutcomes, leftTerminal⟩ := first
  obtain ⟨rightOutcomes, rightTerminal⟩ := second
  exact derived_batch_outcome_is_unique
    ⟨leftOutcomes, leftTerminal.1, leftTerminal.2.1, leftTerminal.2.2.1⟩
    ⟨rightOutcomes, rightTerminal.1, rightTerminal.2.1, rightTerminal.2.2.1⟩

/-! ## The target-local bridge root, and which audit kinds may cause a Receipt record -/

/-- **A projection bridge appends a fresh, cause-free `routeProjected` root.** The step
writes at an id its own premise proved absent, the entry it writes carries no
`AuditRecord` cause, and its kind is the target-local `routeProjected` record — so the
cross-Actor bridge enters the target's log as a root rather than as an edge into the
source's log. -/
theorem projection_bridge_appends_cause_free_bridge_root {effects : EffectLedger}
    {events : EventStore} {before after : AuditLog} {id : AuditId}
    {projection : ProjectionId}
    (step : AuditStep effects events before (.projectBridge id projection) after) :
    before.entries id = none ∧
      ∃ entry, after.entries id = some entry ∧ entry.cause = none ∧
        ∃ bridged reservation invocation,
          entry.kind = .routeProjected bridged reservation invocation := by
  cases step with
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup
      exactProjection exactDigest unique projectionTarget target kind projectionNoCause
      entryNoCause typed =>
      exact ⟨fresh, _, tableSet_self .., entryNoCause, _, _, _, kind⟩

/-- **Only an EffectAttempt audit record may cause an attempted-outcome record.**
`MayCause` admits exactly one edge into an `attemptReceipt` kind, so every other kind is
refused as its cause. -/
theorem only_attempt_audit_may_cause_attempt_receipt {parent : AuditKind}
    {receipt : ReceiptId} {attempt : AttemptId} {invocation : InvocationId}
    {outcome : AttemptOutcome}
    (notAttempt : ∀ id owner, parent ≠ AuditKind.attempt id owner) :
    ¬ MayCause parent (.attemptReceipt receipt attempt invocation outcome) := by
  cases parent <;> first
    | exact absurd rfl (notAttempt _ _)
    | simp [MayCause]

/-- **Only an indeterminate attempt Receipt record may cause a `receiptSuperseded`
record.** Supersession is the one determination the audit plane records separately, and
`MayCause` lets nothing else cause it — in particular no already-final Receipt record. -/
theorem only_indeterminate_receipt_may_cause_supersession {parent : AuditKind}
    {previous next : ReceiptId} {attempt : AttemptId} {invocation : InvocationId}
    (notIndeterminate : ∀ receipt id owner,
      parent ≠ AuditKind.attemptReceipt receipt id owner AttemptOutcome.indeterminate) :
    ¬ MayCause parent (.receiptSuperseded previous next attempt invocation) := by
  cases parent <;> first
    | (cases ‹AttemptOutcome› <;> first
        | exact absurd rfl (notIndeterminate _ _ _)
        | simp [MayCause])
    | simp [MayCause]

end AgentCore
