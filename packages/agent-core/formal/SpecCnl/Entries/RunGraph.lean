import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# RunGraph: the vocabulary of graph closure, merge distinctness, and undo selection

One ledger, `AgentCore.GraphStore`, and one label family, `AgentCore.GraphLabel`, so this
section is three transition families over that pair plus the conditions they scope.

* **The families.** `every graph append` is every step whose label appends a commit, of
  whatever kind; `every graph spawn` is the child-Run spawn; `every graph step` is the
  whole relation, with no label restriction at all, which is what an append-only claim
  quantifies over. The corpus's existing `every merge append` and `every undo append`
  narrow the append family by commit kind and are reused unchanged.
* **The lifters.** The append label carries three payload components and the corpus's
  existing `for the appended commit` scopes a *source-state* condition under the commit.
  A postcondition needs the same scoping at a different category, so this section adds the
  `PX \ PO` twin under the same surface: the two differ only in whether the successor
  state is readable, which is exactly the distinction `requires` and `establishes` make.
  `for the spawn` is the same construction for the spawn label, scoped to the root
  `CommitId` it names.
* **The conditions.** Closure is two conditions on the appended commit — its parents are
  commits of its own Run, and its branch is a branch of that Run. Merge distinctness is
  the two named heads and their pins. Undo is one postcondition, read off the successor
  because the effective state the undo selects is a fact about the graph after the append.

Every denotation is a term over `AgentCore` alone; nothing here introduces a constant.
-/

namespace SpecCnl.Entries.RunGraph

def entries : List LexEntry :=
  [ { id := "every.graph.append"
      surface := "every graph append"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id expected commit, label = AgentCore.GraphLabel.append id expected commit) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "graph.same.run.parents"
      surface := "same run parents"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation := "AgentCore.ParentsClosed" },
    { id := "graph.an.owned.branch"
      surface := "an owned branch"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun store commit => ∃ branch, " ++
        "AgentCore.GraphStore.branches store " ++
        "(AgentCore.RunCommit.branch commit) = some branch ∧ " ++
        "AgentCore.RunBranch.run branch = AgentCore.RunCommit.run commit" },
    { id := "every.graph.spawn"
      surface := "every graph spawn"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ parentTurn child root, " ++
        "label = AgentCore.GraphLabel.spawnChild parentTurn child root) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "for.the.graph.spawn"
      surface := "for the spawn"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.CommitId]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ parentTurn child root, " ++
        "label = AgentCore.GraphLabel.spawnChild parentTurn child root → " ++
        "cond before root after" },
    { id := "graph.an.unparented.child.root"
      surface := "an unparented child root"
      category := "PX[AgentCore.GraphStore,AgentCore.CommitId]"
      denotation :=
        "fun before root after => ∃ record, " ++
        "AgentCore.GraphStore.commits before root = none ∧ " ++
        "AgentCore.GraphStore.commits after root = some record ∧ " ++
        "AgentCore.RunCommit.parents record = [] ∧ " ++
        "∃ childRecord, AgentCore.GraphStore.runs after " ++
        "(AgentCore.RunCommit.run record) = some childRecord ∧ " ++
        "AgentCore.Run.root childRecord = root" },
    { id := "graph.distinct.named.heads"
      surface := "distinct named heads"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun store commit => ∃ sourceBranch destinationHead sourceHead, " ++
        "sourceBranch ≠ AgentCore.RunCommit.branch commit ∧ " ++
        "AgentCore.GraphStore.heads store " ++
        "(AgentCore.RunCommit.branch commit) = some destinationHead ∧ " ++
        "AgentCore.GraphStore.heads store sourceBranch = some sourceHead ∧ " ++
        "destinationHead ≠ sourceHead ∧ " ++
        "AgentCore.RunCommit.parents commit = [destinationHead, sourceHead]" },
    { id := "graph.equal.pinned.parents"
      surface := "equal pinned parents"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun store commit => ∀ parent record, " ++
        "parent ∈ AgentCore.RunCommit.parents commit → " ++
        "AgentCore.GraphStore.commits store parent = some record → " ++
        "AgentCore.RunCommit.pins record = AgentCore.RunCommit.pins commit" },
    { id := "every.graph.step"
      surface := "every graph step"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => ∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "graph.stored.commits"
      surface := "stored commits"
      category := "PR[AgentCore.GraphStore]"
      denotation :=
        "fun before after => ∀ id record, " ++
        "AgentCore.GraphStore.commits before id = some record → " ++
        "AgentCore.GraphStore.commits after id = some record" },
    { id := "graph.for.the.appended.commit"
      surface := "for the appended commit"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.RunCommit]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ id expected commit, " ++
        "label = AgentCore.GraphLabel.append id expected commit → cond before commit after" },
    { id := "graph.a.selected.effective.state"
      surface := "a selected effective state"
      category := "PX[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun _ commit after => ∀ selected receipt, " ++
        "AgentCore.RunCommit.kind commit = " ++
        "AgentCore.RunCommitKind.undo selected receipt → " ++
        "AgentCore.GraphStore.effectiveState after " ++
        "(AgentCore.RunCommit.branch commit) = some selected" } ]

end SpecCnl.Entries.RunGraph
