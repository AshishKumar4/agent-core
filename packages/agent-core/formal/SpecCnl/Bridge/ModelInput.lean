import SpecCnl.Sentences.ModelInput

/-!
# ModelInput: hand propositions and bridges

One hand proposition, written from the rule unit's retention clause against
`AgentCore.Content` directly: whatever resolution a ledger admits, the content the
resolved ref names was stored in that ledger. The `requester` binder is the resolve
label's second payload and the condition does not read it — retention is a fact about the
ref, and the requester is `C13-CONTENT-RESOLUTION`'s clause over the same family.

The bridge is `Iff.rfl`: the grammar's composition of `every content resolve`,
`requires`, `retained content`, and `for the resolved reference` is definitionally the
statement below, and the load-bearing content is in `SpecCnl.Proofs.ModelInput`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §5.6 `C13-TURN-MODEL-INPUT-RETENTION-LOSS` -/

def hand_C13_TURN_MODEL_INPUT_RETENTION_LOSS : Prop :=
  ∀ (before : ContentLedger) (label : ContentLabel) (after : ContentLedger),
    ((∃ ref requester, label = ContentLabel.resolve ref requester) ∧
      ContentStep before label after) →
    ∀ ref requester, label = ContentLabel.resolve ref requester →
      before.stored ref = true

theorem bridge_C13_TURN_MODEL_INPUT_RETENTION_LOSS :
    Sentences.cnl_C13_TURN_MODEL_INPUT_RETENTION_LOSS ↔
      hand_C13_TURN_MODEL_INPUT_RETENTION_LOSS := Iff.rfl

end SpecCnl.Bridge
