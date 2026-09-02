import SpecCnl.Sentences.Isolate

/-!
# Isolate: hand propositions and bridges

Each `hand_X` below is written from its rule unit against `AgentCore.Slates` directly.
Every bridge is `Iff.rfl`: the grammar's composition of the lexicon denotations is
definitionally the hand statement, and the load-bearing content is in
`SpecCnl.Proofs.Isolate`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §4.7 `C13-AUTH-ISOLATE-DELEGATION` -/

def hand_C13_AUTH_ISOLATE_DELEGATION : Prop :=
  ∀ (before : DynamicDomain) (label : IsolateLabel) (after : DynamicDomain),
    IsolateStep before label after →
      ∀ binding, after.passed binding ≠ before.passed binding →
        ∃ capability, label = IsolateLabel.pass binding capability

theorem bridge_C13_AUTH_ISOLATE_DELEGATION :
    Sentences.cnl_C13_AUTH_ISOLATE_DELEGATION ↔ hand_C13_AUTH_ISOLATE_DELEGATION := Iff.rfl

/-! ## §4.7 `C13-AUTH-ISOLATE-NAMESPACE-CLOSED` -/

def hand_C13_AUTH_ISOLATE_NAMESPACE_CLOSED : Prop :=
  ∀ (before : DynamicDomain) (label : IsolateLabel) (after : DynamicDomain),
    ((∃ binding, label = IsolateLabel.invoke binding) ∧ IsolateStep before label after) →
      ∀ binding, label = IsolateLabel.invoke binding →
        ∃ capability, before.passed binding = some capability

theorem bridge_C13_AUTH_ISOLATE_NAMESPACE_CLOSED :
    Sentences.cnl_C13_AUTH_ISOLATE_NAMESPACE_CLOSED ↔
      hand_C13_AUTH_ISOLATE_NAMESPACE_CLOSED := Iff.rfl

/-! ## §4.7 `C13-PLACEMENT-AUTHORED-BACKING` -/

def hand_C13_PLACEMENT_AUTHORED_BACKING : Prop :=
  ∀ (before : DynamicDomain) (label : IsolateLabel) (after : DynamicDomain),
    IsolateStep before label after → ActionsBacked before → ActionsBacked after

theorem bridge_C13_PLACEMENT_AUTHORED_BACKING :
    Sentences.cnl_C13_PLACEMENT_AUTHORED_BACKING ↔
      hand_C13_PLACEMENT_AUTHORED_BACKING := Iff.rfl

/-! ## §9.2 `C13-SLATE-SKELETON-ARTIFACT` -/

def hand_C13_SLATE_SKELETON_ARTIFACT : Prop :=
  (∀ (before : SlateLedger) (label : SlateLabel) (after : SlateLedger),
      (∃ env, SlateStep env before label after) →
        ∀ slate record moved,
          before.slates slate = some record → after.slates slate = some moved →
            moved.head ≠ record.head →
              ∃ version source, label = SlateLabel.commit slate version source ∧
                moved.head = some version) ∧
  (∀ (before : SlateLedger) (label : SlateLabel) (after : SlateLedger),
      (∃ env, SlateStep env before label after) →
        ∀ id record, before.versions id = some record → after.versions id = some record)

theorem bridge_C13_SLATE_SKELETON_ARTIFACT :
    Sentences.cnl_C13_SLATE_SKELETON_ARTIFACT ↔ hand_C13_SLATE_SKELETON_ARTIFACT := Iff.rfl

end SpecCnl.Bridge
