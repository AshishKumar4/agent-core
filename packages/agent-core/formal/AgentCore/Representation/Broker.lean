import AgentCore.Approvals

/-!
# Representing an approval-gateway platform (the connected-account broker shape)

A broker platform mediates an agent's access to an external, credential-holding
resource: a connected account (email, GitHub, a bank). The security promises such a
platform must keep are

1. **custody** — the raw credential lives only in a provider-domain session and never
   enters the agent-visible domain, at any reachable state; and
2. **guarded mutation** — an action that changes external state may only run against a
   live approval bound to that exact invocation, identity, and argument digest.

This module models the broker as its own small labeled transition system and reduces
its action gate to the core approval ledger (SPEC §7.3): requesting an action opens a
pending ticket through `ApprovalStep.request`, and applying an action is admissible
exactly when `ApprovalLedger.Available` holds — the same predicate the composed
mediated pipeline consumes through. The broker's gate is therefore not a parallel
mechanism; it *is* the spec's digest-bound approval availability.

This is a representation result about the mechanism. It does not prove any concrete
broker provider is correctly implemented; that is a refinement obligation.
-/

namespace AgentCore.Representation.Broker

open AgentCore

/-- A protection domain, as the broker model sees it. The agent runs in `agentDomain`;
    the credential-holding session runs in `providerDomain`. -/
inductive Domain where
  | agentDomain
  | providerDomain
  deriving DecidableEq, Repr

/-- What the platform holds in a domain: an opaque capability stub, or the raw
    credential itself. Custody means the credential is only ever in the provider
    domain. -/
inductive Holding where
  | stub
  | rawCredential
  deriving DecidableEq, Repr

/-- A broker state: what each domain currently holds, plus the approval ledger the
    action gate consults. -/
structure GateState where
  holds : Domain → Holding
  ledger : ApprovalLedger

/-- Custody, as a predicate on a state: the agent domain never holds the raw
    credential. -/
def Custody (state : GateState) : Prop :=
  state.holds .agentDomain = .stub

/-- The initial state a platform bootstraps into: the credential sits in the provider
    domain, the agent holds only a stub. -/
def initial (ledger : ApprovalLedger) : GateState :=
  { holds := fun domain => match domain with
      | .agentDomain => .stub
      | .providerDomain => .rawCredential
    ledger := ledger }

theorem initial_custody (ledger : ApprovalLedger) : Custody (initial ledger) := rfl

/-- Broker transitions.

* `observe` — an authorized observation of the resource. Touches no holdings and no
  approval state.
* `requestAction` — the agent asks to mutate; a digest-bound pending ticket opens.
  Reduces to `ApprovalStep.request` (SPEC §7.3).
* `decide` — the approver approves, denies, or a ticket expires: any non-request
  `ApprovalStep`. Holdings are untouched.
* `applyAction` — the mutation runs against a live approval: `Available` binds the
  ticket to the exact prepared invocation (identity and digest) and consumption marks
  it used. The credential is *used* inside the provider domain; no transition moves it
  into the agent domain. -/
inductive GateStep : GateState → GateState → Prop
  | observe {state} :
      GateStep state state
  | requestAction {state id ledger'} :
      ApprovalStep state.ledger (.request id) ledger' →
      GateStep state { state with ledger := ledger' }
  | decide {state label ledger'} :
      (∀ id, label ≠ ApprovalLabel.request id) →
      ApprovalStep state.ledger label ledger' →
      GateStep state { state with ledger := ledger' }
  | applyAction {state id attempt} {prepared : PreparedInvocation} {now : Time} :
      state.ledger.Available id prepared now →
      GateStep state { state with ledger := state.ledger.consume id prepared attempt }

/-- **Custody is preserved by every broker step.** No transition moves the raw
    credential into the agent domain. -/
theorem step_preserves_custody {before after}
    (custody : Custody before) (step : GateStep before after) :
    Custody after := by
  cases step with
  | observe => exact custody
  | requestAction _ => exact custody
  | decide _ _ => exact custody
  | applyAction _ => exact custody

/-- Reachability from the bootstrap state. -/
inductive Reachable (ledger : ApprovalLedger) : GateState → Prop
  | init : Reachable ledger (initial ledger)
  | step {before after} :
      Reachable ledger before → GateStep before after → Reachable ledger after

/-- **Custody holds at every reachable state.** The credential is never, on any path,
    in the agent-visible domain — the core promise of a connected-account broker. -/
theorem reachable_custody {ledger state} (reachable : Reachable ledger state) :
    Custody state := by
  induction reachable with
  | init => exact initial_custody ledger
  | step _ step ih => exact step_preserves_custody ih step

/-- **The action gate is the spec's approval availability (SPEC §7.3).** An
    `applyAction` admissible in a state necessarily has an approved, unexpired,
    unconsumed ticket bound to the exact invocation, identity, and argument digest it
    executes with. -/
theorem apply_action_gate {state : GateState} {id : ApprovalId}
    {prepared : PreparedInvocation} {now : Time}
    (available : state.ledger.Available id prepared now) :
    ∃ ticket, state.ledger.tickets id = some ticket ∧
      ticket.phase = .approved ∧
      ticket.invocation = prepared.header.invocation ∧
      ticket.identity = prepared.identity ∧
      ticket.digest = prepared.digest := by
  obtain ⟨ticket, lookup, approved, invocation, identity, digest, live, unique, unused,
    absent⟩ := available
  exact ⟨ticket, lookup, approved, invocation, identity, digest⟩

/-- **A tampered action can never fire.** If the prepared digest differs from the
    approved ticket's digest, `Available` cannot hold — approving one action does not
    authorize a different one. -/
theorem tampered_action_never_fires {state : GateState} {id : ApprovalId}
    {prepared : PreparedInvocation} {now : Time} {ticket : ApprovalTicket}
    (lookup : state.ledger.tickets id = some ticket)
    (mismatch : prepared.digest ≠ ticket.digest) :
    ¬ state.ledger.Available id prepared now := by
  intro available
  obtain ⟨candidate, lookup', _, _, _, digest, _, _, _, _⟩ := available
  rw [lookup] at lookup'
  exact mismatch (Option.some.inj lookup' ▸ digest).symm

/-- **A consumed approval cannot fire again.** Single-use at the ledger: once consumed
    for an invocation, availability is gone (`consumed_approval_unavailable`), so the
    broker cannot run the same external mutation twice off one approval. -/
theorem consumed_action_never_refires {state : GateState} {id : ApprovalId}
    {prepared : PreparedInvocation} {now : Time} {invocation : InvocationId}
    (consumed : state.ledger.consumedBy id = some invocation) :
    ¬ state.ledger.Available id prepared now :=
  consumed_approval_unavailable consumed

/-- **An expired ticket cannot fire.** Availability requires `now` strictly inside the
    approval window, so a broker action presented after expiry is refused. -/
theorem expired_action_never_fires {state : GateState} {id : ApprovalId}
    {prepared : PreparedInvocation} {now : Time} {ticket : ApprovalTicket}
    (lookup : state.ledger.tickets id = some ticket)
    (expired : ticket.expiresAt.tick ≤ now.tick) :
    ¬ state.ledger.Available id prepared now := by
  intro available
  obtain ⟨candidate, lookup', _, _, _, _, live, _, _, _⟩ := available
  rw [lookup] at lookup'
  rw [Option.some.inj lookup'] at expired
  exact Nat.lt_irrefl _ (Nat.lt_of_lt_of_le live expired)

end AgentCore.Representation.Broker
