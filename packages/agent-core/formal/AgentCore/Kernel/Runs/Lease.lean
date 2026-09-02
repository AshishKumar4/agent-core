/-
Turn leases (SPEC §5.3; `packages/agent-core/src/agents/runs/lease.ts`).

A lease is the right to mutate one Turn, and every executor mutation carries the exact Turn
id and the current epoch. Four transitions move it and they are the whole vocabulary:
`claim` takes an unheld lease, `renew` extends the exact current token strictly forward,
`reclaim` takes over an *expired held* lease, and `fence` clears the holder while advancing
the epoch. Elapsed time alone never releases a lease — that is why `reclaim` exists and why
the model's `BranchHeldBy` reads the holder rather than the expiry.

Time is a millisecond count, which is what the runtime compares (`Date.getTime()`); the
runtime's "valid Date" checks are the finiteness of that number and are discharged by the
type. Each transition is written as one guard, because the runtime refuses all of its
preconditions with the same `lease.invalid` code and a caller cannot tell the branches
apart — the code is the contract, and one guard makes that visible.
-/
import AgentCore.Lease
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- Wall-clock as the runtime compares it: milliseconds since the epoch. -/
abbrev Millis := Nat

/-- The token an executor presents: the exact Turn, holder, and epoch. -/
structure LeaseToken where
  turn : TextId .turn
  holder : PrincipalRef
  epoch : Nat
  deriving DecidableEq

/-- One Turn's lease. `holder = none` is unheld; a held lease always has an expiry, which is
the runtime's `Held Turn leases require an expiration` invariant carried in the type. -/
structure TurnLease where
  turn : TextId .turn
  holder : Option PrincipalRef
  epoch : Nat
  expiresAt : Option Millis
  /-- A held lease has an expiration. -/
  heldHasExpiry : holder.isSome = true → expiresAt.isSome = true

namespace TurnLease

/-- `TurnLease.unclaimed`. -/
def unclaimed (turn : TextId .turn) : TurnLease where
  turn := turn
  holder := none
  epoch := 0
  expiresAt := none
  heldHasExpiry := by simp

theorem eq_of_fields {left right : TurnLease} (turn : left.turn = right.turn)
    (holder : left.holder = right.holder) (epoch : left.epoch = right.epoch)
    (expiresAt : left.expiresAt = right.expiresAt) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨turn, holder, epoch, expiresAt⟩

/-- `admits`: the exact turn, the exact holder, the exact epoch, and an expiry strictly in
the future. Anything less is not the current token. -/
def admits (lease : TurnLease) (token : LeaseToken) (now : Millis) : Bool :=
  match lease.holder, lease.expiresAt with
  | some holder, some expiry =>
      lease.turn == token.turn && holder == token.holder && lease.epoch == token.epoch &&
        now < expiry
  | _, _ => false

/-- Whether the lease is held and its term has already elapsed: the one state `reclaim`
admits. -/
def expiredHeld (lease : TurnLease) (now : Millis) : Bool :=
  match lease.holder, lease.expiresAt with
  | some _, some expiry => expiry ≤ now
  | _, _ => false

/-- Whether a new expiry is strictly later than the current one. -/
def extends' (lease : TurnLease) (expiresAt : Millis) : Bool :=
  match lease.expiresAt with
  | some current => current < expiresAt
  | none => false

/-- The precondition `claim` admits: a future expiry on an unheld lease. -/
def claimable (lease : TurnLease) (now expiresAt : Millis) : Bool :=
  now < expiresAt && lease.holder.isNone

/-- The precondition `renew` admits: a future expiry, the exact current token, and a
strictly later term. -/
def renewable (lease : TurnLease) (token : LeaseToken) (now expiresAt : Millis) : Bool :=
  now < expiresAt && lease.admits token now && lease.extends' expiresAt

/-- The precondition `reclaim` admits: a future expiry over an expired held lease. -/
def reclaimable (lease : TurnLease) (now expiresAt : Millis) : Bool :=
  now < expiresAt && lease.expiredHeld now

/-- `nextEpoch`: one step, refusing at the top of the safe range. -/
def nextEpoch (epoch : Nat) : Outcome Nat :=
  if epoch < maxSafeInteger then .ok (epoch + 1) else refuse .leaseInvalid

theorem nextEpoch_increases {epoch next : Nat} (step : nextEpoch epoch = .ok next) :
    next = epoch + 1 := by
  unfold nextEpoch at step
  by_cases bound : epoch < maxSafeInteger
  · simp only [bound, if_true, Except.ok.injEq] at step
    exact step.symm
  · simp [bound, refuse] at step

/-- `claim`: only an unheld lease, only into the future, and always a new epoch. -/
def claim (lease : TurnLease) (holder : PrincipalRef) (now expiresAt : Millis) :
    Outcome TurnLease :=
  if lease.claimable now expiresAt then
    match nextEpoch lease.epoch with
    | .error fault => .error fault
    | .ok epoch =>
        .ok { turn := lease.turn, holder := some holder, epoch := epoch,
              expiresAt := some expiresAt, heldHasExpiry := by simp }
  else refuse .leaseInvalid

/-- `renew`: the exact current token, and strictly later. The epoch never moves, so a
renewal is not a new incarnation and never extends an immutable deadline into a new one. -/
def renew (lease : TurnLease) (token : LeaseToken) (now expiresAt : Millis) :
    Outcome TurnLease :=
  if lease.renewable token now expiresAt then
    .ok { lease with expiresAt := some expiresAt, heldHasExpiry := by simp }
  else refuse .leaseInvalid

/-- `reclaim`: only an expired held lease, and the new incarnation gets a new epoch. -/
def reclaim (lease : TurnLease) (holder : PrincipalRef) (now expiresAt : Millis) :
    Outcome TurnLease :=
  if lease.reclaimable now expiresAt then
    match nextEpoch lease.epoch with
    | .error fault => .error fault
    | .ok epoch =>
        .ok { turn := lease.turn, holder := some holder, epoch := epoch,
              expiresAt := some expiresAt, heldHasExpiry := by simp }
  else refuse .leaseInvalid

/-- `fence`: clear the holder and advance the epoch. Fencing is the only way a branch is
released; elapsed time is not. -/
def fence (lease : TurnLease) : Outcome TurnLease :=
  match nextEpoch lease.epoch with
  | .error fault => .error fault
  | .ok epoch =>
      .ok { turn := lease.turn, holder := none, epoch := epoch,
            expiresAt := lease.expiresAt, heldHasExpiry := by simp }

/-- **An unclaimed lease admits nothing.** -/
theorem unclaimed_admits_nothing (turn : TextId .turn) (token : LeaseToken) (now : Millis) :
    (unclaimed turn).admits token now = false := by
  simp [unclaimed, admits]

/-- **A fenced lease admits nothing.** Fencing is what makes an in-flight executor's next
mutation fail, whatever token it still holds. -/
theorem fenced_admits_nothing {lease fenced : TurnLease} (step : lease.fence = .ok fenced)
    (token : LeaseToken) (now : Millis) : fenced.admits token now = false := by
  unfold fence at step
  cases epoch : nextEpoch lease.epoch with
  | error fault => rw [epoch] at step; simp at step
  | ok next =>
      rw [epoch] at step
      simp only [Except.ok.injEq] at step
      rw [← step]
      simp [admits]

/-- **Fencing advances the epoch.** A later claim is a different incarnation, so a token
from before the fence can never be current again. -/
theorem fence_advances_epoch {lease fenced : TurnLease} (step : lease.fence = .ok fenced) :
    lease.epoch < fenced.epoch := by
  unfold fence at step
  cases epoch : nextEpoch lease.epoch with
  | error fault => rw [epoch] at step; simp at step
  | ok next =>
      rw [epoch] at step
      simp only [Except.ok.injEq] at step
      have shape : fenced.epoch = next := by rw [← step]
      rw [shape, nextEpoch_increases epoch]
      omega

/-- **A claim advances the epoch.** -/
theorem claim_advances_epoch {lease claimed : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : lease.claim holder now expiresAt = .ok claimed) :
    lease.epoch < claimed.epoch := by
  unfold claim at step
  by_cases guard : lease.claimable now expiresAt = true
  · rw [if_pos guard] at step
    cases epoch : nextEpoch lease.epoch with
    | error fault => rw [epoch] at step; simp at step
    | ok next =>
        rw [epoch] at step
        simp only [Except.ok.injEq] at step
        have shape : claimed.epoch = next := by rw [← step]
        rw [shape, nextEpoch_increases epoch]
        omega
  · rw [if_neg guard] at step
    simp [refuse] at step

/-- **A claim requires an unheld lease.** A second claimant is refused with `lease.invalid`
rather than silently taking over. -/
theorem claim_requires_unheld {lease : TurnLease} {holder existing : PrincipalRef}
    {now expiresAt : Millis} (held : lease.holder = some existing) :
    (lease.claim holder now expiresAt).RefusedWith .leaseInvalid := by
  unfold claim claimable
  simp [held, refuse, Outcome.RefusedWith]

/-- **A claim requires a future expiry.** -/
theorem claim_requires_future {lease : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (past : expiresAt ≤ now) :
    (lease.claim holder now expiresAt).RefusedWith .leaseInvalid := by
  unfold claim claimable
  have notFuture : ¬ now < expiresAt := Nat.not_lt.mpr past
  simp [notFuture, refuse, Outcome.RefusedWith]

/-- **Renewal never extends backwards.** An expiry that is not strictly later is refused, so
a renewal can neither shorten a lease nor leave it unchanged. -/
theorem renew_requires_later {lease : TurnLease} {token : LeaseToken}
    {now expiresAt current : Millis} (expiry : lease.expiresAt = some current)
    (notLater : expiresAt ≤ current) :
    (lease.renew token now expiresAt).RefusedWith .leaseInvalid := by
  unfold renew renewable extends'
  have notStrict : ¬ current < expiresAt := Nat.not_lt.mpr notLater
  simp [expiry, notStrict, refuse, Outcome.RefusedWith]

/-- **Renewal keeps the incarnation.** The holder and epoch are exactly what they were, so a
renewal is not a new lease and a fenced token stays fenced. -/
theorem renew_keeps_epoch {lease renewed : TurnLease} {token : LeaseToken}
    {now expiresAt : Millis} (step : lease.renew token now expiresAt = .ok renewed) :
    renewed.epoch = lease.epoch ∧ renewed.holder = lease.holder := by
  unfold renew at step
  by_cases guard : lease.renewable token now expiresAt = true
  · rw [if_pos guard] at step
    simp only [Except.ok.injEq] at step
    rw [← step]
    exact ⟨rfl, rfl⟩
  · rw [if_neg guard] at step
    simp [refuse] at step

/-- **Renewal requires the exact current token.** -/
theorem renew_requires_exact_token {lease : TurnLease} {token : LeaseToken}
    {now expiresAt : Millis} (stale : lease.admits token now = false) :
    (lease.renew token now expiresAt).RefusedWith .leaseInvalid := by
  unfold renew renewable
  simp [stale, refuse, Outcome.RefusedWith]

/-- **Reclaim requires an expired held lease.** A live lease cannot be taken from its
holder, which is what makes a lease an exclusive right for its whole term. -/
theorem reclaim_requires_expired {lease : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (live : lease.expiredHeld now = false) :
    (lease.reclaim holder now expiresAt).RefusedWith .leaseInvalid := by
  unfold reclaim reclaimable
  simp [live, refuse, Outcome.RefusedWith]

/-- **A live held lease is never reclaimable.** -/
theorem live_lease_not_expiredHeld {lease : TurnLease} {now expiry : Millis}
    (currentExpiry : lease.expiresAt = some expiry) (live : now < expiry) :
    lease.expiredHeld now = false := by
  unfold expiredHeld
  have notElapsed : ¬ expiry ≤ now := Nat.not_le.mpr live
  cases holderShape : lease.holder with
  | none => simp
  | some existing => simp [currentExpiry, notElapsed]

/-- **Reclaim advances the epoch.** The reclaimed lease is a new incarnation, so the previous
holder's token is dead even though it was never fenced. -/
theorem reclaim_advances_epoch {lease reclaimed : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : lease.reclaim holder now expiresAt = .ok reclaimed) :
    lease.epoch < reclaimed.epoch := by
  unfold reclaim at step
  by_cases guard : lease.reclaimable now expiresAt = true
  · rw [if_pos guard] at step
    cases epoch : nextEpoch lease.epoch with
    | error fault => rw [epoch] at step; simp at step
    | ok next =>
        rw [epoch] at step
        simp only [Except.ok.injEq] at step
        have shape : reclaimed.epoch = next := by rw [← step]
        rw [shape, nextEpoch_increases epoch]
        omega
  · rw [if_neg guard] at step
    simp [refuse] at step

/-! ## What each transition leaves behind

Every lease transition keeps the Turn it belongs to, and each one fixes the holder. These
are what the `Turn` record's own invariants are discharged from, so a Turn transition never
has to re-derive them from the lease's definition. -/

theorem claim_shape {lease claimed : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : lease.claim holder now expiresAt = .ok claimed) :
    claimed.turn = lease.turn ∧ claimed.holder = some holder ∧
      claimed.expiresAt = some expiresAt := by
  unfold claim at step
  by_cases guard : lease.claimable now expiresAt = true
  · rw [if_pos guard] at step
    cases epoch : nextEpoch lease.epoch with
    | error fault => rw [epoch] at step; simp at step
    | ok next =>
        rw [epoch] at step
        simp only [Except.ok.injEq] at step
        rw [← step]
        exact ⟨rfl, rfl, rfl⟩
  · rw [if_neg guard] at step
    simp [refuse] at step

theorem reclaim_shape {lease reclaimed : TurnLease} {holder : PrincipalRef}
    {now expiresAt : Millis} (step : lease.reclaim holder now expiresAt = .ok reclaimed) :
    reclaimed.turn = lease.turn ∧ reclaimed.holder = some holder ∧
      reclaimed.expiresAt = some expiresAt := by
  unfold reclaim at step
  by_cases guard : lease.reclaimable now expiresAt = true
  · rw [if_pos guard] at step
    cases epoch : nextEpoch lease.epoch with
    | error fault => rw [epoch] at step; simp at step
    | ok next =>
        rw [epoch] at step
        simp only [Except.ok.injEq] at step
        rw [← step]
        exact ⟨rfl, rfl, rfl⟩
  · rw [if_neg guard] at step
    simp [refuse] at step

theorem renew_shape {lease renewed : TurnLease} {token : LeaseToken} {now expiresAt : Millis}
    (step : lease.renew token now expiresAt = .ok renewed) :
    renewed.turn = lease.turn ∧ renewed.holder = lease.holder := by
  unfold renew at step
  by_cases guard : lease.renewable token now expiresAt = true
  · rw [if_pos guard] at step
    simp only [Except.ok.injEq] at step
    rw [← step]
    exact ⟨rfl, rfl⟩
  · rw [if_neg guard] at step
    simp [refuse] at step

theorem fence_shape {lease fenced : TurnLease} (step : lease.fence = .ok fenced) :
    fenced.turn = lease.turn ∧ fenced.holder = none := by
  unfold fence at step
  cases epoch : nextEpoch lease.epoch with
  | error fault => rw [epoch] at step; simp at step
  | ok next =>
      rw [epoch] at step
      simp only [Except.ok.injEq] at step
      rw [← step]
      exact ⟨rfl, rfl⟩

/-! ## Refinement against the model's lease

`AgentCore.TurnLease` is the abstract lease and `AgentCore.TurnLease.Admits` its admission
predicate. The kernel's `admits` is the executable form of exactly that predicate. -/

/-- The model's lease for this one. The model identifies Turns and holders by `Nat`, so the
map takes the abstraction of identifier text as an explicit parameter: a named premise with
an obvious discharge (any injective interning of the identifier space), never a hidden
axiom. An unheld lease has no expiry to carry and the model's `Time` has no absent value;
`0` is the only honest image, and no theorem here reads it, because admission is false for
an unheld lease on both sides. -/
def toModelLease (lease : TurnLease) (idOf : String → Nat) : AgentCore.TurnLease where
  turn := ⟨idOf lease.turn.value⟩
  holder := lease.holder.map fun holder =>
    ⟨⟨idOf holder.tenant.value⟩, ⟨idOf holder.principal.value⟩⟩
  epoch := lease.epoch
  expiresAt := ⟨lease.expiresAt.getD 0⟩

/-- The model's token for this one, under the same abstraction. -/
def toModelToken (token : LeaseToken) (idOf : String → Nat) : AgentCore.LeaseToken where
  turn := ⟨idOf token.turn.value⟩
  holder := ⟨⟨idOf token.holder.tenant.value⟩, ⟨idOf token.holder.principal.value⟩⟩
  epoch := token.epoch

/-- **The kernel's admission is the model's admission.** Whenever the kernel admits a token,
the model's `Admits` holds of the mapped lease, token, and time — so every lease theorem in
the model applies to what the executor actually checks. -/
theorem admits_refines_model {lease : TurnLease} {token : LeaseToken} {now : Millis}
    (idOf : String → Nat) (admitted : lease.admits token now = true) :
    (toModelLease lease idOf).Admits (toModelToken token idOf) ⟨now⟩ := by
  unfold admits at admitted
  cases holderShape : lease.holder with
  | none => rw [holderShape] at admitted; simp at admitted
  | some holder =>
      cases expiryShape : lease.expiresAt with
      | none => rw [holderShape, expiryShape] at admitted; simp at admitted
      | some expiry =>
          rw [holderShape, expiryShape] at admitted
          simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at admitted
          obtain ⟨⟨⟨turnSame, holderSame⟩, epochSame⟩, live⟩ := admitted
          refine ⟨?_, ?_, ?_, ?_⟩
          · unfold toModelLease toModelToken
            rw [turnSame]
          · unfold toModelLease
            rw [holderShape, holderSame]
            rfl
          · unfold toModelLease toModelToken
            exact epochSame.symm
          · unfold toModelLease
            rw [expiryShape]
            exact live

end TurnLease

end AgentCore.Kernel
