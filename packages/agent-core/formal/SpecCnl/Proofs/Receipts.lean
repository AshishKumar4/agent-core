import AgentCore.Cnl.Receipts
import SpecCnl.Bridge.Receipts

/-!
# Discharging the §7.4 Receipts hand propositions

Every theorem here is proved against `AgentCore` as it stands, through the consequences
collected in `AgentCore.Cnl.Receipts`. Without these the bridges above would relate a
sentence to a proposition nothing shows to be true of the model.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_RECEIPT_IMMUTABLE : Bridge.hand_C13_RECEIPT_IMMUTABLE := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ step
    exact ⟨fun _ _ stored => effect_step_preserves_attempt_receipts step stored,
      fun _ _ stored => effect_step_preserves_pre_receipts step stored⟩
  · intro _ _ _ ⟨_, step⟩ _ _ isSupersession
    exact supersession_requires_indeterminate_chain_head (isSupersession ▸ step)

theorem proved_C13_RECEIPT_FAILURE_ORTHOGONAL :
    Bridge.hand_C13_RECEIPT_FAILURE_ORTHOGONAL := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ isPreReceipt
    exact pre_receipt_records_item_without_attempt (isPreReceipt ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ isAttemptReceipt
    exact attempt_receipt_records_existing_attempt (isAttemptReceipt ▸ step)

theorem proved_C13_BATCH_OUTCOME_COMPLETE : Bridge.hand_C13_BATCH_OUTCOME_COMPLETE :=
  ⟨fun _ _ _ _ first second => derived_batch_outcome_is_unique first second,
    fun _ _ _ _ first second => terminal_batch_outcome_is_unique first second⟩

theorem proved_C13_AUDIT_ROUTE_BRIDGE : Bridge.hand_C13_AUDIT_ROUTE_BRIDGE := by
  intro _ _ _ ⟨_, _, _, step⟩ _ _ isBridge
  exact projection_bridge_appends_cause_free_bridge_root (isBridge ▸ step)

theorem proved_C13_AUDIT_TELEMETRY_EXCLUDED : Bridge.hand_C13_AUDIT_TELEMETRY_EXCLUDED := by
  refine ⟨?_, ?_⟩
  · intro _ notAttempt _ ⟨_, _, _, _, isAttemptReceipt⟩
    exact isAttemptReceipt ▸ only_attempt_audit_may_cause_attempt_receipt notAttempt
  · intro _ notIndeterminate _ ⟨_, _, _, _, isSupersession⟩
    exact isSupersession ▸ only_indeterminate_receipt_may_cause_supersession notIndeterminate

end SpecCnl.Proofs
