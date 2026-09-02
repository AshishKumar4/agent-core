import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# TrustRoute vocabulary: host-derived trust, reservations, and projections

Two paradigms and one reused one.

* **The Event record.** `published event` and `asserted tier` already ship, so the trust
  units here add conditions on an Event and nothing else: the derivation clause and the
  self-tier lease-evidence clause are both `NP[AgentCore.Event]\S`, which is why
  `C13-TRUST-HOST-DERIVED` costs two conditions rather than a paradigm.
* **The event store.** One `TR` family per label constructor the corpus quantifies over
  (`reserve`, `project`), one payload lifter per constructor, and then the postconditions.
  Each family binds the host lease table and the publish clock existentially, because
  `AgentCore.EventStep` takes them as parameters and no model record bundles them with an
  `AgentCore.EventStore`; no premise of `reserve` or `project` reads either.
* **The routing ledger.** `every subscription firing` and `for the firing` are reused
  unchanged from the §6.2 delivery unit, so the asserted-tier unit costs one `RE`
  condition.

Nothing here denotes `fun _ => True`, so this group adds no `typeAsCommonNoun` caveat.
-/

namespace SpecCnl.Entries.TrustRoute

def entries : List LexEntry :=
  [ { id := "derives.a.non.self.tier"
      surface := "derives a non self tier from its provenance without a lease token"
      category := "NP[AgentCore.Event]\\S"
      denotation :=
        "fun event => AgentCore.Event.acceptedTier event ≠ AgentCore.TrustTier.self → " ++
        "AgentCore.Event.acceptedTier event = " ++
        "AgentCore.deriveChannelTrust (AgentCore.Event.provenance event) ∧ " ++
        "AgentCore.Event.leaseToken event = none" },
    { id := "has.lease.evidence.for.a.self.tier"
      surface := "has lease evidence for a self tier"
      category := "NP[AgentCore.Event]\\S"
      denotation :=
        "fun event => AgentCore.Event.acceptedTier event = AgentCore.TrustTier.self → " ++
        "∃ token, AgentCore.Event.leaseToken event = some token" },
    { id := "a.channel.derived.admission"
      surface := "a channel derived admission"
      category := "RE[AgentCore.SubscriptionLedger,AgentCore.SubscriptionId,AgentCore.EventId]"
      denotation :=
        "fun ledger subscription event => ∃ declared record, " ++
        "AgentCore.SubscriptionLedger.subscriptions ledger subscription = some declared ∧ " ++
        "AgentCore.SubscriptionLedger.events ledger event = some record ∧ " ++
        "AgentCore.RoutedSubscription.admits declared " ++
        "(AgentCore.deriveChannelTrust (AgentCore.RoutedEvent.channel record)) = true" },
    { id := "every.route.reservation"
      surface := "every route reservation"
      category := "TR[AgentCore.EventStore,AgentCore.EventLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id, label = AgentCore.EventLabel.reserve id) ∧ " ++
        "∃ leases now, AgentCore.EventStep leases now before label after" },
    { id := "for.the.reservation"
      surface := "for the reservation"
      category :=
        "PX[AgentCore.EventStore,AgentCore.ReservationId]" ++
        "\\PO[AgentCore.EventStore,AgentCore.EventLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.EventLabel.reserve id → cond before id after" },
    { id := "an.authority.matched.tenant.relation"
      surface := "an authority matched tenant relation"
      category := "PX[AgentCore.EventStore,AgentCore.ReservationId]"
      denotation :=
        "fun _ id after => ∃ reservation, " ++
        "AgentCore.EventStore.reservations after id = some reservation ∧ " ++
        "(∀ source, AgentCore.RouteReservation.authority reservation = " ++
        "AgentCore.RouteAuthority.sameTenant source → " ++
        "AgentCore.actorTenantOf (AgentCore.RouteReservation.sourceOwner reservation) = " ++
        "AgentCore.actorTenantOf (AgentCore.RouteReservation.targetOwner reservation)) ∧ " ++
        "∀ source binding, AgentCore.RouteReservation.authority reservation = " ++
        "AgentCore.RouteAuthority.crossTenant source binding → " ++
        "AgentCore.actorTenantOf (AgentCore.RouteReservation.sourceOwner reservation) ≠ " ++
        "AgentCore.actorTenantOf (AgentCore.RouteReservation.targetOwner reservation)" },
    { id := "an.authenticated.source.event"
      surface := "an authenticated source event"
      category := "PX[AgentCore.EventStore,AgentCore.ReservationId]"
      denotation :=
        "fun before id after => ∃ reservation event, " ++
        "AgentCore.EventStore.reservations after id = some reservation ∧ " ++
        "AgentCore.EventStore.events before " ++
        "(AgentCore.RouteReservation.sourceEvent reservation) = some event ∧ " ++
        "AgentCore.Event.owner event = " ++
        "AgentCore.RouteReservation.sourceOwner reservation" },
    { id := "a.stable.invocation"
      surface := "a stable invocation"
      category := "PX[AgentCore.EventStore,AgentCore.ReservationId]"
      denotation :=
        "fun before id after => ∃ reservation, " ++
        "AgentCore.EventStore.reservations after id = some reservation ∧ " ++
        "AgentCore.EventStore.reservationFor before " ++
        "(AgentCore.RouteReservation.invocation reservation) = none ∧ " ++
        "AgentCore.EventStore.reservationFor after " ++
        "(AgentCore.RouteReservation.invocation reservation) = some id" },
    { id := "every.route.projection"
      surface := "every route projection"
      category := "TR[AgentCore.EventStore,AgentCore.EventLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id, label = AgentCore.EventLabel.project id) ∧ " ++
        "∃ leases now, AgentCore.EventStep leases now before label after" },
    { id := "for.the.projection"
      surface := "for the projection"
      category :=
        "PX[AgentCore.EventStore,AgentCore.ProjectionId]" ++
        "\\PO[AgentCore.EventStore,AgentCore.EventLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.EventLabel.project id → cond before id after" },
    { id := "an.exact.authenticated.reservation.projection"
      surface := "an exact authenticated reservation projection"
      category := "PX[AgentCore.EventStore,AgentCore.ProjectionId]"
      denotation :=
        "fun before id after => ∃ projection reservation, " ++
        "AgentCore.EventStore.projections after id = some projection ∧ " ++
        "AgentCore.EventStore.reservations before " ++
        "(AgentCore.RouteProjection.reservation projection) = some reservation ∧ " ++
        "id = AgentCore.RouteReservation.projection reservation ∧ " ++
        "AgentCore.RouteProjection.digest projection = " ++
        "AgentCore.RouteReservation.projectionDigest reservation ∧ " ++
        "AgentCore.EventStore.projectionFor after " ++
        "(AgentCore.RouteProjection.reservation projection) = some id ∧ " ++
        "AgentCore.RouteProjection.targetOwner projection = " ++
        "AgentCore.RouteReservation.targetOwner reservation ∧ " ++
        "AgentCore.RouteProjection.authenticated projection = true" } ]

end SpecCnl.Entries.TrustRoute
