/-
Turn status and the Turn record (SPEC §5.3; `packages/agent-core/src/agents/runs/turn.ts`).

`TurnStatus` is the codebase's dominant idiom: an abstract base whose singleton subclasses
carry the transitions, so an illegal transition is a method call that throws rather than a
state a caller can reach. Which transitions exist is decided in exactly one Lean place —
`AgentCore.Extract.TurnStatus`, the module the runtime's own `TurnStatus` is lowered from —
and this module *consumes* that table rather than restating it: `claim`, `suspend`,
`complete`, `cancelUnheld`, and `isTerminal` each ask Extract and turn its `none` into the
refusal carrying `turn.invalid-state`. The two vocabularies differ only in shape, because
the kernel groups the three terminal statuses under one constructor; `toExtract` and
`ofExtract` are that grouping and its inverse, and `ofExtract_toExtract` proves they are.

The `Turn` record's six constructor checks become `Prop` fields, so a Turn in an
inconsistent state does not typecheck: a queued Turn holds an unheld epoch-zero lease, a
running Turn holds a held one, suspended and terminal Turns are unheld, a suspended Turn
names a checkpoint, and a succeeded or failed Turn names a result. Every transition rebuilds
the record and therefore has to re-establish all six — which is the executable form of
"state transitions preserve the model's invariants".
-/
import AgentCore.RunGraph
import AgentCore.Extract.TurnStatus
import AgentCore.Kernel.Runs.Lease

namespace AgentCore.Kernel

/-- A Turn's terminal outcome (`TerminalOutcome` in `src/agents/runs/outcome.ts`). -/
inductive TerminalOutcome where
  | succeeded
  | failed
  | cancelled
  deriving DecidableEq, Repr

def TerminalOutcome.wire : TerminalOutcome → String
  | .succeeded => "succeeded"
  | .failed => "failed"
  | .cancelled => "cancelled"

/-- Every status a Turn can hold. -/
inductive TurnStatus where
  | queued
  | running
  | suspended
  | terminal (outcome : TerminalOutcome)
  deriving DecidableEq, Repr

namespace TurnStatus

def wire : TurnStatus → String
  | .queued => "queued"
  | .running => "running"
  | .suspended => "suspended"
  | .terminal outcome => outcome.wire

def ofWire (value : String) : Option TurnStatus :=
  if value = "queued" then some .queued
  else if value = "running" then some .running
  else if value = "suspended" then some .suspended
  else if value = "succeeded" then some (.terminal .succeeded)
  else if value = "failed" then some (.terminal .failed)
  else if value = "cancelled" then some (.terminal .cancelled)
  else none

theorem ofWire_wire (status : TurnStatus) : ofWire status.wire = some status := by
  cases status with
  | queued => rfl
  | running => rfl
  | suspended => rfl
  | terminal outcome => cases outcome <;> rfl

/-- The Extract status this one is. The kernel groups the three terminal statuses under one
constructor; Extract lists them flat, and this is that grouping read the other way. -/
def toExtract : TurnStatus → Extract.TurnStatus
  | .queued => .queued
  | .running => .running
  | .suspended => .suspended
  | .terminal .succeeded => .succeeded
  | .terminal .failed => .failed
  | .terminal .cancelled => .cancelled

/-- The kernel status for an Extract one. -/
def ofExtract : Extract.TurnStatus → TurnStatus
  | .queued => .queued
  | .running => .running
  | .suspended => .suspended
  | .succeeded => .terminal .succeeded
  | .failed => .terminal .failed
  | .cancelled => .terminal .cancelled

/-- **The two vocabularies are the same vocabulary.** Nothing is lost by asking Extract for
a transition and reading its answer back. -/
theorem ofExtract_toExtract (status : TurnStatus) : ofExtract status.toExtract = status := by
  cases status with
  | queued => rfl
  | running => rfl
  | suspended => rfl
  | terminal outcome => cases outcome <;> rfl

/-- Whether the Turn has ended, as Extract's table decides it. -/
def isTerminal (status : TurnStatus) : Bool := status.toExtract.terminal

/-- Which statuses admit `claim`: exactly those Extract's table moves. -/
def claimable (status : TurnStatus) : Bool := status.toExtract.claim.isSome

/-- `claim`. The move is Extract's; the refusal is the runtime taxonomy's. -/
def claim (status : TurnStatus) : Outcome TurnStatus :=
  match status.toExtract.claim with
  | some next => .ok (ofExtract next)
  | none => refuse .turnInvalidState

/-- `suspend`: only a running Turn suspends, because that is what Extract's table admits. -/
def suspend (status : TurnStatus) : Outcome TurnStatus :=
  match status.toExtract.suspend with
  | some next => .ok (ofExtract next)
  | none => refuse .turnInvalidState

/-- `complete`: only a status Extract's table admits completes, into the outcome it reports.
Which status may complete is Extract's `completes`; which status it lands on is the
outcome's, which is why the table carries no parameter for it. -/
def complete (status : TurnStatus) (outcome : TerminalOutcome) : Outcome TurnStatus :=
  if status.toExtract.completes then .ok (.terminal outcome) else refuse .turnInvalidState

/-- `cancelUnheld`: a Turn holding no token may be cancelled without one. -/
def cancelUnheld (status : TurnStatus) : Outcome TurnStatus :=
  match status.toExtract.cancelUnheld with
  | some next => .ok (ofExtract next)
  | none => refuse .turnInvalidState

theorem claim_result {status next : TurnStatus} (step : status.claim = .ok next) :
    next = .running := by
  cases status with
  | queued =>
      simp only [claim, toExtract, Extract.TurnStatus.claim, ofExtract, Except.ok.injEq] at step
      exact step.symm
  | running => simp [claim, toExtract, Extract.TurnStatus.claim, refuse] at step
  | suspended =>
      simp only [claim, toExtract, Extract.TurnStatus.claim, ofExtract, Except.ok.injEq] at step
      exact step.symm
  | terminal outcome =>
      cases outcome <;> simp [claim, toExtract, Extract.TurnStatus.claim, refuse] at step

theorem suspend_result {status next : TurnStatus} (step : status.suspend = .ok next) :
    next = .suspended := by
  cases status with
  | running =>
      simp only [suspend, toExtract, Extract.TurnStatus.suspend, ofExtract,
        Except.ok.injEq] at step
      exact step.symm
  | queued => simp [suspend, toExtract, Extract.TurnStatus.suspend, refuse] at step
  | suspended => simp [suspend, toExtract, Extract.TurnStatus.suspend, refuse] at step
  | terminal outcome =>
      cases outcome <;> simp [suspend, toExtract, Extract.TurnStatus.suspend, refuse] at step

theorem complete_result {status next : TurnStatus} {outcome : TerminalOutcome}
    (step : status.complete outcome = .ok next) : next = .terminal outcome := by
  unfold complete at step
  by_cases guard : status.toExtract.completes = true
  · rw [if_pos guard] at step
    exact (Except.ok.inj step).symm
  · rw [if_neg guard] at step
    simp [refuse] at step

theorem cancelUnheld_result {status next : TurnStatus} (step : status.cancelUnheld = .ok next) :
    next = .terminal .cancelled := by
  cases status with
  | queued =>
      simp only [cancelUnheld, toExtract, Extract.TurnStatus.cancelUnheld, ofExtract,
        Except.ok.injEq] at step
      exact step.symm
  | suspended =>
      simp only [cancelUnheld, toExtract, Extract.TurnStatus.cancelUnheld, ofExtract,
        Except.ok.injEq] at step
      exact step.symm
  | running => simp [cancelUnheld, toExtract, Extract.TurnStatus.cancelUnheld, refuse] at step
  | terminal outcome =>
      cases outcome <;>
        simp [cancelUnheld, toExtract, Extract.TurnStatus.cancelUnheld, refuse] at step

/-- **A running Turn cannot be claimed again.** -/
theorem running_not_claimable :
    (TurnStatus.running.claim).RefusedWith .turnInvalidState := by
  simp [claim, toExtract, Extract.TurnStatus.claim, refuse, Outcome.RefusedWith]

/-- **A terminal Turn admits no transition at all.** Every verb refuses with
`turn.invalid-state`, so an ended Turn cannot be resumed, suspended, completed again, or
cancelled again. This is `Extract.terminal_admits_nothing` read through the refusal
channel — the table says `none` four times and the kernel says `turn.invalid-state` four
times. -/
theorem terminal_admits_nothing (outcome outcome' : TerminalOutcome) :
    ((TurnStatus.terminal outcome).claim).RefusedWith .turnInvalidState ∧
      ((TurnStatus.terminal outcome).suspend).RefusedWith .turnInvalidState ∧
      ((TurnStatus.terminal outcome).complete outcome').RefusedWith .turnInvalidState ∧
      ((TurnStatus.terminal outcome).cancelUnheld).RefusedWith .turnInvalidState := by
  have ended : (TurnStatus.terminal outcome).toExtract.terminal = true := by
    cases outcome <;> rfl
  obtain ⟨noClaim, noSuspend, noCancel, noComplete⟩ :=
    Extract.terminal_admits_nothing ended
  refine ⟨?_, ?_, ?_, ?_⟩
  · unfold claim; rw [noClaim]; rfl
  · unfold suspend; rw [noSuspend]; rfl
  · unfold complete; rw [noComplete]; rfl
  · unfold cancelUnheld; rw [noCancel]; rfl

/-- **Only a running Turn suspends or completes.** -/
theorem suspend_requires_running {status : TurnStatus} (notRunning : status ≠ .running) :
    (status.suspend).RefusedWith .turnInvalidState := by
  cases status with
  | running => exact absurd rfl notRunning
  | queued => rfl
  | suspended => rfl
  | terminal outcome => cases outcome <;> rfl

theorem complete_requires_running {status : TurnStatus} {outcome : TerminalOutcome}
    (notRunning : status ≠ .running) :
    (status.complete outcome).RefusedWith .turnInvalidState := by
  cases status with
  | running => exact absurd rfl notRunning
  | queued => rfl
  | suspended => rfl
  | terminal ended => cases ended <;> rfl

/-- The model's status for a terminal outcome. -/
def outcomeToModel : TerminalOutcome → AgentCore.TurnStatus
  | .succeeded => .succeeded
  | .failed => .failed
  | .cancelled => .cancelled

/-- The model's status for this one. -/
def toModel : TurnStatus → AgentCore.TurnStatus
  | .queued => .queued
  | .running => .running
  | .suspended => .suspended
  | .terminal outcome => outcomeToModel outcome

theorem outcomeToModel_injective {left right : TerminalOutcome}
    (same : outcomeToModel left = outcomeToModel right) : left = right := by
  cases left <;> cases right <;> simp_all [outcomeToModel]

/-- **The kernel's terminality is the model's.** The model's terminal statuses are exactly
`succeeded`, `failed`, and `cancelled`, which is what `isTerminal` decides. -/
theorem isTerminal_refines_model (status : TurnStatus) :
    status.isTerminal = true ↔
      (status.toModel = .succeeded ∨ status.toModel = .failed ∨
        status.toModel = .cancelled) := by
  cases status with
  | queued => simp [isTerminal, toExtract, Extract.TurnStatus.terminal, toModel]
  | running => simp [isTerminal, toExtract, Extract.TurnStatus.terminal, toModel]
  | suspended => simp [isTerminal, toExtract, Extract.TurnStatus.terminal, toModel]
  | terminal outcome =>
      cases outcome <;>
        simp [isTerminal, toExtract, Extract.TurnStatus.terminal, toModel, outcomeToModel]

end TurnStatus

/-- One Turn. Every constructor check in `turn.ts` is a field here, so an inconsistent Turn
is not a value: it does not typecheck. -/
structure Turn where
  id : TextId .turn
  run : TextId .run
  branch : TextId .runBranch
  startHead : TextId .runCommit
  effectiveInput : TextId .runCommit
  placement : Digest
  input : ContentRef
  status : TurnStatus
  lease : TurnLease
  checkpoint : Option (TextId .runCheckpoint)
  result : Option ContentRef
  revision : Revision
  /-- The lease belongs to this Turn. -/
  leaseOwned : lease.turn = id
  /-- A queued Turn holds an unheld epoch-zero lease. -/
  queuedUnheld : status = .queued →
    lease.holder = none ∧ lease.epoch = 0 ∧ lease.expiresAt = none
  /-- A running Turn holds its lease. -/
  runningHeld : status = .running → lease.holder.isSome = true
  /-- Suspended and terminal Turns are unheld. -/
  restingUnheld : status = .suspended ∨ status.isTerminal = true → lease.holder = none
  /-- A suspended Turn names the checkpoint it can be resumed from. -/
  suspendedCheckpointed : status = .suspended → checkpoint.isSome = true
  /-- A succeeded or failed Turn names its result. -/
  outcomeRecorded : status = .terminal .succeeded ∨ status = .terminal .failed →
    result.isSome = true

namespace Turn

/-- `requireToken`: a Turn mutation requires the exact current lease token, and only a
running Turn has one. The refusal is `lease.invalid`, not `turn.invalid-state`, because the
caller's token is what failed. -/
def requireToken (turn : Turn) (token : LeaseToken) (now : Millis) : Outcome Unit :=
  if turn.status == .running && turn.lease.admits token now then .ok ()
  else refuse .leaseInvalid

/-- **A token is refused unless the Turn is running under exactly it.** -/
theorem requireToken_refuses {turn : Turn} {token : LeaseToken} {now : Millis}
    (stale : turn.status ≠ .running ∨ turn.lease.admits token now = false) :
    (turn.requireToken token now).RefusedWith .leaseInvalid := by
  unfold requireToken
  rcases stale with notRunning | notAdmitted
  · simp [notRunning, refuse, Outcome.RefusedWith]
  · simp [notAdmitted, refuse, Outcome.RefusedWith]

/-- What `requireToken` proves about the Turn once it succeeds: the Turn is running. Every
token-gated transition uses this, so none of them re-derives it. -/
theorem requireToken_running {turn : Turn} {token : LeaseToken} {now : Millis}
    (admitted : turn.requireToken token now = .ok ()) : turn.status = .running := by
  unfold requireToken at admitted
  by_cases guard : (turn.status == TurnStatus.running) && turn.lease.admits token now
  · simpa using ((Bool.and_eq_true _ _).mp guard).1
  · rw [if_neg guard] at admitted
    simp [refuse] at admitted

/-- `claim`: the status moves to running and the lease is claimed in the same step, so a
running Turn without a held lease is never constructed. The decision is the status
machine's — `claimable` is exactly what `TurnStatus.claim` admits. -/
def claim (turn : Turn) (holder : PrincipalRef) (now expiresAt : Millis) : Outcome Turn :=
  if turn.status.claimable then
    match leaseStep : turn.lease.claim holder now expiresAt with
    | .error fault => .error fault
    | .ok lease =>
        match turn.revision.next with
        | .error fault => .error fault
        | .ok revision =>
            .ok { turn with
                  status := .running, lease := lease, revision := revision,
                  leaseOwned := by
                    rw [(TurnLease.claim_shape leaseStep).1, turn.leaseOwned]
                  queuedUnheld := by intro queued; simp at queued
                  runningHeld := by
                    intro _
                    rw [(TurnLease.claim_shape leaseStep).2.1]
                    rfl
                  restingUnheld := by
                    intro resting
                    rcases resting with suspended | terminal
                    · simp at suspended
                    · simp [TurnStatus.isTerminal, TurnStatus.toExtract,
                        Extract.TurnStatus.terminal] at terminal
                  suspendedCheckpointed := by intro suspended; simp at suspended
                  outcomeRecorded := by
                    intro recorded
                    rcases recorded with succeeded | failed
                    · simp at succeeded
                    · simp at failed }
  else refuse .turnInvalidState

/-- **`claim` admits exactly what the status machine admits.** -/
theorem claim_matches_status_machine (turn : Turn) :
    turn.status.claimable = true ↔ ∃ next, turn.status.claim = .ok next := by
  unfold TurnStatus.claimable TurnStatus.claim
  constructor
  · intro claimable
    cases moved : turn.status.toExtract.claim with
    | none => rw [moved] at claimable; simp at claimable
    | some next => exact ⟨TurnStatus.ofExtract next, rfl⟩
  · intro ⟨_, step⟩
    cases moved : turn.status.toExtract.claim with
    | none => rw [moved] at step; simp [refuse] at step
    | some _ => rfl

/-- `renew`: only a running Turn renews, under exactly its current token. Neither the status
nor the holder moves, so the Turn keeps the invariants it already had. -/
def renew (turn : Turn) (token : LeaseToken) (now expiresAt : Millis) : Outcome Turn :=
  match tokenStep : turn.requireToken token now with
  | .error fault => .error fault
  | .ok _ =>
      match leaseStep : turn.lease.renew token now expiresAt with
      | .error fault => .error fault
      | .ok lease =>
          match turn.revision.next with
          | .error fault => .error fault
          | .ok revision =>
              .ok { turn with
                    lease := lease, revision := revision,
                    leaseOwned := by
                      rw [(TurnLease.renew_shape leaseStep).1, turn.leaseOwned]
                    queuedUnheld := by
                      intro queued
                      rw [requireToken_running tokenStep] at queued
                      simp at queued
                    runningHeld := by
                      intro running
                      rw [(TurnLease.renew_shape leaseStep).2]
                      exact turn.runningHeld running
                    restingUnheld := by
                      intro resting
                      rw [(TurnLease.renew_shape leaseStep).2]
                      exact turn.restingUnheld resting
                    suspendedCheckpointed := turn.suspendedCheckpointed
                    outcomeRecorded := turn.outcomeRecorded }

/-- `reclaim`: a running Turn whose lease expired is taken over by a new holder at a new
epoch. The status does not move, so the Turn stays running with a held lease. -/
def reclaim (turn : Turn) (holder : PrincipalRef) (now expiresAt : Millis) : Outcome Turn :=
  if running : turn.status = .running then
    match leaseStep : turn.lease.reclaim holder now expiresAt with
    | .error fault => .error fault
    | .ok lease =>
        match turn.revision.next with
        | .error fault => .error fault
        | .ok revision =>
            .ok { turn with
                  lease := lease, revision := revision,
                  leaseOwned := by
                    rw [(TurnLease.reclaim_shape leaseStep).1, turn.leaseOwned]
                  queuedUnheld := by
                    intro queued
                    rw [running] at queued
                    simp at queued
                  runningHeld := by
                    intro _
                    rw [(TurnLease.reclaim_shape leaseStep).2.1]
                    rfl
                  restingUnheld := by
                    intro resting
                    rcases resting with suspended | terminal
                    · rw [running] at suspended
                      simp at suspended
                    · rw [running] at terminal
                      simp [TurnStatus.isTerminal, TurnStatus.toExtract,
                        Extract.TurnStatus.terminal] at terminal
                  suspendedCheckpointed := by
                    intro suspended
                    rw [running] at suspended
                    simp at suspended
                  outcomeRecorded := by
                    intro recorded
                    rcases recorded with succeeded | failed
                    · rw [running] at succeeded
                      simp at succeeded
                    · rw [running] at failed
                      simp at failed }
  else refuse .turnInvalidState

/-- `suspend`: the status moves to suspended, the lease is fenced, and the checkpoint the
Turn can be resumed from is recorded — all in one step, because a suspended Turn without a
checkpoint is not a Turn. -/
def suspend (turn : Turn) (token : LeaseToken) (checkpoint : TextId .runCheckpoint)
    (now : Millis) : Outcome Turn :=
  match turn.requireToken token now with
  | .error fault => .error fault
  | .ok _ =>
      match leaseStep : turn.lease.fence with
      | .error fault => .error fault
      | .ok lease =>
          match turn.revision.next with
          | .error fault => .error fault
          | .ok revision =>
              .ok { turn with
                    status := .suspended, lease := lease, revision := revision,
                    checkpoint := some checkpoint,
                    leaseOwned := by
                      rw [(TurnLease.fence_shape leaseStep).1, turn.leaseOwned]
                    queuedUnheld := by intro queued; simp at queued
                    runningHeld := by intro running; simp at running
                    restingUnheld := by
                      intro _
                      exact (TurnLease.fence_shape leaseStep).2
                    suspendedCheckpointed := by intro _; rfl
                    outcomeRecorded := by
                      intro recorded
                      rcases recorded with succeeded | failed
                      · simp at succeeded
                      · simp at failed }

/-- `complete`: the outcome, the fence, and the result land together, so a succeeded or
failed Turn always names its result. -/
def complete (turn : Turn) (token : LeaseToken) (outcome : TerminalOutcome)
    (result : ContentRef) (now : Millis) : Outcome Turn :=
  match turn.requireToken token now with
  | .error fault => .error fault
  | .ok _ =>
      match leaseStep : turn.lease.fence with
      | .error fault => .error fault
      | .ok lease =>
          match turn.revision.next with
          | .error fault => .error fault
          | .ok revision =>
              .ok { turn with
                    status := .terminal outcome, lease := lease, revision := revision,
                    result := some result,
                    leaseOwned := by
                      rw [(TurnLease.fence_shape leaseStep).1, turn.leaseOwned]
                    queuedUnheld := by intro queued; simp at queued
                    runningHeld := by intro running; simp at running
                    restingUnheld := by
                      intro _
                      exact (TurnLease.fence_shape leaseStep).2
                    suspendedCheckpointed := by intro suspended; simp at suspended
                    outcomeRecorded := by intro _; rfl }

/-- `cancelUnheld`: a queued or suspended Turn is cancelled with no token, because it holds
nothing. The lease is fenced anyway, so a stale token cannot mutate the cancelled Turn. -/
def cancelUnheld (turn : Turn) : Outcome Turn :=
  if turn.status.claimable then
    match leaseStep : turn.lease.fence with
    | .error fault => .error fault
    | .ok lease =>
        match turn.revision.next with
        | .error fault => .error fault
        | .ok revision =>
            .ok { turn with
                  status := .terminal .cancelled, lease := lease, revision := revision,
                  leaseOwned := by
                    rw [(TurnLease.fence_shape leaseStep).1, turn.leaseOwned]
                  queuedUnheld := by intro queued; simp at queued
                  runningHeld := by intro running; simp at running
                  restingUnheld := by
                    intro _
                    exact (TurnLease.fence_shape leaseStep).2
                  suspendedCheckpointed := by intro suspended; simp at suspended
                  outcomeRecorded := by
                    intro recorded
                    rcases recorded with succeeded | failed
                    · simp at succeeded
                    · simp at failed }
  else refuse .turnInvalidState

/-- `forceCancel` (SPEC §5.2 forced cancellation): a terminal unheld Turn is already where
this leaves it, so the transition is the identity there; anything else is cancelled and
fenced whatever it held. This is the one Turn transition that needs no token, because it is
system-authored on control evidence rather than executor-authored. -/
def forceCancel (turn : Turn) : Outcome Turn :=
  if turn.status.isTerminal && turn.lease.holder.isNone then .ok turn
  else
    match leaseStep : turn.lease.fence with
    | .error fault => .error fault
    | .ok lease =>
        match turn.revision.next with
        | .error fault => .error fault
        | .ok revision =>
            .ok { turn with
                  status := .terminal .cancelled, lease := lease, revision := revision,
                  leaseOwned := by
                    rw [(TurnLease.fence_shape leaseStep).1, turn.leaseOwned]
                  queuedUnheld := by intro queued; simp at queued
                  runningHeld := by intro running; simp at running
                  restingUnheld := by
                    intro _
                    exact (TurnLease.fence_shape leaseStep).2
                  suspendedCheckpointed := by intro suspended; simp at suspended
                  outcomeRecorded := by
                    intro recorded
                    rcases recorded with succeeded | failed
                    · simp at succeeded
                    · simp at failed }

/-- **A claimed Turn is running and held.** -/
theorem claim_running {turn claimed : Turn} {holder : PrincipalRef} {now expiresAt : Millis}
    (step : turn.claim holder now expiresAt = .ok claimed) :
    claimed.status = .running ∧ claimed.lease.holder.isSome = true := by
  unfold claim at step
  split at step
  · split at step
    · simp at step
    · next lease leaseStep =>
        split at step
        · simp at step
        · simp only [Except.ok.injEq] at step
          rw [← step]
          refine ⟨rfl, ?_⟩
          rw [(TurnLease.claim_shape leaseStep).2.1]
          rfl
  · simp [refuse] at step

/-- **A completed Turn is terminal, unheld, and holds its result.** The three facts arrive
together, so no reader ever sees a finished Turn whose result has not landed. -/
theorem complete_terminal {turn completed : Turn} {token : LeaseToken}
    {outcome : TerminalOutcome} {result : ContentRef} {now : Millis}
    (step : turn.complete token outcome result now = .ok completed) :
    completed.status = .terminal outcome ∧ completed.lease.holder = none ∧
      completed.result = some result := by
  unfold complete at step
  split at step
  · simp at step
  · split at step
    · simp at step
    · next lease leaseStep =>
        split at step
        · simp at step
        · simp only [Except.ok.injEq] at step
          rw [← step]
          exact ⟨rfl, (TurnLease.fence_shape leaseStep).2, rfl⟩

/-- **Every terminal Turn is unheld.** Read straight off the record's invariant: there is no
state in which a finished Turn still holds its branch. -/
theorem terminal_is_unheld (turn : Turn) (terminal : turn.status.isTerminal = true) :
    turn.lease.holder = none :=
  turn.restingUnheld (.inr terminal)

/-- **A queued Turn's lease is the unclaimed one.** -/
theorem queued_lease_is_unclaimed (turn : Turn) (queued : turn.status = .queued) :
    turn.lease.holder = none ∧ turn.lease.epoch = 0 :=
  ⟨(turn.queuedUnheld queued).1, (turn.queuedUnheld queued).2.1⟩

/-! ## Refinement against the model's Turn -/

/-- The model's Turn for this one, under an explicit identifier abstraction (a named premise
with an obvious discharge, never a hidden axiom) and the model's own pins/placement, which
the Turn record does not carry in executable form. -/
def toModel (turn : Turn) (idOf : String → Nat) (pins : AgentCore.TurnPins) :
    AgentCore.Turn where
  run := ⟨idOf turn.run.value⟩
  branch := ⟨idOf turn.branch.value⟩
  pins := pins
  status := turn.status.toModel
  lease := TurnLease.toModelLease turn.lease idOf

/-- **A running kernel Turn maps to a running model Turn that holds its lease.** This is the
model's `BranchHeldBy` precondition, so a kernel Turn that is running genuinely holds its
branch in the model's sense. -/
theorem running_refines_branchHeld {turn : Turn} (idOf : String → Nat)
    (pins : AgentCore.TurnPins) (running : turn.status = .running) :
    (turn.toModel idOf pins).status = .running ∧
      (turn.toModel idOf pins).lease.holder ≠ none := by
  refine ⟨by unfold toModel; rw [running]; rfl, ?_⟩
  unfold toModel TurnLease.toModelLease
  have held := turn.runningHeld running
  cases holderShape : turn.lease.holder with
  | none => rw [holderShape] at held; simp at held
  | some holder => simp

/-- **A terminal kernel Turn maps to a model Turn that holds nothing.** Together with
`terminal_is_unheld` this is the model's `SiblingTurnsTerminalAndUnheld` condition, one Turn
at a time: terminalization can close admission only over Turns in exactly this state. -/
theorem terminal_refines_unheld {turn : Turn} (idOf : String → Nat)
    (pins : AgentCore.TurnPins) (terminal : turn.status.isTerminal = true) :
    ((turn.toModel idOf pins).status = .succeeded ∨
        (turn.toModel idOf pins).status = .failed ∨
        (turn.toModel idOf pins).status = .cancelled) ∧
      (turn.toModel idOf pins).lease.holder = none := by
  refine ⟨?_, ?_⟩
  · unfold toModel
    exact (TurnStatus.isTerminal_refines_model turn.status).mp terminal
  · unfold toModel TurnLease.toModelLease
    rw [terminal_is_unheld turn terminal]
    rfl

end Turn

end AgentCore.Kernel
