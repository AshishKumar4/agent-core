import AgentCore.Policy

/-!
# Event → Subscription routing (SPEC §6.2)

Every input to a platform — a chat message, an email, a schedule firing, a callback —
becomes an Event, and Subscriptions decide what runs in response. Two promises are
normative:

1. **at-most-once reaction** — a given (Subscription, event key) fires at most once,
   even when the transport redelivers the Event arbitrarily many times; and
2. **derived targeting** — a firing invokes the Subscription's *declared* target under
   the Subscription's own stored authority. The Event picks *whether* something runs,
   never *what* runs or *as whom*.

The dedup key is the Event's canonical cause identity, so redelivered duplicates of one
external happening share one key. Trust admission reuses the channel-derived trust tier
of SPEC §6.1: a Subscription declares the lowest tier it accepts, and provenance — not
any source-asserted claim — determines an Event's tier.
-/

namespace AgentCore

structure SubscriptionId where value : Nat deriving DecidableEq, Repr

/-- The dedup identity of an Event: the canonical identity of its external cause, not
    the delivery. Redelivering one happening produces Events sharing one key. -/
structure EventKey where value : Nat deriving DecidableEq, Repr

/-- An Event as the router sees it: which tenant it belongs to, its cause identity, and
    the trust tier derived from the channel that carried it (SPEC §6.1). -/
structure RoutedEvent where
  tenant : TenantId
  key : EventKey
  channel : Provenance
  deriving DecidableEq, Repr

/-- A Subscription: the tenant it lives in, the invocation identity of its declared
    target, the minimum trust its filter admits, and whether it is currently enabled.
    The target is fixed at declaration time — firings cannot substitute it. -/
structure RoutedSubscription where
  tenant : TenantId
  target : InvocationId
  admits : TrustTier → Bool
  enabled : Bool

/-- The routing ledger: declared Subscriptions, accepted Events, and the consumed
    (Subscription, key) pairs that make redelivery inert. -/
structure SubscriptionLedger where
  subscriptions : SubscriptionId → Option RoutedSubscription
  events : EventId → Option RoutedEvent
  consumed : SubscriptionId → EventKey → Prop

instance : Inhabited SubscriptionLedger where
  default := ⟨fun _ => none, fun _ => none, fun _ _ => False⟩

/-- Revocation: same Subscription, firing disabled. -/
def RoutedSubscription.disable (subscription : RoutedSubscription) : RoutedSubscription :=
  { subscription with enabled := false }

def SubscriptionLedger.consume (ledger : SubscriptionLedger) (subscription : SubscriptionId)
    (key : EventKey) : SubscriptionLedger :=
  { ledger with
    consumed := fun candidate candidateKey =>
      (candidate = subscription ∧ candidateKey = key) ∨ ledger.consumed candidate candidateKey }

inductive RoutingLabel where
  | acceptEvent (id : EventId)
  | declareSubscription (id : SubscriptionId)
  | disableSubscription (id : SubscriptionId)
  | fire (subscription : SubscriptionId) (event : EventId) (target : InvocationId)
  deriving DecidableEq, Repr

/-- Routing transitions.

* `acceptEvent` — ingress admits an Event once; its key and channel-derived tier are
  fixed at acceptance and never rewritten.
* `declareSubscription` — a Subscription is declared with its target and filter.
* `disableSubscription` — revocation: the Subscription stops firing but its consumed
  set is retained, so re-enabling cannot replay history.
* `fire` — the guarded step. It requires a live Subscription, an accepted Event in the
  same tenant whose channel-derived tier passes the filter, an unconsumed key, and a
  target equal to the Subscription's declared target. Firing consumes the key. -/
inductive RoutingStep : SubscriptionLedger → RoutingLabel → SubscriptionLedger → Prop
  | acceptEvent {ledger id event} :
      ledger.events id = none →
      RoutingStep ledger (.acceptEvent id)
        { ledger with events := tableSet ledger.events id event }
  | declareSubscription {ledger id subscription} :
      ledger.subscriptions id = none →
      RoutingStep ledger (.declareSubscription id)
        { ledger with subscriptions := tableSet ledger.subscriptions id subscription }
  | disableSubscription {ledger id subscription} :
      ledger.subscriptions id = some subscription →
      RoutingStep ledger (.disableSubscription id)
        { ledger with subscriptions := tableSet ledger.subscriptions id subscription.disable }
  | fire {ledger subscriptionId eventId subscription event} :
      ledger.subscriptions subscriptionId = some subscription →
      subscription.enabled = true →
      ledger.events eventId = some event →
      event.tenant = subscription.tenant →
      subscription.admits (deriveChannelTrust event.channel) = true →
      ¬ ledger.consumed subscriptionId event.key →
      RoutingStep ledger (.fire subscriptionId eventId subscription.target)
        (ledger.consume subscriptionId event.key)

/-- **Firing consumes the event key.** After an accepted firing the key is recorded
    consumed for exactly that Subscription. -/
theorem fire_consumes_key {ledger after : SubscriptionLedger} {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ event, ledger.events eventId = some event ∧
      ¬ ledger.consumed subscriptionId event.key ∧
      after.consumed subscriptionId event.key := by
  cases step with
  | fire lookup _ event _ _ fresh =>
      exact ⟨_, event, fresh, Or.inl ⟨rfl, rfl⟩⟩

/-- **At-most-once.** A consumed (Subscription, key) pair never fires again: any
    redelivery of the same happening — same key under any EventId — is inert for that
    Subscription. This is the §6.2 dedup promise under at-least-once transport. -/
theorem consumed_key_never_refires {ledger after : SubscriptionLedger}
    {subscriptionId eventId target} {event : RoutedEvent}
    (lookup : ledger.events eventId = some event)
    (consumed : ledger.consumed subscriptionId event.key) :
    ¬ RoutingStep ledger (.fire subscriptionId eventId target) after := by
  intro step
  cases step with
  | fire _ _ lookup' _ _ fresh =>
      rw [lookup] at lookup'
      exact fresh (Option.some.inj lookup' ▸ consumed)

/-- **A firing invokes the declared target.** The fired invocation identity is the one
    stored on the Subscription at declaration — an Event cannot steer a firing at a
    different Operation. -/
theorem fire_targets_declared {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ subscription, ledger.subscriptions subscriptionId = some subscription ∧
      subscription.enabled = true ∧ target = subscription.target := by
  cases step with
  | fire lookup enabled _ _ _ _ => exact ⟨_, lookup, enabled, rfl⟩

/-- **Tenant containment.** A firing pairs an Event and a Subscription of the same
    tenant; routing never crosses a tenant boundary. -/
theorem fire_is_tenant_contained {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ subscription event,
      ledger.subscriptions subscriptionId = some subscription ∧
      ledger.events eventId = some event ∧ event.tenant = subscription.tenant := by
  cases step with
  | fire lookup _ eventLookup tenant _ _ => exact ⟨_, _, lookup, eventLookup, tenant⟩

/-- **Trust admission is channel-derived.** The tier the filter admitted is the one
    derived from the Event's provenance (SPEC §6.1) — there is no field a source could
    assert to claim a higher tier. -/
theorem fire_admits_channel_trust {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ subscription event,
      ledger.subscriptions subscriptionId = some subscription ∧
      ledger.events eventId = some event ∧
      subscription.admits (deriveChannelTrust event.channel) = true := by
  cases step with
  | fire lookup _ eventLookup _ admitted _ => exact ⟨_, _, lookup, eventLookup, admitted⟩

/-- **A disabled Subscription never fires.** Fail-closed revocation. -/
theorem disabled_never_fires {ledger after : SubscriptionLedger}
    {subscriptionId eventId target} {subscription : RoutedSubscription}
    (lookup : ledger.subscriptions subscriptionId = some subscription)
    (disabled : subscription.enabled = false) :
    ¬ RoutingStep ledger (.fire subscriptionId eventId target) after := by
  intro step
  cases step with
  | fire lookup' enabled _ _ _ _ =>
      rw [lookup] at lookup'
      rw [Option.some.inj lookup'] at disabled
      rw [disabled] at enabled
      exact Bool.false_ne_true enabled

/-- **Consumption is monotone.** No routing step un-consumes a pair, so at-most-once
    holds along every trace, not just across one step. -/
theorem consumed_is_monotone {ledger after : SubscriptionLedger} {label}
    (step : RoutingStep ledger label after) {subscriptionId key}
    (consumed : ledger.consumed subscriptionId key) :
    after.consumed subscriptionId key := by
  cases step with
  | acceptEvent _ => exact consumed
  | declareSubscription _ => exact consumed
  | disableSubscription _ => exact consumed
  | fire _ _ _ _ _ _ => exact Or.inr consumed

/-- **Disabling retains history.** Revocation keeps the consumed set, so a later
    re-declaration cannot be used to replay already-consumed happenings through the
    same Subscription identity. -/
theorem disable_retains_consumed {ledger after : SubscriptionLedger} {subscriptionId}
    (step : RoutingStep ledger (.disableSubscription subscriptionId) after) :
    ∀ candidate key, ledger.consumed candidate key ↔ after.consumed candidate key := by
  cases step with
  | disableSubscription _ => exact fun _ _ => Iff.rfl

end AgentCore
