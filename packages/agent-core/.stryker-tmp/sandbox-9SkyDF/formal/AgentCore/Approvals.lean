import AgentCore.Lease

/-! Approval owns decision state only; execution consumption remains composed. -/

namespace AgentCore

inductive ApprovalPhase where | pending | approved | denied | expired deriving DecidableEq, Repr

structure ApprovalTicket where
  invocation : InvocationId
  identity : InvocationIdentity
  digest : InvocationDigest
  approver : PrincipalId
  expiresAt : Time
  phase : ApprovalPhase
  deriving DecidableEq, Repr

structure ApprovalContinuation where
  approval : ApprovalId
  invocation : InvocationId
  identity : InvocationIdentity
  digest : InvocationDigest
  firstAttempt : AttemptId
  deriving DecidableEq, Repr

structure ApprovalLedger where
  tickets : ApprovalId → Option ApprovalTicket
  approvalFor : InvocationId → Option ApprovalId
  consumedBy : ApprovalId → Option InvocationId
  continuations : InvocationId → Option ApprovalContinuation

instance : Inhabited ApprovalLedger where
  default := ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none⟩

def ApprovalLedger.setTicket (ledger : ApprovalLedger) (id : ApprovalId)
    (ticket : ApprovalTicket) : ApprovalLedger :=
  { ledger with
    tickets := tableSet ledger.tickets id ticket
    approvalFor := tableSet ledger.approvalFor ticket.invocation id }

def ApprovalLedger.consume (ledger : ApprovalLedger) (id : ApprovalId)
    (prepared : PreparedInvocation) (firstAttempt : AttemptId) : ApprovalLedger :=
  { ledger with
    consumedBy := tableSet ledger.consumedBy id prepared.header.invocation
    continuations := tableSet ledger.continuations prepared.header.invocation
      ⟨id, prepared.header.invocation, prepared.identity, prepared.digest, firstAttempt⟩ }

inductive ApprovalLabel where
  | request (id : ApprovalId) | approve (id : ApprovalId) (approver : PrincipalId) (now : Time)
  | deny (id : ApprovalId) (approver : PrincipalId) | expire (id : ApprovalId) (now : Time)
  deriving DecidableEq, Repr

inductive ApprovalStep : ApprovalLedger → ApprovalLabel → ApprovalLedger → Prop
  | request {ledger id ticket} :
      ledger.tickets id = none → ledger.approvalFor ticket.invocation = none →
      ledger.continuations ticket.invocation = none → ticket.phase = .pending →
      ApprovalStep ledger (.request id) (ledger.setTicket id ticket)
  | approve {ledger id ticket approver now} :
      ledger.tickets id = some ticket → ticket.phase = .pending →
      ticket.approver = approver → now.tick < ticket.expiresAt.tick →
      ApprovalStep ledger (.approve id approver now)
        (ledger.setTicket id { ticket with phase := .approved })
  | deny {ledger id ticket approver} :
      ledger.tickets id = some ticket → ticket.phase = .pending → ticket.approver = approver →
      ApprovalStep ledger (.deny id approver) (ledger.setTicket id { ticket with phase := .denied })
  | expire {ledger id ticket now} :
      ledger.tickets id = some ticket →
      (ticket.phase = .pending ∨ ticket.phase = .approved) → ticket.expiresAt.tick ≤ now.tick →
      ApprovalStep ledger (.expire id now) (ledger.setTicket id { ticket with phase := .expired })

def ApprovalLedger.Available (ledger : ApprovalLedger) (id : ApprovalId)
    (prepared : PreparedInvocation) (now : Time) : Prop :=
  ∃ ticket, ledger.tickets id = some ticket ∧ ticket.phase = .approved ∧
    ticket.invocation = prepared.header.invocation ∧ ticket.identity = prepared.identity ∧
    ticket.digest = prepared.digest ∧ now.tick < ticket.expiresAt.tick ∧
    ledger.approvalFor prepared.header.invocation = some id ∧
    ledger.consumedBy id = none ∧ ledger.continuations prepared.header.invocation = none

theorem approval_available_is_exact {ledger : ApprovalLedger} {id prepared now}
    (available : ledger.Available id prepared now) :
    ∃ ticket, ledger.tickets id = some ticket ∧
      ticket.invocation = prepared.header.invocation ∧ ticket.identity = prepared.identity ∧
      ticket.digest = prepared.digest := by
  obtain ⟨ticket, lookup, approved, invocation, identity, digest, live, unique, unused,
    absent⟩ := available
  exact ⟨ticket, lookup, invocation, identity, digest⟩

theorem approval_available_binds_authority_principal {ledger : ApprovalLedger}
    {id prepared now} (available : ledger.Available id prepared now) :
    ∃ ticket, ledger.tickets id = some ticket ∧
      ticket.identity.header.authority.principal = prepared.header.authority.principal := by
  obtain ⟨ticket, lookup, approved, invocation, identity, digest, live, unique, unused,
    absent⟩ := available
  exact ⟨ticket, lookup, by rw [identity]; rfl⟩

theorem consumed_approval_unavailable {ledger : ApprovalLedger} {id prepared now invocation}
    (consumed : ledger.consumedBy id = some invocation) : ¬ ledger.Available id prepared now := by
  intro available
  obtain ⟨ticket, lookup, approved, exactInvocation, identity, digest, live, unique, unused,
    absent⟩ := available
  rw [consumed] at unused
  contradiction

def ApprovalLedger.Continues (ledger : ApprovalLedger) (id : ApprovalId)
    (prepared : PreparedInvocation) : Prop :=
  ∃ continuation,
    ledger.consumedBy id = some prepared.header.invocation ∧
    ledger.continuations prepared.header.invocation = some continuation ∧
    continuation.approval = id ∧ continuation.invocation = prepared.header.invocation ∧
    continuation.identity = prepared.identity ∧ continuation.digest = prepared.digest

theorem approval_continuation_is_exact {ledger : ApprovalLedger} {id prepared}
    (continues : ledger.Continues id prepared) :
    ∃ continuation,
      ledger.continuations prepared.header.invocation = some continuation ∧
      continuation.approval = id ∧ continuation.invocation = prepared.header.invocation ∧
      continuation.identity = prepared.identity ∧ continuation.digest = prepared.digest := by
  obtain ⟨continuation, consumed, lookup, approval, invocation, identity, digest⟩ := continues
  exact ⟨continuation, lookup, approval, invocation, identity, digest⟩

theorem approval_is_unique_per_invocation {ledger : ApprovalLedger} {invocation first second}
    (firstLookup : ledger.approvalFor invocation = some first)
    (secondLookup : ledger.approvalFor invocation = some second) : first = second := by
  rw [firstLookup] at secondLookup
  exact Option.some.inj secondLookup

theorem approval_available_has_no_continuation {ledger : ApprovalLedger} {id prepared now}
    (available : ledger.Available id prepared now) :
    ledger.continuations prepared.header.invocation = none := by
  obtain ⟨ticket, lookup, approved, invocation, identity, digest, live, unique, unused,
    absent⟩ := available
  exact absent

end AgentCore
