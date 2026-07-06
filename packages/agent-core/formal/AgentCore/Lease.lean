/-!
# The Turn lease protocol (SPEC §5.3)

A Turn holds a lease with a monotonically increasing epoch. Claiming, reclaiming an
expired lease, suspending, and completing all advance the epoch; every Turn-owned commit
carries the epoch it ran under, and a commit presenting a stale epoch is rejected at the
owning Actor. This module models the lease as a small labeled transition system and
proves the guarantees SPEC §5.3 relies on — culminating in the fencing property: once
the epoch has moved past a value, a commit at that value can never be admitted again, so
a zombie executor's writes cannot land.
-/

namespace AgentCore

/-- A lease: who currently holds it (if anyone) and the current fencing epoch. -/
structure Lease where
  holder : Option Nat
  epoch : Nat
  deriving DecidableEq, Repr

inductive LeaseLabel where
  /-- Claim an unheld lease. -/
  | claim (holder : Nat)
  /-- Renew the current holder's lease at the current epoch. -/
  | renew (holder : Nat) (epoch : Nat)
  /-- Reclaim an expired lease under a new executor. -/
  | reclaim (holder : Nat)
  /-- Suspend: persist a checkpoint and fence. -/
  | suspend
  /-- Fence on completion / cancellation. -/
  | fence
  deriving DecidableEq, Repr

inductive LeaseStep : Lease → LeaseLabel → Lease → Prop
  | claim {lease holder} :
      lease.holder = none →
      LeaseStep lease (.claim holder) { holder := some holder, epoch := lease.epoch + 1 }
  | renew {lease holder} :
      lease.holder = some holder →
      LeaseStep lease (.renew holder lease.epoch) lease
  | reclaim {lease holder} :
      lease.holder.isSome →
      LeaseStep lease (.reclaim holder) { holder := some holder, epoch := lease.epoch + 1 }
  | suspend {lease} :
      LeaseStep lease .suspend { holder := none, epoch := lease.epoch + 1 }
  | fence {lease} :
      LeaseStep lease .fence { holder := none, epoch := lease.epoch + 1 }

/-- **The epoch never decreases.** Every lease transition preserves or advances the
    epoch. -/
theorem lease_epoch_monotone {before after label}
    (step : LeaseStep before label after) :
    before.epoch ≤ after.epoch := by
  cases step <;> simp <;> omega

/-- **Claiming advances the epoch.** -/
theorem claim_advances_epoch {before after holder}
    (step : LeaseStep before (.claim holder) after) :
    before.epoch < after.epoch := by
  cases step; simp

/-- **Reclaiming an expired lease advances the epoch.** -/
theorem reclaim_advances_epoch {before after holder}
    (step : LeaseStep before (.reclaim holder) after) :
    before.epoch < after.epoch := by
  cases step; simp

/-- **A claim requires an unheld lease.** You cannot claim a lease someone still holds;
    that path is reclaim, which fences the prior holder by advancing the epoch. -/
theorem claim_requires_unheld {before after holder}
    (step : LeaseStep before (.claim holder) after) :
    before.holder = none := by
  cases step with
  | claim unheld => exact unheld

/-- **Fencing rejects the prior holder.** After a fence the lease is unheld and its
    epoch has advanced, so the prior holder cannot renew (renew requires being the
    current holder at the current epoch). -/
theorem fence_rejects_prior_holder {before after}
    (step : LeaseStep before .fence after) :
    after.holder = none ∧ before.epoch < after.epoch := by
  cases step
  refine ⟨rfl, ?_⟩
  simp

/-- A commit is admitted only when it presents the current epoch and the current holder.
    This is the owning-Actor check every Turn-owned commit passes through (SPEC §5.3). -/
def Admits (lease : Lease) (commitEpoch : Nat) (commitHolder : Nat) : Prop :=
  lease.epoch = commitEpoch ∧ lease.holder = some commitHolder

/-- **A stale epoch is never admitted.** A commit presenting an epoch below the current
    one is rejected — the single-step fencing guarantee. -/
theorem stale_epoch_never_admitted {lease commitEpoch commitHolder}
    (stale : commitEpoch < lease.epoch) :
    ¬ Admits lease commitEpoch commitHolder := by
  intro admits
  rw [admits.1] at stale
  exact Nat.lt_irrefl _ stale

/-! ### Over a run of the protocol -/

inductive LeaseExec : Lease → List LeaseLabel → Lease → Prop
  | nil (lease) : LeaseExec lease [] lease
  | cons {start mid finish label labels} :
      LeaseStep start label mid →
      LeaseExec mid labels finish →
      LeaseExec start (label :: labels) finish

/-- **The epoch is monotone across a whole run.** -/
theorem exec_epoch_monotone {before after labels}
    (exec : LeaseExec before labels after) :
    before.epoch ≤ after.epoch := by
  induction exec with
  | nil => exact Nat.le_refl _
  | cons step _ ih => exact Nat.le_trans (lease_epoch_monotone step) ih

/-- **Fencing is permanent across a run.** Once the epoch has advanced past a commit's
    epoch, no later state in the run admits that commit — a zombie executor holding an
    old epoch can never write, no matter how the protocol proceeds afterward. -/
theorem exec_stale_epoch_never_admitted {before after labels commitEpoch commitHolder}
    (passed : commitEpoch < before.epoch)
    (exec : LeaseExec before labels after) :
    ¬ Admits after commitEpoch commitHolder :=
  stale_epoch_never_admitted (Nat.lt_of_lt_of_le passed (exec_epoch_monotone exec))

end AgentCore
