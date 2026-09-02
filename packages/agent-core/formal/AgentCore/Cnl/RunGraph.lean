import AgentCore.RunGraph

/-!
# Consequences of the existing run-graph model the controlled language needs (§5.2)

Four consequences of `AgentCore.RunGraph` as it stands, all about what a graph transition
that writes a commit had to bring with it. The controlled language quantifies over a
transition's two states and its label, so a premise of the `append` or `spawnChild`
constructor is only reachable from a sentence once it is restated as a fact about that
step; that restatement is what these theorems supply.

No definition is introduced or changed here. Every proof reads `GraphStep`,
`ParentsClosed`, `CurrentMergeHeads`, and `tableSet` as they already stand, and the
closure facts below are exactly the constructor premises, never a strengthening of them.
-/

namespace AgentCore

/-- **An append lands on a branch its own Run owns, and names only parents of that Run.**
The two halves of §5.2 graph closure that the `append` constructor already demands: the
`branch` field resolves to a `RunBranch` of the commit's Run, and every parent the commit
names resolves to a commit of that same Run. -/
theorem append_requires_owned_branch_and_closed_parents
    {effects events audit} {before after : GraphStore} {id expected : CommitId}
    {commit : RunCommit}
    (step : GraphStep effects events audit before (.append id expected commit) after) :
    (∃ branch, before.branches commit.branch = some branch ∧ branch.run = commit.run) ∧
      ParentsClosed before commit := by
  cases step with
  | append _ _ _ branchLookup owned _ closed _ _ => exact ⟨⟨_, branchLookup, owned⟩, closed⟩

/-- **A spawned child starts on a root of its own.** The root commit a `spawnChild` writes
was absent before the step, is present after it with no parents at all, and the Run it
names is a Run whose declared root is exactly that commit — so a child Run's ancestry
begins at a commit the child itself owns rather than at material replayed from its
parent. -/
theorem spawn_child_root_is_unparented
    {effects events audit} {before after : GraphStore} {parentTurn : TurnId} {child : RunId}
    {root : CommitId}
    (step : GraphStep effects events audit before (.spawnChild parentTurn child root) after) :
    ∃ record, before.commits root = none ∧ after.commits root = some record ∧
      record.parents = [] ∧
      ∃ childRecord, after.runs record.run = some childRecord ∧ childRecord.root = root := by
  cases step with
  | spawnChild _ _ _ _ _ _ rootFresh _ _ childRoot _ _ _ rootRun _ _ _ rootParents _ _ =>
      refine ⟨_, rootFresh, tableSet_self .., rootParents, _, ?_, childRoot⟩
      rw [rootRun]
      exact tableSet_self ..

/-- **A merge names two distinct current heads on two distinct branches.** The comparison
§5.2 says a runtime performs is a premise of the step: the merge's parent list is the
destination branch's current head followed by another branch's current head, the two
branches differ, and the two heads differ — so a merge joining a lineage to itself is
refused before it lands. -/
theorem merge_append_names_two_distinct_current_heads
    {effects events audit} {before after : GraphStore} {id expected : CommitId}
    {commit : RunCommit} {conversation : ConversationResolution} {tree : TreeResolution}
    (step : GraphStep effects events audit before (.append id expected commit) after)
    (kind : commit.kind = .merge conversation tree) :
    ∃ sourceBranch destinationHead sourceHead,
      sourceBranch ≠ commit.branch ∧
      before.heads commit.branch = some destinationHead ∧
      before.heads sourceBranch = some sourceHead ∧
      destinationHead ≠ sourceHead ∧
      commit.parents = [destinationHead, sourceHead] := by
  cases step with
  | append _ _ _ _ _ _ _ heads _ =>
      rw [kind] at heads
      obtain ⟨sourceBranch, sourceHead, _, _, different, destinationHead, sourceHeadLookup,
        unique, parents, _, _, _, _, _, _⟩ := heads
      exact ⟨sourceBranch, expected, sourceHead, different, destinationHead, sourceHeadLookup,
        unique, parents⟩

/-- **Both sides of a merge are pinned exactly as the merge is.** Every parent the merge
names that the graph actually stores carries the merge commit's own `RunPins`, so the two
lineages a merge joins were running the same blueprint, package closure, agent revision,
policy, and environment the merge records. -/
theorem merge_append_parents_carry_commit_pins
    {effects events audit} {before after : GraphStore} {id expected : CommitId}
    {commit : RunCommit} {conversation : ConversationResolution} {tree : TreeResolution}
    (step : GraphStep effects events audit before (.append id expected commit) after)
    (kind : commit.kind = .merge conversation tree) :
    ∀ parent record, parent ∈ commit.parents → before.commits parent = some record →
      record.pins = commit.pins := by
  cases step with
  | append _ _ _ _ _ _ _ heads _ =>
      rw [kind] at heads
      obtain ⟨_, _, _, _, _, _, _, _, parents, destinationLookup, sourceLookup, _, _,
        destinationPins, sourcePins⟩ := heads
      intro parent record member lookup
      rw [parents] at member
      rcases List.mem_cons.mp member with rfl | member
      · rw [destinationLookup] at lookup
        cases Option.some.inj lookup
        exact destinationPins
      · rcases List.mem_cons.mp member with rfl | member
        · rw [sourceLookup] at lookup
          cases Option.some.inj lookup
          exact sourcePins
        · cases member

end AgentCore
