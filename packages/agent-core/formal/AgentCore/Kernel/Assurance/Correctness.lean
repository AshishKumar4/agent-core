/-
Total correctness of the kernel's state-machine operations (SPEC §1.6, §5.2, §5.3, §5.6).

"Total correctness" is usually two claims — the program terminates, and if it terminates its
post-state satisfies the contract — and in this kernel the first one is not a theorem: every
definition is a total function, `partial` is banned, and elaboration is what establishes it.
Saying only that would be saying nothing. What is left to prove is the part a total function
can still get wrong, and it is exactly three things:

* **The outcome channel is declared.** Every operation lands in an `.ok`, or in a refusal
  carrying a code from a *listed* vocabulary, or — for the two operations that can — in a
  named shape fault. `TotallyCorrect` states this with the shape-fault list explicit, so an
  operation that passes `[]` for it has *proved* it never produces one. That is the real
  content: `Outcome` admits a `Fault.shape` at every type, and a caller who has to handle a
  `TypeError` from `Turn.claim` cannot be told it never happens without a proof.
* **The post-state satisfies the contract.** Each `.ok` carries the operation's own
  postcondition, not merely a well-typed record.
* **A refusal changes nothing.** `refusal_writes_nothing` states it once for the whole
  library: an operation returns a *new* value or a fault, so a refused operation cannot have
  written anything. In the TypeScript runtime this is a rule to be enforced at every call
  site; here it is a property of the type, and the theorem says so rather than leaving the
  reader to notice.

Nineteen operations are covered — seven on `Turn`, seven on `Run`, three on the admission
registry, two on `RunBranch` — plus the composite `RunSystem.step`, whose contract is the
safety invariant of `Assurance.Safety`. The lease and revision primitives each get a fault
characterization, which is how the refusal vocabularies above are established rather than
asserted.

Where an operation's precondition holds, the `.ok` branch is reached: that is the availability
side, and it is proved in `Assurance.Liveness` (`Turn.forceCancel_available`,
`Run.terminalize_available`, `RunAdmissionRegistry.close_available`) for the operations a
progress argument needs. The two halves together are the Hoare triple.
-/
import AgentCore.Kernel.Assurance.Liveness

namespace AgentCore.Kernel

/-- Total correctness of one operation: it lands in an `.ok` whose value satisfies the
contract, in a refusal carrying one of the declared codes, or in a shape fault naming one of
the declared subjects. An empty subject list is therefore a proof that the operation never
produces a shape fault. -/
def TotallyCorrect {α : Type} (outcome : Outcome α) (post : α → Prop)
    (codes : List ErrorCode) (subjects : List String) : Prop :=
  (∃ value, outcome = .ok value ∧ post value) ∨
    (∃ code ∈ codes, outcome.RefusedWith code) ∨
    (∃ subject ∈ subjects, outcome = .error (.shape subject))

/-- **A refusal writes nothing.** An operation returns a new value or a fault, so there is no
state for a refused operation to have half-written. The runtime has to enforce this at every
call site; here it is the shape of `Outcome` and this is the statement of it. -/
theorem refusal_writes_nothing {α : Type} {outcome : Outcome α} {fault : Fault}
    (refused : outcome = .error fault) : ∀ value : α, outcome ≠ .ok value := by
  intro value
  rw [refused]
  simp

/-- The refusal branch: the outcome is the fault the operation produced, and the fault
carries a declared code. -/
theorem refusedWith_of_fault {α : Type} {outcome : Outcome α} {fault : Fault} {code : ErrorCode}
    (refused : outcome = .error fault) (characterized : fault = .refusal code) :
    outcome.RefusedWith code := by
  rw [refused, characterized]
  rfl

/-! ## Fault characterization of the primitives

Every refusal an operation can produce comes from one of these, so the vocabularies below are
read off rather than asserted. -/

namespace TurnLease

theorem nextEpoch_fault {epoch : Nat} {fault : Fault} (step : nextEpoch epoch = .error fault) :
    fault = .refusal .leaseInvalid := by
  unfold nextEpoch at step
  split at step
  · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

theorem claim_fault {lease : TurnLease} {holder : PrincipalRef} {now expiresAt : Millis}
    {fault : Fault} (step : lease.claim holder now expiresAt = .error fault) :
    fault = .refusal .leaseInvalid := by
  unfold claim at step
  split at step
  · split at step
    · rename_i epochFault epochStep
      simp only [Except.error.injEq] at step
      rw [← step]
      exact nextEpoch_fault epochStep
    · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

theorem renew_fault {lease : TurnLease} {token : LeaseToken} {now expiresAt : Millis}
    {fault : Fault} (step : lease.renew token now expiresAt = .error fault) :
    fault = .refusal .leaseInvalid := by
  unfold renew at step
  split at step
  · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

theorem reclaim_fault {lease : TurnLease} {holder : PrincipalRef} {now expiresAt : Millis}
    {fault : Fault} (step : lease.reclaim holder now expiresAt = .error fault) :
    fault = .refusal .leaseInvalid := by
  unfold reclaim at step
  split at step
  · split at step
    · rename_i epochFault epochStep
      simp only [Except.error.injEq] at step
      rw [← step]
      exact nextEpoch_fault epochStep
    · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

theorem fence_fault {lease : TurnLease} {fault : Fault} (step : lease.fence = .error fault) :
    fault = .refusal .leaseInvalid := by
  unfold fence at step
  split at step
  · rename_i epochFault epochStep
    simp only [Except.error.injEq] at step
    rw [← step]
    exact nextEpoch_fault epochStep
  · cases step

end TurnLease

namespace Revision

theorem next_fault {revision : Revision} {fault : Fault} (step : revision.next = .error fault) :
    fault = .refusal .protocolRevisionConflict := by
  unfold next at step
  split at step
  · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

end Revision

namespace Run

theorem nextRevision_fault {revision : Revision} {fault : Fault}
    (step : Run.nextRevision revision = .error fault) :
    fault = .refusal .protocolRevisionConflict := by
  unfold nextRevision at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm
  · split at step
    · cases step
    · rename_i revisionFault revisionStep
      simp only [Except.error.injEq] at step
      rw [← step]
      exact Revision.next_fault revisionStep

theorem transition_fault {run : Run} {terminal : Option TerminalSnapshot}
    {configurations : List Digest} {tokensConsumed : Nat} {costConsumed : Option RealizedCost}
    {deliveries : List RunInvocationDelivery} {genesisFirst configurationsUnique tokensValid
      deliveriesOwned deliveriesOrdered terminalOwned} {fault : Fault}
    (step : run.transition terminal configurations tokensConsumed costConsumed deliveries
      genesisFirst configurationsUnique tokensValid deliveriesOwned deliveriesOrdered
      terminalOwned = .error fault) :
    fault = .refusal .protocolRevisionConflict := by
  unfold transition at step
  split at step
  · rename_i revisionFault revisionStep
    simp only [Except.error.injEq] at step
    rw [← step]
    exact nextRevision_fault revisionStep
  · cases step

end Run

namespace RealizedCost

theorem add_fault {held next : RealizedCost} {fault : Fault} (step : held.add next = .error fault) :
    fault = .refusal .runInvalidState := by
  unfold add at step
  split at step
  · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

end RealizedCost

namespace Turn

theorem requireToken_fault {turn : Turn} {token : LeaseToken} {now : Millis} {fault : Fault}
    (step : turn.requireToken token now = .error fault) : fault = .refusal .leaseInvalid := by
  unfold requireToken at step
  split at step
  · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact step.symm

/-! ## The seven Turn operations

Each one's refusal vocabulary is read off the definition through the primitives' fault
characterizations, and each one's `.ok` carries the postcondition the record's own theorems
establish. None of the seven can produce a shape fault. -/

theorem claim_fault {turn : Turn} {holder : PrincipalRef} {now expiresAt : Millis}
    {fault : Fault} (step : turn.claim holder now expiresAt = .error fault) :
    fault = .refusal .turnInvalidState ∨ fault = .refusal .leaseInvalid ∨
      fault = .refusal .protocolRevisionConflict := by
  unfold claim at step
  split at step
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inr (.inl (by rw [← step]; exact TurnLease.claim_fault leaseStep))
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (.inr (by rw [← step]; exact Revision.next_fault revisionStep))
      · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm

theorem claim_totallyCorrect (turn : Turn) (holder : PrincipalRef) (now expiresAt : Millis) :
    TotallyCorrect (turn.claim holder now expiresAt)
      (fun next => next.status = .running ∧ next.lease.holder.isSome = true ∧
        next.id = turn.id ∧ next.run = turn.run ∧ turn.lease.epoch < next.lease.epoch)
      [.turnInvalidState, .leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.claim holder now expiresAt with
  | ok next =>
      exact .inl ⟨next, rfl, (claim_running result).1, (claim_running result).2,
        (claim_preserves_identity result).1, (claim_preserves_identity result).2,
        claim_advances_epoch result⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases claim_fault result with hit | hit | hit
      · exact ⟨.turnInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem renew_fault {turn : Turn} {token : LeaseToken} {now expiresAt : Millis} {fault : Fault}
    (step : turn.renew token now expiresAt = .error fault) :
    fault = .refusal .leaseInvalid ∨ fault = .refusal .protocolRevisionConflict := by
  unfold renew at step
  split at step
  · rename_i tokenFault tokenStep
    simp only [Except.error.injEq] at step
    exact .inl (by rw [← step]; exact requireToken_fault tokenStep)
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inl (by rw [← step]; exact TurnLease.renew_fault leaseStep)
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (by rw [← step]; exact Revision.next_fault revisionStep)
      · cases step

theorem renew_totallyCorrect (turn : Turn) (token : LeaseToken) (now expiresAt : Millis) :
    TotallyCorrect (turn.renew token now expiresAt)
      (fun next => next.id = turn.id ∧ next.run = turn.run ∧
        next.lease.epoch = turn.lease.epoch ∧ next.lease.holder = turn.lease.holder ∧
        turn.lease.admits token now = true)
      [.leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.renew token now expiresAt with
  | ok next =>
      exact .inl ⟨next, rfl, (renew_preserves_identity result).1,
        (renew_preserves_identity result).2, (renew_keeps_incarnation result).1,
        (renew_keeps_incarnation result).2,
        requireToken_admits (renew_requires_token result)⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases renew_fault result with hit | hit
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem reclaim_fault {turn : Turn} {holder : PrincipalRef} {now expiresAt : Millis}
    {fault : Fault} (step : turn.reclaim holder now expiresAt = .error fault) :
    fault = .refusal .turnInvalidState ∨ fault = .refusal .leaseInvalid ∨
      fault = .refusal .protocolRevisionConflict := by
  unfold reclaim at step
  split at step
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inr (.inl (by rw [← step]; exact TurnLease.reclaim_fault leaseStep))
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (.inr (by rw [← step]; exact Revision.next_fault revisionStep))
      · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm

theorem reclaim_totallyCorrect (turn : Turn) (holder : PrincipalRef) (now expiresAt : Millis) :
    TotallyCorrect (turn.reclaim holder now expiresAt)
      (fun next => next.status = .running ∧ next.lease.holder = some holder ∧
        next.id = turn.id ∧ next.run = turn.run ∧ turn.lease.epoch < next.lease.epoch ∧
        turn.lease.expiredHeld now = true)
      [.turnInvalidState, .leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.reclaim holder now expiresAt with
  | ok next =>
      refine .inl ⟨next, rfl, ?_, (reclaim_result result).2,
        (reclaim_preserves_identity result).1, (reclaim_preserves_identity result).2,
        reclaim_advances_epoch result, reclaim_requires_expired result⟩
      rw [(reclaim_result result).1, reclaim_requires_running result]
  | error fault =>
      refine .inr (.inl ?_)
      rcases reclaim_fault result with hit | hit | hit
      · exact ⟨.turnInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem suspend_fault {turn : Turn} {token : LeaseToken} {checkpoint : TextId .runCheckpoint}
    {now : Millis} {fault : Fault} (step : turn.suspend token checkpoint now = .error fault) :
    fault = .refusal .leaseInvalid ∨ fault = .refusal .protocolRevisionConflict := by
  unfold suspend at step
  split at step
  · rename_i tokenFault tokenStep
    simp only [Except.error.injEq] at step
    exact .inl (by rw [← step]; exact requireToken_fault tokenStep)
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inl (by rw [← step]; exact TurnLease.fence_fault leaseStep)
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (by rw [← step]; exact Revision.next_fault revisionStep)
      · cases step

theorem suspend_totallyCorrect (turn : Turn) (token : LeaseToken)
    (checkpoint : TextId .runCheckpoint) (now : Millis) :
    TotallyCorrect (turn.suspend token checkpoint now)
      (fun next => next.status = .suspended ∧ next.checkpoint = some checkpoint ∧
        next.lease.holder = none ∧ next.id = turn.id ∧
        turn.lease.epoch < next.lease.epoch)
      [.leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.suspend token checkpoint now with
  | ok next =>
      exact .inl ⟨next, rfl, (suspend_result result).1, (suspend_result result).2,
        next.restingUnheld (.inl (suspend_result result).1),
        (suspend_preserves_identity result).1, suspend_advances_epoch result⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases suspend_fault result with hit | hit
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem complete_fault {turn : Turn} {token : LeaseToken} {outcome : TerminalOutcome}
    {result : ContentRef} {now : Millis} {fault : Fault}
    (step : turn.complete token outcome result now = .error fault) :
    fault = .refusal .leaseInvalid ∨ fault = .refusal .protocolRevisionConflict := by
  unfold complete at step
  split at step
  · rename_i tokenFault tokenStep
    simp only [Except.error.injEq] at step
    exact .inl (by rw [← step]; exact requireToken_fault tokenStep)
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inl (by rw [← step]; exact TurnLease.fence_fault leaseStep)
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (by rw [← step]; exact Revision.next_fault revisionStep)
      · cases step

theorem complete_totallyCorrect (turn : Turn) (token : LeaseToken) (outcome : TerminalOutcome)
    (result : ContentRef) (now : Millis) :
    TotallyCorrect (turn.complete token outcome result now)
      (fun next => next.status = .terminal outcome ∧ next.lease.holder = none ∧
        next.result = some result ∧ next.id = turn.id ∧
        turn.lease.epoch < next.lease.epoch)
      [.leaseInvalid, .protocolRevisionConflict] [] := by
  cases outcomeResult : turn.complete token outcome result now with
  | ok next =>
      exact .inl ⟨next, rfl, (complete_terminal outcomeResult).1,
        (complete_terminal outcomeResult).2.1, (complete_terminal outcomeResult).2.2,
        (complete_preserves_identity outcomeResult).1, complete_advances_epoch outcomeResult⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases complete_fault outcomeResult with hit | hit
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem cancelUnheld_fault {turn : Turn} {fault : Fault}
    (step : turn.cancelUnheld = .error fault) :
    fault = .refusal .turnInvalidState ∨ fault = .refusal .leaseInvalid ∨
      fault = .refusal .protocolRevisionConflict := by
  unfold cancelUnheld at step
  split at step
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inr (.inl (by rw [← step]; exact TurnLease.fence_fault leaseStep))
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (.inr (by rw [← step]; exact Revision.next_fault revisionStep))
      · cases step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm

theorem cancelUnheld_totallyCorrect (turn : Turn) :
    TotallyCorrect turn.cancelUnheld
      (fun next => next.status.isTerminal = true ∧ next.lease.holder = none ∧
        next.id = turn.id ∧ turn.lease.epoch < next.lease.epoch)
      [.turnInvalidState, .leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.cancelUnheld with
  | ok next =>
      exact .inl ⟨next, rfl, cancelUnheld_lands_terminal result,
        terminal_is_unheld next (cancelUnheld_lands_terminal result),
        (cancelUnheld_preserves_identity result).1, cancelUnheld_advances_epoch result⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases cancelUnheld_fault result with hit | hit | hit
      · exact ⟨.turnInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem forceCancel_fault {turn : Turn} {fault : Fault}
    (step : turn.forceCancel = .error fault) :
    fault = .refusal .leaseInvalid ∨ fault = .refusal .protocolRevisionConflict := by
  unfold forceCancel at step
  split at step
  · cases step
  · split at step
    · rename_i leaseFault leaseStep
      simp only [Except.error.injEq] at step
      exact .inl (by rw [← step]; exact TurnLease.fence_fault leaseStep)
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (by rw [← step]; exact Revision.next_fault revisionStep)
      · cases step

theorem forceCancel_totallyCorrect (turn : Turn) :
    TotallyCorrect turn.forceCancel
      (fun next => next.status.isTerminal = true ∧ next.lease.holder = none ∧
        next.id = turn.id ∧ next.run = turn.run)
      [.leaseInvalid, .protocolRevisionConflict] [] := by
  cases result : turn.forceCancel with
  | ok next =>
      exact .inl ⟨next, rfl, forceCancel_lands_terminal result,
        terminal_is_unheld next (forceCancel_lands_terminal result),
        (forceCancel_preserves_identity result).1, (forceCancel_preserves_identity result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases forceCancel_fault result with hit | hit
      · exact ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

end Turn

namespace Run

/-! ## The seven Run operations

Six ordinary mutations and the terminalization. Only the last can produce a shape fault, and
it is the canonical-order check on the outbox — the same check `Run.terminalize` performs at
runtime, and the reason `terminalize_available` has to establish the order before it can
claim the operation succeeds. -/

theorem revise_fault {run : Run} {fault : Fault} (step : run.revise = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold revise at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm
  · exact .inr (transition_fault step)

theorem revise_totallyCorrect (run : Run) :
    TotallyCorrect run.revise
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.revise with
  | ok next => exact .inl ⟨next, rfl, (revise_shape result).1, (revise_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases revise_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem recordEvidence_fault {run : Run} {fault : Fault}
    (step : run.recordEvidence = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold recordEvidence at step
  split at step
  · exact .inr (transition_fault step)
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm

theorem recordEvidence_totallyCorrect (run : Run) :
    TotallyCorrect run.recordEvidence
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.recordEvidence with
  | ok next =>
      exact .inl ⟨next, rfl, (recordEvidence_shape result).1, (recordEvidence_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases recordEvidence_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem recordConfiguration_fault {run : Run} {configuration : Digest} {fault : Fault}
    (step : run.recordConfiguration configuration = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold recordConfiguration at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm
  · split at step
    · cases step
    · exact .inr (transition_fault step)

theorem recordConfiguration_totallyCorrect (run : Run) (configuration : Digest) :
    TotallyCorrect (run.recordConfiguration configuration)
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.recordConfiguration configuration with
  | ok next =>
      exact .inl ⟨next, rfl, (recordConfiguration_shape result).1,
        (recordConfiguration_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases recordConfiguration_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem recordModelUsage_fault {run : Run} {tokens : Nat} {cost : Option RealizedCost}
    {lineage : List Currency} {fault : Fault}
    (step : run.recordModelUsage tokens cost lineage = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold recordModelUsage at step
  repeat' split at step
  all_goals
    first
      | (exact .inr (transition_fault step))
      | (simp only [refuse, Except.error.injEq] at step; exact .inl step.symm)
      | (rename_i costFault costStep
         simp only [Except.error.injEq] at step
         have characterized : costFault = .refusal .runInvalidState := by
           split at costStep
           · cases costStep
           · exact RealizedCost.add_fault costStep
         exact .inl (by rw [← step]; exact characterized))

theorem recordModelUsage_totallyCorrect (run : Run) (tokens : Nat) (cost : Option RealizedCost)
    (lineage : List Currency) :
    TotallyCorrect (run.recordModelUsage tokens cost lineage)
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.recordModelUsage tokens cost lineage with
  | ok next =>
      exact .inl ⟨next, rfl, (recordModelUsage_shape result).1,
        (recordModelUsage_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases recordModelUsage_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem publishDelivery_fault {run : Run} {delivery : RunInvocationDelivery} {fault : Fault}
    (step : run.publishDelivery delivery = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold publishDelivery at step
  repeat' split at step
  all_goals
    first
      | (exact .inr (transition_fault step))
      | (simp only [refuse, Except.error.injEq] at step; exact .inl step.symm)
      | cases step

theorem publishDelivery_totallyCorrect (run : Run) (delivery : RunInvocationDelivery) :
    TotallyCorrect (run.publishDelivery delivery)
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.publishDelivery delivery with
  | ok next =>
      exact .inl ⟨next, rfl, (publishDelivery_shape result).1,
        (publishDelivery_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases publishDelivery_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem acknowledgeDelivery_fault {run : Run} {delivery : RunInvocationDelivery} {fault : Fault}
    (step : run.acknowledgeDelivery delivery = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict := by
  unfold acknowledgeDelivery at step
  repeat' split at step
  all_goals
    first
      | (exact .inr (transition_fault step))
      | (simp only [refuse, Except.error.injEq] at step; exact .inl step.symm)
      | cases step

theorem acknowledgeDelivery_totallyCorrect (run : Run) (delivery : RunInvocationDelivery) :
    TotallyCorrect (run.acknowledgeDelivery delivery)
      (fun next => next.id = run.id ∧ next.terminal = run.terminal)
      [.runInvalidState, .protocolRevisionConflict] [] := by
  cases result : run.acknowledgeDelivery delivery with
  | ok next =>
      exact .inl ⟨next, rfl, (acknowledgeDelivery_shape result).1,
        (acknowledgeDelivery_shape result).2⟩
  | error fault =>
      refine .inr (.inl ?_)
      rcases acknowledgeDelivery_fault result with hit | hit
      · exact ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩
      · exact ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩

theorem terminalize_fault {run : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery} {fault : Fault}
    (step : run.terminalize snapshot cancellations = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict ∨
      fault = .shape "Run invocation delivery outbox" := by
  unfold terminalize at step
  split at step
  · split at step
    · exact .inr (.inl (transition_fault step))
    · simp only [unshaped, Except.error.injEq] at step
      exact .inr (.inr step.symm)
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm

theorem terminalize_totallyCorrect (run : Run) (snapshot : TerminalSnapshot)
    (cancellations : List RunInvocationDelivery) :
    TotallyCorrect (run.terminalize snapshot cancellations)
      (fun next => next.terminal = some snapshot ∧ next.id = run.id ∧
        run.terminal = none)
      [.runInvalidState, .protocolRevisionConflict]
      ["Run invocation delivery outbox"] := by
  cases result : run.terminalize snapshot cancellations with
  | ok next =>
      exact .inl ⟨next, rfl, (terminalize_shape result).2, (terminalize_shape result).1,
        terminalize_requires_active result⟩
  | error fault =>
      rcases terminalize_fault result with hit | hit | hit
      · exact .inr (.inl ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inl ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inr ⟨"Run invocation delivery outbox", by simp, by rw [hit]⟩)

end Run

namespace RunAdmissionRegistry

/-! ## The three admission operations

None of the three can produce a shape fault, and all three refuse with the same code: SPEC
§5.6 gives admission one refusal, and a caller cannot tell a closed registry from a
reservation of another Run apart by the code. -/

theorem reserve_fault {registry : RunAdmissionRegistry} {obligation : RunObligation}
    {fault : Fault} (step : registry.reserve obligation = .error fault) :
    fault = .refusal .runInvalidState := by
  unfold reserve at step
  repeat' split at step
  all_goals
    first
      | (simp only [refuse, Except.error.injEq] at step; exact step.symm)
      | cases step

theorem reserve_totallyCorrect (registry : RunAdmissionRegistry) (obligation : RunObligation) :
    TotallyCorrect (registry.reserve obligation)
      (fun pair => pair.1.run = registry.run ∧ pair.1.«open» = registry.«open» ∧
        pair.1.epoch = registry.epoch ∧ registry.«open» = true)
      [.runInvalidState] [] := by
  cases result : registry.reserve obligation with
  | ok pair =>
      obtain ⟨next, reservation⟩ := pair
      exact .inl ⟨(next, reservation), rfl, (reserve_shape result).1, (reserve_shape result).2.1,
        (reserve_shape result).2.2, reserve_requires_open result⟩
  | error fault =>
      exact .inr (.inl ⟨.runInvalidState, by simp,
        refusedWith_of_fault rfl (reserve_fault result)⟩)

theorem complete_fault {registry : RunAdmissionRegistry} {reservation : RunAdmissionReservation}
    {fault : Fault} (step : registry.complete reservation = .error fault) :
    fault = .refusal .runInvalidState := by
  unfold complete at step
  repeat' split at step
  all_goals
    first
      | (simp only [refuse, Except.error.injEq] at step; exact step.symm)
      | cases step

theorem complete_totallyCorrect (registry : RunAdmissionRegistry)
    (reservation : RunAdmissionReservation) :
    TotallyCorrect (registry.complete reservation)
      (fun next => next.run = registry.run ∧ next.«open» = registry.«open» ∧
        next.epoch = registry.epoch ∧ next.reserved = registry.reserved)
      [.runInvalidState] [] := by
  cases result : registry.complete reservation with
  | ok next =>
      exact .inl ⟨next, rfl, (complete_shape result).1, (complete_shape result).2.1,
        (complete_shape result).2.2.1, (complete_shape result).2.2.2⟩
  | error fault =>
      exact .inr (.inl ⟨.runInvalidState, by simp,
        refusedWith_of_fault rfl (complete_fault result)⟩)

theorem close_fault {registry : RunAdmissionRegistry} {fault : Fault}
    (step : registry.close = .error fault) : fault = .refusal .runInvalidState := by
  unfold close at step
  repeat' split at step
  all_goals
    first
      | (simp only [refuse, Except.error.injEq] at step; exact step.symm)
      | cases step

/-- Closing lands closed, whether it moved or was already there. -/
theorem close_lands_closed {registry closed : RunAdmissionRegistry}
    (step : registry.close = .ok closed) : closed.«open» = false := by
  unfold close at step
  split at step
  · split at step
    · simp only [Except.ok.injEq] at step
      rw [← step]
    · cases step
  · rename_i notOpen
    simp only [Except.ok.injEq] at step
    rw [← step]
    simpa using notOpen

theorem close_totallyCorrect (registry : RunAdmissionRegistry) :
    TotallyCorrect registry.close
      (fun closed => closed.«open» = false ∧ closed.run = registry.run ∧
        closed.reserved = registry.reserved ∧ closed.frontier = registry.frontier)
      [.runInvalidState] [] := by
  cases result : registry.close with
  | ok closed =>
      exact .inl ⟨closed, rfl, close_lands_closed result, (close_shape result).1,
        (close_shape result).2.1, close_frontier result⟩
  | error fault =>
      exact .inr (.inl ⟨.runInvalidState, by simp,
        refusedWith_of_fault rfl (close_fault result)⟩)

end RunAdmissionRegistry

namespace RunBranch

/-! ## The two branch operations -/

theorem advance_fault {branch : RunBranch} {head : TextId .runCommit} {fault : Fault}
    (step : branch.advance head = .error fault) :
    fault = .refusal .protocolRevisionConflict := by
  unfold advance at step
  split at step
  · rename_i revisionFault revisionStep
    simp only [Except.error.injEq] at step
    rw [← step]
    exact Run.nextRevision_fault revisionStep
  · cases step

theorem advance_result {branch advanced : RunBranch} {head : TextId .runCommit}
    (step : branch.advance head = .ok advanced) :
    advanced.head = head ∧ advanced.run = branch.run ∧ advanced.id = branch.id := by
  unfold advance at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; exact ⟨rfl, rfl, rfl⟩)
      | cases step

theorem advance_totallyCorrect (branch : RunBranch) (head : TextId .runCommit) :
    TotallyCorrect (branch.advance head)
      (fun advanced => advanced.head = head ∧ advanced.run = branch.run ∧
        advanced.id = branch.id)
      [.protocolRevisionConflict] [] := by
  cases result : branch.advance head with
  | ok advanced => exact .inl ⟨advanced, rfl, advance_result result⟩
  | error fault =>
      exact .inr (.inl ⟨.protocolRevisionConflict, by simp,
        refusedWith_of_fault rfl (advance_fault result)⟩)

theorem reserveRewrite_fault {branch : RunBranch} {planned : TextId .runCommit} {fault : Fault}
    (step : branch.reserveRewrite planned = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .protocolRevisionConflict ∨
      fault = .shape "Run branch rewrite" := by
  unfold reserveRewrite at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm
  · split at step
    · split at step
      · rename_i revisionFault revisionStep
        simp only [Except.error.injEq] at step
        exact .inr (.inl (by rw [← step]; exact Run.nextRevision_fault revisionStep))
      · cases step
    · simp only [unshaped, Except.error.injEq] at step
      exact .inr (.inr step.symm)

theorem reserveRewrite_result {branch reserved : RunBranch} {planned : TextId .runCommit}
    (step : branch.reserveRewrite planned = .ok reserved) :
    reserved.rewrite = some planned ∧ reserved.head = branch.head ∧
      reserved.run = branch.run := by
  unfold reserveRewrite at step
  repeat' split at step
  all_goals
    first
      | (simp only [Except.ok.injEq] at step; subst step; exact ⟨rfl, rfl, rfl⟩)
      | cases step

theorem reserveRewrite_totallyCorrect (branch : RunBranch) (planned : TextId .runCommit) :
    TotallyCorrect (branch.reserveRewrite planned)
      (fun reserved => reserved.rewrite = some planned ∧ reserved.head = branch.head ∧
        reserved.run = branch.run)
      [.runInvalidState, .protocolRevisionConflict] ["Run branch rewrite"] := by
  cases result : branch.reserveRewrite planned with
  | ok reserved => exact .inl ⟨reserved, rfl, reserveRewrite_result result⟩
  | error fault =>
      rcases reserveRewrite_fault result with hit | hit | hit
      · exact .inr (.inl ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inl ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inr ⟨"Run branch rewrite", by simp, by rw [hit]⟩)

end RunBranch

namespace RunSystem

/-! ## The composite step

The step's contract is the safety invariant, and its refusal vocabulary is the union of the
vocabularies above. Two shape faults are reachable and both are canonical-order checks: the
settlement capture (ruled out by `Liveness.CanonicalKeys`) and the delivery outbox (ruled out
by the `Run` record's own `deliveriesOrdered`). Naming them is the point — `Outcome` admits a
shape fault at every type, and a caller cannot be told which two of the nineteen operations
can raise one without this enumeration. -/

/-- Addressing a Turn refuses with `run.invalid-state`, or fails exactly as the Turn's own
transition failed. -/
theorem onTurn_fault {system : RunSystem} {id : TextId .turn} {transition : Turn → Outcome Turn}
    {fault : Fault} (step : system.onTurn id transition = .error fault) :
    fault = .refusal .runInvalidState ∨ ∃ turn, transition turn = .error fault := by
  unfold onTurn at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm
  · rename_i turn found
    split at step
    · rename_i turnFault turnStep
      simp only [Except.error.injEq] at step
      exact .inr ⟨turn, by rw [← step]; exact turnStep⟩
    · cases step

theorem admitTerminalExhaustion_fault {remainder : Option ResourceCeiling}
    {exhausted : Option ResourceDimension} {fault : Fault}
    (step : admitTerminalExhaustion remainder exhausted = .error fault) :
    fault = .refusal .runInvalidState := by
  unfold admitTerminalExhaustion at step
  split at step
  · cases step
  · split at step
    · cases step
    · simp only [refuse, Except.error.injEq] at step
      exact step.symm

theorem terminalSnapshot_fault {run : TextId .run} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {obligation : SettlementObligation} {recordedAt : Millis}
    {exhausted : Option ResourceDimension} {fault : Fault}
    (step : terminalSnapshot run turn preterminal terminalCommit outcome obligation recordedAt
      exhausted = .error fault) : fault = .refusal .runInvalidState := by
  unfold terminalSnapshot at step
  split at step
  · cases step
  · split at step
    · cases step
    · simp only [refuse, Except.error.injEq] at step
      exact step.symm

theorem admitsCommit_fault {system : RunSystem} {commit : AppendedCommit} {fault : Fault}
    (step : system.admitsCommit commit = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .leaseInvalid := by
  unfold admitsCommit at step
  split at step
  · simp only [refuse, Except.error.injEq] at step
    exact .inl step.symm
  · split at step
    · rename_i matrixFault matrixStep
      simp only [Except.error.injEq] at step
      have characterized : matrixFault = .refusal .runInvalidState := by
        unfold admitTurnWriter at matrixStep
        split at matrixStep
        · cases matrixStep
        · simp only [refuse, Except.error.injEq] at matrixStep
          exact matrixStep.symm
      exact .inl (by rw [← step]; exact characterized)
    · unfold admitsWriterLease at step
      split at step
      · split at step
        · simp only [refuse, Except.error.injEq] at step
          exact .inl step.symm
        · rename_i turn found
          exact .inr (Turn.requireToken_fault step)
      · cases step

/-- **The whole Run lifecycle refuses in exactly four codes and faults in exactly two
shapes.** -/
theorem step_fault {system : RunSystem} {event : RunEvent} {fault : Fault}
    (stepped : system.step event = .error fault) :
    fault = .refusal .runInvalidState ∨ fault = .refusal .turnInvalidState ∨
      fault = .refusal .leaseInvalid ∨ fault = .refusal .protocolRevisionConflict ∨
      fault = .shape "Run settlement capture" ∨
      fault = .shape "Run invocation delivery outbox" := by
  cases event with
  | tick elapsed => simp only [step] at stepped; cases stepped
  | revise =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.revise_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | recordEvidence =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.recordEvidence_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | admitTurn newTurn =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · simp only [refuse, Except.error.injEq] at stepped
        exact .inl stepped.symm
  | claimTurn target holder expiresAt =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.claim_fault turnStep with hit | hit | hit
        · exact .inr (.inl hit)
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | renewTurn token expiresAt =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.renew_fault turnStep with hit | hit
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | reclaimTurn target holder expiresAt =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.reclaim_fault turnStep with hit | hit | hit
        · exact .inr (.inl hit)
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | suspendTurn token checkpoint =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.suspend_fault turnStep with hit | hit
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | completeTurn token outcome result =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.complete_fault turnStep with hit | hit
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | cancelTurn target =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.cancelUnheld_fault turnStep with hit | hit | hit
        · exact .inr (.inl hit)
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | forceCancelTurn target cause =>
      simp only [step] at stepped
      rcases onTurn_fault stepped with hit | ⟨turn, turnStep⟩
      · exact .inl hit
      · rcases Turn.forceCancel_fault turnStep with hit | hit
        · exact .inr (.inr (.inl hit))
        · exact .inr (.inr (.inr (.inl hit)))
  | appendCommit commit =>
      simp only [step] at stepped
      split at stepped
      · rename_i commitFault commitStep
        simp only [Except.error.injEq] at stepped
        rcases admitsCommit_fault commitStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inl (by rw [← stepped]; exact hit)))
      · cases stepped
  | reserveObligation obligation =>
      simp only [step] at stepped
      split at stepped
      · rename_i registryFault registryStep
        simp only [Except.error.injEq] at stepped
        exact .inl (by rw [← stepped]; exact RunAdmissionRegistry.reserve_fault registryStep)
      · cases stepped
  | completeObligation reservation =>
      simp only [step] at stepped
      split at stepped
      · rename_i registryFault registryStep
        simp only [Except.error.injEq] at stepped
        exact .inl (by rw [← stepped]; exact RunAdmissionRegistry.complete_fault registryStep)
      · cases stepped
  | publishDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.publishDelivery_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | acknowledgeDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.acknowledgeDelivery_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | recordConfiguration configuration =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.recordConfiguration_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | recordUsage usage cost lineage =>
      simp only [step] at stepped
      split at stepped
      · rename_i runFault runStep
        simp only [Except.error.injEq] at stepped
        rcases Run.recordModelUsage_fault runStep with hit | hit
        · exact .inl (by rw [← stepped]; exact hit)
        · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
      · cases stepped
  | terminalize target preterminal terminalCommit outcome exhausted cancellations =>
      simp only [step] at stepped
      repeat' split at stepped
      all_goals
        first
          | (cases stepped; done)
          | (simp only [refuse, Except.error.injEq] at stepped
             exact .inl stepped.symm)
          | (simp only [unshaped, Except.error.injEq] at stepped
             exact .inr (.inr (.inr (.inr (.inl stepped.symm)))))
          | (rename_i innerFault innerStep
             simp only [Except.error.injEq] at stepped
             exact .inl (by rw [← stepped]; exact admitTerminalExhaustion_fault innerStep))
          | (rename_i innerFault innerStep
             simp only [Except.error.injEq] at stepped
             exact .inl (by
               rw [← stepped]
               exact RunAdmissionRegistry.close_fault innerStep))
          | (rename_i innerFault innerStep
             simp only [Except.error.injEq] at stepped
             exact .inl (by rw [← stepped]; exact terminalSnapshot_fault innerStep))
          | (rename_i snapshot built innerFault innerStep
             simp only [Except.error.injEq] at stepped
             rcases Run.terminalize_fault innerStep with hit | hit | hit
             · exact .inl (by rw [← stepped]; exact hit)
             · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
             · exact .inr (.inr (.inr (.inr (.inr (by rw [← stepped]; exact hit))))))
          | (rename_i snapshot built _ innerFault innerStep
             simp only [Except.error.injEq] at stepped
             rcases Run.terminalize_fault innerStep with hit | hit | hit
             · exact .inl (by rw [← stepped]; exact hit)
             · exact .inr (.inr (.inr (.inl (by rw [← stepped]; exact hit))))
             · exact .inr (.inr (.inr (.inr (.inr (by rw [← stepped]; exact hit))))))

/-- **The composite step is totally correct.** For every state satisfying the invariant and
every event, the step lands in an `.ok` whose state satisfies the invariant again, in a
refusal from the Run lifecycle's four-code vocabulary, or in one of exactly two named
canonical-order shape faults. Termination is not a theorem here and never was: `step` is a
total function, which the elaborator establishes. -/
theorem step_totallyCorrect {system : RunSystem} (invariant : Invariant system)
    (event : RunEvent) :
    TotallyCorrect (system.step event) (fun after => Invariant after)
      [.runInvalidState, .turnInvalidState, .leaseInvalid, .protocolRevisionConflict]
      ["Run settlement capture", "Run invocation delivery outbox"] := by
  cases result : system.step event with
  | ok after => exact .inl ⟨after, rfl, invariant_step invariant result⟩
  | error fault =>
      rcases step_fault result with hit | hit | hit | hit | hit | hit
      · exact .inr (.inl ⟨.runInvalidState, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inl ⟨.turnInvalidState, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inl ⟨.leaseInvalid, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inl ⟨.protocolRevisionConflict, by simp, refusedWith_of_fault rfl hit⟩)
      · exact .inr (.inr ⟨"Run settlement capture", by simp, by rw [hit]⟩)
      · exact .inr (.inr ⟨"Run invocation delivery outbox", by simp, by rw [hit]⟩)

/-- **Every reachable state's every step is totally correct.** The form a reader wants: no
reachable state has a step that escapes the declared channels or lands outside the
invariant. -/
theorem reachable_step_totallyCorrect {system : RunSystem} (reached : Reachable system)
    (event : RunEvent) :
    TotallyCorrect (system.step event) (fun after => Invariant after)
      [.runInvalidState, .turnInvalidState, .leaseInvalid, .protocolRevisionConflict]
      ["Run settlement capture", "Run invocation delivery outbox"] :=
  step_totallyCorrect (reachable_invariant reached) event

end RunSystem

end AgentCore.Kernel
