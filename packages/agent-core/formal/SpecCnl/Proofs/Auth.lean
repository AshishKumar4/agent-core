import SpecCnl.Bridge.Auth

/-!
# Discharging the Auth group's hand propositions

Every proposition of `SpecCnl.Bridge.Auth` is true of `AgentCore` as it stands. The
consequences these discharges lean on that the model never spelled out live in
`AgentCore.Cnl.Auth`; everything else is a theorem the model already proved.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_AUTH_DENY_PRECEDENCE : Bridge.hand_C13_AUTH_DENY_PRECEDENCE :=
  fun _ allowed => authority_decision_is_sound allowed

theorem proved_C13_AUTH_GUEST_ELEVATION : Bridge.hand_C13_AUTH_GUEST_ELEVATION := by
  refine ⟨fun _ ⟨guest, elevating⟩ => guest_elevation_is_refused guest elevating, ?_⟩
  intro _ _ _ ⟨_, step⟩ foreign _ _ stored allow
  exact guest_materialization_has_no_elevated_allow step foreign stored allow

theorem proved_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP :
    Bridge.hand_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP :=
  fun _ _ _ ⟨_, step⟩ _ _ _ subject => materialization_requires_completed_scheme subject step

theorem proved_C13_AUTH_PRINCIPAL_REF : Bridge.hand_C13_AUTH_PRINCIPAL_REF := by
  refine ⟨?_, fun _ _ _ _ leftActs rightActs =>
    acts_under_principal_subject_is_unique leftActs rightActs⟩
  intro _ _ _ ⟨_, step⟩ _ isResolve
  exact resolution_principal_is_tenant_qualified (isResolve ▸ step)

theorem proved_C13_AUTH_PLANE : Bridge.hand_C13_AUTH_PLANE := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ stored
    exact materialization_writes_only_membership_keyed_grants step stored
  · intro _ _ _ ⟨_, step⟩
    exact rematerialization_advances_epoch step

theorem proved_C13_AUTH_ROLE_MATERIALIZATION : Bridge.hand_C13_AUTH_ROLE_MATERIALIZATION := by
  intro _ _ _ ⟨role, step⟩ _ _ stored
  obtain ⟨subject, scope, source⟩ := materialized_grant_is_ordinal_keyed step stored
  exact ⟨subject, scope, role.id, source⟩

theorem proved_C13_AUTH_BINDING_RESOLUTION : Bridge.hand_C13_AUTH_BINDING_RESOLUTION := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ isDelegate
    exact delegation_names_contained_allow_parent (isDelegate ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ isResolve
    exact resolution_binding_matches_operation_facet (isResolve ▸ step)

theorem proved_C13_AUTH_MEDIATED_STALE : Bridge.hand_C13_AUTH_MEDIATED_STALE := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ isStart
    exact mediated_start_rechecks_authority_path (isStart ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ _ _ isStale
    obtain ⟨record, item, prepared, stored, exactInvocation, denied, intent, itemLookup⟩ :=
      stale_mediated_denial_matches_intent (isStale ▸ step)
    refine ⟨record, prepared, item, stored, denied, ?_, itemLookup⟩
    rw [exactInvocation]
    exact intent

theorem proved_C13_AUTH_RESOLUTION_LIFETIME : Bridge.hand_C13_AUTH_RESOLUTION_LIFETIME := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ isResolve
    exact resolution_deadline_is_window_bounded (isResolve ▸ step)
  · intro _ _ _ ⟨_, step⟩ _ isResolve _ lease
    exact resolution_lease_deadline_is_lease_bounded (isResolve ▸ step) lease

end SpecCnl.Proofs
