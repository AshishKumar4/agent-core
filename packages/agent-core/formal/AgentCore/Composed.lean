import AgentCore.Model
import AgentCore.Approvals
import AgentCore.Scopes

/-!
SPEC v2 §7.3: the composed resume path. Resuming an approved Invocation revalidates
Grant, Binding, lease, revocation epoch, AND the argument digest together. This file
composes the approval-ledger results (Approvals.lean), the authority model
(Model.lean), and the epoch model (Scopes.lean) into one property and proves the
guarantee set it implies — closing the split that AC-APPROVAL-001 records.
-/

namespace AgentCore

/-- Everything SPEC §7.3 requires to hold at resume time, as one property. -/
structure ComposedResumeOk (core : State) (auth : ScopeAuthority) (ledger : ApprovalLedger)
    (ticketId : Nat) (digest : ArgumentDigest)
    (invocation : Invocation) (stamp : ResolutionStamp) : Prop where
  resume : ∃ after, ApprovalStep ledger (.resume ticketId digest) after
  requirements : Invocation.RequirementsSatisfied core invocation
  ready : Invocation.Ready core invocation
  fresh : auth.Fresh stamp

/-- The composed guarantee: a valid resume implies an approved single-use ticket with
    a matching digest, satisfied authorization (a live, well-scoped, chained Grant
    behind the Binding), approval-requirement satisfaction, readiness (a running Turn
    for run-domain invocations), and a fresh revocation stamp. -/
theorem composed_resume_guarantees {core : State} {auth : ScopeAuthority}
    {ledger : ApprovalLedger} {ticketId : Nat} {digest : ArgumentDigest}
    {invocation : Invocation} {stamp : ResolutionStamp}
    (ok : ComposedResumeOk core auth ledger ticketId digest invocation stamp) :
    (∃ ticket, ledger.tickets ticketId = some ticket ∧
       ticket.phase = .approved ∧ digest = ticket.digest) ∧
    Invocation.AuthorizationSatisfied core invocation ∧
    Invocation.ApprovalSatisfied core invocation ∧
    Invocation.Ready core invocation ∧
    stamp.epoch = auth.epoch stamp.scope := by
  obtain ⟨after, step⟩ := ok.resume
  have requirements := ok.requirements
  unfold Invocation.RequirementsSatisfied at requirements
  exact ⟨resume_requires_approved_matching_digest step,
    requirements.1, requirements.2, ok.ready, ok.fresh⟩

/-- Revoking the stamp's scope blocks the composed resume: the epoch check fails
    (SPEC §3.4 rule 5 deadline (b) — mediated resume revalidates on the durable
    path). -/
theorem revocation_blocks_composed_resume {core : State} {auth : ScopeAuthority}
    {ledger : ApprovalLedger} {ticketId : Nat} {digest : ArgumentDigest}
    {invocation : Invocation} {stamp : ResolutionStamp}
    (fresh : auth.Fresh stamp) :
    ¬ ComposedResumeOk core (auth.bumpEpoch stamp.scope) ledger
        ticketId digest invocation stamp :=
  fun ok => ScopeAuthority.bump_stales_stamp fresh ok.fresh

/-- A digest mismatch blocks the composed resume (SPEC §7.3). -/
theorem digest_mismatch_blocks_composed_resume
    {core : State} {auth : ScopeAuthority} {ledger : ApprovalLedger} {ticketId : Nat}
    {digest : ArgumentDigest} {invocation : Invocation} {stamp : ResolutionStamp}
    {ticket : ApprovalTicket}
    (lookup : ledger.tickets ticketId = some ticket)
    (mismatch : digest ≠ ticket.digest) :
    ¬ ComposedResumeOk core auth ledger ticketId digest invocation stamp :=
  fun ok => by
    obtain ⟨after, step⟩ := ok.resume
    exact digest_mismatch_never_resumes lookup mismatch step

/-- A consumed (already-resumed) ticket blocks the composed resume: single use holds
    for the composed path (SPEC §7.3). -/
theorem consumed_blocks_composed_resume
    {core : State} {auth : ScopeAuthority} {ledger : ApprovalLedger} {ticketId : Nat}
    {digest : ArgumentDigest} {invocation : Invocation} {stamp : ResolutionStamp}
    {ticket : ApprovalTicket}
    (lookup : ledger.tickets ticketId = some ticket)
    (consumed : ticket.phase = .consumed) :
    ¬ ComposedResumeOk core auth ledger ticketId digest invocation stamp :=
  fun ok => by
    obtain ⟨after, step⟩ := ok.resume
    exact unapproved_never_resumes lookup
      (by rw [consumed]; intro h; cases h) step

/-- A denied ticket blocks the composed resume (SPEC §7.3). -/
theorem denied_blocks_composed_resume
    {core : State} {auth : ScopeAuthority} {ledger : ApprovalLedger} {ticketId : Nat}
    {digest : ArgumentDigest} {invocation : Invocation} {stamp : ResolutionStamp}
    {ticket : ApprovalTicket}
    (lookup : ledger.tickets ticketId = some ticket)
    (denied : ticket.phase = .denied) :
    ¬ ComposedResumeOk core auth ledger ticketId digest invocation stamp :=
  fun ok => by
    obtain ⟨after, step⟩ := ok.resume
    exact denied_never_resumes lookup denied step

end AgentCore
