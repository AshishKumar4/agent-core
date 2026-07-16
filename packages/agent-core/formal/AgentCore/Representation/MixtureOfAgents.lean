import AgentCore.RunGraph

/-!
# Representing mixture-of-agents orchestration (the proposer / aggregator shape)

A mixture-of-agents platform runs several proposer turns in parallel, each on its own
branch off a shared run, then aggregates their results. In the core model merges are
binary — a merge commit joins the destination head with one source-branch head, under
equal pins (SPEC §5.2) — so an n-way aggregation is a *chain* of binary merges: the
aggregator folds proposer heads into the destination branch one at a time.

The promise the orchestration must keep is **lineage completeness**: every proposer's
result is in the ancestry of the final aggregate, the whole chain stays inside one run,
and no merge step can smuggle in a foreign pin set. This module models the chain shape
over the core commit graph and proves those properties. It is a structural
representability result — the commit graph expresses the pattern exactly — not a claim
about aggregation quality.
-/

namespace AgentCore.Representation.MixtureOfAgents

open AgentCore

/-- A single proposer: the branch it ran on and the commit that holds its result. -/
structure Proposer where
  branch : BranchId
  head : CommitId
  deriving DecidableEq, Repr

/-- An aggregation chain in a commit store: starting from a root commit, each step
    merges one proposer head into the running aggregate with a binary merge commit,
    inside one run and under one pin set — the chain reading of the core model's
    equal-pin binary merge (SPEC §5.2). -/
inductive AggregationChain (store : GraphStore) (run : RunId) (pins : RunPins) :
    CommitId → List Proposer → CommitId → Prop
  | root {id commit} :
      store.commits id = some commit → commit.run = run → commit.pins = pins →
      AggregationChain store run pins id [] id
  | merge {root proposers aggregate mergeId commit proposer proposerCommit} :
      AggregationChain store run pins root proposers aggregate →
      store.commits mergeId = some commit →
      commit.run = run → commit.pins = pins →
      commit.parents = [aggregate, proposer.head] →
      store.commits proposer.head = some proposerCommit →
      proposerCommit.run = run → proposerCommit.pins = pins →
      proposerCommit.branch = proposer.branch →
      AggregationChain store run pins root (proposers ++ [proposer]) mergeId

/-- The aggregate commit of a chain exists in the store, in the right run, under the
    chain's pin set. -/
theorem aggregate_recorded {store run pins root proposers aggregate}
    (chain : AggregationChain store run pins root proposers aggregate) :
    ∃ commit, store.commits aggregate = some commit ∧
      commit.run = run ∧ commit.pins = pins := by
  cases chain with
  | root lookup runEq pinsEq => exact ⟨_, lookup, runEq, pinsEq⟩
  | merge _ lookup runEq pinsEq _ _ _ _ _ => exact ⟨_, lookup, runEq, pinsEq⟩

/-- **Lineage completeness.** Every proposer folded into the chain is an ancestor of
    the final aggregate: no proposer result can silently drop out of the provenance of
    an aggregated answer. -/
theorem proposers_are_ancestors {store run pins root proposers aggregate}
    (chain : AggregationChain store run pins root proposers aggregate) :
    ∀ proposer, proposer ∈ proposers → Ancestor store proposer.head aggregate := by
  induction chain with
  | root _ _ _ =>
      intro proposer membership
      cases membership
  | merge _ lookup _ _ parents proposerLookup _ _ _ ih =>
      intro proposer membership
      rcases List.mem_append.mp membership with earlier | latest
      · -- An earlier proposer reaches the previous aggregate, which is a parent here.
        exact Ancestor.parent lookup (parents ▸ List.mem_cons_self _ _) (ih proposer earlier)
      · -- The latest proposer's head is itself a parent of this merge commit.
        cases latest with
        | head =>
            exact Ancestor.parent lookup
              (parents ▸ List.mem_cons_of_mem _ (List.mem_cons_self _ _))
              (Ancestor.refl proposerLookup)
        | tail _ empty => cases empty

/-- **The aggregate descends from the shared root.** The chain never abandons its
    starting commit: the root is in the final aggregate's ancestry. -/
theorem root_is_ancestor {store run pins root proposers aggregate}
    (chain : AggregationChain store run pins root proposers aggregate) :
    Ancestor store root aggregate := by
  induction chain with
  | root lookup _ _ => exact Ancestor.refl lookup
  | merge _ lookup _ _ parents _ _ _ _ ih =>
      exact Ancestor.parent lookup (parents ▸ List.mem_cons_self _ _) ih

/-- **The fan-out never escapes its run.** Every proposer head recorded by the chain
    belongs to the chain's run — aggregation cannot reach across run boundaries. -/
theorem proposers_are_single_run {store run pins root proposers aggregate}
    (chain : AggregationChain store run pins root proposers aggregate) :
    ∀ proposer, proposer ∈ proposers →
      ∃ commit, store.commits proposer.head = some commit ∧
        commit.run = run ∧ commit.branch = proposer.branch := by
  induction chain with
  | root _ _ _ =>
      intro proposer membership
      cases membership
  | merge _ _ _ _ _ proposerLookup proposerRun _ branch ih =>
      intro proposer membership
      rcases List.mem_append.mp membership with earlier | latest
      · exact ih proposer earlier
      · cases latest with
        | head => exact ⟨_, proposerLookup, proposerRun, branch⟩
        | tail _ empty => cases empty

/-- **Pin discipline.** Every merge along the chain carries the one pin set — a chain
    cannot aggregate results produced under different pins, matching the equal-pin
    requirement on core merges (SPEC §5.2). -/
theorem chain_preserves_pins {store run pins root proposers aggregate}
    (chain : AggregationChain store run pins root proposers aggregate) :
    ∃ commit, store.commits aggregate = some commit ∧ commit.pins = pins := by
  obtain ⟨commit, lookup, _, pinsEq⟩ := aggregate_recorded chain
  exact ⟨commit, lookup, pinsEq⟩

end AgentCore.Representation.MixtureOfAgents
