/-
Impact and the enforcement-tier floor (SPEC §7.1, §7.2, §9.2).

The floor itself is already executable and already extracted: `AgentCore.Facets.Impact`,
`admitsDirect`, and `enforcementFloor` in `formal/AgentCore/Facets/Enforcement.lean` are
what `src/facets/generated/AgentCore/Facets/Enforcement.ts` is generated from. The kernel
imports them rather than restating them — a second copy of the floor is exactly the defect
this layer exists to prevent.

What this module adds is the decision `src/definition/policy.ts#evaluatePolicy` makes on
top of that floor, and the merge `mergePolicySets` performs along a policy chain. Both are
one-directional: policy may raise a floor to `mediated`, never lower a floor to `direct`.
`policy_only_tightens` is that rule as a theorem, and `mergeTier_mediated_absorbs` is the
same rule for the chain merge.

One divergence inside the existing model is worth naming, because this module has to pick a
side. `AgentCore.Policy.defaultTier` mediates every `mutate`, while
`AgentCore.Facets.enforcementFloor` admits a direct `mutate` against a Turn-owned Session's
own filesystem — the §7.2 exception the SPEC states and the TypeScript implements. The
kernel follows the SPEC and `Facets`, and `floor_refines_model_outside_mutate` records
exactly where the two model modules still agree.
-/
import AgentCore.Facets
import AgentCore.Policy
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- The enforcement tier that serves a call, as the runtime spells it. -/
abbrev EnforcementTier := AgentCore.Facets.EnforcementTier

/-- The impact an Operation declares. -/
abbrev Impact := AgentCore.Facets.Impact

/-- Every impact a policy may speak about, in `POLICY_IMPACTS` order. -/
def policyImpacts : List Impact :=
  [.observe, .mutate, .externalSend, .execute, .delegate, .administer]

theorem policyImpacts_complete (impact : Impact) : impact ∈ policyImpacts := by
  cases impact <;> decide

/-- `IsolationMode`: the protection domain a call is served in (SPEC §9.2). -/
inductive IsolationMode where
  | dynamic
  | provider
  | bundled
  deriving DecidableEq, Repr

/-- The wire label, and the `IsolationMode` union member. -/
def IsolationMode.wire : IsolationMode → String
  | .dynamic => "dynamic"
  | .provider => "provider"
  | .bundled => "bundled"

/-- The one fixed preference order (`PLACEMENT_PREFERENCE`, SPEC §9.2). -/
def placementPreference : List IsolationMode := [.dynamic, .provider, .bundled]

/-- The model's placement vocabulary for the same mode. -/
def IsolationMode.toModel : IsolationMode → AgentCore.Placement
  | .dynamic => .dynamic
  | .provider => .provider
  | .bundled => .bundled

theorem IsolationMode.toModel_injective {left right : IsolationMode}
    (same : left.toModel = right.toModel) : left = right := by
  cases left <;> cases right <;> simp_all [IsolationMode.toModel]

/-- What one policy chain says about a call: a tier per impact where it speaks, the impacts
it requires approval for, and the modes it still admits. -/
structure PolicySet where
  /-- The tier this chain requests for an impact, where it requests one. -/
  tier : Impact → Option EnforcementTier
  /-- Whether this chain requires approval for an impact. -/
  approval : Impact → Bool
  /-- The modes this chain admits. -/
  admits : IsolationMode → Bool

/-- The empty policy set: no tier requested, no approval required, every mode admitted. -/
def PolicySet.empty : PolicySet where
  tier := fun _ => none
  approval := fun _ => false
  admits := fun _ => true

/-- `mergePolicySets`' tier rule: the first request stands unless a later one is stricter.
`mediated` absorbs, which is what makes the merge tighten-only. -/
def mergeTier : Option EnforcementTier → Option EnforcementTier → Option EnforcementTier
  | none, request => request
  | some held, none => some held
  | some _, some .mediated => some .mediated
  | some held, some _ => some held

/-- One step of `mergePolicySets` along the chain. -/
def PolicySet.merge (held next : PolicySet) : PolicySet where
  tier := fun impact => mergeTier (held.tier impact) (next.tier impact)
  approval := fun impact => held.approval impact || next.approval impact
  admits := fun mode => held.admits mode && next.admits mode

/-- `mergePolicySets` over a chain, left to right from the empty set. -/
def mergePolicySets (policies : List PolicySet) : PolicySet :=
  policies.foldl PolicySet.merge PolicySet.empty

/-- What `evaluatePolicy` decides. -/
structure PolicyDecision where
  tier : EnforcementTier
  approvalRequired : Bool
  deriving DecidableEq, Repr

/-- The four facts one enforcement decision is taken over. -/
structure PolicyEvaluation where
  impact : Impact
  turnOwnedSession : Bool
  /-- True only where the target is the Turn-owned Session's own filesystem (SPEC §7.2). -/
  sessionFilesystemTarget : Bool
  placement : IsolationMode

/-- SPEC §7.2's floor, read off the extracted `Facets` model rather than restated. -/
def enforcementFloor (evaluation : PolicyEvaluation) : EnforcementTier :=
  AgentCore.Facets.enforcementFloor evaluation.impact evaluation.turnOwnedSession
    evaluation.sessionFilesystemTarget

/-- `evaluatePolicy`: mediated where the floor is mediated, where the chain asked for
mediated, where the call is not co-located, or where approval is required. -/
def evaluatePolicy (evaluation : PolicyEvaluation) (policy : PolicySet) : PolicyDecision :=
  let approvalRequired := policy.approval evaluation.impact
  let requested := (policy.tier evaluation.impact).getD .direct
  let mediated :=
    enforcementFloor evaluation == .mediated || requested == .mediated ||
      evaluation.placement != .bundled || approvalRequired
  { tier := if mediated then .mediated else .direct, approvalRequired }

/-- **Policy only tightens.** Where the §7.2 floor is `mediated`, no policy, placement, or
approval setting can produce a direct call. -/
theorem policy_only_tightens {evaluation : PolicyEvaluation} {policy : PolicySet}
    (floor : enforcementFloor evaluation = .mediated) :
    (evaluatePolicy evaluation policy).tier = .mediated := by
  unfold evaluatePolicy
  simp [floor]

/-- **A requested `mediated` is honored.** A chain that asks for mediation gets it, whatever
the floor and the placement admit. -/
theorem requested_mediation_is_honored {evaluation : PolicyEvaluation} {policy : PolicySet}
    (requested : policy.tier evaluation.impact = some .mediated) :
    (evaluatePolicy evaluation policy).tier = .mediated := by
  unfold evaluatePolicy
  simp [requested]

/-- **Approval forces mediation.** A required approval has to be recorded, and only the
mediated path records anything. -/
theorem approval_forces_mediation {evaluation : PolicyEvaluation} {policy : PolicySet}
    (approval : policy.approval evaluation.impact = true) :
    (evaluatePolicy evaluation policy).tier = .mediated := by
  unfold evaluatePolicy
  simp [approval]

/-- **Only a co-located call can be direct.** A `dynamic` or `provider` placement is always
mediated, which is §7.2's co-location requirement. -/
theorem direct_requires_bundled {evaluation : PolicyEvaluation} {policy : PolicySet}
    (direct : (evaluatePolicy evaluation policy).tier = .direct) :
    evaluation.placement = .bundled := by
  unfold evaluatePolicy at direct
  by_cases colocated : evaluation.placement = .bundled
  · exact colocated
  · simp [colocated] at direct

/-- **A direct call stands on a direct floor.** The decision never invents a direct tier the
floor did not already admit. -/
theorem direct_stands_on_floor {evaluation : PolicyEvaluation} {policy : PolicySet}
    (direct : (evaluatePolicy evaluation policy).tier = .direct) :
    enforcementFloor evaluation = .direct := by
  unfold evaluatePolicy at direct
  cases floor : enforcementFloor evaluation with
  | direct => rfl
  | mediated => simp [floor] at direct

/-- **`mediated` absorbs along the chain.** Once any policy on the chain requests mediation,
no later policy can hand the impact back a direct tier. -/
theorem mergeTier_mediated_absorbs (held : Option EnforcementTier) :
    mergeTier held (some .mediated) = some .mediated := by
  cases held <;> rfl

/-- **The chain merge never widens the admitted modes.** A mode the merged set admits was
admitted by both sides, so tightening is the only direction the chain can move. -/
theorem merge_admits_both {held next : PolicySet} {mode : IsolationMode}
    (admitted : (held.merge next).admits mode = true) :
    held.admits mode = true ∧ next.admits mode = true := by
  unfold PolicySet.merge at admitted
  simpa using (Bool.and_eq_true _ _).mp admitted

/-- **The chain merge never drops a required approval.** -/
theorem merge_keeps_approval {held next : PolicySet} {impact : Impact}
    (required : held.approval impact = true ∨ next.approval impact = true) :
    (held.merge next).approval impact = true := by
  unfold PolicySet.merge
  simpa using required

/-! ## Refinement against the model's tier policy

`AgentCore.effectiveTier` decides the same question with the interceptor fact in place of
the kernel's requested-tier-and-approval conjunction, and over
`AgentCore.Policy.defaultTier` rather than the extracted `Facets` floor. The two floors
agree on every impact but `mutate`, where `Facets` and the SPEC admit the Turn-owned
filesystem exception and `Policy.defaultTier` does not. -/

/-- The model's impact vocabulary for the same impact. -/
def Impact.toModel : Impact → AgentCore.InvocationImpact
  | .observe => .observe
  | .mutate => .mutate
  | .externalSend => .externalSend
  | .execute => .execute
  | .delegate => .delegate
  | .administer => .administer

/-- The model declares its own enforcement-tier vocabulary in `Model.lean`, separate from
the extracted one in `Facets`, because `Facets/Enforcement.lean` imports nothing. This is
the bridge between the two, and it is a bijection. -/
def tierToModel : EnforcementTier → AgentCore.EnforcementTier
  | .direct => .direct
  | .mediated => .mediated

theorem tierToModel_injective {left right : EnforcementTier}
    (same : tierToModel left = tierToModel right) : left = right := by
  cases left <;> cases right <;> simp_all [tierToModel]

/-- **The kernel's floor is the model's floor everywhere the two model modules agree.**
Outside `mutate`, `Facets.enforcementFloor` and `Policy.defaultTier` decide identically, so
a theorem proved over either applies to the kernel. -/
theorem floor_refines_model_outside_mutate (impact : Impact) (turnOwnedSession : Bool)
    (sessionFilesystemTarget : Bool) (notMutate : impact ≠ .mutate) :
    tierToModel (AgentCore.Facets.enforcementFloor impact turnOwnedSession
        sessionFilesystemTarget) =
      AgentCore.defaultTier (Impact.toModel impact) turnOwnedSession := by
  cases impact with
  | mutate => exact absurd rfl notMutate
  | observe => rfl
  | externalSend => rfl
  | execute => cases turnOwnedSession <;> rfl
  | delegate => rfl
  | administer => rfl

/-- **The `mutate` gap is exactly the §7.2 filesystem exception.** Stated rather than
hidden: for a Turn-owned Session's own filesystem the kernel and `Facets` admit a direct
floor where `Policy.defaultTier` mediates, and they agree in every other `mutate` case. -/
theorem mutate_floor_gap :
    AgentCore.Facets.enforcementFloor .mutate true true = .direct ∧
      AgentCore.defaultTier (Impact.toModel .mutate) true = .mediated ∧
      AgentCore.Facets.enforcementFloor .mutate true false = .mediated ∧
      AgentCore.Facets.enforcementFloor .mutate false true = .mediated :=
  ⟨rfl, rfl, rfl, rfl⟩

/-- **A direct decision refines the model's `effectiveTier`.** Where the kernel serves a
call directly, the model's own tier function serves it directly too, with the interceptor
fact false — which is the only way the model admits a direct tier. -/
theorem direct_refines_effectiveTier {evaluation : PolicyEvaluation} {policy : PolicySet}
    (notMutate : evaluation.impact ≠ .mutate)
    (direct : (evaluatePolicy evaluation policy).tier = .direct) :
    AgentCore.effectiveTier evaluation.placement.toModel (Impact.toModel evaluation.impact)
        evaluation.turnOwnedSession false = .direct := by
  have colocated : evaluation.placement = .bundled := direct_requires_bundled direct
  have floor : enforcementFloor evaluation = .direct := direct_stands_on_floor direct
  have modelFloor : AgentCore.defaultTier (Impact.toModel evaluation.impact)
      evaluation.turnOwnedSession = .direct := by
    rw [← floor_refines_model_outside_mutate evaluation.impact evaluation.turnOwnedSession
      evaluation.sessionFilesystemTarget notMutate]
    unfold enforcementFloor at floor
    rw [floor]
    rfl
  unfold AgentCore.effectiveTier
  rw [modelFloor, colocated]
  rfl

end AgentCore.Kernel
