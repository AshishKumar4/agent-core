/-
Agent Core SPEC §5.3: the Turn status vocabulary and every transition it admits.

One Lean module lowers to one TypeScript file. This module owns the transition table that
`packages/agent-core/src/agents/runs/turn.ts` used to spread across four singleton
subclasses of a handwritten `TurnStatus`: which status a claim, a suspension, a completion,
or an unheld cancellation moves a Turn to, and which of those moves does not exist. The
lowering emits that same shape — an abstract base with a singleton per case — so the case
behaviour still lives next to the case.

A move that does not exist is `none` here and an `AgentCoreError` with a stable code there.
The refusal is the host's to raise, because the code and its message are runtime taxonomy;
*which* moves are refused is decided here and nowhere else.

`TerminalOutcome` is the same vocabulary `src/agents/runs/outcome.ts` declares, lowered
once: a Turn's terminal statuses and a Run's terminal outcomes are the same three words, and
`ofTerminalOutcome` is the only mapping between them.
-/

namespace AgentCore.Extract

/--
How a Turn ended (SPEC §5.3). The three outcomes are the whole terminal vocabulary, shared
by Turn status, Run settlement, and every record that names an ending.
-/
inductive TerminalOutcome where
  | succeeded
  | failed
  | cancelled
  deriving DecidableEq, Repr

/--
Where a Turn is in its lifecycle (SPEC §5.3). `queued` and `suspended` are the two statuses
a lease may be claimed from; `running` is the only status that may complete; the three
terminal statuses admit no further move.
-/
inductive TurnStatus where
  | queued
  | running
  | suspended
  | succeeded
  | failed
  | cancelled
  deriving DecidableEq, Repr

/-- The status a Turn reaches by ending with this outcome. -/
def ofTerminalOutcome (outcome : TerminalOutcome) : TurnStatus :=
  match outcome with
  | .succeeded => .succeeded
  | .failed => .failed
  | .cancelled => .cancelled

/--
The status a claim moves this Turn to, and nothing when a Turn in this status cannot be
claimed. A queued Turn starts; a suspended Turn resumes; a running Turn is already held and
a terminal Turn is finished, so neither admits a claim.
-/
def TurnStatus.claim (status : TurnStatus) : Option TurnStatus :=
  match status with
  | .queued => some .running
  | .suspended => some .running
  | .running => none
  | .succeeded => none
  | .failed => none
  | .cancelled => none

/--
The status a suspension moves this Turn to. Only a running Turn suspends: suspending a
queued Turn would invent a hold nobody took, and a terminal Turn has nothing to suspend.
-/
def TurnStatus.suspend (status : TurnStatus) : Option TurnStatus :=
  match status with
  | .running => some .suspended
  | .queued => none
  | .suspended => none
  | .succeeded => none
  | .failed => none
  | .cancelled => none

/--
Whether this Turn may complete with an outcome. Only a running Turn may — a Turn that never
started, or already ended, has no attempt to record an outcome for. The status it reaches is
`ofTerminalOutcome` of that outcome, which is a fact about the outcome alone and so is
decided there; keeping the two apart is also what keeps this dispatch from carrying a
parameter half its cases would ignore.
-/
def TurnStatus.completes (status : TurnStatus) : Bool :=
  match status with
  | .running => true
  | .queued => false
  | .suspended => false
  | .succeeded => false
  | .failed => false
  | .cancelled => false

/--
The status an unheld cancellation moves this Turn to. Cancelling without a lease token is
admitted exactly where no token exists to be presented: a queued or suspended Turn. A
running Turn is held, and cancelling it requires that holder's token.
-/
def TurnStatus.cancelUnheld (status : TurnStatus) : Option TurnStatus :=
  match status with
  | .queued => some .cancelled
  | .suspended => some .cancelled
  | .running => none
  | .succeeded => none
  | .failed => none
  | .cancelled => none

/-- Whether this Turn has ended (SPEC §5.3): terminalization reads exactly this. -/
def TurnStatus.terminal (status : TurnStatus) : Bool :=
  match status with
  | .succeeded => true
  | .failed => true
  | .cancelled => true
  | .queued => false
  | .running => false
  | .suspended => false

/-- A terminal Turn admits no move at all: the four transitions are total on this fact. -/
theorem terminal_admits_nothing {status : TurnStatus} (ended : status.terminal = true) :
    status.claim = none ∧ status.suspend = none ∧ status.cancelUnheld = none ∧
      status.completes = false := by
  cases status <;>
    simp_all [TurnStatus.terminal, TurnStatus.claim, TurnStatus.suspend, TurnStatus.cancelUnheld,
      TurnStatus.completes]

/-- Every status a claim or a suspension reaches is non-terminal: neither move ends a Turn. -/
theorem moves_stay_live {status next : TurnStatus}
    (moved : status.claim = some next ∨ status.suspend = some next) : next.terminal = false := by
  cases status <;> simp_all [TurnStatus.claim, TurnStatus.suspend] <;> subst_vars <;>
    simp [TurnStatus.terminal]

/-- Completion always lands on a terminal status, whichever outcome it records. -/
theorem complete_is_terminal (outcome : TerminalOutcome) :
    (ofTerminalOutcome outcome).terminal = true := by
  cases outcome <;> simp [ofTerminalOutcome, TurnStatus.terminal]

/-- A cancellation with no token lands on `cancelled`, never on another ending. -/
theorem cancel_unheld_cancels {status next : TurnStatus}
    (cancelled : status.cancelUnheld = some next) : next = .cancelled := by
  cases status <;> simp_all [TurnStatus.cancelUnheld]

end AgentCore.Extract
