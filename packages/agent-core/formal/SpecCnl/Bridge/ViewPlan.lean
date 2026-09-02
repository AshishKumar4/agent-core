import SpecCnl.Sentences.ViewPlan

/-!
# Hand proposition and bridge for the ViewPlan group (§6.3)

The hand proposition below is written directly over `AgentCore` from the rule unit: the
three facts about `applyDelta` and `replay` that make a View a projection of its patch
stream. The bridge is `Iff.rfl` — the grammar's composition of this group's denotations is
definitionally the hand statement — so the load-bearing content is in `SpecCnl.Proofs`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §6.3 `C13-VIEW-NO-LIVE-STATE` -/

def hand_C13_VIEW_NO_LIVE_STATE : Prop :=
  ((∀ (before : ViewState) (delta : ViewDelta) (after : ViewState),
      applyDelta before delta = some after → delta.base = before.revision) ∧
    ∀ (before : ViewState) (delta : ViewDelta) (after : ViewState),
      applyDelta before delta = some after →
        after.revision = before.revision + 1 ∧
          after.body = delta.patch.apply before.body) ∧
  ∀ (before : ViewState) (deltas : List ViewDelta) (after : ViewState),
    replay before deltas = some after →
      after.revision = before.revision + deltas.length

theorem bridge_C13_VIEW_NO_LIVE_STATE :
    Sentences.cnl_C13_VIEW_NO_LIVE_STATE ↔ hand_C13_VIEW_NO_LIVE_STATE := Iff.rfl

end SpecCnl.Bridge
