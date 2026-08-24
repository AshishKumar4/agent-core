import SpecCnl.Bridge

/-!
# Discharging every hand proposition

Written by hand against `AgentCore`, not generated. Without these a bridge lemma is
worthless: `cnl_X ↔ hand_X` says nothing at all if `hand_X` is false. These theorems are
what make the bridges load-bearing, and they are what the gate counts.

Every unit in the corpus has a theorem here. A unit whose hand proposition cannot be
discharged does not get a weaker sentence: it stays out of the corpus, and its
counterexample goes in `SpecCnl.Divergence`.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_RUN_ANCESTRY : Bridge.hand_C13_RUN_ANCESTRY := by
  have forward : ∀ (left right : GraphStore), left.commits = right.commits →
      ∀ ancestor child, Ancestor left ancestor child → Ancestor right ancestor child := by
    intro left right same ancestor child chain
    induction chain with
    | refl lookup => exact .refl (same ▸ lookup)
    | parent lookup member _ step => exact .parent (same ▸ lookup) member step
  intro left right same ancestor child
  exact ⟨forward left right same ancestor child, forward right left same.symm ancestor child⟩

theorem proved_C13_SUBSCRIPTION_ACCEPTED_TIERS : Bridge.hand_C13_SUBSCRIPTION_ACCEPTED_TIERS :=
  fun accepted => ⟨⟨⟨0⟩, ⟨0⟩, accepted, true⟩, rfl⟩

theorem proved_C13_TRUST_VERIFIED_INGRESS : Bridge.hand_C13_TRUST_VERIFIED_INGRESS := by
  intro event ⟨leases, now, before, after, id, step, lookup⟩
  obtain ⟨published, found, unasserted⟩ := published_event_has_no_asserted_tier step
  rw [lookup] at found
  cases Option.some.inj found
  exact unasserted

theorem proved_C13_TURN_LEASE_EXPIRY : Bridge.hand_C13_TURN_LEASE_EXPIRY :=
  fun _ _ _ _ _ step => reclaim_requires_expiry step

/-- A fresh-key insert never disturbs an entry that is already present. -/
private theorem tableSet_preserves {α β : Type} [DecidableEq α]
    {table : α → Option β} {key candidate : α} {value found : β}
    (fresh : table key = none) (stored : table candidate = some found) :
    tableSet table key value candidate = some found := by
  by_cases same : candidate = key
  · rw [same, fresh] at stored
    simp at stored
  · rw [tableSet_other _ _ _ same]
    exact stored

theorem proved_C13_EFFECT_ATTEMPT_IMMUTABLE : Bridge.hand_C13_EFFECT_ATTEMPT_IMMUTABLE := by
  intro before label after step id attempt stored
  cases step <;> first
    | exact stored
    | exact tableSet_preserves (by assumption) stored

theorem proved_C13_RECEIPT_ID_NAMESPACE : Bridge.hand_C13_RECEIPT_ID_NAMESPACE :=
  fun _ _ _ step disjoint => effect_step_preserves_receipt_id_disjointness disjoint step

theorem proved_C13_RUN_GRAPH_ARITY : Bridge.hand_C13_RUN_GRAPH_ARITY := by
  intro before label after ⟨isMergeAppend, effects, events, audit, step⟩ id expected commit isAppend
  subst isAppend
  obtain ⟨_, _, _, conversation, tree, labelEq, isMerge⟩ := isMergeAppend
  obtain ⟨rfl, rfl, rfl⟩ := GraphLabel.append.inj labelEq
  cases step with
  | append fresh run active branch owned head closed arity allowed =>
      rw [isMerge] at arity
      obtain ⟨_, _, _, _, _, _, parents, _⟩ := merge_has_equal_pinned_current_heads arity
      rw [parents]
      rfl

theorem proved_C13_RUN_UNDO_FENCE : Bridge.hand_C13_RUN_UNDO_FENCE := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨isUndoAppend, effects, events, audit, step⟩ id expected commit isAppend
    subst isAppend
    obtain ⟨_, _, _, selected, receipt, labelEq, isUndo⟩ := isUndoAppend
    obtain ⟨rfl, rfl, rfl⟩ := GraphLabel.append.inj labelEq
    cases step with
    | append fresh run active branch owned head closed arity allowed =>
        exact (undo_requires_unheld_branch_and_ancestor_selection allowed isUndo).1
  · intro before label after ⟨_, effects, events, audit, step⟩ id expected commit isAppend
      selected receipt isUndo
    subst isAppend
    cases step with
    | append fresh run active branch owned head closed arity allowed =>
        exact (undo_requires_unheld_branch_and_ancestor_selection allowed isUndo).2

theorem proved_C13_AUTH_GUEST_VERIFICATION : Bridge.hand_C13_AUTH_GUEST_VERIFICATION :=
  fun _ _ _ ⟨_, step⟩ _ _ _ subject => materialization_requires_verified_guest subject step

theorem proved_C13_CONTENT_RESOLUTION : Bridge.hand_C13_CONTENT_RESOLUTION := by
  intro before label after ⟨_, step⟩ ref requester isResolve
  exact content_resolution_requires_home_or_grant (isResolve ▸ step)

theorem proved_C13_RUN_ACCEPTANCE_OBLIGATION : Bridge.hand_C13_RUN_ACCEPTANCE_OBLIGATION := by
  intro store run left right
  intro ⟨_, _, _, leftRun, leftHead, leftCommit, _, leftTree⟩
  intro ⟨_, _, _, rightRun, rightHead, rightCommit, _, rightTree⟩
  rw [leftRun] at rightRun
  cases Option.some.inj rightRun
  rw [leftHead] at rightHead
  cases Option.some.inj rightHead
  rw [leftCommit] at rightCommit
  cases Option.some.inj rightCommit
  rw [leftTree] at rightTree
  exact Option.some.inj rightTree

end SpecCnl.Proofs
