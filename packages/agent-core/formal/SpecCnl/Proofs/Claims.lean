import SpecCnl.Bridge.Claims

/-!
# Discharging the §7.4 claims group

Each theorem proves its hand proposition is true of `AgentCore` as it stands. Three of the
seven clauses rest on consequences stated in `AgentCore.Cnl.Claims`; the rest come from
theorems the model already had.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_CLAIM_INITIAL_ATOMIC : Bridge.hand_C13_CLAIM_INITIAL_ATOMIC := by
  refine ⟨⟨?_, ?_⟩, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ isClaim
    exact claim_requires_unclaimed_item (isClaim ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ _ _ isClaim
    exact claim_records_future_expiry (isClaim ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ _ _ isClaim
    exact claim_uses_exact_prepared_owner (isClaim ▸ step)

theorem proved_C13_CLAIM_RECOVERY_NO_ATTEMPT :
    Bridge.hand_C13_CLAIM_RECOVERY_NO_ATTEMPT := by
  intro _ _ _ ⟨_, step⟩ _ _ _ isRecovery
  exact abandoned_claim_recovery_preserves_ordinal_without_attempt (isRecovery ▸ step)

theorem proved_C13_ATTEMPT_ORDINAL_AFTER_FAILURE :
    Bridge.hand_C13_ATTEMPT_ORDINAL_AFTER_FAILURE := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ isClaim
    exact claim_ordinal_is_initial_or_follows_failure (isClaim ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ _ isRetry
    exact retry_requires_prior_final_failure (isRetry ▸ step)

theorem proved_C13_EFFECT_WRITE_AHEAD : Bridge.hand_C13_EFFECT_WRITE_AHEAD := by
  refine ⟨⟨?_, ?_⟩, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ isReceipt
    exact attempt_receipt_requires_recorded_latest_attempt (isReceipt ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ _ isSupersede
    obtain ⟨old, _, oldLookup, _, indeterminate, unused, _, _⟩ :=
      supersession_is_same_attempt_once (isSupersede ▸ step)
    exact ⟨old, oldLookup, indeterminate, unused⟩
  · intro _ _ _ ⟨_, step⟩ _ _ isSupersede
    exact superseding_receipt_is_recorded_same_attempt_final (isSupersede ▸ step)

end SpecCnl.Proofs
