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

theorem proved_C13_CONFIG_SECRET_REF : Bridge.hand_C13_CONFIG_SECRET_REF :=
  fun _ _ _ step refOnly => secret_step_preserves_carrier_ref_only refOnly step

theorem proved_C13_CONTENT_CUSTODY : Bridge.hand_C13_CONTENT_CUSTODY := by
  refine ⟨fun _ _ _ step owned => content_step_preserves_owned_implies_stored owned step, ?_⟩
  intro _ _ _ ⟨_, step⟩ ref isCollect
  exact (collect_requires_unowned (isCollect ▸ step)).2

theorem proved_C13_AUTH_SCOPE_DIRECTION : Bridge.hand_C13_AUTH_SCOPE_DIRECTION :=
  ⟨fun _ _ _ first second => scope_reaches_trans first second,
    fun _ _ forward backward => scope_reaches_antisymm forward backward⟩

theorem proved_C13_AUDIT_EDGE_RELATION : Bridge.hand_C13_AUDIT_EDGE_RELATION := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, _, step⟩ id entry stored
    exact audit_step_preserves_existing_entry step stored
  · intro _ _ _ ⟨_, _, step⟩
    exact local_cause_same_actor_lower_sequence step

theorem proved_C13_ROUTE_DELIVERY_ONCE : Bridge.hand_C13_ROUTE_DELIVERY_ONCE := by
  refine ⟨fun _ _ _ step _ _ consumed => consumed_is_monotone step consumed, ?_⟩
  intro _ _ _ ⟨_, step⟩ _ _ _ isFire _ stored consumed
  exact consumed_key_never_refires stored consumed (isFire ▸ step)

theorem proved_C13_ENVIRONMENT_SESSION_LIFECYCLE :
    Bridge.hand_C13_ENVIRONMENT_SESSION_LIFECYCLE := by
  refine ⟨?_, ?_⟩
  · refine ⟨?_, ?_⟩
    · intro _ _ _ step use isUse
      obtain ⟨session, _, stored, live, epoch, _, _, _⟩ :=
        session_use_is_turn_owned_and_live step isUse
      exact ⟨session, stored, live, epoch⟩
    · intro _ _ _ ⟨⟨_, isRotate⟩, step⟩
      exact (rotation_does_not_retarget_open_sessions (isRotate ▸ step)).1
  · intro _ _ _ ⟨_, step⟩ session isClose
    exact close_disposes_child_facets (isClose ▸ step)

theorem proved_C13_PLACEMENT_DYNAMIC_NO_EGRESS :
    Bridge.hand_C13_PLACEMENT_DYNAMIC_NO_EGRESS := by
  refine ⟨?_, ?_⟩
  · intro before _ _ ⟨fresh, step⟩
    rw [fresh] at step
    exact fresh_dynamic_isolate_admits_only_host_pass step
  · intro _ _ _ ⟨_, step⟩ _ _ isEgress
    exact isolate_egress_matches_passed_destination (isEgress ▸ step)

theorem proved_C13_RUN_BINARY_TREE_MERGE : Bridge.hand_C13_RUN_BINARY_TREE_MERGE := by
  intro before label after family id expected commit isAppend
  exact Nat.le_of_eq
    (proved_C13_RUN_GRAPH_ARITY before label after family id expected commit isAppend)

theorem proved_C13_INTERCEPTOR_ORDER : Bridge.hand_C13_INTERCEPTOR_ORDER :=
  ⟨fun _ _ _ first second => interceptor_order_trans first second,
    fun contribution => interceptor_order_irrefl contribution⟩

theorem proved_C13_BLUEPRINT_REMATERIALIZE : Bridge.hand_C13_BLUEPRINT_REMATERIALIZE := by
  intro _ label _ ⟨_, step⟩ blueprint template id isMaterialize
  subst isMaterialize
  cases step with
  | materialize fresh _ => exact fresh

theorem proved_C13_ENVIRONMENT_TURN_OWNED : Bridge.hand_C13_ENVIRONMENT_TURN_OWNED := by
  intro _ _ _ step use isUse
  obtain ⟨session, lease, stored, _, _, held, holder, admits⟩ :=
    session_use_is_turn_owned_and_live step isUse
  exact ⟨session, lease, stored, held, holder, admits⟩

theorem proved_C13_AUTH_SECRET_SCOPE : Bridge.hand_C13_AUTH_SECRET_SCOPE := by
  intro _ _ _ ⟨_, step⟩ _ _ _ _ _ isResolve
  exact secret_resolution_requires_exact_tenant (isResolve ▸ step)

theorem proved_C13_PREPARED_APPROVAL_UNIQUE :
    Bridge.hand_C13_PREPARED_APPROVAL_UNIQUE :=
  fun _ _ _ _ first second => approval_is_unique_per_invocation first second

theorem proved_C13_PROTOCOL_DUPLICATE : Bridge.hand_C13_PROTOCOL_DUPLICATE := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨⟨id, isResubmit⟩, step⟩
    exact duplicate_submission_reserves_and_emits_nothing (isResubmit ▸ step)
  · intro _ _ _ ⟨_, step⟩ id isDuplicate
    exact resubmission_returns_recorded_reply (isDuplicate ▸ step)

end SpecCnl.Proofs
