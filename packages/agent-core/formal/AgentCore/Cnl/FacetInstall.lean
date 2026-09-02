import AgentCore.Policy
import AgentCore.Slots

/-!
# Consequences of the existing placement and slot model the controlled language needs

Three consequences of definitions this file does not touch.

* `placement_intersection_contains_component` and `valid_placement_is_declared_and_trusted`
  read `choosePlacement`, `placementIntersection`, `PlacementSet.intersect`,
  `PlacementSet.contains`, and `PlacementSnapshot.Valid` from `AgentCore.Policy`. The model
  proves which mode `choosePlacement` selects; what §4.1 needs is the containment that
  makes the selection admissible — a selected mode was declared by the manifest *and*
  admitted by the trust set, so listing a mode does not obtain it.
* `contribution_names_a_declared_slot` and `contribution_requires_unclaimed_entry_id` are
  the positive readings of `AgentCore.uninstalled_slot_contribution_rejected` and
  `AgentCore.entry_id_reuse_rejected`: the model states both gates as refusals, and a
  precondition over a transition family needs them as requirements of the step that lands.
-/

namespace AgentCore

/-- **Every component set contains what the intersection contains.** §9.2's admissible set
is the pointwise conjunction of the manifest, the policy, the substrate, and the trust set,
so a mode the intersection admits was admitted by each of the four independently. -/
theorem placement_intersection_contains_component {manifest policy substrate trust : PlacementSet}
    {placement : Placement}
    (available :
      (placementIntersection manifest policy substrate trust).contains placement = true) :
    manifest.contains placement = true ∧ policy.contains placement = true ∧
      substrate.contains placement = true ∧ trust.contains placement = true := by
  have decompose : ∀ first second third fourth : Bool,
      (((first && second) && third) && fourth) = true →
      first = true ∧ second = true ∧ third = true ∧ fourth = true := by
    intro first second third fourth joined
    simp only [Bool.and_eq_true] at joined
    exact ⟨joined.1.1.1, joined.1.1.2, joined.1.2, joined.2⟩
  cases placement
  · exact decompose _ _ _ _ available
  · exact decompose _ _ _ _ available
  · exact decompose _ _ _ _ available

/-- **A selected placement was declared by the manifest and admitted by the trust set.**
Whichever branch of `choosePlacement` selected it, the mode came out of the four-way
intersection, so a manifest listing `bundled` does not thereby obtain it — the trust set
excludes it independently — and a mode the manifest omits is never selected. -/
theorem valid_placement_is_declared_and_trusted {snapshot : PlacementSnapshot}
    (valid : snapshot.Valid) :
    snapshot.manifest.contains snapshot.selected = true ∧
      snapshot.trust.contains snapshot.selected = true := by
  have available :
      (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
        snapshot.trust).contains snapshot.selected = true := by
    unfold PlacementSnapshot.Valid at valid
    by_cases dynamic : (placementIntersection snapshot.manifest snapshot.policy
        snapshot.substrate snapshot.trust).dynamic = true
    · rw [placement_prefers_dynamic dynamic] at valid
      rw [(Option.some.inj valid).symm]
      exact dynamic
    · rw [Bool.not_eq_true] at dynamic
      by_cases provider : (placementIntersection snapshot.manifest snapshot.policy
          snapshot.substrate snapshot.trust).provider = true
      · rw [placement_uses_provider_without_dynamic dynamic provider] at valid
        rw [(Option.some.inj valid).symm]
        exact provider
      · rw [Bool.not_eq_true] at provider
        by_cases bundled : (placementIntersection snapshot.manifest snapshot.policy
            snapshot.substrate snapshot.trust).bundled = true
        · rw [placement_uses_bundled_last dynamic provider bundled] at valid
          rw [(Option.some.inj valid).symm]
          exact bundled
        · rw [Bool.not_eq_true] at bundled
          exact absurd valid (by simp [choosePlacement, dynamic, provider, bundled])
  exact ⟨(placement_intersection_contains_component available).1,
    (placement_intersection_contains_component available).2.2.2⟩

/-- **A contribution that lands named an installed slot declaration.** The positive
reading of `uninstalled_slot_contribution_rejected`: the declaration is a requirement of
the admitted step, not only a refusal of the missing one. -/
theorem contribution_names_a_declared_slot {schemas} {ledger after : SlotLedger}
    {entry : SlotEntry} (step : SlotStep schemas ledger (.contribute entry) after) :
    ∃ declaration, ledger.slots entry.slot = some declaration := by
  cases step with
  | contribute lookup _ _ => exact ⟨_, lookup⟩

/-- **A contribution that lands claimed an unused entry id.** The positive reading of
`entry_id_reuse_rejected`, quantified over every stored entry rather than stated against
one colliding witness. A stored id is therefore never reachable a second time through
`contribute`; the identical no-op is `recontribute`. -/
theorem contribution_requires_unclaimed_entry_id {schemas} {ledger after : SlotLedger}
    {entry : SlotEntry} (step : SlotStep schemas ledger (.contribute entry) after) :
    ∀ stored ∈ ledger.entries, stored.id ≠ entry.id := by
  cases step with
  | contribute _ _ fresh => exact fun stored member => (fresh stored member).1

end AgentCore
