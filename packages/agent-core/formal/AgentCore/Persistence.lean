import AgentCore.Model

/-!
# Actor-local persistence (SPEC §8.1, §8.4, §14)

An Actor is one authoritative coordination unit owning its mailbox, its local transaction
boundary, and its durable fencing state. Everywhere else in this package an Actor's storage
is treated as a *value*: a ledger steps from one complete state to the next, and no theorem
contemplates half a transition being durable. This module is where that treatment is earned
rather than assumed.

The concrete machine here has what the implementation has and the value treatment does not:
an *open transaction*, holding the storage it opened against and the writes staged so far.
`MemoryActorStore` stages onto a detached clone and promotes it only on the success path;
`SqliteActorStore` stages inside a `BEGIN`. Either way there are reachable states carrying
staged-but-undurable writes, and the question is whether any of them can be observed as
durable. `durable_state_refines_the_atomic_actor` answers it: every reachable concrete
storage is one the atomic machine — where a transaction is a single state change — also
reaches. A crash at any point therefore recovers a state the rest of this package describes.

That refinement rests on one invariant, and the invariant on one implementation guard.
`reachable_transaction_anchored` says an open transaction's base is still the current
storage, which is what makes its staged writes replayable against that storage at commit. It
holds only because `begin` refuses to open a second transaction over an open one — the guard
both stores spell "Nested actor transactions are not supported".

## What is assumed, and what that assumption buys

Not proved here, because it is not this package's to prove: that SQLite, or the Durable
Object storage under it, commits atomically. The two-branch semantics of `commitUnknown` —
the durable outcome is the base or the whole commit, never a mixture — is the modeled form
of the SPEC §14 assumption, registered as `ASM-ACTOR-LOCAL-ATOMICITY`. It is a premise, not
a result, and every theorem below inherits it.

What *is* proved is what an Actor may conclude given it. The fence rotation is among the
writes whose fate the caller never learns, so the two branches leave different durable
epochs; a still-serving incarnation would then admit a command on evidence that decides
nothing (`serving_past_commit_unknown_is_branch_dependent`), while an incarnation that
closes and re-activates lands where both branches agree
(`reactivation_resolves_commit_unknown`).
-/

namespace AgentCore

/-- The fence an incarnation holds: this Actor, at this epoch. -/
structure ActorFence where
  actor : ActorRef
  epoch : Nat
  deriving DecidableEq, Repr

/-- The durable fencing record. `epoch` fences commands; `recoveries` counts activations. -/
structure ActorRecovery where
  actor : ActorRef
  epoch : Nat
  recoveries : Nat
  deriving DecidableEq, Repr

def ActorRecovery.fence (state : ActorRecovery) : ActorFence := ⟨state.actor, state.epoch⟩

def ActorRecovery.initial (actor : ActorRef) : ActorRecovery := ⟨actor, 0, 1⟩

/-- Activation of storage that already held a record: a new incarnation. -/
def ActorRecovery.recover (state : ActorRecovery) : ActorRecovery :=
  ⟨state.actor, state.epoch + 1, state.recoveries + 1⟩

/-- A fence rotation inside a live incarnation. Deliberately not `recover`: the epoch moves,
the activation count does not. -/
def ActorRecovery.advance (state : ActorRecovery) : ActorRecovery :=
  ⟨state.actor, state.epoch + 1, state.recoveries⟩

/-- One Actor's own durable storage: the singleton identity row, the fencing record, and the
Actor-owned records SPEC §14 requires persistence to preserve append-only. -/
structure ActorStorage where
  identity : Option ActorRef
  recovery : Option ActorRecovery
  journal : List Nat
  deriving DecidableEq, Repr

def ActorStorage.empty : ActorStorage := ⟨none, none, []⟩

def ActorStorage.epoch (storage : ActorStorage) : Nat := storage.recovery.elim 0 (·.epoch)

/-- The storage an activation writes back: the identity row bound and the fencing record
replaced, with the Actor's own records untouched. -/
def ActorStorage.activated (storage : ActorStorage) (actor : ActorRef) (state : ActorRecovery) :
    ActorStorage :=
  { storage with identity := some actor, recovery := some state }


/-! ## Activation: the decision both stores run

`activateExec` is the executable model of `activateActor`, in the precedence the
implementation checks: the identity binding first, then the record's own provenance, then
the two consistency guards, then `initial` or `recover`. It is not a mirror proved equal to
a separate relation — it *is* the modeled decision, and the transition system below admits
an activation exactly when it succeeds. -/

inductive ActivationFault where
  /-- Storage is already bound to a different Actor. -/
  | foreignActor
  /-- The stored record names an Actor other than the one whose key holds it. -/
  | foreignRecovery
  /-- Bound storage carrying no fencing record. -/
  | missingRecoveryState
  /-- Unbound storage carrying a fencing record. -/
  | unboundRecoveryState
  deriving DecidableEq, Repr

inductive ActivationKind where
  | created
  | recovered
  deriving DecidableEq, Repr

structure Activation where
  kind : ActivationKind
  state : ActorRecovery
  deriving DecidableEq, Repr

def activateExec (storage : ActorStorage) (actor : ActorRef) :
    Except ActivationFault (ActorStorage × Activation) :=
  match storage.identity, storage.recovery with
  | none, none =>
      .ok (storage.activated actor (ActorRecovery.initial actor),
        ⟨.created, ActorRecovery.initial actor⟩)
  | none, some previous =>
      -- The record's provenance is checked where it is read, so a record whose payload
      -- disagrees with the key it was read under is refused before the binding is.
      if previous.actor = actor then .error .unboundRecoveryState else .error .foreignRecovery
  | some bound, none =>
      if bound = actor then .error .missingRecoveryState else .error .foreignActor
  | some bound, some previous =>
      if bound = actor then
        if previous.actor = actor then
          .ok (storage.activated actor previous.recover, ⟨.recovered, previous.recover⟩)
        else .error .foreignRecovery
      else .error .foreignActor

theorem activateExec_created {storage : ActorStorage} {actor : ActorRef}
    (identity : storage.identity = none) (recovery : storage.recovery = none) :
    activateExec storage actor =
      .ok (storage.activated actor (ActorRecovery.initial actor),
        ⟨.created, ActorRecovery.initial actor⟩) := by
  unfold activateExec; rw [identity, recovery]

theorem activateExec_recovered {storage : ActorStorage} {actor : ActorRef}
    {previous : ActorRecovery} (identity : storage.identity = some actor)
    (recovery : storage.recovery = some previous) (owned : previous.actor = actor) :
    activateExec storage actor =
      .ok (storage.activated actor previous.recover, ⟨.recovered, previous.recover⟩) := by
  unfold activateExec; rw [identity, recovery]; simp [owned]

theorem activateExec_unbound_recovery {storage : ActorStorage} {actor : ActorRef}
    {previous : ActorRecovery} (identity : storage.identity = none)
    (recovery : storage.recovery = some previous) (owned : previous.actor = actor) :
    activateExec storage actor = .error .unboundRecoveryState := by
  unfold activateExec; rw [identity, recovery]; simp [owned]

theorem activateExec_unbound_foreign_recovery {storage : ActorStorage} {actor : ActorRef}
    {previous : ActorRecovery} (identity : storage.identity = none)
    (recovery : storage.recovery = some previous) (foreign : previous.actor ≠ actor) :
    activateExec storage actor = .error .foreignRecovery := by
  unfold activateExec; rw [identity, recovery]; simp [foreign]

theorem activateExec_missing_recovery {storage : ActorStorage} {actor : ActorRef}
    (identity : storage.identity = some actor) (recovery : storage.recovery = none) :
    activateExec storage actor = .error .missingRecoveryState := by
  unfold activateExec; rw [identity, recovery]; simp

theorem activateExec_foreign_recovery {storage : ActorStorage} {actor : ActorRef}
    {previous : ActorRecovery} (identity : storage.identity = some actor)
    (recovery : storage.recovery = some previous) (foreign : previous.actor ≠ actor) :
    activateExec storage actor = .error .foreignRecovery := by
  unfold activateExec; rw [identity, recovery]; simp [foreign]

/-- **Activation refuses an Actor the storage is not bound to.** -/
theorem activation_refuses_a_foreign_actor {storage : ActorStorage} {bound actor : ActorRef}
    (held : storage.identity = some bound) (foreign : bound ≠ actor) :
    activateExec storage actor = .error .foreignActor := by
  unfold activateExec
  cases recovery : storage.recovery <;> rw [held] <;> simp [foreign]

/-- The two shapes a successful activation can have. Every activation theorem below is a
corollary of this one case analysis. -/
theorem activateExec_ok {storage next : ActorStorage} {actor : ActorRef} {activation : Activation}
    (activated : activateExec storage actor = .ok (next, activation)) :
    (storage.identity = none ∧ storage.recovery = none ∧
        next = storage.activated actor (ActorRecovery.initial actor) ∧
        activation = ⟨.created, ActorRecovery.initial actor⟩) ∨
      (∃ previous, storage.identity = some actor ∧ storage.recovery = some previous ∧
        previous.actor = actor ∧ next = storage.activated actor previous.recover ∧
        activation = ⟨.recovered, previous.recover⟩) := by
  cases identity : storage.identity with
  | none =>
      cases recovery : storage.recovery with
      | none =>
          rw [activateExec_created identity recovery] at activated
          simp only [Except.ok.injEq, Prod.mk.injEq] at activated
          exact .inl ⟨rfl, rfl, activated.1.symm, activated.2.symm⟩
      | some previous =>
          by_cases owned : previous.actor = actor
          · rw [activateExec_unbound_recovery identity recovery owned] at activated
            simp at activated
          · rw [activateExec_unbound_foreign_recovery identity recovery owned] at activated
            simp at activated
  | some bound =>
      by_cases same : bound = actor
      · subst same
        cases recovery : storage.recovery with
        | none =>
            rw [activateExec_missing_recovery identity recovery] at activated
            simp at activated
        | some previous =>
            by_cases owned : previous.actor = bound
            · rw [activateExec_recovered identity recovery owned] at activated
              simp only [Except.ok.injEq, Prod.mk.injEq] at activated
              exact .inr ⟨previous, rfl, rfl, owned, activated.1.symm, activated.2.symm⟩
            · rw [activateExec_foreign_recovery identity recovery owned] at activated
              simp at activated
      · rw [activation_refuses_a_foreign_actor identity same] at activated
        simp at activated

theorem activation_binds_its_own_actor {storage next actor activation}
    (activated : activateExec storage actor = .ok (next, activation)) :
    next.identity = some actor ∧ next.recovery = some activation.state ∧
      activation.state.actor = actor := by
  rcases activateExec_ok activated with ⟨_, _, shape, kind⟩ | ⟨previous, _, _, owned, shape, kind⟩
  · exact ⟨by simp [shape, ActorStorage.activated], by simp [shape, kind, ActorStorage.activated],
      by simp [kind, ActorRecovery.initial]⟩
  · exact ⟨by simp [shape, ActorStorage.activated], by simp [shape, kind, ActorStorage.activated],
      by simp [kind, ActorRecovery.recover, owned]⟩

/-- **An activation over existing storage strictly advances the epoch**; one over empty
storage starts at zero with a single recorded activation. -/
theorem activation_advances_the_epoch {storage next actor activation}
    (activated : activateExec storage actor = .ok (next, activation)) :
    (storage.recovery = none ∧ activation.kind = .created ∧ activation.state.epoch = 0 ∧
        activation.state.recoveries = 1 ∧ next.epoch = 0) ∨
      (storage.epoch < next.epoch ∧ activation.kind = .recovered ∧
        activation.state.recoveries = storage.recovery.elim 0 (·.recoveries) + 1) := by
  rcases activateExec_ok activated with ⟨_, empty, shape, kind⟩ | ⟨previous, _, held, _, shape, kind⟩
  · refine .inl ⟨empty, by simp [kind], by simp [kind, ActorRecovery.initial],
      by simp [kind, ActorRecovery.initial], ?_⟩
    simp [shape, ActorStorage.epoch, ActorStorage.activated, ActorRecovery.initial]
  · refine .inr ⟨?_, by simp [kind], by simp [kind, ActorRecovery.recover, held]⟩
    simp [shape, ActorStorage.epoch, ActorStorage.activated, held, ActorRecovery.recover]


/-! ## The command gate

`admitsCommand` is the check `Actor.mutate` runs before any command body: the incarnation's
held fence must name this Actor at the stored epoch, and a fenced command's own fence must
too. Absent storage refuses, which is what makes an un-activated store unserveable. -/

def ActorFence.matches (fence : ActorFence) (actor : ActorRef) (epoch : Nat) : Bool :=
  fence.actor == actor && fence.epoch == epoch

def admitsCommand (self : ActorRef) (held : ActorFence) (expected : Option ActorFence)
    (stored : Option ActorRecovery) : Bool :=
  match stored with
  | none => false
  | some state =>
      held.matches self state.epoch &&
        match expected with
        | none => true
        | some fence => fence.matches self state.epoch

theorem admitsCommand_refuses_absent_storage {self held expected} :
    admitsCommand self held expected none = false := rfl

/-- A fence naming any epoch but the stored one is refused, whatever else it carries. -/
theorem admitsCommand_refuses_other_epoch {self held expected} {state : ActorRecovery}
    (stale : held.epoch ≠ state.epoch) :
    admitsCommand self held expected (some state) = false := by
  simp only [admitsCommand, ActorFence.matches, Bool.and_eq_false_iff, beq_eq_false_iff_ne]
  exact .inl (.inr stale)

/-- The fence an activation issued is admitted by an unfenced command against its own
record. -/
theorem admitsCommand_admits_own_fence {state : ActorRecovery} :
    admitsCommand state.actor state.fence none (some state) = true := by
  simp [admitsCommand, ActorFence.matches, ActorRecovery.fence]


/-! ## Writes -/

inductive ActorWrite where
  | append (record : Nat)
  | advanceFence
  deriving DecidableEq, Repr

def ActorWrite.apply (storage : ActorStorage) : ActorWrite → ActorStorage
  | .append record => { storage with journal := storage.journal ++ [record] }
  | .advanceFence => { storage with recovery := storage.recovery.map ActorRecovery.advance }

def applyWrites (storage : ActorStorage) (writes : List ActorWrite) : ActorStorage :=
  writes.foldl ActorWrite.apply storage

theorem applyWrites_cons {storage : ActorStorage} {write : ActorWrite} {rest : List ActorWrite} :
    applyWrites storage (write :: rest) = applyWrites (write.apply storage) rest := rfl

theorem write_journal_extends (write : ActorWrite) (storage : ActorStorage) :
    ∃ appended, (write.apply storage).journal = storage.journal ++ appended := by
  cases write with
  | append record => exact ⟨[record], rfl⟩
  | advanceFence => exact ⟨[], by simp [ActorWrite.apply]⟩

theorem write_preserves_recoveries (write : ActorWrite) (storage : ActorStorage) :
    (write.apply storage).recovery.map (·.recoveries) = storage.recovery.map (·.recoveries) := by
  cases write with
  | append record => rfl
  | advanceFence =>
      cases stored : storage.recovery <;>
        simp [ActorWrite.apply, stored, ActorRecovery.advance]

theorem write_preserves_recovery_actor (write : ActorWrite) (storage : ActorStorage) :
    (write.apply storage).recovery.map (·.actor) = storage.recovery.map (·.actor) := by
  cases write with
  | append record => rfl
  | advanceFence =>
      cases stored : storage.recovery <;>
        simp [ActorWrite.apply, stored, ActorRecovery.advance]

theorem write_preserves_identity (write : ActorWrite) (storage : ActorStorage) :
    (write.apply storage).identity = storage.identity := by
  cases write <;> rfl

theorem write_epoch_never_decreases (write : ActorWrite) (storage : ActorStorage) :
    storage.epoch ≤ (write.apply storage).epoch := by
  cases write with
  | append record => exact Nat.le_refl _
  | advanceFence =>
      cases stored : storage.recovery with
      | none => simp [ActorWrite.apply, ActorStorage.epoch, stored]
      | some state =>
          simp [ActorWrite.apply, ActorStorage.epoch, stored, ActorRecovery.advance]

/-- **Staged writes only ever extend the record log.** Whatever a transaction stages, the
storage it produces has the base's journal as a prefix, so SPEC §14's append-only reading
survives every commit — and, below, both branches of an unknown one. -/
theorem applyWrites_journal_extends (writes : List ActorWrite) (storage : ActorStorage) :
    ∃ appended, (applyWrites storage writes).journal = storage.journal ++ appended := by
  induction writes generalizing storage with
  | nil => exact ⟨[], by simp [applyWrites]⟩
  | cons write rest ih =>
      obtain ⟨tail, tailShape⟩ := ih (write.apply storage)
      obtain ⟨head, headShape⟩ := write_journal_extends write storage
      exact ⟨head ++ tail, by rw [applyWrites_cons, tailShape, headShape, List.append_assoc]⟩

/-- **A fence rotation never forges a restart.** No sequence of writes changes the activation
count, so `recoveries` counts activations and nothing else — which is what lets `created`
(`recoveries = 1`) and `recovered` (`recoveries ≥ 2`) mean what they say. -/
theorem applyWrites_preserve_recoveries (writes : List ActorWrite) (storage : ActorStorage) :
    (applyWrites storage writes).recovery.map (·.recoveries) =
      storage.recovery.map (·.recoveries) := by
  induction writes generalizing storage with
  | nil => rfl
  | cons write rest ih => rw [applyWrites_cons, ih]; exact write_preserves_recoveries write storage

/-- Writes never clear the fencing record and never repoint it at another Actor. -/
theorem applyWrites_preserve_recovery_actor (writes : List ActorWrite) (storage : ActorStorage) :
    (applyWrites storage writes).recovery.map (·.actor) = storage.recovery.map (·.actor) := by
  induction writes generalizing storage with
  | nil => rfl
  | cons write rest ih =>
      rw [applyWrites_cons, ih]; exact write_preserves_recovery_actor write storage

theorem applyWrites_preserve_identity (writes : List ActorWrite) (storage : ActorStorage) :
    (applyWrites storage writes).identity = storage.identity := by
  induction writes generalizing storage with
  | nil => rfl
  | cons write rest ih => rw [applyWrites_cons, ih]; exact write_preserves_identity write storage

theorem applyWrites_epoch_never_decreases (writes : List ActorWrite) (storage : ActorStorage) :
    storage.epoch ≤ (applyWrites storage writes).epoch := by
  induction writes generalizing storage with
  | nil => exact Nat.le_refl _
  | cons write rest ih =>
      exact Nat.le_trans (write_epoch_never_decreases write storage) (ih (write.apply storage))

theorem applyWrites_recovery_stays_present {storage : ActorStorage} {state : ActorRecovery}
    (writes : List ActorWrite) (stored : storage.recovery = some state) :
    ∃ next, (applyWrites storage writes).recovery = some next := by
  have actors := applyWrites_preserve_recovery_actor writes storage
  rw [stored] at actors
  cases result : (applyWrites storage writes).recovery with
  | none => rw [result] at actors; simp at actors
  | some next => exact ⟨next, rfl⟩

/-- The Actor as every other module in this package reads it: a transaction is one durable
state change, and there is no state between the base and the whole commit. -/
inductive AtomicStep : ActorStorage → ActorStorage → Prop
  | bind {storage actor} :
      storage.identity = none ∨ storage.identity = some actor →
      AtomicStep storage { storage with identity := some actor }
  | activate {storage actor next activation} :
      activateExec storage actor = .ok (next, activation) → AtomicStep storage next
  | transact {storage writes} : AtomicStep storage (applyWrites storage writes)

inductive AtomicReachable : ActorStorage → Prop
  | boot : AtomicReachable ActorStorage.empty
  | step {before after} :
      AtomicReachable before → AtomicStep before after → AtomicReachable after


/-! ## The concrete Actor -/

inductive ActorPhase where
  /-- Constructed, or crashed: no incarnation is serving. -/
  | unbound
  | serving (fence : ActorFence)
  | closed
  deriving DecidableEq, Repr

/-- An open local transaction: the storage it opened against and the writes staged so far. -/
structure ActorTransaction where
  base : ActorStorage
  staged : List ActorWrite
  deriving DecidableEq, Repr

def ActorTransaction.working (txn : ActorTransaction) : ActorStorage :=
  applyWrites txn.base txn.staged

structure ActorNode where
  storage : ActorStorage
  phase : ActorPhase
  pending : Option ActorTransaction
  deriving DecidableEq, Repr

def ActorNode.boot : ActorNode := ⟨ActorStorage.empty, .unbound, none⟩

inductive ActorLabel where
  | bind (actor : ActorRef)
  | activate (actor : ActorRef)
  | begin
  | stage (write : ActorWrite)
  | commit
  | abort
  /-- The commit whose outcome the caller never learns. `committed` is the branch the
  substrate took; nothing in the Actor observes it. -/
  | commitUnknown (committed : Bool)
  | command (expected : Option ActorFence)
  /-- The volatile half is lost; durable storage survives. -/
  | crash
  deriving DecidableEq, Repr

inductive ActorStep : ActorNode → ActorLabel → ActorNode → Prop
  | bind {node actor} :
      node.pending = none →
      (node.storage.identity = none ∨ node.storage.identity = some actor) →
      ActorStep node (.bind actor)
        { node with storage := { node.storage with identity := some actor } }
  | activate {node actor storage activation} :
      node.pending = none → node.phase ≠ .closed →
      activateExec node.storage actor = .ok (storage, activation) →
      ActorStep node (.activate actor)
        { node with storage := storage, phase := .serving activation.state.fence }
  | begin {node} :
      node.pending = none → node.phase ≠ .closed →
      ActorStep node .begin { node with pending := some ⟨node.storage, []⟩ }
  | stage {node txn write} :
      node.pending = some txn →
      ActorStep node (.stage write)
        { node with pending := some { txn with staged := txn.staged ++ [write] } }
  | command {node txn self held expected} :
      node.pending = some txn → node.phase = .serving held →
      txn.working.identity = some self →
      admitsCommand self held expected txn.working.recovery = true →
      ActorStep node (.command expected) node
  | commit {node txn} :
      node.pending = some txn →
      ActorStep node .commit { node with storage := txn.working, pending := none }
  | abort {node txn} :
      node.pending = some txn →
      ActorStep node .abort { node with pending := none }
  | commitUnknown {node txn committed} :
      node.pending = some txn →
      ActorStep node (.commitUnknown committed)
        { storage := if committed then txn.working else txn.base,
          phase := .closed, pending := none }
  | crash {node} :
      ActorStep node .crash { storage := node.storage, phase := .unbound, pending := none }

inductive ActorReachable : ActorNode → Prop
  | boot : ActorReachable ActorNode.boot
  | step {before label after} :
      ActorReachable before → ActorStep before label after → ActorReachable after

/-- Reachability from a named node, so a theorem can say "at every later state" without
quantifying over how the Actor reached the earlier one. -/
inductive ActorTrace : ActorNode → ActorNode → Prop
  | refl {node} : ActorTrace node node
  | step {first middle last label} :
      ActorTrace first middle → ActorStep middle label last → ActorTrace first last

theorem trace_preserves_reachable {first last} (reachable : ActorReachable first)
    (trace : ActorTrace first last) : ActorReachable last := by
  induction trace with
  | refl => exact reachable
  | step _ step ih => exact .step ih step

/-! Reading a step back out of the relation. Stating each shape once keeps the theorems
below from re-deriving it, and keeps them independent of the constructor's binder order. -/

theorem activate_step_shape {before after actor} (step : ActorStep before (.activate actor) after) :
    ∃ activation, activateExec before.storage actor = .ok (after.storage, activation) ∧
      after.phase = .serving activation.state.fence ∧ before.pending = none ∧
      before.phase ≠ .closed := by
  cases step with
  | activate noPending notClosed activated => exact ⟨_, activated, rfl, noPending, notClosed⟩

theorem commit_unknown_step_shape {before after txn committed}
    (step : ActorStep before (.commitUnknown committed) after)
    (pending : before.pending = some txn) :
    after.storage = (if committed then txn.working else txn.base) ∧ after.phase = .closed := by
  cases step with
  | commitUnknown otherPending =>
      have same := Option.some.inj (otherPending.symm.trans pending)
      subst same
      exact ⟨rfl, rfl⟩

theorem command_step_shape {node after expected} (step : ActorStep node (.command expected) after) :
    ∃ txn self held, node.pending = some txn ∧ node.phase = .serving held ∧
      txn.working.identity = some self ∧
      admitsCommand self held expected txn.working.recovery = true := by
  cases step with
  | command pending serving identity admitted =>
      exact ⟨_, _, _, pending, serving, identity, admitted⟩


/-! ## The nesting guard, and the refinement it buys -/

/-- An open transaction's base is still the current storage. -/
def TransactionAnchored (node : ActorNode) : Prop :=
  ∀ txn, node.pending = some txn → txn.base = node.storage

/-- **While a transaction is open, storage is frozen.** Every step that changes storage
demands no open transaction, and every step that leaves one open leaves storage alone. The
`begin` guard both stores spell "Nested actor transactions are not supported" is what
excludes the remaining case: a second transaction would snapshot a base the first is about
to overwrite, and its commit would then discard the first's writes. -/
theorem reachable_transaction_anchored {node : ActorNode} (reachable : ActorReachable node) :
    TransactionAnchored node := by
  induction reachable with
  | boot => intro txn pending; simp [ActorNode.boot] at pending
  | @step before label after _ step ih =>
      cases step with
      | @bind actor noPending _ => intro txn pending; simp [noPending] at pending
      | @activate actor storage activation noPending _ _ =>
          intro txn pending; simp [noPending] at pending
      | @begin _ _ =>
          intro txn pending
          simp only at pending
          rw [← Option.some.inj pending]
      | @stage txn write pending =>
          intro other otherPending
          simp only at otherPending
          rw [← Option.some.inj otherPending]
          exact ih txn pending
      | @command txn self held expected _ _ _ _ => exact ih
      | @commit txn _ => intro other otherPending; simp at otherPending
      | @abort txn _ => intro other otherPending; simp at otherPending
      | @commitUnknown txn committed _ => intro other otherPending; simp at otherPending
      | crash => intro other otherPending; simp at otherPending

/-- **Every durable state a crash can expose is one the atomic Actor reaches.** The concrete
machine has states holding staged, undurable writes; none of them is ever the storage. This
is the refinement the rest of this package relies on when it treats an Actor's storage as a
value that steps whole. -/
theorem durable_state_refines_the_atomic_actor {node : ActorNode}
    (reachable : ActorReachable node) : AtomicReachable node.storage := by
  induction reachable with
  | boot => exact AtomicReachable.boot
  | @step before label after prior step ih =>
      cases step with
      | @bind actor _ binding => exact .step ih (.bind binding)
      | @activate actor storage activation _ _ activated => exact .step ih (.activate activated)
      | @begin _ _ => exact ih
      | @stage txn write _ => exact ih
      | @command txn self held expected _ _ _ _ => exact ih
      | @commit txn pending =>
          have base : txn.base = before.storage := reachable_transaction_anchored prior txn pending
          show AtomicReachable txn.working
          rw [ActorTransaction.working, base]
          exact .step ih AtomicStep.transact
      | @abort txn _ => exact ih
      | @commitUnknown txn committed pending =>
          have base : txn.base = before.storage := reachable_transaction_anchored prior txn pending
          cases committed with
          | false =>
              show AtomicReachable txn.base
              rw [base]
              exact ih
          | true =>
              show AtomicReachable txn.working
              rw [ActorTransaction.working, base]
              exact .step ih AtomicStep.transact
      | crash => exact ih

/-- **Staging is invisible.** No `stage` step changes durable storage, whatever it stages. -/
theorem staged_writes_are_not_durable {before after write}
    (step : ActorStep before (.stage write) after) : after.storage = before.storage := by
  cases step; rfl

/-- **Rollback restores the base exactly** — the whole staged sequence, not part of it. -/
theorem abort_discards_every_staged_write {before after txn}
    (step : ActorStep before .abort after) (pending : before.pending = some txn)
    (anchored : TransactionAnchored before) :
    after.storage = txn.base ∧ after.pending = none := by
  cases step with
  | @abort other _ => exact ⟨(anchored txn pending).symm, rfl⟩

/-- **Commit applies exactly the staged writes to exactly the base.** -/
theorem commit_applies_exactly_the_staged_writes {before after txn}
    (step : ActorStep before .commit after) (pending : before.pending = some txn) :
    after.storage = applyWrites txn.base txn.staged := by
  cases step with
  | @commit other otherPending =>
      have same : other = txn := Option.some.inj (otherPending.symm.trans pending)
      show applyWrites other.base other.staged = applyWrites txn.base txn.staged
      rw [same]


/-! ## Uniqueness: one storage, one Actor -/

theorem step_preserves_bound_identity {before after label} {actor : ActorRef}
    (anchored : TransactionAnchored before) (step : ActorStep before label after)
    (bound : before.storage.identity = some actor) :
    after.storage.identity = some actor := by
  cases step with
  | @bind other _ binding =>
      cases binding with
      | inl unbound => exact absurd (unbound.symm.trans bound) (by simp)
      | inr same =>
          have : other = actor := Option.some.inj (same.symm.trans bound)
          simp [this]
  | @activate other storage activation _ _ activated =>
      by_cases same : actor = other
      · simpa [same] using (activation_binds_its_own_actor activated).1
      · rw [activation_refuses_a_foreign_actor bound same] at activated
        simp at activated
  | @begin _ _ => exact bound
  | @stage txn write _ => exact bound
  | @command txn self held expected _ _ _ _ => exact bound
  | @commit txn pending =>
      have base : txn.base = before.storage := anchored txn pending
      show (applyWrites txn.base txn.staged).identity = some actor
      rw [applyWrites_preserve_identity, base]
      exact bound
  | @abort txn _ => exact bound
  | @commitUnknown txn committed pending =>
      have base : txn.base = before.storage := anchored txn pending
      cases committed with
      | false =>
          show txn.base.identity = some actor
          rw [base]; exact bound
      | true =>
          show (applyWrites txn.base txn.staged).identity = some actor
          rw [applyWrites_preserve_identity, base]
          exact bound
  | crash => exact bound

/-- Once bound, always bound to the same Actor, at every later state. -/
theorem trace_preserves_bound_identity {first last} {actor : ActorRef}
    (reachable : ActorReachable first) (trace : ActorTrace first last)
    (bound : first.storage.identity = some actor) :
    last.storage.identity = some actor := by
  induction trace with
  | refl => exact bound
  | step sub st ih =>
      exact step_preserves_bound_identity
        (reachable_transaction_anchored (trace_preserves_reachable reachable sub)) st ih

/-- **One storage serves one Actor.** Two activations anywhere in one history name the same
Actor: the first binds the identity, the binding survives every later step, and the second
activation is refused for anything else. This is what stops a recovered Actor from reading
another Actor's fencing record. -/
theorem one_storage_serves_one_actor {first second : ActorRef} {before started later after}
    (reachable : ActorReachable before)
    (firstActivation : ActorStep before (.activate first) started)
    (between : ActorTrace started later)
    (secondActivation : ActorStep later (.activate second) after) : first = second := by
  obtain ⟨activation, activated, _, _, _⟩ := activate_step_shape firstActivation
  have bound : started.storage.identity = some first :=
    (activation_binds_its_own_actor activated).1
  have carried : later.storage.identity = some first :=
    trace_preserves_bound_identity (.step reachable firstActivation) between bound
  obtain ⟨_, secondExec, _, _, _⟩ := activate_step_shape secondActivation
  by_cases same : first = second
  · exact same
  · rw [activation_refuses_a_foreign_actor carried same] at secondExec
    simp at secondExec


/-! ## Restart: the epoch, and the fences it retires -/

/-- No step lowers the durable epoch. A rolled-back rotation is not a decrease: the rotation
was never durable. -/
theorem step_epoch_never_decreases {before after label} (anchored : TransactionAnchored before)
    (step : ActorStep before label after) : before.storage.epoch ≤ after.storage.epoch := by
  cases step with
  | @bind actor _ _ => exact Nat.le_refl _
  | @activate actor storage activation _ _ activated =>
      rcases activation_advances_the_epoch activated with ⟨empty, _, _, _, zero⟩ | ⟨advanced, _, _⟩
      · show before.storage.epoch ≤ storage.epoch
        rw [zero]
        simp [ActorStorage.epoch, empty]
      · exact Nat.le_of_lt advanced
  | @begin _ _ => exact Nat.le_refl _
  | @stage txn write _ => exact Nat.le_refl _
  | @command txn self held expected _ _ _ _ => exact Nat.le_refl _
  | @commit txn pending =>
      have base : txn.base = before.storage := anchored txn pending
      show before.storage.epoch ≤ (applyWrites txn.base txn.staged).epoch
      rw [base]
      exact applyWrites_epoch_never_decreases txn.staged before.storage
  | @abort txn _ => exact Nat.le_refl _
  | @commitUnknown txn committed pending =>
      have base : txn.base = before.storage := anchored txn pending
      cases committed with
      | false =>
          show before.storage.epoch ≤ txn.base.epoch
          rw [base]
          exact Nat.le_refl _
      | true =>
          show before.storage.epoch ≤ (applyWrites txn.base txn.staged).epoch
          rw [base]
          exact applyWrites_epoch_never_decreases txn.staged before.storage
  | crash => exact Nat.le_refl _

theorem trace_epoch_never_decreases {first last} (reachable : ActorReachable first)
    (trace : ActorTrace first last) : first.storage.epoch ≤ last.storage.epoch := by
  induction trace with
  | refl => exact Nat.le_refl _
  | step sub st ih =>
      exact Nat.le_trans ih (step_epoch_never_decreases
        (reachable_transaction_anchored (trace_preserves_reachable reachable sub)) st)

/-- **A fence held before a restart is never admitted again.** Not by the restarted
incarnation, and not by any state it later reaches: the activation strictly advances the
epoch and nothing lowers it. This is SPEC §8.1's "rejects stale fences" as a property of
every reachable successor, rather than of the next command only. -/
theorem pre_restart_fence_never_readmitted {before restarted later actor previous held expected}
    (reachable : ActorReachable before)
    (activation : ActorStep before (.activate actor) restarted)
    (bound : before.storage.recovery = some previous) (stale : held.epoch ≤ previous.epoch)
    (afterwards : ActorTrace restarted later) :
    admitsCommand actor held expected later.storage.recovery = false := by
  have advanced : previous.epoch < restarted.storage.epoch := by
    obtain ⟨act, activated, _, _, _⟩ := activate_step_shape activation
    rcases activation_advances_the_epoch activated with ⟨empty, _⟩ | ⟨strict, _⟩
    · exact absurd (empty.symm.trans bound) (by simp)
    · simpa [ActorStorage.epoch, bound] using strict
  have carried : previous.epoch < later.storage.epoch :=
    Nat.lt_of_lt_of_le advanced
      (trace_epoch_never_decreases (.step reachable activation) afterwards)
  cases stored : later.storage.recovery with
  | none => exact admitsCommand_refuses_absent_storage
  | some state =>
      refine admitsCommand_refuses_other_epoch (Nat.ne_of_lt ?_)
      have : previous.epoch < state.epoch := by
        simpa [ActorStorage.epoch, stored] using carried
      exact Nat.lt_of_le_of_lt stale this


/-! ## The activation guards, and which of them the Actor's own steps can trip -/

/-- The record a store holds names the Actor the store is bound to. -/
def RecoveryIsBound (storage : ActorStorage) : Prop :=
  ∀ state, storage.recovery = some state → storage.identity = some state.actor

theorem applyWrites_preserve_bound {storage : ActorStorage} {writes : List ActorWrite}
    (bound : RecoveryIsBound storage) : RecoveryIsBound (applyWrites storage writes) := by
  intro state stored
  rw [applyWrites_preserve_identity writes storage]
  have actors := applyWrites_preserve_recovery_actor writes storage
  rw [stored] at actors
  cases source : storage.recovery with
  | none => rw [source] at actors; simp at actors
  | some original =>
      rw [source] at actors
      have same : state.actor = original.actor := by simpa using actors
      rw [same]
      exact bound original source

/-- Every step writes the fencing record under the identity it names. -/
theorem reachable_recovery_is_bound {node : ActorNode} (reachable : ActorReachable node) :
    RecoveryIsBound node.storage := by
  induction reachable with
  | boot => intro state stored; simp [ActorNode.boot, ActorStorage.empty] at stored
  | @step before label after prior step ih =>
      have anchored := reachable_transaction_anchored prior
      cases step with
      | @bind actor _ binding =>
          intro state stored
          have held := ih state stored
          cases binding with
          | inl unbound => exact absurd (unbound.symm.trans held) (by simp)
          | inr same =>
              have : actor = state.actor := Option.some.inj (same.symm.trans held)
              simp [this]
      | @activate actor storage activation _ _ activated =>
          intro state stored
          obtain ⟨identity, recovery, owner⟩ := activation_binds_its_own_actor activated
          have same : state = activation.state := Option.some.inj (stored.symm.trans recovery)
          simpa [same, owner] using identity
      | @begin _ _ => exact ih
      | @stage txn write _ => exact ih
      | @command txn self held expected _ _ _ _ => exact ih
      | @commit txn pending =>
          have base : txn.base = before.storage := anchored txn pending
          show RecoveryIsBound (applyWrites txn.base txn.staged)
          rw [base]
          exact applyWrites_preserve_bound ih
      | @abort txn _ => exact ih
      | @commitUnknown txn committed pending =>
          have base : txn.base = before.storage := anchored txn pending
          cases committed with
          | false =>
              show RecoveryIsBound txn.base
              rw [base]
              exact ih
          | true =>
              show RecoveryIsBound (applyWrites txn.base txn.staged)
              rw [base]
              exact applyWrites_preserve_bound ih
      | crash => exact ih

/-- **Neither record-provenance fault is reachable by the Actor's own steps.**
`unboundRecoveryState` and `foreignRecovery` screen the storage layer, not the logic: they
detect a fencing record with no identity row, or one whose payload disagrees with the key it
was read under, and no reachable step writes either. Both are reachable by *some* storage —
`nonvacuous_actor_activation_discriminates` constructs them — which is why they are worth
checking for at all. -/
theorem reachable_storage_never_faults_on_recovery_provenance {node : ActorNode}
    {actor : ActorRef} (reachable : ActorReachable node) :
    activateExec node.storage actor ≠ .error .unboundRecoveryState ∧
      activateExec node.storage actor ≠ .error .foreignRecovery := by
  have bound := reachable_recovery_is_bound reachable
  cases recovery : node.storage.recovery with
  | none =>
      cases identity : node.storage.identity with
      | none => rw [activateExec_created identity recovery]; exact ⟨by simp, by simp⟩
      | some held =>
          by_cases same : held = actor
          · rw [activateExec_missing_recovery (same ▸ identity) recovery]
            exact ⟨by simp, by simp⟩
          · rw [activation_refuses_a_foreign_actor identity same]
            exact ⟨by simp, by simp⟩
  | some state =>
      have identity : node.storage.identity = some state.actor := bound state recovery
      by_cases same : state.actor = actor
      · rw [activateExec_recovered (same ▸ identity) recovery same]
        exact ⟨by simp, by simp⟩
      · rw [activation_refuses_a_foreign_actor identity same]
        exact ⟨by simp, by simp⟩

/-- **A bare identity bind leaves storage its own next activation refuses.** `bindActor` is
public and writes the identity row on its own, so unlike the other two activation faults
this one is reachable by the Actor's own steps: `missingRecoveryState` is the guard that
catches storage bound that way, and it is load-bearing. -/
theorem bind_without_activation_faults_the_next_activation (actor : ActorRef) :
    ∃ node, ActorStep ActorNode.boot (.bind actor) node ∧
      activateExec node.storage actor = .error .missingRecoveryState := by
  refine ⟨_, ActorStep.bind rfl (.inl rfl), ?_⟩
  simp [activateExec, ActorNode.boot, ActorStorage.empty]


/-! ## Commit-unknown -/

/-- The incarnation that saw an unknown commit serves nothing further. -/
theorem commit_unknown_closes_the_incarnation {before after committed}
    (step : ActorStep before (.commitUnknown committed) after) : after.phase = .closed := by
  cases step; rfl

/-- A closed incarnation admits no command, whatever fence it is offered. -/
theorem closed_incarnation_admits_no_command {node after expected} (closed : node.phase = .closed) :
    ¬ ActorStep node (.command expected) after := by
  intro step
  obtain ⟨_, _, held, _, serving, _, _⟩ := command_step_shape step
  exact absurd (closed.symm.trans serving) (by simp)

/-- **A still-serving incarnation past an unknown commit would admit on evidence that decides
nothing.** The fence rotation is among the writes whose fate the caller never learns, so the
fence the incarnation still holds is current in the rolled-back branch and stale in the
committed one. Whether the command runs would then depend on an outcome nothing observed.
This is the constructive reason `ActorCommitUnknownError` closes the incarnation instead of
retrying it. -/
theorem serving_past_commit_unknown_is_branch_dependent (actor : ActorRef) :
    ∃ (txn : ActorTransaction) (held : ActorFence),
      admitsCommand actor held none txn.base.recovery = true ∧
        admitsCommand actor held none txn.working.recovery = false := by
  refine ⟨⟨⟨some actor, some ⟨actor, 0, 1⟩, []⟩, [.advanceFence]⟩, ⟨actor, 0⟩, ?_, ?_⟩
  · simp [admitsCommand, ActorFence.matches]
  · simp [ActorTransaction.working, applyWrites, ActorWrite.apply, ActorRecovery.advance,
      admitsCommand, ActorFence.matches]

/-- **Closing and re-activating removes the dependence.** Whichever branch the substrate
took, the re-activated incarnation admits the fence its own activation issued and refuses
every fence from before the unknown commit. Safety after commit-unknown therefore does not
rest on learning which branch happened. -/
theorem reactivation_resolves_commit_unknown {before after txn committed actor previous held}
    (step : ActorStep before (.commitUnknown committed) after)
    (pending : before.pending = some txn) (recorded : txn.base.recovery = some previous)
    (stale : held.epoch ≤ previous.epoch)
    {storage : ActorStorage} {activation : Activation}
    (activated : activateExec after.storage actor = .ok (storage, activation)) :
    admitsCommand actor activation.state.fence none storage.recovery = true ∧
      ∀ expected, admitsCommand actor held expected storage.recovery = false := by
  obtain ⟨identity, recovery, owner⟩ := activation_binds_its_own_actor activated
  obtain ⟨landed, _⟩ := commit_unknown_step_shape step pending
  have retained : previous.epoch ≤ after.storage.epoch ∧ after.storage.recovery ≠ none := by
    rw [landed]
    cases committed with
    | false =>
        exact ⟨by simp [ActorStorage.epoch, recorded], by simp [recorded]⟩
    | true =>
        obtain ⟨next, present⟩ := applyWrites_recovery_stays_present txn.staged recorded
        refine ⟨?_, by simp [ActorTransaction.working, present]⟩
        show previous.epoch ≤ (applyWrites txn.base txn.staged).epoch
        refine Nat.le_trans ?_ (applyWrites_epoch_never_decreases txn.staged txn.base)
        simp [ActorStorage.epoch, recorded]
  refine ⟨by
    rw [recovery]
    simpa [owner] using admitsCommand_admits_own_fence (state := activation.state), ?_⟩
  intro expected
  rw [recovery]
  refine admitsCommand_refuses_other_epoch (Nat.ne_of_lt ?_)
  rcases activation_advances_the_epoch activated with ⟨empty, _⟩ | ⟨strict, _⟩
  · exact absurd empty retained.2
  · have : activation.state.epoch = storage.epoch := by
      simp [ActorStorage.epoch, recovery]
    exact Nat.lt_of_le_of_lt (Nat.le_trans stale retained.1) (this ▸ strict)

end AgentCore
