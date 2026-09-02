import SpecCnl.Sentences.NoRetry

/-!
# Hand propositions and bridges for the NoRetry group (§5.6)

The hand proposition below is written directly over `AgentCore` from the rule unit, and the
bridge is the kernel-checked identification of it with what the grammar composed. It is
`Iff.rfl`: the grammar's composition of this group's denotations is definitionally the hand
statement, so the load-bearing content is in `SpecCnl.Proofs`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §5.6 `C13-TURN-NO-RETRY` -/

def hand_C13_TURN_NO_RETRY : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      (∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id turn, before.turns id = some turn →
        (turn.status = TurnStatus.succeeded ∨ turn.status = TurnStatus.failed ∨
          turn.status = TurnStatus.cancelled) →
        ∃ later, after.turns id = some later ∧
          (later.status = TurnStatus.succeeded ∨ later.status = TurnStatus.failed ∨
            later.status = TurnStatus.cancelled)) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ turn, label = GraphLabel.startTurn turn) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ turn, label = GraphLabel.startTurn turn →
        ∃ record, after.turns turn = some record ∧
          record.lease = TurnLease.initial turn ∧
          ∀ token now, ¬ TurnLease.Admits record.lease token now

theorem bridge_C13_TURN_NO_RETRY :
    Sentences.cnl_C13_TURN_NO_RETRY ↔ hand_C13_TURN_NO_RETRY := Iff.rfl

end SpecCnl.Bridge
