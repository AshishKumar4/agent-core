import SpecCnl.Sentences

/-!
# Hand propositions and bridge lemmas

For each unit: `hand_X` is written directly over `AgentCore`, by hand, without looking at
the grammar's output shape; `bridge_X : cnl_X ↔ hand_X` is the kernel-checked bridge.

Read what a bridge lemma is and is not worth.

* A bridge whose proof is `Iff.rfl` establishes that the grammar's composition of lexicon
  denotations is *definitionally* the hand statement. It adds nothing beyond
  typechecking; the load-bearing content is the corresponding theorem in
  `SpecCnl.Proofs`, which proves `hand_X` is true of the model.
* A bridge with a real proof establishes a non-trivial equivalence — stripping the `True`
  that a type-as-common-noun entry introduces, turning `∀ t, x ≠ some t` into
  `x = none`, or moving between an existential label pattern and an instantiated
  constructor. Those are stated as tactic proofs so the work is visible.

Neither kind says the controlled sentence means what the SPEC prose means. Nothing in
this repository checks that; it is the review question the corpus record's `dropped` list
exists to make answerable.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §5.2 `C13-RUN-ANCESTRY` -/

def hand_C13_RUN_ANCESTRY : Prop :=
  ∀ (left right : GraphStore), left.commits = right.commits →
    ∀ (ancestor child : CommitId), Ancestor left ancestor child ↔ Ancestor right ancestor child

theorem bridge_C13_RUN_ANCESTRY :
    Sentences.cnl_C13_RUN_ANCESTRY ↔ hand_C13_RUN_ANCESTRY := Iff.rfl

/-! ## §6.1 `C13-SUBSCRIPTION-ACCEPTED-TIERS` -/

def hand_C13_SUBSCRIPTION_ACCEPTED_TIERS : Prop :=
  ∀ (accepted : TrustTier → Bool), ∃ (subscription : RoutedSubscription),
    subscription.admits = accepted

theorem bridge_C13_SUBSCRIPTION_ACCEPTED_TIERS :
    Sentences.cnl_C13_SUBSCRIPTION_ACCEPTED_TIERS ↔ hand_C13_SUBSCRIPTION_ACCEPTED_TIERS := by
  simp [Sentences.cnl_C13_SUBSCRIPTION_ACCEPTED_TIERS, hand_C13_SUBSCRIPTION_ACCEPTED_TIERS,
    qEvery, qSomeObj]

/-! ## §6.1 `C13-TRUST-VERIFIED-INGRESS` -/

def hand_C13_TRUST_VERIFIED_INGRESS : Prop :=
  ∀ (event : Event),
    (∃ leases now before after id,
      EventStep leases now before (EventLabel.publish id) after ∧
        after.events id = some event) →
    event.assertedTier = none

theorem bridge_C13_TRUST_VERIFIED_INGRESS :
    Sentences.cnl_C13_TRUST_VERIFIED_INGRESS ↔ hand_C13_TRUST_VERIFIED_INGRESS := by
  unfold Sentences.cnl_C13_TRUST_VERIFIED_INGRESS hand_C13_TRUST_VERIFIED_INGRESS qEvery qNoObj
  constructor
  · intro claim event published
    cases tier : event.assertedTier with
    | none => rfl
    | some asserted => exact absurd tier (claim event published asserted trivial)
  · intro claim event published asserted _ equal
    rw [claim event published] at equal
    simp at equal

/-! ## §5.3 `C13-TURN-LEASE-EXPIRY` -/

def hand_C13_TURN_LEASE_EXPIRY : Prop :=
  ∀ (before after : TurnLease) (holder : PrincipalRef) (now expiresAt : Time),
    LeaseStep before (LeaseLabel.reclaim holder now expiresAt) after →
      before.expiresAt.tick ≤ now.tick

theorem bridge_C13_TURN_LEASE_EXPIRY :
    Sentences.cnl_C13_TURN_LEASE_EXPIRY ↔ hand_C13_TURN_LEASE_EXPIRY := by
  unfold Sentences.cnl_C13_TURN_LEASE_EXPIRY hand_C13_TURN_LEASE_EXPIRY trRequires
  constructor
  · intro claim before after holder now expiresAt step
    exact claim before _ after ⟨⟨holder, now, expiresAt, rfl⟩, step⟩ holder now expiresAt rfl
  · intro claim before label after step holder now expiresAt equal
    exact claim before after holder now expiresAt (equal ▸ step.2)

/-! ## §7.4 `C13-EFFECT-ATTEMPT-IMMUTABLE` -/

def hand_C13_EFFECT_ATTEMPT_IMMUTABLE : Prop :=
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    EffectStep before label after →
      ∀ id attempt, before.attempts id = some attempt → after.attempts id = some attempt

theorem bridge_C13_EFFECT_ATTEMPT_IMMUTABLE :
    Sentences.cnl_C13_EFFECT_ATTEMPT_IMMUTABLE ↔ hand_C13_EFFECT_ATTEMPT_IMMUTABLE := Iff.rfl

/-! ## §7.4 `C13-RECEIPT-ID-NAMESPACE` -/

def hand_C13_RECEIPT_ID_NAMESPACE : Prop :=
  ∀ (before : EffectLedger) (label : EffectLabel) (after : EffectLedger),
    EffectStep before label after → ReceiptIdsDisjoint before → ReceiptIdsDisjoint after

theorem bridge_C13_RECEIPT_ID_NAMESPACE :
    Sentences.cnl_C13_RECEIPT_ID_NAMESPACE ↔ hand_C13_RECEIPT_ID_NAMESPACE := Iff.rfl

/-! ## §5.2 `C13-RUN-GRAPH-ARITY` -/

def hand_C13_RUN_GRAPH_ARITY : Prop :=
  ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
    ((∃ id expected commit conversation tree,
        label = GraphLabel.append id expected commit ∧
          commit.kind = RunCommitKind.merge conversation tree) ∧
      ∃ effects events audit, GraphStep effects events audit before label after) →
    ∀ id expected commit, label = GraphLabel.append id expected commit →
      commit.parents.length = 2

theorem bridge_C13_RUN_GRAPH_ARITY :
    Sentences.cnl_C13_RUN_GRAPH_ARITY ↔ hand_C13_RUN_GRAPH_ARITY := Iff.rfl

/-! ## §5.2 `C13-RUN-UNDO-FENCE` -/

def hand_C13_RUN_UNDO_FENCE : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit selected receipt,
          label = GraphLabel.append id expected commit ∧
            commit.kind = RunCommitKind.undo selected receipt) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        BranchUnheld before commit.run commit.branch) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ id expected commit selected receipt,
          label = GraphLabel.append id expected commit ∧
            commit.kind = RunCommitKind.undo selected receipt) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ id expected commit, label = GraphLabel.append id expected commit →
        ∀ selected receipt, commit.kind = RunCommitKind.undo selected receipt →
          ∃ parent, parent ∈ commit.parents ∧ Ancestor before selected parent

theorem bridge_C13_RUN_UNDO_FENCE :
    Sentences.cnl_C13_RUN_UNDO_FENCE ↔ hand_C13_RUN_UNDO_FENCE := Iff.rfl

/-! ## §3.3 `C13-AUTH-GUEST-VERIFICATION` -/

def hand_C13_AUTH_GUEST_VERIFICATION : Prop :=
  ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
    (∃ role, MaterializationStep before membership role after) →
      ∀ home principal scheme, membership.subject = Subject.foreign home principal scheme →
        before.foreignVerified home principal

theorem bridge_C13_AUTH_GUEST_VERIFICATION :
    Sentences.cnl_C13_AUTH_GUEST_VERIFICATION ↔ hand_C13_AUTH_GUEST_VERIFICATION := Iff.rfl

/-! ## §8.2 `C13-CONTENT-RESOLUTION` -/

def hand_C13_CONTENT_RESOLUTION : Prop :=
  ∀ (before : ContentLedger) (label : ContentLabel) (after : ContentLedger),
    ((∃ ref requester, label = ContentLabel.resolve ref requester) ∧
      ContentStep before label after) →
    ∀ ref requester, label = ContentLabel.resolve ref requester →
      requester = ref.tenant ∨ before.crossTenantGrants requester ref

theorem bridge_C13_CONTENT_RESOLUTION :
    Sentences.cnl_C13_CONTENT_RESOLUTION ↔ hand_C13_CONTENT_RESOLUTION := Iff.rfl

/-! ## §5.2 `C13-RUN-ACCEPTANCE-OBLIGATION` -/

def hand_C13_RUN_ACCEPTANCE_OBLIGATION : Prop :=
  ∀ (store : GraphStore) (run : RunId) (left right : TreeId),
    store.HeadTree run left → store.HeadTree run right → left = right

theorem bridge_C13_RUN_ACCEPTANCE_OBLIGATION :
    Sentences.cnl_C13_RUN_ACCEPTANCE_OBLIGATION ↔ hand_C13_RUN_ACCEPTANCE_OBLIGATION := Iff.rfl

end SpecCnl.Bridge
