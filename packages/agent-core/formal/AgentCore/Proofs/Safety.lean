import AgentCore.Composed
import AgentCore.Representation.Broker
import AgentCore.Representation.Consent
import AgentCore.Representation.Reaction
import AgentCore.Representation.MixtureOfAgents

/-! Consequences of the strengthened component and integrated transition guards. -/

namespace AgentCore

theorem direct_has_no_durable_side_effect {before request after}
    (step : DirectStep before request after) : after = before := direct_admission_is_nondurable step

theorem direct_uses_current_exact_lease {state request}
    (ready : DirectReady state request) : ExactLeaseGate state request.prepared.header request.now :=
  direct_checks_exact_current_incarnation ready

theorem mediated_rechecks_current_authority_path {state request}
    (ready : MediatedReady state request) :
  ∃ resolution,
      state.authority.MediatedResolutionUsable resolution
        request.prepared.header.authority.principal
        request.prepared.header request.scope := by
  obtain ⟨resolution, lookup, usable⟩ := ready.2.2.2.2.2.2
  exact ⟨resolution, usable⟩

theorem approved_execution_uses_persisted_identity {before after approval invocation attempt audit}
    (step : MediatedStep before (.approvalStart approval invocation attempt audit) after) :
    ∃ (prepared : PreparedInvocation) (ticket : ApprovalTicket),
      before.effects.invocations invocation = some prepared ∧
      ticket.invocation = invocation ∧ ticket.identity = prepared.identity := by
  obtain ⟨prepared, ticket, continuation, firstAttempt, firstItem, persisted, lookup,
    exactInvocation, identity, consumed, continuationLookup, firstIdentity, attemptLookup,
    firstInvocation, firstAt, firstKey⟩ :=
    approval_start_consumes_persisted_exact_intent step
  exact ⟨prepared, ticket, persisted, exactInvocation, identity⟩

theorem terminal_batch_is_derived_not_stored {ledger prepared outcomes aggregate}
    (terminal : BatchTerminalOutcome ledger prepared outcomes aggregate) :
    deriveBatchOutcome outcomes = some aggregate := terminal.2.2.1

end AgentCore
