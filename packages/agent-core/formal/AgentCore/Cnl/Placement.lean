import AgentCore.Composed

/-!
# Consequences of the existing placement, floor, and admission model the controlled
language needs

Nothing here changes a definition. Each theorem is a consequence of `choosePlacement`,
`placementIntersection`, `PlacementSnapshot.Valid`, `effectiveTier`, `DirectReady`,
`DirectStep`, or `MediatedReady` exactly as they stand.

Three groups:

* **The preference order as a property of a validated snapshot.** `Policy.lean` proves
  the order from the *inputs*: given a `dynamic` in the intersection, `choosePlacement`
  returns `dynamic`. The controlled language quantifies over a `PlacementSnapshot` whose
  `selected` field the model has already validated, so it needs the same three facts read
  backwards from the selection — the selected mode is in the intersection, a `bundled`
  selection means no other mode was available, and a `provider` selection means `dynamic`
  was not. Together they are "placement is the first member of the intersection in the
  order dynamic, provider, bundled", and the first of them says contrapositively that an
  empty intersection validates no selection at all (§9.2).
* **The escalation floor.** A mode other than `bundled` never reaches the direct tier,
  whatever the impact, the Turn-owned-Session fact, or the interception fact (§7.2).
* **Direct and mediated admission read as named facts.** `DirectReady` and `MediatedReady`
  are long conjunctions whose components the corpus needs by name rather than by
  projection index.
-/

namespace AgentCore

/-! ## The preference order, read off a validated snapshot -/

/-- **A validated placement is a member of the intersection.** §9.2: placement is
computed from `manifest ∩ policy ∩ substrate ∩ trust`, so a validated selection is
admissible in all four sets at once. Contrapositively, an empty intersection validates no
selection, which is the no-fallback half of the same rule. -/
theorem chosen_placement_selects_an_admissible_mode {snapshot : PlacementSnapshot}
    (valid : snapshot.Valid) :
    (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
      snapshot.trust).contains snapshot.selected = true := by
  have selection : choosePlacement snapshot.manifest snapshot.policy snapshot.substrate
      snapshot.trust = some snapshot.selected := valid
  cases dynamic : (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
      snapshot.trust).dynamic with
  | true =>
      have chosen := placement_prefers_dynamic dynamic
      rw [selection] at chosen
      rw [Option.some.inj chosen]
      exact dynamic
  | false =>
      cases provider : (placementIntersection snapshot.manifest snapshot.policy
          snapshot.substrate snapshot.trust).provider with
      | true =>
          have chosen := placement_uses_provider_without_dynamic dynamic provider
          rw [selection] at chosen
          rw [Option.some.inj chosen]
          exact provider
      | false =>
          cases bundled : (placementIntersection snapshot.manifest snapshot.policy
              snapshot.substrate snapshot.trust).bundled with
          | true =>
              have chosen := placement_uses_bundled_last dynamic provider bundled
              rw [selection] at chosen
              rw [Option.some.inj chosen]
              exact bundled
          | false => simp [choosePlacement, dynamic, provider, bundled] at selection

/-- **A `bundled` selection means no earlier mode was admissible.** `bundled` is last in
the preference order, so a validated `bundled` selection excludes every other mode from
the intersection (§9.2). -/
theorem bundled_choice_excludes_earlier_modes {snapshot : PlacementSnapshot}
    (valid : snapshot.Valid) (last : snapshot.selected = Placement.bundled)
    {mode : Placement} (earlier : mode ≠ Placement.bundled) :
    ¬ (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
        snapshot.trust).contains mode = true := by
  have selection : choosePlacement snapshot.manifest snapshot.policy snapshot.substrate
      snapshot.trust = some snapshot.selected := valid
  intro admissible
  cases mode with
  | bundled => exact earlier rfl
  | dynamic =>
      have chosen := placement_prefers_dynamic admissible
      rw [selection, last] at chosen
      simp at chosen
  | provider =>
      cases dynamic : (placementIntersection snapshot.manifest snapshot.policy
          snapshot.substrate snapshot.trust).dynamic with
      | true =>
          have chosen := placement_prefers_dynamic dynamic
          rw [selection, last] at chosen
          simp at chosen
      | false =>
          have chosen := placement_uses_provider_without_dynamic dynamic admissible
          rw [selection, last] at chosen
          simp at chosen

/-- **A `provider` selection means `dynamic` was not admissible.** `dynamic` is first in
the preference order (§9.2). -/
theorem provider_choice_excludes_dynamic_mode {snapshot : PlacementSnapshot}
    (valid : snapshot.Valid) (chosen : snapshot.selected = Placement.provider) :
    ¬ (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
        snapshot.trust).contains Placement.dynamic = true := by
  have selection : choosePlacement snapshot.manifest snapshot.policy snapshot.substrate
      snapshot.trust = some snapshot.selected := valid
  intro admissible
  have preferred := placement_prefers_dynamic admissible
  rw [selection, chosen] at preferred
  simp at preferred

/-! ## The escalation floor -/

/-- **A mode other than `bundled` never reaches the direct tier.** §7.2: a
policy-selected direct call whose chosen mode cannot admit it escalates to mediated. The
statement is uniform in the impact, the Turn-owned-Session fact, and the interception
fact, because `effectiveTier` reaches `direct` only through the bundled branch. -/
theorem unbundled_placement_is_never_direct {mode : Placement}
    (unbundled : mode ≠ Placement.bundled) (impact : InvocationImpact)
    (sessionScoped intercepted : Bool) :
    effectiveTier mode impact sessionScoped intercepted = EnforcementTier.mediated := by
  unfold effectiveTier
  split
  · rw [if_neg]
    intro ⟨bundled, _⟩
    exact unbundled bundled
  · rfl

/-! ## Direct admission -/

/-- **A direct admission resolves a `bundled` facet.** Half of §7.2's co-location
requirement: a provider- or dynamic-mode facet is never `direct`. -/
theorem direct_admission_selects_bundled_placement {before request after}
    (step : DirectStep before request after) :
    request.prepared.header.placement.selected = Placement.bundled := by
  cases step with
  | admit ready => exact ready.2.2.2.2.1

/-- **A direct admission runs under the exact current Turn lease, in that Turn's own Run
domain, on the placement that Turn pinned.** The other half of §7.2's co-location
requirement: the `bundled` facet is bundled *in the Actor that owns the Turn lease*. -/
theorem direct_admission_uses_exact_turn_lease {before request after}
    (step : DirectStep before request after) :
    ∃ token turn run,
      request.prepared.header.lease = some token ∧
      before.graph.turns token.turn = some turn ∧
      before.graph.runs turn.run = some run ∧
      request.prepared.header.domain = ProtectionDomain.run run.tenant turn.run ∧
      turn.pins.placement = request.prepared.header.placement ∧
      turn.lease.Admits token request.now := by
  cases step with
  | admit ready =>
      exact exact_turn_lease_gate_binds_run_domain_and_placement
        (direct_checks_exact_current_incarnation ready)

/-- **Only an `observe` impact is ever admitted directly.** §7.2's floor: every `execute`
and `mutate`, plus `externalSend`, `delegate`, and `administer`, is mediated in this
model — including the Turn-owned-Session `execute` the SPEC floors at `direct` and policy
may raise. -/
theorem direct_admission_observes_only {before request after}
    (step : DirectStep before request after) :
    request.prepared.header.impact = InvocationImpact.observe := by
  cases step with
  | admit ready => exact ready.2.2.2.1

/-- **A call that needs an approval is never admitted directly.** §7.2: an approval has
nowhere to be recorded on the direct path, so requiring one raises the floor. -/
theorem direct_admission_requires_no_approval {before request after}
    (step : DirectStep before request after) :
    requiresApproval request.prepared = false := by
  unfold requiresApproval
  rw [direct_admission_observes_only step]

/-! ## Mediated admission -/

/-- **A mediated admission compares the presented path epochs against the live ledger
epochs.** §7.2 with §3.4 rule 7: the one final authority-admission linearization point
re-reads the current epoch of every Scope on the target's ordered path, so evidence a
`bumpScope` has overtaken is not admissible. This is not limited to external sends — the
statement is over `MediatedReady`, which every mediated effect satisfies, an internal
mutation or execution included. -/
theorem mediated_admission_compares_current_path_epochs {state request}
    (ready : MediatedReady state request) :
    state.authority.PathEvidenceComplete request.prepared.header request.scope := by
  obtain ⟨_, _, usable⟩ := ready.2.2.2.2.2.2
  exact usable.2.2.2

/-- **A mediated admission in a Run domain matches the live registry epoch.** The
reservation the request carries was taken under the registry epoch still current at
admission, against a registry still accepting, for an obligation reserved and not yet
completed. `changed_registry_epoch_blocks_mediated_ready` is the refusal form of the same
comparison. -/
theorem mediated_admission_matches_open_reservation_epoch {state request tenant run}
    (ready : MediatedReady state request)
    (domain : request.prepared.header.domain = ProtectionDomain.run tenant run) :
    ∃ reservation registry,
      request.reservation = some reservation ∧
      state.graph.admissionRegistry run = some registry ∧
      registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
      reservation.obligation ∈ registry.reserved ∧
      reservation.obligation ∉ registry.completed := by
  obtain ⟨_, reservation, registry, _, _, requestReservation, _, registryLookup, accepting,
    epoch, reserved, incomplete⟩ :=
    mediated_ready_validates_exact_run_reservation ready domain
  exact ⟨reservation, registry, requestReservation, registryLookup, accepting, epoch,
    reserved, incomplete⟩

end AgentCore
