import SpecCnl.Sentences.RunGraph

/-!
# Hand propositions and bridges for the RunGraph group (§5.2)

Each `hand_` proposition below is written directly over `AgentCore` from the rule unit, and
each bridge is the kernel-checked identification of it with what the grammar composed.
Every bridge here is `Iff.rfl`: the grammar's composition of this group's denotations is
definitionally the hand statement, so the load-bearing content is in `SpecCnl.Proofs`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §5.2 `C13-RUN-GRAPH-CLOSED` -/

def hand_C13_RUN_GRAPH_CLOSED : Prop :=
  ((∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit, label = GraphLabel.append id expected commit) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ParentsClosed before commit) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit, label = GraphLabel.append id expected commit) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ∃ branch, before.branches commit.branch = some branch ∧
          branch.run = commit.run) ∧
  ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
    ((∃ parentTurn child root, label = GraphLabel.spawnChild parentTurn child root) ∧
      ∃ effects events audit, GraphStep effects events audit before label after) →
    ∀ parentTurn child root, label = GraphLabel.spawnChild parentTurn child root →
      ∃ record, before.commits root = none ∧ after.commits root = some record ∧
        record.parents = [] ∧
        ∃ childRecord, after.runs record.run = some childRecord ∧ childRecord.root = root

theorem bridge_C13_RUN_GRAPH_CLOSED :
    Sentences.cnl_C13_RUN_GRAPH_CLOSED ↔ hand_C13_RUN_GRAPH_CLOSED := Iff.rfl

/-! ## §5.2 `C13-RUN-DISTINCTION-REPRESENTABLE` -/

def hand_C13_RUN_DISTINCTION_REPRESENTABLE : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit conversation tree,
          label = GraphLabel.append id expected commit ∧
            commit.kind = RunCommitKind.merge conversation tree) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ∃ sourceBranch destinationHead sourceHead,
          sourceBranch ≠ commit.branch ∧
          before.heads commit.branch = some destinationHead ∧
          before.heads sourceBranch = some sourceHead ∧
          destinationHead ≠ sourceHead ∧
          commit.parents = [destinationHead, sourceHead]) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit conversation tree,
          label = GraphLabel.append id expected commit ∧
            commit.kind = RunCommitKind.merge conversation tree) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ∀ parent record, parent ∈ commit.parents → before.commits parent = some record →
          record.pins = commit.pins

theorem bridge_C13_RUN_DISTINCTION_REPRESENTABLE :
    Sentences.cnl_C13_RUN_DISTINCTION_REPRESENTABLE ↔
      hand_C13_RUN_DISTINCTION_REPRESENTABLE := Iff.rfl

/-! ## §5.2 `C13-RUN-UNDO-REDO` -/

def hand_C13_RUN_UNDO_REDO : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      (∃ effects events audit, GraphStep effects events audit before label after) →
        ∀ id record, before.commits id = some record → after.commits id = some record) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit selected receipt,
          label = GraphLabel.append id expected commit ∧
            commit.kind = RunCommitKind.undo selected receipt) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ∀ selected receipt, commit.kind = RunCommitKind.undo selected receipt →
          after.effectiveState commit.branch = some selected

theorem bridge_C13_RUN_UNDO_REDO :
    Sentences.cnl_C13_RUN_UNDO_REDO ↔ hand_C13_RUN_UNDO_REDO := Iff.rfl

end SpecCnl.Bridge
