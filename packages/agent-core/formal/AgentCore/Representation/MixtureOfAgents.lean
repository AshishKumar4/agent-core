import AgentCore.Model

/-!
# Representing mixture-of-agents orchestration (the proposer / aggregator / judge shape)

A mixture-of-agents platform runs several proposer turns in parallel, each on its own
branch off a shared parent commit; an aggregator turn then reads the proposer branch
heads and writes a single merge commit; a judge turn writes a verdict. The promise the
orchestration must keep is **lineage completeness**: the merge records exactly the set
of proposer results it combined, so the provenance of an aggregated answer is exact and
auditable.

In the core model a merge is a RunCommit with two or more parents (SPEC §5.2). This
module models the MoA shape over that commit structure and proves that a well-formed
mixture is faithfully represented: the merge's parents are exactly the proposer heads,
every proposer shares the one parent commit, and the whole shape lives in a single run.
This is a structural representability result — it says the commit graph can express the
pattern exactly — not a claim about aggregation quality.
-/

namespace AgentCore.Representation.MixtureOfAgents

/-- A single proposer: the branch it ran on and the commit that holds its result. -/
structure Proposer where
  branch : BranchId
  head : CommitId
  deriving DecidableEq, Repr

/-- A mixture: one shared parent commit, a list of proposers, and the merge commit that
    aggregates them. -/
structure Mixture where
  root : CommitId
  proposers : List Proposer
  merge : CommitId
  deriving DecidableEq, Repr

/-- A proposer is *represented* in a state when its head commit exists, sits on its
    branch, and descends directly from the shared root (SPEC §5.2: sibling branches
    from one parent commit). -/
def ProposerRepresented (state : State) (runId : RunId) (root : CommitId)
    (proposer : Proposer) : Prop :=
  ∃ commit,
    state.commits proposer.head = some commit ∧
    commit.run = runId ∧
    commit.branch = proposer.branch ∧
    commit.parent = some root

/-- The merge is *represented* when it exists in the run and its parents are exactly the
    proposer heads — no more, no fewer. This is lineage completeness. -/
def MergeRepresented (state : State) (runId : RunId) (mixture : Mixture)
    (mergeParents : List CommitId) : Prop :=
  (∃ commit, state.commits mixture.merge = some commit ∧ commit.run = runId) ∧
  mergeParents = mixture.proposers.map (fun p => p.head)

/-- A mixture is faithfully represented in `state` for `runId` when the shared root
    exists, every proposer is represented off that root, and the merge records exactly
    the proposer heads as its parents. -/
def MixtureRepresented (state : State) (runId : RunId) (mixture : Mixture)
    (mergeParents : List CommitId) : Prop :=
  (∃ rootCommit, state.commits mixture.root = some rootCommit ∧ rootCommit.run = runId) ∧
  (∀ proposer, proposer ∈ mixture.proposers →
    ProposerRepresented state runId mixture.root proposer) ∧
  MergeRepresented state runId mixture mergeParents

/-- **The merge's parents are exactly the proposer heads.** Pulled straight from a
    representation witness — the aggregated result's provenance is complete and exact. -/
theorem merge_parents_are_proposer_heads
    {state : State} {runId : RunId} {mixture : Mixture} {mergeParents : List CommitId}
    (represented : MixtureRepresented state runId mixture mergeParents) :
    mergeParents = mixture.proposers.map (fun p => p.head) :=
  represented.2.2.2

/-- **Every proposer branches off the one shared parent.** In a represented mixture,
    each proposer's head descends directly from the shared root commit — the sibling-
    branch structure of SPEC §5.2. -/
theorem proposers_share_root
    {state : State} {runId : RunId} {mixture : Mixture} {mergeParents : List CommitId}
    (represented : MixtureRepresented state runId mixture mergeParents)
    {proposer : Proposer} (member : proposer ∈ mixture.proposers) :
    ∃ commit, state.commits proposer.head = some commit ∧
      commit.parent = some mixture.root ∧ commit.run = runId := by
  obtain ⟨commit, lookup, run, _branch, parent⟩ := represented.2.1 proposer member
  exact ⟨commit, lookup, parent, run⟩

/-- **A represented mixture lives in one run.** Root, proposers, and merge all belong to
    the same run — MoA fan-out never escapes its run boundary. -/
theorem mixture_is_single_run
    {state : State} {runId : RunId} {mixture : Mixture} {mergeParents : List CommitId}
    (represented : MixtureRepresented state runId mixture mergeParents) :
    (∃ c, state.commits mixture.root = some c ∧ c.run = runId) ∧
    (∃ c, state.commits mixture.merge = some c ∧ c.run = runId) :=
  ⟨represented.1, represented.2.2.1⟩

/-- **A well-formed merge requires at least two parents.** A merge that aggregates a
    proposer pool is a genuine multi-parent commit, matching `RunCommitKind.merge`'s
    arity in the core model (SPEC §5.2). With two or more proposers, the recorded
    parent list has length ≥ 2. -/
theorem merge_has_multiple_parents
    {state : State} {runId : RunId} {mixture : Mixture} {mergeParents : List CommitId}
    (represented : MixtureRepresented state runId mixture mergeParents)
    (twoPlus : 2 ≤ mixture.proposers.length) :
    2 ≤ mergeParents.length := by
  rw [merge_parents_are_proposer_heads represented, List.length_map]
  exact twoPlus

end AgentCore.Representation.MixtureOfAgents
