import AgentCore.Events

/-!
# Consequences of the existing event model the controlled language needs

Five premise extractions from `AgentCore.EventStep`, all consequences of the constructors
as they stand: nothing here adds a premise, and nothing here is used by the step relation
itself.

* The two publish theorems read the `HostDerivedTrust` premise of `EventStep.publish` and
  split it the way §6.1 words it: away from `self` the accepted tier is exactly the host's
  derivation from the Event's own provenance, and a `self` tier presents a lease token.
  The liveness half of the `self` case is `accepted_self_has_live_exact_lease`, which the
  second theorem reads rather than restates.
* The three reserve theorems read what `reserveSameTenant` and `reserveCrossTenant` agree
  on, which is what §6.2 and §7.4 call authentication of the reservation: the authority
  form matches the actual tenant relation of the two owning Actors, the cited source Event
  is present and owned by the Actor the reservation names as its source, and the
  Invocation the reservation carries was unreserved before the step and is indexed to
  exactly this reservation after it.
-/

namespace AgentCore

/-- **A published Event's non-`self` tier is the host's channel derivation.** Reads
`EventStep.publish`'s `HostDerivedTrust` premise: away from `self` the tier is exactly
`deriveChannelTrust` of the Event's own provenance, and no lease token is presented. -/
theorem published_non_self_tier_is_channel_derived {leases now before after id}
    (step : EventStep leases now before (.publish id) after) :
    ∀ event, after.events id = some event → event.acceptedTier ≠ .self →
      event.acceptedTier = deriveChannelTrust event.provenance ∧ event.leaseToken = none := by
  cases step with
  | publish _ _ _ trust =>
      intro event lookup notSelf
      change tableSet before.events id _ id = some event at lookup
      rw [tableSet_self] at lookup
      rw [Option.some.inj lookup] at trust
      unfold HostDerivedTrust at trust
      cases tier : event.acceptedTier with
      | owner => rw [tier] at trust; exact trust.symm
      | authenticated => rw [tier] at trust; exact trust.symm
      | external => rw [tier] at trust; exact trust.symm
      | self => exact absurd tier notSelf

/-- **A published `self` tier presents a lease token.** The token half of
`accepted_self_has_live_exact_lease`, which is the strongest part of that premise
expressible about the Event record alone: the liveness half also reads the host's lease
table and the publish instant. -/
theorem published_self_tier_presents_a_lease_token {leases now before after id}
    (step : EventStep leases now before (.publish id) after) :
    ∀ event, after.events id = some event → event.acceptedTier = .self →
      ∃ token, event.leaseToken = some token := by
  intro event lookup self
  obtain ⟨token, _, field, _, _⟩ := accepted_self_has_live_exact_lease step event lookup self
  exact ⟨token, field⟩

/-- **A reservation's authority form matches the tenant relation of its two owners.** A
`sameTenant` authority is admitted only where the source and target Actors sit in one
Tenant, and a `crossTenant` authority only where they do not. -/
theorem reservation_authority_matches_tenant_relation {leases now before after id}
    (step : EventStep leases now before (.reserve id) after) :
    ∃ reservation, after.reservations id = some reservation ∧
      (∀ source, reservation.authority = .sameTenant source →
        actorTenantOf reservation.sourceOwner = actorTenantOf reservation.targetOwner) ∧
      ∀ source binding, reservation.authority = .crossTenant source binding →
        actorTenantOf reservation.sourceOwner ≠ actorTenantOf reservation.targetOwner := by
  cases step with
  | reserveSameTenant _ _ _ _ authority tenants =>
      refine ⟨_, tableSet_self .., fun _ _ => tenants, ?_⟩
      intro _ _ cross
      rw [authority] at cross
      simp at cross
  | reserveCrossTenant _ _ _ _ authority tenants =>
      refine ⟨_, tableSet_self .., ?_, fun _ _ _ => tenants⟩
      intro _ same
      rw [authority] at same
      simp at same

/-- **A reservation cites a present source Event owned by the Actor it names.** Both
reserve constructors require the cited Event to be in the store already and its owner to
be the reservation's declared source owner, so no reservation invents a source. -/
theorem reservation_cites_owned_source_event {leases now before after id}
    (step : EventStep leases now before (.reserve id) after) :
    ∃ reservation event, after.reservations id = some reservation ∧
      before.events reservation.sourceEvent = some event ∧
      event.owner = reservation.sourceOwner := by
  cases step with
  | reserveSameTenant _ _ eventLookup owner _ _ =>
      exact ⟨_, _, tableSet_self .., eventLookup, owner⟩
  | reserveCrossTenant _ _ eventLookup owner _ _ =>
      exact ⟨_, _, tableSet_self .., eventLookup, owner⟩

/-- **A reservation fixes one Invocation.** The Invocation the reservation carries had no
reservation before the step and is indexed to exactly this reservation after it, which is
the stability the §7.4 stable-`InvocationId` clause asks for at one step;
`route_reservation_is_unique_per_invocation` is the whole-trace form. -/
theorem reservation_fixes_one_invocation {leases now before after id}
    (step : EventStep leases now before (.reserve id) after) :
    ∃ reservation, after.reservations id = some reservation ∧
      before.reservationFor reservation.invocation = none ∧
      after.reservationFor reservation.invocation = some id := by
  cases step with
  | reserveSameTenant _ freshIndex _ _ _ _ =>
      exact ⟨_, tableSet_self .., freshIndex, tableSet_self ..⟩
  | reserveCrossTenant _ freshIndex _ _ _ _ =>
      exact ⟨_, tableSet_self .., freshIndex, tableSet_self ..⟩

end AgentCore
