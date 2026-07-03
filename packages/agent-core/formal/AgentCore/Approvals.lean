import AgentCore.Model

/-!
SPEC v2 §7.3: the approval continuation. An Approval is digest-bound, single-use,
and survives process death; resuming revalidates the argument digest against the
approved digest before execution.

This file models the approval ledger as its own small labeled transition system and
proves the continuation contract: resume requires an approved ticket with a matching
digest; denied tickets never execute; and once a ticket is consumed, no later step in
any trace can resume it again (single use).
-/

namespace AgentCore

structure ArgumentDigest where
  value : Nat
  deriving DecidableEq, Repr

inductive ApprovalPhase where
  | pending | approved | denied | consumed
  deriving DecidableEq, Repr

structure ApprovalTicket where
  invocation : Nat
  digest : ArgumentDigest
  phase : ApprovalPhase
  deriving DecidableEq, Repr

structure ApprovalLedger where
  tickets : Nat → Option ApprovalTicket

def ApprovalLedger.set (ledger : ApprovalLedger) (id : Nat) (ticket : ApprovalTicket) :
    ApprovalLedger :=
  ⟨fun candidate => if candidate = id then some ticket else ledger.tickets candidate⟩

theorem ApprovalLedger.set_lookup (ledger : ApprovalLedger) (id target : Nat)
    (ticket : ApprovalTicket) :
    (ledger.set id ticket).tickets target =
      if target = id then some ticket else ledger.tickets target := rfl

inductive ApprovalLabel where
  | request (id : Nat) (invocation : Nat) (digest : ArgumentDigest)
  | approve (id : Nat)
  | deny (id : Nat)
  /-- Resuming executes the approved invocation with `digest` as the argument digest
      presented at execution time (SPEC §7.3 revalidation). -/
  | resume (id : Nat) (digest : ArgumentDigest)
  deriving DecidableEq, Repr

inductive ApprovalStep : ApprovalLedger → ApprovalLabel → ApprovalLedger → Prop
  | request {ledger id invocation digest} :
      ledger.tickets id = none →
      ApprovalStep ledger (.request id invocation digest)
        (ledger.set id ⟨invocation, digest, .pending⟩)
  | approve {ledger id ticket} :
      ledger.tickets id = some ticket →
      ticket.phase = .pending →
      ApprovalStep ledger (.approve id) (ledger.set id { ticket with phase := .approved })
  | deny {ledger id ticket} :
      ledger.tickets id = some ticket →
      ticket.phase = .pending →
      ApprovalStep ledger (.deny id) (ledger.set id { ticket with phase := .denied })
  | resume {ledger id ticket digest} :
      ledger.tickets id = some ticket →
      ticket.phase = .approved →
      digest = ticket.digest →
      ApprovalStep ledger (.resume id digest) (ledger.set id { ticket with phase := .consumed })

inductive ApprovalExec : ApprovalLedger → List ApprovalLabel → ApprovalLedger → Prop
  | nil (ledger) : ApprovalExec ledger [] ledger
  | cons {start middle finish label labels} :
      ApprovalStep start label middle →
      ApprovalExec middle labels finish →
      ApprovalExec start (label :: labels) finish

/-- SPEC §7.3: resuming requires an approved ticket whose recorded digest matches the
    digest presented at execution time. -/
theorem resume_requires_approved_matching_digest {ledger after id digest}
    (step : ApprovalStep ledger (.resume id digest) after) :
    ∃ ticket, ledger.tickets id = some ticket ∧
      ticket.phase = .approved ∧ digest = ticket.digest := by
  cases step with
  | resume lookup phase digestEq => exact ⟨_, lookup, phase, digestEq⟩

/-- A digest mismatch can never execute: no resume step exists for a presented digest
    different from the approved one. -/
theorem digest_mismatch_never_resumes {ledger after id ticket digest}
    (lookup : ledger.tickets id = some ticket)
    (mismatch : digest ≠ ticket.digest) :
    ¬ ApprovalStep ledger (.resume id digest) after := by
  intro step
  cases step with
  | resume lookup' _ digestEq =>
      rw [lookup] at lookup'
      injection lookup' with eq
      subst eq
      exact mismatch digestEq

/-- Only approved tickets can resume: any non-approved phase blocks execution. This
    subsumes SPEC §7.3's "denial produces a denied Receipt, never an execution" and
    the single-use consumed case. -/
theorem unapproved_never_resumes {ledger after id ticket digest}
    (lookup : ledger.tickets id = some ticket)
    (unapproved : ticket.phase ≠ .approved) :
    ¬ ApprovalStep ledger (.resume id digest) after := by
  intro step
  cases step with
  | resume lookup' phase _ =>
      rw [lookup] at lookup'
      injection lookup' with eq
      subst eq
      exact unapproved phase

/-- Denied approvals never execute. -/
theorem denied_never_resumes {ledger after id ticket digest}
    (lookup : ledger.tickets id = some ticket)
    (denied : ticket.phase = .denied) :
    ¬ ApprovalStep ledger (.resume id digest) after :=
  unapproved_never_resumes lookup (by rw [denied]; intro h; cases h)

/-- Once consumed, a ticket stays consumed across every step. -/
theorem consumed_stable {ledger after label id ticket}
    (step : ApprovalStep ledger label after)
    (lookup : ledger.tickets id = some ticket)
    (consumed : ticket.phase = .consumed) :
    ∃ ticket', after.tickets id = some ticket' ∧ ticket'.phase = .consumed := by
  cases step with
  | @request id' _ _ empty =>
      refine ⟨ticket, ?_, consumed⟩
      rw [ApprovalLedger.set_lookup]
      split
      · next eq => rw [eq] at lookup; rw [lookup] at empty; cases empty
      · exact lookup
  | @approve id' ticket' lookup' pending =>
      refine ⟨ticket, ?_, consumed⟩
      rw [ApprovalLedger.set_lookup]
      split
      · next eq =>
          rw [eq] at lookup
          rw [lookup] at lookup'
          injection lookup' with eq'
          subst eq'
          rw [consumed] at pending
          cases pending
      · exact lookup
  | @deny id' ticket' lookup' pending =>
      refine ⟨ticket, ?_, consumed⟩
      rw [ApprovalLedger.set_lookup]
      split
      · next eq =>
          rw [eq] at lookup
          rw [lookup] at lookup'
          injection lookup' with eq'
          subst eq'
          rw [consumed] at pending
          cases pending
      · exact lookup
  | @resume id' ticket' _ lookup' approved _ =>
      refine ⟨ticket, ?_, consumed⟩
      rw [ApprovalLedger.set_lookup]
      split
      · next eq =>
          rw [eq] at lookup
          rw [lookup] at lookup'
          injection lookup' with eq'
          subst eq'
          rw [consumed] at approved
          cases approved
      · exact lookup

/-- No trace starting from a consumed ticket ever resumes it again. -/
theorem no_resume_when_consumed {ledger labels finish id}
    (exec : ApprovalExec ledger labels finish) :
    ∀ ticket, ledger.tickets id = some ticket → ticket.phase = .consumed →
      ∀ digest, ApprovalLabel.resume id digest ∉ labels := by
  induction exec with
  | nil => intro ticket _ _ digest mem; cases mem
  | @cons start middle finish label labels step _ ih =>
      intro ticket lookup consumed digest mem
      cases mem with
      | head =>
          exact unapproved_never_resumes lookup
            (by rw [consumed]; intro h; cases h) step
      | tail _ rest =>
          obtain ⟨ticket', lookup', consumed'⟩ := consumed_stable step lookup consumed
          exact ih ticket' lookup' consumed' digest rest

/-- SPEC §7.3 single use: after a resume executes, no later step in the trace can
    resume the same approval again. -/
theorem approval_single_use {ledger middle finish id digest labels}
    (step : ApprovalStep ledger (.resume id digest) middle)
    (exec : ApprovalExec middle labels finish) :
    ∀ digest', ApprovalLabel.resume id digest' ∉ labels := by
  cases step with
  | @resume _ ticket _ lookup _ _ =>
      have lookup' : (ledger.set id { ticket with phase := .consumed }).tickets id
          = some { ticket with phase := .consumed } := by
        rw [ApprovalLedger.set_lookup]
        simp
      intro digest'
      exact no_resume_when_consumed exec _ lookup' rfl digest'

end AgentCore
