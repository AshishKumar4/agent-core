import AgentCore.Model

/-!
SPEC v2 §5.2: the commit graph is append-only; undo/redo are selection commits.
The branch head only advances; an undo commit's `selects` field names an ancestor,
and the branch's *effective state* is the selected commit; undo against a branch
with a live (unfenced) Turn lease is rejected.
-/

namespace AgentCore

inductive GraphCommitKind where
  | normal
  | undo (selects : CommitId)
  deriving DecidableEq, Repr

structure GraphCommit where
  parent : Option CommitId
  kind : GraphCommitKind
  deriving Repr

/-- One branch of a Run: its commit table, its head, and whether an unexpired Turn
    lease currently holds the branch (SPEC §5.3). -/
structure BranchState where
  commits : CommitId → Option GraphCommit
  head : Option CommitId
  leaseHeld : Bool

/-- Ancestry over the commit table (reflexive, via parent edges). -/
inductive Ancestor (state : BranchState) : CommitId → CommitId → Prop
  | refl {id commit} :
      state.commits id = some commit →
      Ancestor state id id
  | parent {ancestor child commit parentId} :
      state.commits child = some commit →
      commit.parent = some parentId →
      Ancestor state ancestor parentId →
      Ancestor state ancestor child

/-- The branch's effective state: the head, unless the head is an undo commit, in
    which case the selected commit (SPEC §5.2). -/
def BranchState.effective (state : BranchState) : Option CommitId :=
  match state.head with
  | none => none
  | some id =>
      match state.commits id with
      | some ⟨_, .undo selects⟩ => some selects
      | some ⟨_, .normal⟩ => some id
      | none => none

def BranchState.append (state : BranchState) (id : CommitId) (commit : GraphCommit) :
    BranchState :=
  { state with
    commits := fun candidate => if candidate = id then some commit else state.commits candidate
    head := some id }

inductive GraphLabel where
  | append (id : CommitId)
  | undo (id : CommitId) (selects : CommitId)
  | fence
  deriving DecidableEq, Repr

inductive GraphStep : BranchState → GraphLabel → BranchState → Prop
  | append {state id} :
      state.commits id = none →
      GraphStep state (.append id) (state.append id ⟨state.head, .normal⟩)
  | undo {state id selects head} :
      state.commits id = none →
      state.head = some head →
      Ancestor state selects head →
      state.leaseHeld = false →
      GraphStep state (.undo id selects) (state.append id ⟨state.head, .undo selects⟩)
  | fence {state} :
      GraphStep state .fence { state with leaseHeld := false }

/-- The table is append-only: no step removes or rewrites a commit. -/
theorem step_preserves_commits {state after label id commit}
    (step : GraphStep state label after)
    (lookup : state.commits id = some commit) :
    after.commits id = some commit := by
  cases step with
  | @append id' empty =>
      unfold BranchState.append
      dsimp only
      split
      · next eq => rw [eq] at lookup; rw [lookup] at empty; cases empty
      · exact lookup
  | @undo id' _ _ empty _ _ _ =>
      unfold BranchState.append
      dsimp only
      split
      · next eq => rw [eq] at lookup; rw [lookup] at empty; cases empty
      · exact lookup
  | fence => exact lookup

theorem append_preserves_lookup {state : BranchState} {id : CommitId} {commit : GraphCommit}
    {node : CommitId} {existing : GraphCommit}
    (empty : state.commits id = none)
    (lookup : state.commits node = some existing) :
    (state.append id commit).commits node = some existing := by
  unfold BranchState.append
  dsimp only
  split
  · next eq => rw [eq] at lookup; rw [lookup] at empty; cases empty
  · exact lookup

theorem append_lookup_self (state : BranchState) (id : CommitId) (commit : GraphCommit) :
    (state.append id commit).commits id = some commit := by
  unfold BranchState.append
  simp

/-- Ancestry survives appending a fresh commit. -/
theorem append_ancestor_mono {state : BranchState} {id : CommitId} {commit : GraphCommit}
    {a b : CommitId}
    (empty : state.commits id = none)
    (ancestor : Ancestor state a b) :
    Ancestor (state.append id commit) a b := by
  induction ancestor with
  | refl lookup => exact .refl (append_preserves_lookup empty lookup)
  | parent lookup parentEdge _ ih =>
      exact .parent (append_preserves_lookup empty lookup) parentEdge ih

/-- Ancestry is monotone under append-only growth. -/
theorem ancestor_mono {state after label a b}
    (step : GraphStep state label after)
    (ancestor : Ancestor state a b) :
    Ancestor after a b := by
  induction ancestor with
  | refl lookup => exact .refl (step_preserves_commits step lookup)
  | parent lookup parentEdge _ ih =>
      exact .parent (step_preserves_commits step lookup) parentEdge ih

/-- Heads only advance: any head-changing step appends a commit whose parent is the
    prior head (SPEC §5.2 append-only). -/
theorem head_advances {state after id}
    (step : GraphStep state (.append id) after) :
    ∃ commit, after.commits id = some commit ∧ commit.parent = state.head ∧
      after.head = some id := by
  cases step with
  | append empty =>
      refine ⟨⟨state.head, .normal⟩, ?_, rfl, rfl⟩
      unfold BranchState.append
      simp

/-- Undo appends (never rewrites): the undo commit's parent is the prior head, the
    head advances to the undo commit, and the effective state becomes the selected
    ancestor (SPEC §5.2). -/
theorem undo_appends_and_selects {state after id selects}
    (step : GraphStep state (.undo id selects) after) :
    after.head = some id ∧
    (∃ head, state.head = some head ∧ Ancestor state selects head) ∧
    after.effective = some selects := by
  cases step with
  | @undo _ _ head empty headEq ancestor _ =>
      refine ⟨rfl, ⟨head, headEq, ancestor⟩, ?_⟩
      unfold BranchState.effective BranchState.append
      simp

/-- SPEC §5.2: undo against a branch whose Turn holds an unexpired lease is rejected —
    the Turn must be fenced first. -/
theorem undo_requires_fenced_turn {state after id selects}
    (held : state.leaseHeld = true) :
    ¬ GraphStep state (.undo id selects) after := by
  intro step
  cases step with
  | undo _ _ _ free => rw [held] at free; cases free

/-- After an undo, the effective state is an ancestor of the new head — undo never
    escapes the branch's history. -/
theorem undo_effective_is_ancestor {state after id selects}
    (step : GraphStep state (.undo id selects) after) :
    ∃ head, after.head = some head ∧ ∃ e, after.effective = some e ∧
      Ancestor after e head := by
  obtain ⟨headEq, ⟨head, priorHead, ancestor⟩, effectiveEq⟩ := undo_appends_and_selects step
  refine ⟨id, headEq, selects, effectiveEq, ?_⟩
  cases step with
  | @undo _ _ head' empty headEq' ancestor' _ =>
      exact Ancestor.parent
        (append_lookup_self state id ⟨state.head, .undo selects⟩)
        headEq'
        (append_ancestor_mono empty ancestor')

end AgentCore
