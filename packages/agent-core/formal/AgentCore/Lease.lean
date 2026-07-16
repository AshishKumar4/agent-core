import AgentCore.Policy

/-!
# Exact Turn leases

The immutable Turn id is present in both lease and token. Admission is one check over
Turn, holder, epoch, and strict expiry. Reclaim requires expiry, resume retains the same
Turn, and terminal fencing atomically clears the holder while advancing the epoch.
-/

namespace AgentCore

structure TurnLease where
  turn : TurnId
  holder : Option PrincipalRef
  epoch : Nat
  expiresAt : Time
  deriving DecidableEq, Repr

def TurnLease.initial (turn : TurnId) : TurnLease := ⟨turn, none, 0, ⟨0⟩⟩

def TurnLease.Admits (lease : TurnLease) (token : LeaseToken) (now : Time) : Prop :=
  token.turn = lease.turn ∧ lease.holder = some token.holder ∧
  token.epoch = lease.epoch ∧ now.tick < lease.expiresAt.tick

def TurnLease.admitsBool (lease : TurnLease) (token : LeaseToken) (now : Time) : Bool :=
  token.turn == lease.turn && lease.holder == some token.holder &&
  token.epoch == lease.epoch && decide (now.tick < lease.expiresAt.tick)

theorem TurnLease.admitsBool_eq_true {lease : TurnLease} {token : LeaseToken} {now : Time} :
    lease.admitsBool token now = true ↔ lease.Admits token now := by
  simp only [TurnLease.admitsBool, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq,
    TurnLease.Admits]
  constructor
  · rintro ⟨⟨⟨turn, holder⟩, epoch⟩, live⟩
    exact ⟨turn, holder, epoch, live⟩
  · rintro ⟨turn, holder, epoch, live⟩
    exact ⟨⟨⟨turn, holder⟩, epoch⟩, live⟩

inductive LeaseLabel where
  | claim (holder : PrincipalRef) (now expiresAt : Time)
  | renew (token : LeaseToken) (now expiresAt : Time)
  | reclaim (holder : PrincipalRef) (now expiresAt : Time)
  | suspendFence
  | resume (holder : PrincipalRef) (now expiresAt : Time)
  | terminalFence
  deriving DecidableEq, Repr

inductive LeaseStep : TurnLease → LeaseLabel → TurnLease → Prop
  | claim {lease holder now expiresAt} :
      lease.holder = none → now.tick < expiresAt.tick →
      LeaseStep lease (.claim holder now expiresAt)
        ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
  | renew {lease token now expiresAt} :
      lease.Admits token now → lease.expiresAt.tick < expiresAt.tick →
      LeaseStep lease (.renew token now expiresAt) { lease with expiresAt := expiresAt }
  | reclaim {lease holder now expiresAt} :
      lease.holder.isSome → lease.expiresAt.tick ≤ now.tick → now.tick < expiresAt.tick →
      LeaseStep lease (.reclaim holder now expiresAt)
        ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
  | suspendFence {lease} :
      LeaseStep lease .suspendFence ⟨lease.turn, none, lease.epoch + 1, lease.expiresAt⟩
  | resume {lease holder now expiresAt} :
      lease.holder = none → now.tick < expiresAt.tick →
      LeaseStep lease (.resume holder now expiresAt)
        ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
  | terminalFence {lease} :
      LeaseStep lease .terminalFence ⟨lease.turn, none, lease.epoch + 1, lease.expiresAt⟩

theorem lease_turn_immutable {before label after} (step : LeaseStep before label after) :
    after.turn = before.turn := by cases step <;> rfl

theorem lease_epoch_monotone {before label after} (step : LeaseStep before label after) :
    before.epoch ≤ after.epoch := by cases step <;> simp

theorem reclaim_requires_expiry {before holder now expiresAt after}
    (step : LeaseStep before (.reclaim holder now expiresAt) after) :
    before.expiresAt.tick ≤ now.tick := by cases step; assumption

theorem resume_is_same_turn {before holder now expiresAt after}
    (step : LeaseStep before (.resume holder now expiresAt) after) :
    after.turn = before.turn ∧ after.epoch = before.epoch + 1 := by cases step; exact ⟨rfl, rfl⟩

theorem terminal_fence_is_atomic {before after}
    (step : LeaseStep before .terminalFence after) :
    after.turn = before.turn ∧ after.holder = none ∧ after.epoch = before.epoch + 1 := by
  cases step
  exact ⟨rfl, rfl, rfl⟩

theorem wrong_turn_rejects {lease : TurnLease} {token : LeaseToken} {now : Time}
    (wrong : token.turn ≠ lease.turn) :
    ¬ lease.Admits token now := fun admitted => wrong admitted.1

theorem stale_token_rejects {lease : TurnLease} {token : LeaseToken} {now : Time}
    (stale : token.epoch < lease.epoch) :
    ¬ lease.Admits token now := by
  intro admitted
  rw [admitted.2.2.1] at stale
  exact Nat.lt_irrefl _ stale

theorem expired_lease_rejects {lease : TurnLease} {token : LeaseToken} {now : Time}
    (expired : lease.expiresAt.tick ≤ now.tick) : ¬ lease.Admits token now := by
  intro admitted
  exact Nat.not_lt_of_ge expired admitted.2.2.2

theorem renewal_cannot_extend_resolution_deadline {before after : TurnLease}
    {token : LeaseToken} {now expiresAt : Time} {resolution : Resolution}
    (step : LeaseStep before (.renew token now expiresAt) after)
    (bounded : resolution.deadline.tick ≤ before.expiresAt.tick) :
    resolution.deadline.tick ≤ after.expiresAt.tick := by
  cases step with
  | renew admitted extended => exact Nat.le_trans bounded (Nat.le_of_lt extended)


/-! ## Executable step semantics

`leaseStepExec` is the computable mirror of `LeaseStep`, proven sound and complete
below. The differential-testing oracle runs it against the TypeScript implementation;
the two theorems make the oracle's answers carry the relation's meaning.
-/

instance {lease : TurnLease} {token : LeaseToken} {now : Time} :
    Decidable (lease.Admits token now) := by
  unfold TurnLease.Admits
  infer_instance

def leaseStepExec (lease : TurnLease) : LeaseLabel → Option TurnLease
  | .claim holder now expiresAt =>
      if lease.holder = none ∧ now.tick < expiresAt.tick then
        some ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
      else none
  | .renew token now expiresAt =>
      if lease.Admits token now ∧ lease.expiresAt.tick < expiresAt.tick then
        some { lease with expiresAt := expiresAt }
      else none
  | .reclaim holder now expiresAt =>
      if lease.holder.isSome ∧ lease.expiresAt.tick ≤ now.tick ∧ now.tick < expiresAt.tick then
        some ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
      else none
  | .suspendFence => some ⟨lease.turn, none, lease.epoch + 1, lease.expiresAt⟩
  | .resume holder now expiresAt =>
      if lease.holder = none ∧ now.tick < expiresAt.tick then
        some ⟨lease.turn, some holder, lease.epoch + 1, expiresAt⟩
      else none
  | .terminalFence => some ⟨lease.turn, none, lease.epoch + 1, lease.expiresAt⟩

theorem leaseStepExec_sound {lease after : TurnLease} {label : LeaseLabel}
    (executed : leaseStepExec lease label = some after) : LeaseStep lease label after := by
  cases label with
  | claim holder now expiresAt =>
      simp only [leaseStepExec] at executed
      split at executed
      next h => exact Option.some.inj executed ▸ LeaseStep.claim h.1 h.2
      next => exact absurd executed (by simp)
  | renew token now expiresAt =>
      simp only [leaseStepExec] at executed
      split at executed
      next h => exact Option.some.inj executed ▸ LeaseStep.renew h.1 h.2
      next => exact absurd executed (by simp)
  | reclaim holder now expiresAt =>
      simp only [leaseStepExec] at executed
      split at executed
      next h => exact Option.some.inj executed ▸ LeaseStep.reclaim h.1 h.2.1 h.2.2
      next => exact absurd executed (by simp)
  | suspendFence =>
      simp only [leaseStepExec] at executed
      exact Option.some.inj executed ▸ LeaseStep.suspendFence
  | resume holder now expiresAt =>
      simp only [leaseStepExec] at executed
      split at executed
      next h => exact Option.some.inj executed ▸ LeaseStep.resume h.1 h.2
      next => exact absurd executed (by simp)
  | terminalFence =>
      simp only [leaseStepExec] at executed
      exact Option.some.inj executed ▸ LeaseStep.terminalFence

theorem leaseStepExec_complete {lease after : TurnLease} {label : LeaseLabel}
    (step : LeaseStep lease label after) : leaseStepExec lease label = some after := by
  cases step with
  | claim unheld fresh => simp [leaseStepExec, unheld, fresh]
  | renew admitted extended => simp [leaseStepExec, admitted, extended]
  | reclaim held expired fresh => simp [leaseStepExec, held, expired, fresh]
  | suspendFence => simp [leaseStepExec]
  | resume unheld fresh => simp [leaseStepExec, unheld, fresh]
  | terminalFence => simp [leaseStepExec]


end AgentCore
