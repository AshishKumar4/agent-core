import SpecCnl.Sentences.Definition

/-!
# Definition: hand propositions and bridges

`bridge_C13_PACKAGE_DEPENDENCY_DECLARED` is `Iff.rfl`: the grammar's composition of
lexicon denotations is definitionally the hand statement.
`bridge_C13_BLUEPRINT_CONVERGENCE` is a real proof, because the third clause's subject
noun denotes `fun _ => True` and the hand proposition carries no such hypothesis —
stripping it is the work, and it is visible here rather than buried in a denotation.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §9.3 `C13-BLUEPRINT-CONVERGENCE` -/

def hand_C13_BLUEPRINT_CONVERGENCE : Prop :=
  ((∀ (before : MaterializerLedger) (label : MaterializeLabel) (after : MaterializerLedger),
      ((∃ blueprint template, label = MaterializeLabel.reconcile blueprint template) ∧
        MaterializeStep before label after) →
        after.installed = before.installed ∧ after.routing = before.routing) ∧
    ∀ (before : MaterializerLedger) (label : MaterializeLabel) (after : MaterializerLedger),
      MaterializeStep before label after →
        ∀ blueprint name id, before.installed blueprint name = some id →
          after.installed blueprint name = some id) ∧
  ∀ (ledger : MaterializerLedger) (blueprint : BlueprintId) (name : SubscriptionTemplateName)
      (left right : SubscriptionId),
    ledger.installed blueprint name = some left →
      ledger.installed blueprint name = some right → left = right

theorem bridge_C13_BLUEPRINT_CONVERGENCE :
    Sentences.cnl_C13_BLUEPRINT_CONVERGENCE ↔ hand_C13_BLUEPRINT_CONVERGENCE := by
  unfold Sentences.cnl_C13_BLUEPRINT_CONVERGENCE hand_C13_BLUEPRINT_CONVERGENCE qEvery
  exact ⟨fun ⟨steps, unique⟩ => ⟨steps, fun ledger => unique ledger trivial⟩,
    fun ⟨steps, unique⟩ => ⟨steps, fun ledger _ => unique ledger⟩⟩

/-! ## §9.1 `C13-PACKAGE-DEPENDENCY-DECLARED` -/

def hand_C13_PACKAGE_DEPENDENCY_DECLARED : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      (∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run id expected commit, label = GraphLabel.migrate run id expected commit →
        ∀ pins operation receipt, commit.kind = RunCommitKind.migration pins operation receipt →
          pins.packageClosure ≠ []) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      (∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run id expected commit, label = GraphLabel.migrate run id expected commit →
        ∀ pins operation receipt, commit.kind = RunCommitKind.migration pins operation receipt →
          (pins.packageClosure.map PackagePin.package).Nodup

theorem bridge_C13_PACKAGE_DEPENDENCY_DECLARED :
    Sentences.cnl_C13_PACKAGE_DEPENDENCY_DECLARED ↔
      hand_C13_PACKAGE_DEPENDENCY_DECLARED := Iff.rfl

end SpecCnl.Bridge
