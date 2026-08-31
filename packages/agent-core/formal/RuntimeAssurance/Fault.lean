import RuntimeAssurance.Premise

/-!
# The fault vocabulary, and which faults refute nothing

A fault is something the deployed world does. A premise is something the model assumes.
`Fault.consequence` is the only mapping between them, and it goes one way: a fault names
the premise it refutes, or it names none.

`withinModel` is the load-bearing case. Message loss, duplication, and reordering are
already inside `AC-COMPOSED-001`'s transport relation; a lost remote acknowledgement is
already `AC-EFFECT-001`'s indeterminate attempt; volatile state lost at restart is already
fenced by the §5.3 lease epoch, and an over-bound payload the caller submitted is already
refused at the §10.4 write seam before a transaction opens. Those six faults happen, are
survived by construction, and refute nothing. Recording a premise for them would claim the
model is weaker than it is, and observing one must not move a single claim.

That is also where the anti-axiom rule bites. A monitor may only report a fault that
refutes a premise it declares coverage of (`Report.AttributesWithinCoverage`), so a monitor
watching packet order has nothing to say to this ledger at all — the observation is real
and the consequence is none. No platform fact becomes a premise, still less an axiom,
because somebody watched it happen.

Every premise is refuted by exactly one fault here, and `every_premise_is_refutable` proves
the total half of that: a premise nothing could falsify would be decoration.
-/

namespace RuntimeAssurance

/-- What a fault does to the premise plane. Two cases with different behavior rather than
an `Option`, so a caller answers both or does not compile. -/
inductive Consequence where
  | withinModel
  | refutes (premise : Premise)
  deriving DecidableEq, Repr

/--
The closed fault vocabulary: clocks, process reset, storage integrity and retention,
declared bounds, the execution budget, the transport, external-service protocol behavior,
and the language runtime's own semantics.
-/
inductive Fault where
  | clockWentBackward
  | clockOffsetBeyondBound
  | restartAttachedToDifferentState
  | restartLostVolatileState
  | restartObservedPartialCommit
  | storedRecordReadBackDifferent
  | storedRecordAbsentAfterCommit
  | platformRefusedDeclaredPayloadSize
  | callerSubmittedOverBoundPayload
  | memoryBudgetExhaustedMidSpan
  | cpuBudgetExhaustedMidSpan
  | messageLost
  | messageDuplicated
  | messageReordered
  | messageForged
  | deliveryExceededDeclaredBound
  | wakeupNeverRan
  | providerAppliedOneKeyTwice
  | remoteAcknowledgementLost
  | remoteDeniedAnAppliedEffect
  | engineRenderedTwoValuesAlike
  | engineInterleavedGuardedSpan
  deriving DecidableEq, Repr

/-- Written out case by case. A fault added without a consequence fails to elaborate rather
than defaulting into either half, and defaulting into `withinModel` is the silent pass this
whole module exists to prevent. -/
def Fault.consequence : Fault → Consequence
  | .clockWentBackward => .refutes .monotonicTime
  | .clockOffsetBeyondBound => .refutes .boundedClockOffset
  | .restartAttachedToDifferentState => .refutes .restartResumesDurableState
  | .restartLostVolatileState => .withinModel
  | .restartObservedPartialCommit => .refutes .localTransactionAtomicity
  | .storedRecordReadBackDifferent => .refutes .durableRecordIntegrity
  | .storedRecordAbsentAfterCommit => .refutes .durableRecordRetention
  | .platformRefusedDeclaredPayloadSize => .refutes .declaredStorageBoundAccepted
  | .callerSubmittedOverBoundPayload => .withinModel
  | .memoryBudgetExhaustedMidSpan => .refutes .sufficientMemoryBudget
  | .cpuBudgetExhaustedMidSpan => .refutes .sufficientCpuBudget
  | .messageLost => .withinModel
  | .messageDuplicated => .withinModel
  | .messageReordered => .withinModel
  | .messageForged => .refutes .transportAuthenticity
  | .deliveryExceededDeclaredBound => .refutes .eventualDelivery
  | .wakeupNeverRan => .refutes .eventualScheduling
  | .providerAppliedOneKeyTwice => .refutes .providerIdempotency
  | .remoteAcknowledgementLost => .withinModel
  | .remoteDeniedAnAppliedEffect => .refutes .providerQueryTruthful
  | .engineRenderedTwoValuesAlike => .refutes .engineSemanticsMatchModel
  | .engineInterleavedGuardedSpan => .refutes .engineSynchronousSpan

/-- Exactly six faults refute nothing, and each is inside the modeled relation for a reason
the module header states. Adding a premise for any of them breaks this theorem, which is
the point of stating it as an iff over the whole vocabulary rather than six separate facts.
-/
theorem Fault.withinModel_iff (fault : Fault) :
    fault.consequence = .withinModel ↔
      (fault = .restartLostVolatileState ∨ fault = .callerSubmittedOverBoundPayload ∨
        fault = .messageLost ∨ fault = .messageDuplicated ∨ fault = .messageReordered ∨
        fault = .remoteAcknowledgementLost) := by
  cases fault <;> simp [Fault.consequence]

theorem transport_loss_is_within_model : Fault.messageLost.consequence = .withinModel := rfl

theorem transport_duplication_is_within_model :
    Fault.messageDuplicated.consequence = .withinModel := rfl

theorem transport_reordering_is_within_model :
    Fault.messageReordered.consequence = .withinModel := rfl

theorem acknowledgement_loss_is_within_model :
    Fault.remoteAcknowledgementLost.consequence = .withinModel := rfl

theorem lost_volatile_state_is_within_model :
    Fault.restartLostVolatileState.consequence = .withinModel := rfl

theorem over_bound_submission_is_within_model :
    Fault.callerSubmittedOverBoundPayload.consequence = .withinModel := rfl

/-- No premise is unfalsifiable: each one has a fault that refutes it. Without this the
premise plane could carry an entry no observation and no record could ever contradict, and
`conditional` would be a permanent resting state by construction rather than by evidence.
-/
theorem every_premise_is_refutable (premise : Premise) :
    ∃ fault : Fault, fault.consequence = .refutes premise := by
  cases premise with
  | monotonicTime => exact ⟨.clockWentBackward, rfl⟩
  | boundedClockOffset => exact ⟨.clockOffsetBeyondBound, rfl⟩
  | restartResumesDurableState => exact ⟨.restartAttachedToDifferentState, rfl⟩
  | localTransactionAtomicity => exact ⟨.restartObservedPartialCommit, rfl⟩
  | durableRecordIntegrity => exact ⟨.storedRecordReadBackDifferent, rfl⟩
  | durableRecordRetention => exact ⟨.storedRecordAbsentAfterCommit, rfl⟩
  | declaredStorageBoundAccepted => exact ⟨.platformRefusedDeclaredPayloadSize, rfl⟩
  | sufficientMemoryBudget => exact ⟨.memoryBudgetExhaustedMidSpan, rfl⟩
  | sufficientCpuBudget => exact ⟨.cpuBudgetExhaustedMidSpan, rfl⟩
  | transportAuthenticity => exact ⟨.messageForged, rfl⟩
  | providerIdempotency => exact ⟨.providerAppliedOneKeyTwice, rfl⟩
  | providerQueryTruthful => exact ⟨.remoteDeniedAnAppliedEffect, rfl⟩
  | engineSemanticsMatchModel => exact ⟨.engineRenderedTwoValuesAlike, rfl⟩
  | engineSynchronousSpan => exact ⟨.engineInterleavedGuardedSpan, rfl⟩
  | eventualDelivery => exact ⟨.deliveryExceededDeclaredBound, rfl⟩
  | eventualScheduling => exact ⟨.wakeupNeverRan, rfl⟩

/-- Only a progress fault refutes a progress premise. This is what lets a safety claim
survive a partition: the fault that lost the messages refutes nothing, and the fault that
missed the delivery bound refutes a premise no safety claim may support. -/
theorem progress_premises_have_progress_faults {fault : Fault} {premise : Premise}
    (refutes : fault.consequence = .refutes premise) (progress : premise.kind = .progress) :
    fault = .deliveryExceededDeclaredBound ∨ fault = .wakeupNeverRan := by
  rcases (Premise.progress_is_exactly_eventual premise).mp progress with delivery | scheduling
  · subst delivery
    cases fault <;> simp_all [Fault.consequence]
  · subst scheduling
    cases fault <;> simp_all [Fault.consequence]

end RuntimeAssurance
