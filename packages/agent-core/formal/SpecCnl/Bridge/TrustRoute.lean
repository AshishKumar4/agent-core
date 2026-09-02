import SpecCnl.Sentences.TrustRoute

/-!
# TrustRoute: hand propositions and bridges

Each `hand_X` below is written from the rule unit against `AgentCore` directly. The
event-store families bind the host lease table and the publish clock existentially,
because `AgentCore.EventStep` reads both as parameters and no model record bundles them
with an `AgentCore.EventStore`; neither the `reserve` nor the `project` constructor has a
premise that mentions either, so on those two families the existential and a universal
quantifier admit the same steps.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §6.1 `C13-TRUST-HOST-DERIVED` -/

def hand_C13_TRUST_HOST_DERIVED : Prop :=
  (∀ (event : Event),
      (∃ leases now before after id,
        EventStep leases now before (EventLabel.publish id) after ∧
          after.events id = some event) →
      event.acceptedTier ≠ TrustTier.self →
        event.acceptedTier = deriveChannelTrust event.provenance ∧
          event.leaseToken = none) ∧
    ∀ (event : Event),
      (∃ leases now before after id,
        EventStep leases now before (EventLabel.publish id) after ∧
          after.events id = some event) →
      event.acceptedTier = TrustTier.self → ∃ token, event.leaseToken = some token

theorem bridge_C13_TRUST_HOST_DERIVED :
    Sentences.cnl_C13_TRUST_HOST_DERIVED ↔ hand_C13_TRUST_HOST_DERIVED := Iff.rfl

/-! ## §6.1 `C13-TRUST-ASSERTION-REJECTION` -/

def hand_C13_TRUST_ASSERTION_REJECTION : Prop :=
  ∀ (before : SubscriptionLedger) (label : RoutingLabel) (after : SubscriptionLedger),
    ((∃ subscription event target, label = RoutingLabel.fire subscription event target) ∧
      RoutingStep before label after) →
    ∀ subscription event target, label = RoutingLabel.fire subscription event target →
      ∃ declared record, before.subscriptions subscription = some declared ∧
        before.events event = some record ∧
        declared.admits (deriveChannelTrust record.channel) = true

theorem bridge_C13_TRUST_ASSERTION_REJECTION :
    Sentences.cnl_C13_TRUST_ASSERTION_REJECTION ↔
      hand_C13_TRUST_ASSERTION_REJECTION := Iff.rfl

/-! ## §6.2 `C13-SUBSCRIPTION-AUTHORITY`, `C13-ROUTE-CROSS-TENANT-BINDING` -/

def hand_C13_SUBSCRIPTION_AUTHORITY : Prop :=
  ∀ (before : EventStore) (label : EventLabel) (after : EventStore),
    ((∃ id, label = EventLabel.reserve id) ∧
      ∃ leases now, EventStep leases now before label after) →
    ∀ id, label = EventLabel.reserve id →
      ∃ reservation, after.reservations id = some reservation ∧
        (∀ source, reservation.authority = RouteAuthority.sameTenant source →
          actorTenantOf reservation.sourceOwner = actorTenantOf reservation.targetOwner) ∧
        ∀ source binding, reservation.authority = RouteAuthority.crossTenant source binding →
          actorTenantOf reservation.sourceOwner ≠ actorTenantOf reservation.targetOwner

theorem bridge_C13_SUBSCRIPTION_AUTHORITY :
    Sentences.cnl_C13_SUBSCRIPTION_AUTHORITY ↔ hand_C13_SUBSCRIPTION_AUTHORITY := Iff.rfl

/-! ## §6.2 `C13-ROUTE-SOURCE-OWNED`, `C13-ROUTE-PROJECTION-DIGEST` -/

def hand_C13_ROUTE_SOURCE_OWNED : Prop :=
  ∀ (before : EventStore) (label : EventLabel) (after : EventStore),
    ((∃ id, label = EventLabel.project id) ∧
      ∃ leases now, EventStep leases now before label after) →
    ∀ id, label = EventLabel.project id →
      ∃ projection reservation, after.projections id = some projection ∧
        before.reservations projection.reservation = some reservation ∧
        id = reservation.projection ∧
        projection.digest = reservation.projectionDigest ∧
        after.projectionFor projection.reservation = some id ∧
        projection.targetOwner = reservation.targetOwner ∧
        projection.authenticated = true

theorem bridge_C13_ROUTE_SOURCE_OWNED :
    Sentences.cnl_C13_ROUTE_SOURCE_OWNED ↔ hand_C13_ROUTE_SOURCE_OWNED := Iff.rfl

/-! ## §7.4 `C13-ROUTE-STABLE-INVOCATION`, `C13-ROUTE-SOURCE-EVENT`,
`C13-ROUTE-AUDIT-CAUSE`, `C13-ROUTE-TENANT-RELATION` -/

def hand_C13_ROUTE_STABLE_INVOCATION : Prop :=
  (∀ (before : EventStore) (label : EventLabel) (after : EventStore),
      ((∃ id, label = EventLabel.reserve id) ∧
        ∃ leases now, EventStep leases now before label after) →
      ∀ id, label = EventLabel.reserve id →
        ∃ reservation event, after.reservations id = some reservation ∧
          before.events reservation.sourceEvent = some event ∧
          event.owner = reservation.sourceOwner) ∧
    ∀ (before : EventStore) (label : EventLabel) (after : EventStore),
      ((∃ id, label = EventLabel.reserve id) ∧
        ∃ leases now, EventStep leases now before label after) →
      ∀ id, label = EventLabel.reserve id →
        ∃ reservation, after.reservations id = some reservation ∧
          before.reservationFor reservation.invocation = none ∧
          after.reservationFor reservation.invocation = some id

theorem bridge_C13_ROUTE_STABLE_INVOCATION :
    Sentences.cnl_C13_ROUTE_STABLE_INVOCATION ↔ hand_C13_ROUTE_STABLE_INVOCATION := Iff.rfl

end SpecCnl.Bridge
