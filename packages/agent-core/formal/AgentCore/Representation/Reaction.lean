import AgentCore.Subscriptions
import AgentCore.Lease

/-!
# Representing a reaction system (the unified-inbox / mid-turn-injection shape)

A reaction platform treats every input the same way: a chat message, an email, a
schedule firing, and a sandbox completion callback all become Events, and a routing
layer decides whether each starts a new run, starts a reaction turn in an existing run,
or is delivered mid-turn into a running turn's inbox. The promises are

1. **at-most-once reaction** — a given (Subscription, event key) reacts at most once,
   even under at-least-once delivery;
2. **derived reaction identity** — an Event decides *whether* something runs, never
   *what* runs: the fired target is the Subscription's declared invocation; and
3. **lease-fenced mid-turn delivery** — an event injected into a running turn is
   accepted only under the turn's current lease incarnation, so a stale executor
   cannot inject.

All three discharge through existing core modules: routing is `RoutingStep` with
consumed-key dedup (SPEC §6.2), and mid-turn delivery is admission under
`TurnLease.Admits` (SPEC §5.3). The reaction system is the core Event/Subscription
mechanism, not a new one.
-/

namespace AgentCore.Representation.Reaction

open AgentCore

/-- The routing decision a reaction system makes for an eligible event: start a fresh
    run, start a reaction turn in an existing run, or deliver into a running turn's
    inbox. Every branch drives the same firing step, so all three inherit the same
    dedup, targeting, and trust guarantees. -/
inductive Route where
  | startRun
  | reactionTurn
  | deliverMidTurn
  deriving DecidableEq, Repr

/-- **At-most-once reaction.** Once a Subscription has consumed an event key, it cannot
    fire again for that key, no matter how many times the happening is redelivered —
    under the same EventId or a fresh one carrying the same cause identity. -/
theorem reaction_at_most_once {ledger after : SubscriptionLedger}
    {subscriptionId eventId target} {event : RoutedEvent}
    (lookup : ledger.events eventId = some event)
    (consumed : ledger.consumed subscriptionId event.key) :
    ¬ RoutingStep ledger (.fire subscriptionId eventId target) after :=
  consumed_key_never_refires lookup consumed

/-- **A reaction fires the declared target.** The invocation identity a firing carries
    is the one stored on the Subscription at declaration — an inbound email cannot
    steer the reaction at a different Operation (SPEC §6.2). -/
theorem reaction_targets_declared {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ subscription, ledger.subscriptions subscriptionId = some subscription ∧
      subscription.enabled = true ∧ target = subscription.target :=
  fire_targets_declared step

/-- **A reaction consumes its event key.** After an accepted firing the key was
    previously unconsumed and is now consumed — which is what makes
    `reaction_at_most_once` bite on the next redelivery. -/
theorem reaction_consumes_key {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ event, ledger.events eventId = some event ∧
      ¬ ledger.consumed subscriptionId event.key ∧
      after.consumed subscriptionId event.key :=
  fire_consumes_key step

/-- **Reaction trust is channel-derived.** The tier the Subscription's filter admitted
    is derived from the Event's provenance, never asserted by the sender — an external
    email cannot claim owner trust to reach an owner-only reaction (SPEC §6.1). -/
theorem reaction_trust_is_channel_derived {ledger after : SubscriptionLedger}
    {subscriptionId eventId target}
    (step : RoutingStep ledger (.fire subscriptionId eventId target) after) :
    ∃ subscription event,
      ledger.subscriptions subscriptionId = some subscription ∧
      ledger.events eventId = some event ∧
      subscription.admits (deriveChannelTrust event.channel) = true :=
  fire_admits_channel_trust step

/-!
## Mid-turn delivery is lease-fenced (SPEC §5.3)

A reaction routed as `deliverMidTurn` appends the event into a running turn's inbox.
In the core model that append is admitted through the turn's lease, and admission
carries the current incarnation: `TurnLease.Admits` requires the presenting token to
name the same turn, the same holder, and the *current* epoch, inside the expiry window.
The three rejection theorems below are the injection-safety reading of the lease
algebra — each is the core theorem, re-stated at the reaction seam.
-/

/-- **A stale executor cannot inject.** A token minted under a previous lease epoch is
    refused at admission, so an executor that lost its lease cannot deliver into the
    turn it no longer owns. -/
theorem stale_injection_rejected {lease : TurnLease} {token : LeaseToken} {now : Time}
    (stale : token.epoch ≠ lease.epoch) :
    ¬ lease.Admits token now :=
  fun admitted => stale admitted.2.2.1

/-- **A wrong-turn token cannot inject.** Mid-turn delivery is addressed: a token for
    one turn is refused at any other turn's inbox. -/
theorem wrong_turn_injection_rejected {lease : TurnLease} {token : LeaseToken} {now : Time}
    (wrong : token.turn ≠ lease.turn) :
    ¬ lease.Admits token now :=
  wrong_turn_rejects wrong

/-- **An expired lease cannot inject.** Past the lease window, delivery requires a
    reclaim first — which bumps the epoch and stales every outstanding token. -/
theorem expired_injection_rejected {lease : TurnLease} {token : LeaseToken} {now : Time}
    (expired : lease.expiresAt.tick ≤ now.tick) :
    ¬ lease.Admits token now :=
  expired_lease_rejects expired

end AgentCore.Representation.Reaction
