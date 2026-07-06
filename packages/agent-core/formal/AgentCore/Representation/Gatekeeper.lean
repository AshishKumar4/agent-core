import AgentCore.Approvals

/-!
# Representing an approval-gateway platform (the "connected-account gatekeeper" shape)

A gatekeeper platform mediates an agent's access to an external, credential-holding
resource: a connected account (email, GitHub, a bank). The security promises such a
platform must keep are

1. **custody** — the raw credential lives only in a provider-domain session and never
   enters the agent-visible domain, at any reachable state; and
2. **guarded mutation** — an action that changes external state (`applyAction`) may
   only run against an approval bound to that exact action.

This module models the gatekeeper as its own small labeled transition system, states
the two invariants, and proves them. The guarded-mutation proof is a genuine reduction:
it discharges through `AgentCore.ApprovalStep` (SPEC §7.3), so a gatekeeper's action
gate is exactly the spec's approval continuation, not a parallel mechanism.

This is a representation result about the *mechanism*. It does not prove a concrete
gatekeeper provider is correctly implemented; that is a refinement obligation.
-/

namespace AgentCore.Representation.Gatekeeper

/-- A protection domain, as seen by the gatekeeper model. The agent runs in
    `agentDomain`; the credential-holding session runs in `providerDomain`. -/
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

/-- The impact of a resource operation (SPEC §7.1). Observations reveal data; actions
    change external state and are the guarded ones. -/
inductive ResourceImpact where
  | observe
  | applyAction
  deriving DecidableEq, Repr

/-- A gatekeeper state: what each domain currently holds, plus the approval ledger the
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

/-- Gatekeeper transitions.

* `observe` — an authorized observation of the resource. Touches no holdings.
* `requestAction` — the agent asks to mutate; a digest-bound approval ticket is
  opened (this is the consent card). Reduces to `ApprovalStep.request`.
* `applyAction` — the mutation runs. It is gated on an approved, digest-matching
  ticket, discharged through `ApprovalStep.resume`. The credential is *used* inside
  the provider domain; it is never moved into the agent domain. -/
inductive GateStep : GateState → ResourceImpact → GateState → Prop
  | observe {state} :
      GateStep state .observe state
  | requestAction {state ticketId action digest ledger'} :
      ApprovalStep state.ledger (.request ticketId action digest) ledger' →
      GateStep state .applyAction { state with ledger := ledger' }
  | applyAction {state ticketId digest ledger'} :
      ApprovalStep state.ledger (.resume ticketId digest) ledger' →
      GateStep state .applyAction { state with ledger := ledger' }

/-- **Custody is preserved by every gatekeeper step.** No transition moves the raw
    credential into the agent domain. -/
theorem step_preserves_custody {before impact after}
    (custody : Custody before) (step : GateStep before impact after) :
    Custody after := by
  cases step with
  | observe => exact custody
  | requestAction _ => exact custody
  | applyAction _ => exact custody

/-- Reachability from the bootstrap state. -/
inductive Reachable (ledger : ApprovalLedger) : GateState → Prop
  | init : Reachable ledger (initial ledger)
  | step {before impact after} :
      Reachable ledger before → GateStep before impact after → Reachable ledger after

/-- **Custody holds at every reachable state.** The credential is never, on any path,
    in the agent-visible domain — the core promise of a connected-account gatekeeper. -/
theorem reachable_custody {ledger state} (reachable : Reachable ledger state) :
    Custody state := by
  induction reachable with
  | init => exact initial_custody ledger
  | step _ step ih => exact step_preserves_custody ih step

/-- **The action gate reduces to the spec's approval continuation (SPEC §7.3).** An
    `applyAction` that fires through a resume necessarily had an approved ticket whose
    recorded digest matches the digest presented at execution. The gatekeeper's action
    gate is therefore not a parallel mechanism — it *is* the spec's digest-bound
    approval resume. -/
theorem apply_action_gate {before : GateState} {ticketId : Nat} {digest : ArgumentDigest}
    {ledger' : ApprovalLedger}
    (resume : ApprovalStep before.ledger (.resume ticketId digest) ledger') :
    ∃ ticket, before.ledger.tickets ticketId = some ticket ∧
      ticket.phase = .approved ∧ digest = ticket.digest :=
  resume_requires_approved_matching_digest resume

/-- A tampered action can never fire: if the presented digest differs from the
    approved one, no `applyAction` resume step exists. This is the gatekeeper reading
    of §7.3's digest binding — approving one action does not authorize a different
    one. -/
theorem tampered_action_never_fires {before : GateState} {ticketId : Nat}
    {digest : ArgumentDigest} {ledger' : ApprovalLedger} {ticket : ApprovalTicket}
    (lookup : before.ledger.tickets ticketId = some ticket)
    (mismatch : digest ≠ ticket.digest) :
    ¬ ApprovalStep before.ledger (.resume ticketId digest) ledger' :=
  digest_mismatch_never_resumes lookup mismatch

end AgentCore.Representation.Gatekeeper
