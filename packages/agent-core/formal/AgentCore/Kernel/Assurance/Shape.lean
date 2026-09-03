/-
What each kernel Run transition leaves behind (SPEC §5.2, §5.3, §5.6).

Every proof by induction over `RunSystem.step` needs to know which fields an operation moved
and which guard it passed, and the `Runs` modules state that only where their own theorems
needed it. These are the remaining projections, one per operation. Nothing here decides
anything: each theorem is the operation's own definition, read for the facts the induction
consumes.

Two families are worth naming, because they carry weight later:

* **Identity is never re-parented.** Seven Turn transitions and seven Run transitions, and
  none of them moves an identity or a Run membership. Single ownership
  (`Assurance.Safety.Invariant.turnsOwned`) is that fact plus induction.
* **Every guard is recoverable from its success.** `claim` succeeded, therefore the status was
  claimable; `renew` succeeded, therefore the Turn was running under the exact token. A
  transition system cannot reason about a step without reading its guard back off the step,
  and a guard that is not recoverable is a guard whose refusal a caller could not have
  predicted.
-/
import AgentCore.Kernel.Assurance.System

namespace AgentCore.Kernel

namespace Run

/-- **A Run transition keeps the Run's identity, installs exactly the named fields, and
advances the revision.** Optimistic concurrency rests on the last clause: a later write
carries a strictly greater revision, so a stale write is detectable by comparison alone. -/
theorem transition_shape {run next : Run} {terminal : Option TerminalSnapshot}
    {configurations : List Digest} {tokensConsumed : Nat} {costConsumed : Option RealizedCost}
    {deliveries : List RunInvocationDelivery} {genesisFirst configurationsUnique tokensValid
      deliveriesOwned deliveriesOrdered terminalOwned}
    (step : run.transition terminal configurations tokensConsumed costConsumed deliveries
      genesisFirst configurationsUnique tokensValid deliveriesOwned deliveriesOrdered
      terminalOwned = .ok next) :
    next.id = run.id ∧ next.terminal = terminal ∧ next.deliveries = deliveries ∧
      run.revision.value < next.revision.value := by
  unfold transition at step
  cases stepped : nextRevision run.revision with
  | error fault => rw [stepped] at step; simp at step
  | ok revision =>
      rw [stepped] at step
      simp only [Except.ok.injEq] at step
      refine ⟨by rw [← step], by rw [← step], by rw [← step], ?_⟩
      have shape : next.revision = revision := by rw [← step]
      rw [shape, nextRevision_succ stepped]
      omega

/-! ### The six ordinary Run mutations

None of them is the transition that ends a Run, so each keeps the identity and the terminal
snapshot it already had. -/

theorem revise_shape {run next : Run} (step : run.revise = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold revise transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem recordEvidence_shape {run next : Run} (step : run.recordEvidence = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold recordEvidence transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem recordConfiguration_shape {run next : Run} {configuration : Digest}
    (step : run.recordConfiguration configuration = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold recordConfiguration transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem recordModelUsage_shape {run next : Run} {tokens : Nat} {cost : Option RealizedCost}
    {lineage : List Currency} (step : run.recordModelUsage tokens cost lineage = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold recordModelUsage transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem publishDelivery_shape {run next : Run} {delivery : RunInvocationDelivery}
    (step : run.publishDelivery delivery = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold publishDelivery transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem acknowledgeDelivery_shape {run next : Run} {delivery : RunInvocationDelivery}
    (step : run.acknowledgeDelivery delivery = .ok next) :
    next.id = run.id ∧ next.terminal = run.terminal := by
  unfold acknowledgeDelivery transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

/-- **Terminalization keeps the Run's identity and installs exactly the snapshot it was
given.** -/
theorem terminalize_shape {run next : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery}
    (step : run.terminalize snapshot cancellations = .ok next) :
    next.id = run.id ∧ next.terminal = some snapshot := by
  unfold terminalize transition at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

/-- **A terminal Run refuses terminalization**, so the snapshot a Run holds is write-once:
the transition that installs it is the only one that can, and it runs once. -/
theorem terminalize_requires_active {run next : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery}
    (step : run.terminalize snapshot cancellations = .ok next) : run.terminal = none := by
  by_cases ended : run.lifecycle.isTerminal = true
  · exact absurd step (Outcome.refusedWith_ne_ok (terminalize_refuses_terminal ended))
  · simp only [Bool.not_eq_true] at ended
    cases shape : run.terminal with
    | none => rfl
    | some held =>
        rw [(lifecycle_is_terminal_iff_snapshot run).mpr (by rw [shape]; rfl)] at ended
        simp at ended

/-- **An active Run holds no snapshot, in the form the induction needs it.** -/
theorem active_of_not_terminal {run : Run} (active : run.lifecycle.isTerminal = false) :
    run.terminal = none := by
  cases shape : run.terminal with
  | none => rfl
  | some snapshot =>
      rw [(lifecycle_is_terminal_iff_snapshot run).mpr (by rw [shape]; rfl)] at active
      simp at active

/-- **A Run holding a snapshot is terminal, in the form the induction needs it.** -/
theorem terminal_of_snapshot {run : Run} {snapshot : TerminalSnapshot}
    (ended : run.terminal = some snapshot) : run.lifecycle.isTerminal = true :=
  (lifecycle_is_terminal_iff_snapshot run).mpr (by rw [ended]; rfl)

end Run

namespace TurnStatus

/-- **A claimable status is not a terminal one.** `claim` and `cancelUnheld` are gated on
`claimable`, so this is what makes them impossible on a Turn that has ended. -/
theorem claimable_not_terminal {status : TurnStatus} (movable : status.claimable = true) :
    status.isTerminal = false := by
  cases status with
  | queued => rfl
  | running => exact absurd movable (by decide)
  | suspended => rfl
  | terminal outcome => cases outcome <;> exact absurd movable (by decide)

/-- **A running status is not a terminal one.** -/
theorem running_not_terminal : TurnStatus.running.isTerminal = false := rfl

end TurnStatus

namespace TurnLease

/-- **An admitted token is the exact current one.** The Turn, the holder, and the epoch all
agree, which is what "at the exact epoch" means and what every fencing argument reads. -/
theorem admits_exact {lease : TurnLease} {token : LeaseToken} {now : Millis}
    (admitted : lease.admits token now = true) :
    lease.turn = token.turn ∧ lease.holder = some token.holder ∧
      lease.epoch = token.epoch := by
  unfold admits at admitted
  cases holderShape : lease.holder with
  | none => rw [holderShape] at admitted; simp at admitted
  | some holder =>
      cases expiryShape : lease.expiresAt with
      | none => rw [holderShape, expiryShape] at admitted; simp at admitted
      | some expiry =>
          rw [holderShape, expiryShape] at admitted
          simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at admitted
          obtain ⟨⟨⟨turnSame, holderSame⟩, epochSame⟩, _⟩ := admitted
          exact ⟨turnSame, by rw [holderSame], epochSame⟩

end TurnLease

namespace Turn

/-! ### The seven Turn transitions

Each one keeps the Turn's identity and the Run it belongs to, and each one's guard is
recoverable from its success. -/

theorem claim_preserves_identity {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.claim holder now expiresAt = .ok next) :
    next.id = turn.id ∧ next.run = turn.run := by
  unfold claim at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem renew_preserves_identity {turn next : Turn} {token : LeaseToken}
    {now expiresAt : Millis} (step : turn.renew token now expiresAt = .ok next) :
    next.id = turn.id ∧ next.run = turn.run := by
  unfold renew at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem reclaim_preserves_identity {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.reclaim holder now expiresAt = .ok next) :
    next.id = turn.id ∧ next.run = turn.run := by
  unfold reclaim at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem suspend_preserves_identity {turn next : Turn} {token : LeaseToken}
    {checkpoint : TextId .runCheckpoint} {now : Millis}
    (step : turn.suspend token checkpoint now = .ok next) :
    next.id = turn.id ∧ next.run = turn.run := by
  unfold suspend at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem complete_preserves_identity {turn next : Turn} {token : LeaseToken}
    {outcome : TerminalOutcome} {result : ContentRef} {now : Millis}
    (step : turn.complete token outcome result now = .ok next) :
    next.id = turn.id ∧ next.run = turn.run := by
  unfold complete at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem cancelUnheld_preserves_identity {turn next : Turn}
    (step : turn.cancelUnheld = .ok next) : next.id = turn.id ∧ next.run = turn.run := by
  unfold cancelUnheld at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

theorem forceCancel_preserves_identity {turn next : Turn}
    (step : turn.forceCancel = .ok next) : next.id = turn.id ∧ next.run = turn.run := by
  unfold forceCancel at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; simp)
      | cases step

/-! ### The guards, read back off the success -/

theorem claim_requires_claimable {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.claim holder now expiresAt = .ok next) :
    turn.status.claimable = true := by
  by_cases guard : turn.status.claimable = true
  · exact guard
  · unfold claim at step
    rw [if_neg guard] at step
    cases step

theorem cancelUnheld_requires_claimable {turn next : Turn}
    (step : turn.cancelUnheld = .ok next) : turn.status.claimable = true := by
  by_cases guard : turn.status.claimable = true
  · exact guard
  · unfold cancelUnheld at step
    rw [if_neg guard] at step
    cases step

theorem reclaim_requires_running {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.reclaim holder now expiresAt = .ok next) :
    turn.status = .running := by
  by_cases guard : turn.status = .running
  · exact guard
  · unfold reclaim at step
    rw [dif_neg guard] at step
    cases step

/-- **Reclaim only takes over an expired held lease.** A live lease cannot be taken from its
holder, which is what makes a lease an exclusive right for its whole term. -/
theorem reclaim_requires_expired {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.reclaim holder now expiresAt = .ok next) :
    turn.lease.expiredHeld now = true := by
  unfold reclaim at step
  split at step
  · split at step
    · cases step
    · rename_i lease leaseStep
      by_cases expired : turn.lease.expiredHeld now = true
      · exact expired
      · simp only [Bool.not_eq_true] at expired
        exact absurd leaseStep
          (Outcome.refusedWith_ne_ok (TurnLease.reclaim_requires_expired expired))
  · cases step

theorem renew_requires_token {turn next : Turn} {token : LeaseToken} {now expiresAt : Millis}
    (step : turn.renew token now expiresAt = .ok next) :
    turn.requireToken token now = .ok () := by
  unfold renew at step
  split at step
  · cases step
  · rename_i value gate
    cases value
    exact gate

theorem suspend_requires_token {turn next : Turn} {token : LeaseToken}
    {checkpoint : TextId .runCheckpoint} {now : Millis}
    (step : turn.suspend token checkpoint now = .ok next) :
    turn.requireToken token now = .ok () := by
  unfold suspend at step
  split at step
  · cases step
  · rename_i value gate
    cases value
    exact gate

theorem complete_requires_token {turn next : Turn} {token : LeaseToken}
    {outcome : TerminalOutcome} {result : ContentRef} {now : Millis}
    (step : turn.complete token outcome result now = .ok next) :
    turn.requireToken token now = .ok () := by
  unfold complete at step
  split at step
  · cases step
  · rename_i value gate
    cases value
    exact gate

/-- **Forced cancellation always lands terminal.** Either the Turn was already terminal and
unheld — where the transition is the identity — or it is cancelled and fenced. This is the
one Turn transition a terminal Turn admits, and it leaves it where it was. -/
theorem forceCancel_lands_terminal {turn next : Turn} (step : turn.forceCancel = .ok next) :
    next.status.isTerminal = true := by
  unfold forceCancel at step
  split at step
  · rename_i ended
    simp only [Except.ok.injEq] at step
    subst step
    exact ((Bool.and_eq_true _ _).mp ended).1
  · repeat' split at step
    all_goals
      first
        | (simp only [Except.ok.injEq] at step; subst step; rfl)
        | cases step

/-- **A suspended Turn holds the checkpoint it can be resumed from.** -/
theorem suspend_result {turn next : Turn} {token : LeaseToken}
    {checkpoint : TextId .runCheckpoint} {now : Millis}
    (step : turn.suspend token checkpoint now = .ok next) :
    next.status = .suspended ∧ next.checkpoint = some checkpoint := by
  unfold suspend at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; exact ⟨rfl, rfl⟩)
      | cases step

/-- **A reclaimed Turn keeps its status and holds its new holder's lease.** The status does
not move because `reclaim` is gated on the Turn already running; `reclaim_requires_running` is
that half. -/
theorem reclaim_result {turn next : Turn} {holder : PrincipalRef} {now expiresAt : Millis}
    (step : turn.reclaim holder now expiresAt = .ok next) :
    next.status = turn.status ∧ next.lease.holder = some holder := by
  unfold reclaim at step
  split at step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact ⟨rfl, (TurnLease.reclaim_shape leaseStep).2.1⟩
  · cases step

/-- **A completed Turn has ended.** -/
theorem complete_lands_terminal {turn next : Turn} {token : LeaseToken}
    {outcome : TerminalOutcome} {result : ContentRef} {now : Millis}
    (step : turn.complete token outcome result now = .ok next) :
    next.status.isTerminal = true := by
  rw [(complete_terminal step).1]
  cases outcome <;> rfl

/-- **A cancelled Turn has ended.** -/
theorem cancelUnheld_lands_terminal {turn next : Turn} (step : turn.cancelUnheld = .ok next) :
    next.status.isTerminal = true := by
  unfold cancelUnheld at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; rfl)
      | cases step

/-- **A token-gated transition acts on a running Turn**, so a Turn that has ended, is queued,
or is suspended admits none of the three. -/
theorem requireToken_not_terminal {turn : Turn} {token : LeaseToken} {now : Millis}
    (admitted : turn.requireToken token now = .ok ()) : turn.status.isTerminal = false := by
  rw [requireToken_running admitted]
  rfl

/-- **A token-gated transition admits the exact current token.** -/
theorem requireToken_admits {turn : Turn} {token : LeaseToken} {now : Millis}
    (admitted : turn.requireToken token now = .ok ()) :
    turn.lease.admits token now = true := by
  unfold requireToken at admitted
  by_cases guard : (turn.status == TurnStatus.running) && turn.lease.admits token now
  · exact ((Bool.and_eq_true _ _).mp guard).2
  · rw [if_neg guard] at admitted
    cases admitted

/-- **A claimable Turn holds nothing.** Both token-free claims — `claim` and `cancelUnheld` —
are gated on `claimable`, and a claimable Turn is queued or suspended, both of which the
record's own invariants make unheld. So neither transition ever takes a lease from a
holder. -/
theorem claimable_is_unheld {turn : Turn} (movable : turn.status.claimable = true) :
    turn.lease.holder = none := by
  have resting : turn.status = .queued ∨ turn.status = .suspended := by
    cases shape : turn.status with
    | queued => exact .inl rfl
    | suspended => exact .inr rfl
    | running => exact absurd (shape ▸ movable) (by decide)
    | terminal outcome => cases outcome <;> exact absurd (shape ▸ movable) (by decide)
  rcases resting with queued | suspended
  · exact (turn.queuedUnheld queued).1
  · exact turn.restingUnheld (.inl suspended)

/-! ### What each Turn transition does to the incarnation

A lease's *incarnation* is its epoch together with its holder, and §5.3 fencing is entirely
a statement about incarnations: a token is current only at the exact epoch, so a transition
that advances the epoch retires every token minted before it. Six of the seven transitions
advance it; renewal is the one that deliberately does not, because extending a term is not a
new incarnation. -/

theorem claim_advances_epoch {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.claim holder now expiresAt = .ok next) :
    turn.lease.epoch < next.lease.epoch := by
  unfold claim at step
  split at step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.claim_advances_epoch leaseStep
  · cases step

theorem reclaim_advances_epoch {turn next : Turn} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : turn.reclaim holder now expiresAt = .ok next) :
    turn.lease.epoch < next.lease.epoch := by
  unfold reclaim at step
  split at step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.reclaim_advances_epoch leaseStep
  · cases step

theorem suspend_advances_epoch {turn next : Turn} {token : LeaseToken}
    {checkpoint : TextId .runCheckpoint} {now : Millis}
    (step : turn.suspend token checkpoint now = .ok next) :
    turn.lease.epoch < next.lease.epoch := by
  unfold suspend at step
  split at step
  · cases step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.fence_advances_epoch leaseStep

theorem complete_advances_epoch {turn next : Turn} {token : LeaseToken}
    {outcome : TerminalOutcome} {result : ContentRef} {now : Millis}
    (step : turn.complete token outcome result now = .ok next) :
    turn.lease.epoch < next.lease.epoch := by
  unfold complete at step
  split at step
  · cases step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.fence_advances_epoch leaseStep

theorem cancelUnheld_advances_epoch {turn next : Turn} (step : turn.cancelUnheld = .ok next) :
    turn.lease.epoch < next.lease.epoch := by
  unfold cancelUnheld at step
  split at step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.fence_advances_epoch leaseStep
  · cases step

/-- **Renewal keeps the incarnation.** The holder and the epoch are exactly what they were,
so a renewal is not a new lease and a token fenced before it stays fenced. -/
theorem renew_keeps_incarnation {turn next : Turn} {token : LeaseToken}
    {now expiresAt : Millis} (step : turn.renew token now expiresAt = .ok next) :
    next.lease.epoch = turn.lease.epoch ∧ next.lease.holder = turn.lease.holder := by
  unfold renew at step
  split at step
  · cases step
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact TurnLease.renew_keeps_epoch leaseStep

/-- **Forced cancellation either changes nothing or advances the epoch.** The identity case
is a terminal unheld Turn, which is already where cancellation would leave it. -/
theorem forceCancel_incarnation {turn next : Turn} (step : turn.forceCancel = .ok next) :
    next = turn ∨ turn.lease.epoch < next.lease.epoch := by
  unfold forceCancel at step
  split at step
  · simp only [Except.ok.injEq] at step
    exact .inl step.symm
  · split at step
    · cases step
    · rename_i lease leaseStep
      split at step
      · cases step
      · simp only [Except.ok.injEq] at step
        subst step
        exact .inr (TurnLease.fence_advances_epoch leaseStep)

end Turn

namespace RunAdmissionRegistry

/-- **Reserving keeps the registry's Run, its epoch, its open state, and what it has
discharged.** -/
theorem reserve_shape {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} {obligation : RunObligation}
    (step : registry.reserve obligation = .ok (next, reservation)) :
    next.run = registry.run ∧ next.«open» = registry.«open» ∧ next.epoch = registry.epoch := by
  unfold reserve at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq, Prod.mk.injEq] at step
         rw [← step.1]
         exact ⟨rfl, rfl, rfl⟩)
      | cases step

/-- **Reserving is refused on a closed registry**, so what a Run owes is fixed the moment
admission closes. -/
theorem reserve_requires_open {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} {obligation : RunObligation}
    (step : registry.reserve obligation = .ok (next, reservation)) :
    registry.«open» = true := by
  by_cases open' : registry.«open» = true
  · exact open'
  · simp only [Bool.not_eq_true] at open'
    unfold reserve at step
    rw [if_neg (by simp [open'])] at step
    cases step

/-- **Completing keeps the registry's Run, epoch, open state, and reserved set.** -/
theorem complete_shape {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} (step : registry.complete reservation = .ok next) :
    next.run = registry.run ∧ next.«open» = registry.«open» ∧ next.epoch = registry.epoch ∧
      next.reserved = registry.reserved := by
  unfold complete at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step
         rw [← step]
         exact ⟨rfl, rfl, rfl, rfl⟩)
      | cases step

/-- **Completing only ever adds to what has been discharged.** -/
theorem complete_completed_superset {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} (step : registry.complete reservation = .ok next) :
    ∀ obligation ∈ registry.completed, obligation ∈ next.completed := by
  unfold complete at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step
         subst step
         intro obligation member
         first
           | exact member
           | exact List.mem_append.mpr (.inl member))
      | cases step

/-- **Completing an obligation only shrinks the frontier.** -/
theorem complete_frontier_subset {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} (step : registry.complete reservation = .ok next)
    {obligation : RunObligation} (member : obligation ∈ next.frontier) :
    obligation ∈ registry.frontier := by
  obtain ⟨_, _, _, reserved⟩ := complete_shape step
  obtain ⟨held, absent⟩ := mem_frontier.mp member
  refine mem_frontier.mpr ⟨by rw [← reserved]; exact held, ?_⟩
  by_cases discharged : registry.discharged obligation = true
  · obtain ⟨existing, existingMember, same⟩ := List.any_eq_true.mp discharged
    have carried : next.discharged obligation = true :=
      List.any_eq_true.mpr
        ⟨existing, complete_completed_superset step existing existingMember, same⟩
    rw [carried] at absent
    simp at absent
  · simpa using discharged

/-- **Closing keeps the registry's Run and both of its obligation lists**, so the frontier is
exactly what it was: closing decides what may still be *taken on*, never what is owed. -/
theorem close_shape {registry closed : RunAdmissionRegistry} (step : registry.close = .ok closed) :
    closed.run = registry.run ∧ closed.reserved = registry.reserved ∧
      closed.completed = registry.completed := by
  unfold close at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step
         rw [← step]
         exact ⟨rfl, rfl, rfl⟩)
      | cases step

/-- **Closing preserves the frontier.** -/
theorem close_frontier {registry closed : RunAdmissionRegistry}
    (step : registry.close = .ok closed) : closed.frontier = registry.frontier := by
  obtain ⟨_, reserved, completed⟩ := close_shape step
  unfold frontier discharged
  rw [reserved, completed]

/-- **A frontier obligation after a reservation is either the one just taken on or one the
registry already held.** -/
theorem reserve_frontier_source {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} {obligation : RunObligation}
    (step : registry.reserve obligation = .ok (next, reservation))
    {candidate : RunObligation} (member : candidate ∈ next.frontier) :
    candidate = obligation ∨ candidate ∈ registry.frontier := by
  unfold reserve at step
  split at step
  · split at step
    · simp only [Except.ok.injEq, Prod.mk.injEq] at step
      have shape : next.reserved = registry.reserved ++ [obligation] := by rw [← step.1]
      have discharged : next.completed = registry.completed := by rw [← step.1]
      obtain ⟨held, absent⟩ := mem_frontier.mp member
      rw [shape] at held
      rcases List.mem_append.mp held with existing | appended
      · refine .inr (mem_frontier.mpr ⟨existing, ?_⟩)
        unfold RunAdmissionRegistry.discharged at absent ⊢
        rw [← discharged]
        exact absent
      · exact .inl (by simpa using appended)
    · simp only [Except.ok.injEq, Prod.mk.injEq] at step
      have shape : next = registry := by rw [← step.1]
      exact .inr (by rw [← shape]; exact member)
  · cases step

end RunAdmissionRegistry

namespace RunSystem

/-! ### The composite steps

Two step arms build their post-state out of several kernel operations, and the induction in
`Assurance.Safety` needs each operation's own result out of the composite. These two lemmas
are that decomposition, and nothing more. -/

/-- **A Turn step addresses one Turn the Run holds, transitions it, and installs the
result.** -/
theorem onTurn_shape {system after : RunSystem} {id : TextId .turn}
    {transition : Turn → Outcome Turn} (stepped : system.onTurn id transition = .ok after) :
    ∃ turn next, system.turnById id = some turn ∧ transition turn = .ok next ∧
      after = system.withTurn next := by
  unfold onTurn at stepped
  split at stepped
  · cases stepped
  · rename_i turn found
    split at stepped
    · cases stepped
    · rename_i next moved
      simp only [Except.ok.injEq] at stepped
      exact ⟨turn, next, found, moved, stepped.symm⟩

/-- **A looked-up Turn on an extended table is the same lookup**, where the new Turn is not
the one being asked for. -/
theorem turnById_cons_of_ne {system : RunSystem} {turn : Turn} {id : TextId .turn}
    (other : turn.id ≠ id) :
    ({ system with turns := turn :: system.turns } : RunSystem).turnById id =
      system.turnById id := by
  unfold turnById
  have miss : (turn.id == id) = false := by simp [other]
  simp [miss]

/-- Lookup reads only the Turn table, so two states with the same table answer alike. -/
theorem turnById_congr {left right : RunSystem} (turns : left.turns = right.turns)
    (id : TextId .turn) : left.turnById id = right.turnById id := by
  unfold turnById
  rw [turns]

/-- **A Turn identity the Run does not hold is held by none of its Turns.** -/
theorem turnById_none {system : RunSystem} {id : TextId .turn}
    (absent : system.turnById id = none) : ∀ turn ∈ system.turns, turn.id ≠ id := by
  intro turn member same
  unfold turnById at absent
  have missing := List.find?_eq_none.mp absent turn member
  simp [same] at missing

/-- **A transitioned Turn is either the replacement or one the table already held.** -/
theorem mem_replaceTurn {system : RunSystem} {target candidate : Turn}
    (member : candidate ∈ system.replaceTurn target) :
    candidate = target ∨ candidate ∈ system.turns := by
  unfold replaceTurn at member
  obtain ⟨existing, existingMember, mapped⟩ := List.mem_map.mp member
  by_cases hit : existing.id = target.id
  · rw [if_pos hit] at mapped
    exact .inl mapped.symm
  · rw [if_neg hit] at mapped
    exact .inr (mapped ▸ existingMember)

/-- Replacement is pointwise on identities, so the identities a table holds never change. -/
theorem replaced_ids : ∀ (turns : List Turn) (target : Turn),
    ((turns.map fun existing => if existing.id = target.id then target else existing).map
      Turn.id) = turns.map Turn.id
  | [], _ => rfl
  | turn :: rest, target => by
      by_cases hit : turn.id = target.id
      · simp [hit, replaced_ids rest target]
      · simp [hit, replaced_ids rest target]

/-- **Transitioning a Turn leaves the table's identities exactly as they were**, so single
ownership of an identity cannot be broken by a state move. -/
theorem replaceTurn_ids (system : RunSystem) (target : Turn) :
    (system.replaceTurn target).map Turn.id = system.turns.map Turn.id :=
  replaced_ids system.turns target

end RunSystem

end AgentCore.Kernel
