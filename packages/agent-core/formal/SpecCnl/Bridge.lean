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

/-! ## §3.5 `C13-CONFIG-SECRET-REF` -/

def hand_C13_CONFIG_SECRET_REF : Prop :=
  ∀ (before : SecretLedger) (label : SecretLabel) (after : SecretLedger),
    SecretStep before label after → CarrierRefOnly before → CarrierRefOnly after

theorem bridge_C13_CONFIG_SECRET_REF :
    Sentences.cnl_C13_CONFIG_SECRET_REF ↔ hand_C13_CONFIG_SECRET_REF := Iff.rfl

/-! ## §8.2 `C13-CONTENT-CUSTODY` -/

def hand_C13_CONTENT_CUSTODY : Prop :=
  (∀ (before : ContentLedger) (label : ContentLabel) (after : ContentLedger),
      ContentStep before label after → OwnedImpliesStored before → OwnedImpliesStored after) ∧
    ∀ (before : ContentLedger) (label : ContentLabel) (after : ContentLedger),
      ((∃ ref, label = ContentLabel.collect ref) ∧ ContentStep before label after) →
      ∀ ref, label = ContentLabel.collect ref →
        ∀ record, ¬ before.owningRecords ref record

theorem bridge_C13_CONTENT_CUSTODY :
    Sentences.cnl_C13_CONTENT_CUSTODY ↔ hand_C13_CONTENT_CUSTODY := Iff.rfl

/-! ## §3.2 `C13-AUTH-SCOPE-DIRECTION` -/

def hand_C13_AUTH_SCOPE_DIRECTION : Prop :=
  (∀ (left middle right : Scope),
      ScopeReaches left middle → ScopeReaches middle right → ScopeReaches left right) ∧
    ∀ (left right : Scope), ScopeReaches left right → ScopeReaches right left → left = right

theorem bridge_C13_AUTH_SCOPE_DIRECTION :
    Sentences.cnl_C13_AUTH_SCOPE_DIRECTION ↔ hand_C13_AUTH_SCOPE_DIRECTION := Iff.rfl

/-! ## §7.4 `C13-AUDIT-EDGE-RELATION` -/

def hand_C13_AUDIT_EDGE_RELATION : Prop :=
  (∀ (before : AuditLog) (label : AuditLabel) (after : AuditLog),
      (∃ effects events, AuditStep effects events before label after) →
        ∀ id entry, before.entries id = some entry → after.entries id = some entry) ∧
    ∀ (before : AuditLog) (label : AuditLabel) (after : AuditLog),
      (∃ effects events, AuditStep effects events before label after) →
        ∃ id entry, after.entries id = some entry ∧
          ∀ cause, entry.cause = some cause →
            ∃ parent, before.entries cause = some parent ∧ parent.actor = entry.actor ∧
              parent.sequence < entry.sequence ∧ parent.correlation = entry.correlation ∧
              MayCause parent.kind entry.kind

theorem bridge_C13_AUDIT_EDGE_RELATION :
    Sentences.cnl_C13_AUDIT_EDGE_RELATION ↔ hand_C13_AUDIT_EDGE_RELATION := Iff.rfl

/-! ## §6.2 `C13-ROUTE-DELIVERY-ONCE` -/

def hand_C13_ROUTE_DELIVERY_ONCE : Prop :=
  (∀ (before : SubscriptionLedger) (label : RoutingLabel) (after : SubscriptionLedger),
      RoutingStep before label after →
        ∀ subscription key, before.consumed subscription key → after.consumed subscription key) ∧
    ∀ (before : SubscriptionLedger) (label : RoutingLabel) (after : SubscriptionLedger),
      ((∃ subscription event target, label = RoutingLabel.fire subscription event target) ∧
        RoutingStep before label after) →
      ∀ subscription event target, label = RoutingLabel.fire subscription event target →
        ∀ record, before.events event = some record →
          ¬ before.consumed subscription record.key

theorem bridge_C13_ROUTE_DELIVERY_ONCE :
    Sentences.cnl_C13_ROUTE_DELIVERY_ONCE ↔ hand_C13_ROUTE_DELIVERY_ONCE := Iff.rfl

/-! ## §4.5 `C13-ENVIRONMENT-STALE-SESSION`, `C13-ENVIRONMENT-ROTATION`,
`C13-ENVIRONMENT-DISPOSE-CLOSE` -/

def hand_C13_ENVIRONMENT_SESSION_LIFECYCLE : Prop :=
  ((∀ (before : EnvironmentLedger) (label : EnvironmentLabel) (after : EnvironmentLedger),
      EnvironmentStep before label after →
        ∀ use, label.use? = some use →
          ∃ session, before.sessions use.session = some session ∧
            session.phase = SessionPhase.live ∧ use.epoch = session.epoch) ∧
    ∀ (before : EnvironmentLedger) (label : EnvironmentLabel) (after : EnvironmentLedger),
      ((∃ environment, label = EnvironmentLabel.rotate environment) ∧
        EnvironmentStep before label after) → after.sessions = before.sessions) ∧
  ∀ (before : EnvironmentLedger) (label : EnvironmentLabel) (after : EnvironmentLedger),
    ((∃ session, label = EnvironmentLabel.closeSession session) ∧
      EnvironmentStep before label after) →
    ∀ session, label = EnvironmentLabel.closeSession session →
      (∃ record, after.sessions session = some record ∧ record.phase = SessionPhase.closed) ∧
        (∀ path, after.files session path = none) ∧
        ∀ id exposure, after.exposures id = some exposure → exposure.session = session →
          exposure.live = false

theorem bridge_C13_ENVIRONMENT_SESSION_LIFECYCLE :
    Sentences.cnl_C13_ENVIRONMENT_SESSION_LIFECYCLE ↔
      hand_C13_ENVIRONMENT_SESSION_LIFECYCLE := Iff.rfl

/-! ## §1.5 `C13-PLACEMENT-DYNAMIC-NO-EGRESS` -/

def hand_C13_PLACEMENT_DYNAMIC_NO_EGRESS : Prop :=
  (∀ (before : DynamicDomain) (label : IsolateLabel) (after : DynamicDomain),
      (before = DynamicDomain.fresh ∧ IsolateStep before label after) →
        ∃ binding capability, label = IsolateLabel.pass binding capability) ∧
    ∀ (before : DynamicDomain) (label : IsolateLabel) (after : DynamicDomain),
      ((∃ binding destination, label = IsolateLabel.egress binding destination) ∧
        IsolateStep before label after) →
      ∀ binding destination, label = IsolateLabel.egress binding destination →
        ∃ capability, before.passed binding = some capability ∧
          capability.destination = some destination

theorem bridge_C13_PLACEMENT_DYNAMIC_NO_EGRESS :
    Sentences.cnl_C13_PLACEMENT_DYNAMIC_NO_EGRESS ↔
      hand_C13_PLACEMENT_DYNAMIC_NO_EGRESS := Iff.rfl

/-! ## §5.2 `C13-RUN-BINARY-TREE-MERGE` -/

def hand_C13_RUN_BINARY_TREE_MERGE : Prop :=
  ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
    ((∃ id expected commit conversation tree,
        label = GraphLabel.append id expected commit ∧
          commit.kind = RunCommitKind.merge conversation tree) ∧
      ∃ effects events audit, GraphStep effects events audit before label after) →
    ∀ id expected commit, label = GraphLabel.append id expected commit →
      commit.parents.length ≤ 2

theorem bridge_C13_RUN_BINARY_TREE_MERGE :
    Sentences.cnl_C13_RUN_BINARY_TREE_MERGE ↔ hand_C13_RUN_BINARY_TREE_MERGE := Iff.rfl

/-! ## §4.4 `C13-INTERCEPTOR-ORDER` -/

def hand_C13_INTERCEPTOR_ORDER : Prop :=
  (∀ (left middle right : InterceptorContribution),
      InterceptorOrder left middle → InterceptorOrder middle right →
        InterceptorOrder left right) ∧
    ∀ (contribution : InterceptorContribution), ¬ InterceptorOrder contribution contribution

theorem bridge_C13_INTERCEPTOR_ORDER :
    Sentences.cnl_C13_INTERCEPTOR_ORDER ↔ hand_C13_INTERCEPTOR_ORDER := Iff.rfl

/-! ## §9.2 `C13-BLUEPRINT-REMATERIALIZE` -/

def hand_C13_BLUEPRINT_REMATERIALIZE : Prop :=
  ∀ (before : MaterializerLedger) (label : MaterializeLabel) (after : MaterializerLedger),
    ((∃ blueprint template id, label = MaterializeLabel.materialize blueprint template id) ∧
      MaterializeStep before label after) →
    ∀ blueprint template id, label = MaterializeLabel.materialize blueprint template id →
      before.installed blueprint template.name = none

theorem bridge_C13_BLUEPRINT_REMATERIALIZE :
    Sentences.cnl_C13_BLUEPRINT_REMATERIALIZE ↔ hand_C13_BLUEPRINT_REMATERIALIZE := Iff.rfl

/-! ## §4.5 `C13-ENVIRONMENT-TURN-OWNED` -/

def hand_C13_ENVIRONMENT_TURN_OWNED : Prop :=
  ∀ (before : EnvironmentLedger) (label : EnvironmentLabel) (after : EnvironmentLedger),
    EnvironmentStep before label after →
      ∀ use, label.use? = some use →
        ∃ session lease, before.sessions use.session = some session ∧
          before.leases session.owner = some lease ∧
          use.token.turn = session.owner ∧ lease.Admits use.token use.now

theorem bridge_C13_ENVIRONMENT_TURN_OWNED :
    Sentences.cnl_C13_ENVIRONMENT_TURN_OWNED ↔ hand_C13_ENVIRONMENT_TURN_OWNED := Iff.rfl

/-! ## §3.5 `C13-AUTH-SECRET-SCOPE` -/

def hand_C13_AUTH_SECRET_SCOPE : Prop :=
  ∀ (before : SecretLedger) (label : SecretLabel) (after : SecretLedger),
    ((∃ id secret requester binding endpoint,
        label = SecretLabel.resolve id secret requester binding endpoint) ∧
      SecretStep before label after) →
    ∀ id secret requester binding endpoint,
      label = SecretLabel.resolve id secret requester binding endpoint →
        requester = secret.source

theorem bridge_C13_AUTH_SECRET_SCOPE :
    Sentences.cnl_C13_AUTH_SECRET_SCOPE ↔ hand_C13_AUTH_SECRET_SCOPE := Iff.rfl

/-! ## §7.3 `C13-PREPARED-APPROVAL-UNIQUE` -/

def hand_C13_PREPARED_APPROVAL_UNIQUE : Prop :=
  ∀ (ledger : ApprovalLedger) (invocation : InvocationId) (left right : ApprovalId),
    ledger.approvalFor invocation = some left →
      ledger.approvalFor invocation = some right → left = right

theorem bridge_C13_PREPARED_APPROVAL_UNIQUE :
    Sentences.cnl_C13_PREPARED_APPROVAL_UNIQUE ↔
      hand_C13_PREPARED_APPROVAL_UNIQUE := Iff.rfl

/-! ## §8.5 `C13-PROTOCOL-DUPLICATE` -/

def hand_C13_PROTOCOL_DUPLICATE : Prop :=
  (∀ (before : SubmissionLedger) (label : SubmissionLabel) (after : SubmissionLedger),
      ((∃ id, label = SubmissionLabel.resubmit id) ∧ SubmissionStep before label after) →
        after.reserved = before.reserved ∧ after.invoked = before.invoked) ∧
    ∀ (before : SubmissionLedger) (label : SubmissionLabel) (after : SubmissionLedger),
      ((∃ id, label = SubmissionLabel.resubmit id) ∧ SubmissionStep before label after) →
      ∀ id, label = SubmissionLabel.resubmit id →
        ∃ write originalId original,
          after.writes id = some write ∧
          before.reserved write.identity = some originalId ∧
          before.writes originalId = some original ∧
          original.identity = write.identity ∧
          write.outcome = SubmissionOutcome.duplicate originalId ∧
          write.reply = original.reply

theorem bridge_C13_PROTOCOL_DUPLICATE :
    Sentences.cnl_C13_PROTOCOL_DUPLICATE ↔ hand_C13_PROTOCOL_DUPLICATE := Iff.rfl

end SpecCnl.Bridge
