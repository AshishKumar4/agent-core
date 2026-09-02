import SpecCnl.Bridge.Protocol

/-!
# Discharging the Protocol group (§8.1, §8.4, §8.5)

The proofs use only the model theorems beside ActorStep and DispatchStep. No controlled-
language-specific model consequence is needed: the local Actor command/activation shape
lemmas, reachable transaction anchoring, and dispatcher linkage theorem already have the
exact propositions the entries expose.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_OWNERSHIP_ACTOR_CONTRACT : Bridge.hand_C13_OWNERSHIP_ACTOR_CONTRACT := by
  rintro before label after ⟨_, step⟩ expected isCommand
  subst label
  exact command_step_shape step

theorem proved_C13_OWNERSHIP_SINGLE_OWNER : Bridge.hand_C13_OWNERSHIP_SINGLE_OWNER := by
  refine ⟨?_, ?_⟩
  · rintro before label after ⟨_, step⟩ actor isActivation
    subst label
    obtain ⟨activation, activated, _, _, _⟩ := activate_step_shape step
    obtain ⟨identity, recovery, owner⟩ := activation_binds_its_own_actor activated
    exact ⟨identity, activation.state, recovery, owner⟩
  · rintro before label after ⟨reachable, step⟩ actor bound
    exact step_preserves_bound_identity (reachable_transaction_anchored reachable) step bound

theorem proved_C13_PROTOCOL_REJECTION_ROOT : Bridge.hand_C13_PROTOCOL_REJECTION_ROOT := by
  rintro before label after ⟨_, step⟩ id requestAudit raw now isRequest
  subst label
  have fresh : before.writes id = none ∧ before.audits requestAudit = none := by
    cases step with
    | rejectMalformed freshWrite freshAudit _ => exact ⟨freshWrite, freshAudit⟩
    | rejectAuthentication freshWrite freshAudit _ _ => exact ⟨freshWrite, freshAudit⟩
    | duplicate freshWrite freshAudit _ _ _ => exact ⟨freshWrite, freshAudit⟩
    | rejectAuthority freshWrite freshAudit _ _ _ _ => exact ⟨freshWrite, freshAudit⟩
    | rejectLifecycle freshWrite freshAudit _ _ _ _ _ => exact ⟨freshWrite, freshAudit⟩
    | rejectRevision freshWrite freshAudit _ _ _ _ _ _ => exact ⟨freshWrite, freshAudit⟩
    | rejectLease freshWrite freshAudit _ _ _ _ _ _ _ => exact ⟨freshWrite, freshAudit⟩
    | commit freshWrite freshAudit _ _ _ _ _ _ _ => exact ⟨freshWrite, freshAudit⟩
  obtain ⟨record, stored, linked, auditStored, otherWrites, otherAudits⟩ :=
    dispatch_appends_exactly_one_linked_write_and_audit step
  exact ⟨record, requestAudit, fresh.1, fresh.2, stored, linked, auditStored, otherWrites,
    otherAudits⟩

end SpecCnl.Proofs
