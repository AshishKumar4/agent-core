import SpecCnl.Bridge.Isolate

/-!
# Isolate: discharging every hand proposition

Each theorem below reduces its hand proposition to a theorem `AgentCore` already proves.
Three come straight from `AgentCore.Slates`; the head-advance clause comes from
`AgentCore.Cnl.Isolate`, which states it as a consequence of the same six constructors.
-/

namespace SpecCnl.Proofs

open AgentCore

theorem proved_C13_AUTH_ISOLATE_DELEGATION : Bridge.hand_C13_AUTH_ISOLATE_DELEGATION :=
  fun _ _ _ step _ grew => isolate_capability_growth_is_host_pass step grew

theorem proved_C13_AUTH_ISOLATE_NAMESPACE_CLOSED :
    Bridge.hand_C13_AUTH_ISOLATE_NAMESPACE_CLOSED := by
  intro _ _ _ ⟨_, step⟩ _ isInvoke
  exact isolate_invoke_requires_passed_binding (isInvoke ▸ step)

theorem proved_C13_PLACEMENT_AUTHORED_BACKING : Bridge.hand_C13_PLACEMENT_AUTHORED_BACKING :=
  fun _ _ _ step backed => isolate_step_preserves_actions_backed backed step

theorem proved_C13_SLATE_SKELETON_ARTIFACT : Bridge.hand_C13_SLATE_SKELETON_ARTIFACT := by
  refine ⟨?_, ?_⟩
  · intro _ _ _ ⟨_, step⟩ _ _ _ lookup found advanced
    exact slate_head_advances_only_by_commit step lookup found advanced
  · intro _ _ _ ⟨_, step⟩ _ _ lookup
    exact committed_version_is_immutable step lookup

end SpecCnl.Proofs
