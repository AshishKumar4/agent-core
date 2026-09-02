import SpecCnl.Bridge.RunSettle

/-!
# Discharging the RunSettle group (§5.2)

Every hand proposition of the group, proved true of the model. Each discharge reads a
theorem already stated beside `AgentCore.GraphStep` or `AgentCore.Settled`; this group adds
nothing to `AgentCore`.

The `⟨_, _, _, _, step⟩` pattern that opens most proofs is the transition family: a label
match, and then the `EffectLedger`, `EventStore` and `AuditLog` the step was taken under.
Those three are existentially bound in the family, which is exactly why no condition of
this group reads a Receipt or an AuditRecord.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_RUN_ADMISSION_REGISTRY : Bridge.hand_C13_RUN_ADMISSION_REGISTRY := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨_, _, _, _, step⟩ run epoch obligation isCompletion
    subst isCompletion
    obtain ⟨beforeRegistry, _, beforeLookup, _, reserved, _⟩ :=
      completed_obligation_is_reserved step
    exact ⟨beforeRegistry, beforeLookup, reserved⟩
  · intro before label after ⟨_, _, _, _, step⟩ run epoch obligation isReservation
    subst isReservation
    exact reserved_obligation_yields_valid_reservation step

theorem proved_C13_RUN_ACCEPTANCE_SUBJECT : Bridge.hand_C13_RUN_ACCEPTANCE_SUBJECT := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨_, _, _, _, step⟩ run verdict isRecording
    subst isRecording
    obtain ⟨_, _, _, _, _, _, _, admissible, _⟩ :=
      acceptance_verdict_step_requires_declared_verifier_receipt step
    exact admissible
  · intro _ _ _ _ headTree noVerdictAtHead
    exact acceptance_verdict_only_for_its_subject headTree noVerdictAtHead

theorem proved_C13_RUN_FORCED_CANCELLATION : Bridge.hand_C13_RUN_FORCED_CANCELLATION := by
  refine ⟨?_, ?_⟩
  · intro before label after ⟨_, _, _, _, step⟩ run terminalTurn sibling isCancellation
    subst isCancellation
    obtain ⟨_, cancelled, evidence, _, cancelledLookup, cancelledStatus, unheld,
      evidenceLookup, _, _, exactSibling, _, _⟩ := forced_cancellation_is_system_fence step
    exact ⟨cancelled, evidence, cancelledLookup, cancelledStatus, unheld, evidenceLookup,
      exactSibling⟩
  · intro before label after ⟨_, _, _, _, step⟩ run turn id expected isTerminalization
    subst isTerminalization
    exact terminalization_requires_terminal_and_unheld_siblings step

theorem proved_C13_RUN_FRONTIER_COMPLETE : Bridge.hand_C13_RUN_FRONTIER_COMPLETE := by
  intro before label after ⟨_, _, _, _, step⟩ run turn id expected isTerminalization
  subst isTerminalization
  obtain ⟨registry, closed, snapshot, registryLookup, closedLookup, notAccepting,
    epochAdvanced, snapshotLookup, epochCaptured, captured⟩ :=
    terminalization_closes_exact_registry step
  refine ⟨registry, snapshot, registryLookup, snapshotLookup, ?_, epochCaptured, closed,
    closedLookup, notAccepting, epochAdvanced⟩
  intro obligation
  rw [captured]
  simp [RunAdmissionRegistry.outstanding, List.mem_filter]

theorem proved_C13_RUN_SETTLED_DERIVED : Bridge.hand_C13_RUN_SETTLED_DERIVED := by
  refine ⟨fun _ _ _ settled => ?_, fun _ _ _ settled => ?_⟩
  · exact (settled_has_coherent_snapshot_and_exact_obligations settled).1
  · exact (settled_has_coherent_snapshot_and_exact_obligations settled).2

end SpecCnl.Proofs
