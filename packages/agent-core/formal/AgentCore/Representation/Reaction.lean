import AgentCore.Model
import AgentCore.Proofs.Safety

/-!
# Representing a reaction system (the unified-inbox / mid-turn-injection shape)

A reaction platform treats every input the same way: a chat message, an email, a
schedule firing, and a sandbox completion callback all become events, and a routing
layer decides whether each starts a new run, starts a reaction turn in an existing run,
or is delivered mid-turn into a running turn's inbox. The promises are

1. **at-most-once reaction** — a given (subscription, event-key) reacts at most once,
   even under at-least-once delivery; and
2. **lease-fenced mid-turn delivery** — an event injected into a running turn is
   accepted only under the turn's current lease epoch, so a stale executor cannot
   inject.

Both discharge through the existing core model: routing is `AgentCore`'s subscription
firing with `consumeEvent` dedup (SPEC §6.2), and mid-turn delivery is a lease-fenced
turn commit (SPEC §5.3). The reaction system is therefore the core Event/Subscription
mechanism, not a new one.
-/

namespace AgentCore.Representation.Reaction

/-- The routing decision a reaction system makes for an eligible event: start a fresh
    run, start a reaction turn in an existing run, or deliver into a running turn's
    inbox. Every branch ultimately drives the same executor, so all three inherit the
    same authorization and dedup guarantees. -/
inductive Route where
  | startRun
  | reactionTurn
  | deliverMidTurn
  deriving DecidableEq, Repr

/-- **At-most-once reaction.** Once a subscription has consumed an event key, it cannot
    fire again for that key, no matter how many times the event is redelivered. This is
    exactly the core dedup guarantee (SPEC §6.2), read as the reaction system's
    idempotency promise under at-least-once transport. -/
theorem reaction_at_most_once
    {state after : State} {subscriptionId : SubscriptionId} {eventId : EventId}
    {event : Event} {receipt : Receipt}
    (lookupEvent : state.events eventId = some event)
    (consumed : state.consumedEvents subscriptionId event.key) :
    ¬ Step state (.fireSubscription subscriptionId eventId receipt) .accepted after :=
  consumed_event_blocks_subscription_fire lookupEvent consumed

/-- **A reaction fires under authorization.** An accepted routing step delivers to the
    subscription's declared target under satisfied authorization — routing cannot
    invent a target or bypass the authority requirement. This is the reaction reading
    of `subscription_invocation_satisfies_authorization` (SPEC §6.2). -/
theorem reaction_routes_authorized
    {state after : State} {subscriptionId : SubscriptionId} {eventId : EventId}
    {receipt : Receipt}
    (step : Step state (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    Invocation.AuthorizationSatisfied state receipt.invocation :=
  subscription_invocation_satisfies_authorization step

/-- **A reaction consumes its event key.** After an accepted firing, the event was
    previously unconsumed and is now consumed, which is what makes
    `reaction_at_most_once` bite on the next redelivery. -/
theorem reaction_consumes_key
    {state after : State} {subscriptionId : SubscriptionId} {eventId : EventId}
    {receipt : Receipt}
    (step : Step state (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    ∃ event, state.events eventId = some event ∧
      ¬ state.consumedEvents subscriptionId event.key ∧
      after.consumedEvents subscriptionId event.key :=
  subscription_fire_consumes_event_key step

/-!
## Mid-turn delivery is lease-fenced

A reaction routed as `deliverMidTurn` appends the event to a running turn's inbox. In
the core model this is a turn commit, and every turn commit carries the current lease
epoch: a commit under a stale epoch is rejected at the owning actor
(`run_invocation_requires_running_turn` and the lease algebra of SPEC §5.3). So an
injection from a stale executor cannot land. The lease guarantee is proven in the core
Run/Turn model; the reaction system inherits it by construction, since mid-turn
delivery is an ordinary lease-fenced commit rather than a side channel.
-/

end AgentCore.Representation.Reaction
