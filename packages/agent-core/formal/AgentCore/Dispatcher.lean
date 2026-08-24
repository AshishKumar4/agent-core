import AgentCore.Lease

/-!
# The command protocol dispatcher (SPEC §8.5)

Every protocol command — the Grant, Binding, RouteReservation, RunPins migration,
PreparedInvocation, Approval consumption, EffectAttempt, Receipt, and AuditRecord append
families — crosses one dispatcher that enforces the envelope in a fixed gate order:
decode/shape, authenticate the exact caller, duplicate lookup on `(caller,
idempotencyKey)`, authority, lifecycle, expected revision, an optional LeaseToken, then
mutation. This module is generic over the family-specific domain state `σ` and its
authority/lifecycle/revision decisions — those stay concrete per family (out of scope
here, `NC-PROTOCOL-DISPATCHER`) — while proving the two structural promises that hold
for every family:

* **duplicate-never-mutates.** A resubmitted `(caller, idempotencyKey)` never runs
  authority, lifecycle, revision, or lease gates again and never invokes the family's
  mutation; it produces evidence only.
* **exactly one linked WriteRecord and AuditRecord per request.** Every request —
  malformed, rejected at any gate, duplicate, or committed — appends exactly one fresh
  `WriteRecord` and exactly one fresh audit id, bijectively linked, in the same
  transition as the decision.

`dispatchExec` is the computable mirror of `DispatchStep`, proven sound and complete,
following the `leaseStepExec` pattern: every gate decision is a `Bool`-valued policy
function, so the relation and the executable step agree by construction, not by
convenient definition.

The dispatcher-created audit id is deliberately uninterpreted here: `AC-AUDIT-001`
already proves the typed causal-chain rules (`LocalCauseValid`, `CauseChainValid`) for
the invocation-mediation `AuditKind` family. Threading a protocol-command `write` root
through that same typed chain — enumerating which parent kinds may cause which command
family — is future work; this module proves the id-linkage and atomicity §8.5 states
without asserting the typed-cause content of that link.
-/

namespace AgentCore

structure WriteRecordId where value : Nat deriving DecidableEq, Repr

inductive CommandCaller where
  | principal (ref : PrincipalRef)
  | actor (ref : ActorRef)
  deriving DecidableEq, Repr

/-- The §8.5 duplicate-lookup identity: exact caller plus idempotency key. -/
structure CommandIdentity where
  caller : CommandCaller
  idempotencyKey : String
  deriving DecidableEq, Repr

inductive LeaseRequirement where | required | optional | forbidden deriving DecidableEq, Repr

/-- The raw submitted bytes, reduced to their digest — decode may fail before any
    envelope exists, but the digest is always computable from what was submitted. -/
structure RawEnvelope where
  digest : StructuralDigest
  deriving DecidableEq, Repr

structure CommandEnvelope where
  command : String
  caller : CommandCaller
  idempotencyKey : String
  expectedRevision : Option Nat
  lease : Option LeaseToken
  callerCause : Option AuditId
  deriving DecidableEq, Repr

def CommandEnvelope.identity (envelope : CommandEnvelope) : CommandIdentity :=
  ⟨envelope.caller, envelope.idempotencyKey⟩

inductive CommandOutcome where
  | committed
  | rejectedMalformed
  | rejectedAuthentication
  | rejectedAuthority
  | rejectedLifecycle
  | rejectedRevision
  | rejectedLease
  | duplicate (original : WriteRecordId)
  deriving DecidableEq, Repr

/-- A duplicate write is evidence of the recorded outcome; every other outcome reserves
    its identity (§8.5: "Duplicate returns the original reply... without re-running
    later gates or mutation"). -/
def CommandOutcome.Reserves : CommandOutcome → Prop
  | .duplicate _ => False
  | _ => True

structure WriteRecord where
  id : WriteRecordId
  actor : ActorRef
  envelopeDigest : StructuralDigest
  caller : Option CommandCaller
  command : Option String
  submittedAt : Time
  outcome : CommandOutcome
  audit : AuditId
  deriving DecidableEq, Repr

/-- The §8.5 lease-token gate, generalized from `TurnLease.Admits`: forbidden admits
    only absence, required admits only a currently-admitted token, optional admits
    either. -/
def LeaseGate (requirement : LeaseRequirement) (leases : TurnId → Option TurnLease)
    (lease : Option LeaseToken) (now : Time) : Prop :=
  match requirement, lease with
  | .forbidden, none => True
  | .forbidden, some _ => False
  | .required, none => False
  | .required, some token => ∃ turnLease, leases token.turn = some turnLease ∧
      turnLease.Admits token now
  | .optional, none => True
  | .optional, some token => ∃ turnLease, leases token.turn = some turnLease ∧
      turnLease.Admits token now

def leaseGateBool (requirement : LeaseRequirement) (leases : TurnId → Option TurnLease)
    (lease : Option LeaseToken) (now : Time) : Bool :=
  match requirement, lease with
  | .forbidden, none => true
  | .forbidden, some _ => false
  | .required, none => false
  | .required, some token =>
      match leases token.turn with
      | some turnLease => turnLease.admitsBool token now
      | none => false
  | .optional, none => true
  | .optional, some token =>
      match leases token.turn with
      | some turnLease => turnLease.admitsBool token now
      | none => false

private theorem leaseGateBool_some_iff (leases : TurnId → Option TurnLease) (token : LeaseToken)
    (now : Time) :
    (match leases token.turn with
      | some turnLease => turnLease.admitsBool token now
      | none => false) = true ↔
      ∃ turnLease, leases token.turn = some turnLease ∧ turnLease.Admits token now := by
  cases lookup : leases token.turn with
  | none => simp []
  | some turnLease =>
      simp only [TurnLease.admitsBool_eq_true]
      constructor
      · intro admits; exact ⟨turnLease, rfl, admits⟩
      · rintro ⟨found, foundLookup, admits⟩
        exact Option.some.inj foundLookup ▸ admits

theorem leaseGateBool_eq_true_iff {requirement leases lease now} :
    leaseGateBool requirement leases lease now = true ↔
      LeaseGate requirement leases lease now := by
  cases requirement with
  | forbidden =>
      cases lease with
      | none => simp [leaseGateBool, LeaseGate]
      | some _ => simp [leaseGateBool, LeaseGate]
  | required =>
      cases lease with
      | none => simp [leaseGateBool, LeaseGate]
      | some token =>
          simp only [leaseGateBool, LeaseGate]
          exact leaseGateBool_some_iff leases token now
  | optional =>
      cases lease with
      | none => simp [leaseGateBool, LeaseGate]
      | some token =>
          simp only [leaseGateBool, LeaseGate]
          exact leaseGateBool_some_iff leases token now

/-- The family-specific policy the dispatcher consults: decode, the authenticate /
    authority / lifecycle / expected-revision gates over the domain state `σ`, the
    per-command lease requirement, and the mutation the committed branch alone applies.
    Every gate is `Bool`-valued so `dispatchExec` can decide it. -/
structure DispatchPolicy (σ : Type) where
  decode : RawEnvelope → Option CommandEnvelope
  authenticates : σ → CommandEnvelope → Bool
  authorizes : σ → CommandEnvelope → Bool
  lifecycleAdmits : σ → CommandEnvelope → Bool
  revisionMatches : σ → CommandEnvelope → Bool
  leaseRequirement : String → LeaseRequirement
  leases : σ → TurnId → Option TurnLease
  mutate : σ → CommandEnvelope → σ

structure DispatcherLedger (σ : Type) where
  actor : ActorRef
  domain : σ
  writes : WriteRecordId → Option WriteRecord
  reserved : CommandIdentity → Option WriteRecordId
  audits : AuditId → Option WriteRecordId

def DispatcherLedger.boot (actor : ActorRef) (domain : σ) : DispatcherLedger σ :=
  ⟨actor, domain, fun _ => none, fun _ => none, fun _ => none⟩

/-- Every branch appends exactly one write, bijectively links its fresh audit id, and
    optionally reserves the caller's `(caller, idempotencyKey)` identity — never for
    `rejectedMalformed` (no identity exists) or `duplicate` (nothing new to reserve). -/
def DispatcherLedger.appendWrite (ledger : DispatcherLedger σ) (record : WriteRecord)
    (reserve : Option CommandIdentity) (domain' : σ) : DispatcherLedger σ :=
  { ledger with
    domain := domain'
    writes := tableSet ledger.writes record.id record
    audits := tableSet ledger.audits record.audit record.id
    reserved := match reserve with
      | some identity => tableSet ledger.reserved identity record.id
      | none => ledger.reserved }

inductive DispatchLabel where
  | process (id : WriteRecordId) (audit : AuditId) (raw : RawEnvelope) (now : Time)
  deriving DecidableEq, Repr

variable {σ : Type}

/-- Dispatcher transitions, one per §8.5 outcome, each gated by every earlier stage in
    the fixed order: decode/shape, authenticate, duplicate lookup, authority, lifecycle,
    expected revision, lease. A rejection at any stage is reachable only when every
    earlier stage passed; `duplicate` sits between authenticate and authority, so it
    never depends on — and never re-runs — authority, lifecycle, revision, lease, or
    mutation. -/
inductive DispatchStep (policy : DispatchPolicy σ) :
    DispatcherLedger σ → DispatchLabel → DispatcherLedger σ → Prop
  | rejectMalformed {ledger id audit raw now} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = none →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, none, none, now,
          .rejectedMalformed, audit⟩ none ledger.domain)
  | rejectAuthentication {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = false →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .rejectedAuthentication, audit⟩
          (some envelope.identity) ledger.domain)
  | duplicate {ledger id audit raw now envelope originalId} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = some originalId →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .duplicate originalId, audit⟩ none ledger.domain)
  | rejectAuthority {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = none →
      policy.authorizes ledger.domain envelope = false →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .rejectedAuthority, audit⟩
          (some envelope.identity) ledger.domain)
  | rejectLifecycle {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = none →
      policy.authorizes ledger.domain envelope = true →
      policy.lifecycleAdmits ledger.domain envelope = false →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .rejectedLifecycle, audit⟩
          (some envelope.identity) ledger.domain)
  | rejectRevision {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = none →
      policy.authorizes ledger.domain envelope = true →
      policy.lifecycleAdmits ledger.domain envelope = true →
      policy.revisionMatches ledger.domain envelope = false →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .rejectedRevision, audit⟩
          (some envelope.identity) ledger.domain)
  | rejectLease {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = none →
      policy.authorizes ledger.domain envelope = true →
      policy.lifecycleAdmits ledger.domain envelope = true →
      policy.revisionMatches ledger.domain envelope = true →
      leaseGateBool (policy.leaseRequirement envelope.command) (policy.leases ledger.domain)
        envelope.lease now = false →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .rejectedLease, audit⟩
          (some envelope.identity) ledger.domain)
  | commit {ledger id audit raw now envelope} :
      ledger.writes id = none → ledger.audits audit = none →
      policy.decode raw = some envelope →
      policy.authenticates ledger.domain envelope = true →
      ledger.reserved envelope.identity = none →
      policy.authorizes ledger.domain envelope = true →
      policy.lifecycleAdmits ledger.domain envelope = true →
      policy.revisionMatches ledger.domain envelope = true →
      leaseGateBool (policy.leaseRequirement envelope.command) (policy.leases ledger.domain)
        envelope.lease now = true →
      DispatchStep policy ledger (.process id audit raw now)
        (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
          some envelope.command, now, .committed, audit⟩
          (some envelope.identity) (policy.mutate ledger.domain envelope))

/-- **Exactly one linked WriteRecord and AuditRecord per request.** Whatever the
    outcome, the step appends exactly one fresh write at `id`, bijectively linked to the
    fresh audit id, and touches no other write or audit entry — the atomic commit §8.5
    requires. -/
theorem dispatch_appends_exactly_one_linked_write_and_audit {policy : DispatchPolicy σ}
    {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after) :
    ∃ record, after.writes id = some record ∧ record.audit = audit ∧
      after.audits audit = some id ∧
      (∀ other, other ≠ id → after.writes other = ledger.writes other) ∧
      (∀ other, other ≠ audit → after.audits other = ledger.audits other) := by
  cases step <;>
    exact ⟨_, tableSet_self .., rfl, tableSet_self ..,
      fun other different => tableSet_other _ _ _ different _,
      fun other different => tableSet_other _ _ _ different _⟩

/-- **Duplicate-never-mutates.** A resubmission whose caller authenticates never
    touches the domain state and never adds a new reservation — the appended write is
    evidence citing the original, not a second effect. Authentication must be checked
    independently: §8.5 authenticates before the duplicate lookup, so an unauthenticated
    resubmission still yields `rejectedAuthentication`, never `duplicate`. -/
theorem dispatch_duplicate_never_mutates {policy : DispatchPolicy σ}
    {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after)
    {envelope originalId} (decoded : policy.decode raw = some envelope)
    (authed : policy.authenticates ledger.domain envelope = true)
    (dup : ledger.reserved envelope.identity = some originalId) :
    after.domain = ledger.domain ∧ after.reserved = ledger.reserved ∧
      ∃ record, after.writes id = some record ∧ record.outcome = .duplicate originalId := by
  cases step with
  | rejectMalformed _ _ noDecode => rw [decoded] at noDecode; contradiction
  | rejectAuthentication _ _ decoded' notAuthed =>
      rw [decoded] at decoded'; cases decoded'
      rw [authed] at notAuthed; contradiction
  | duplicate _ _ decoded' _ found =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at found; cases Option.some.inj found
      exact ⟨rfl, rfl, _, tableSet_self .., rfl⟩
  | rejectAuthority _ _ decoded' _ fresh _ =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at fresh; contradiction
  | rejectLifecycle _ _ decoded' _ fresh _ _ =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at fresh; contradiction
  | rejectRevision _ _ decoded' _ fresh _ _ _ =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at fresh; contradiction
  | rejectLease _ _ decoded' _ fresh _ _ _ _ =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at fresh; contradiction
  | commit _ _ decoded' _ fresh _ _ _ _ =>
      rw [decoded] at decoded'; cases decoded'
      rw [dup] at fresh; contradiction

/-- **Every non-committed outcome preserves the domain.** Only `commit` invokes
    `policy.mutate`; every rejection and the `duplicate` branch leave the domain state
    exactly as it was. -/
theorem dispatch_nonmutating_outcome_preserves_domain {policy : DispatchPolicy σ}
    {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after)
    {record} (stored : after.writes id = some record) (notCommitted : record.outcome ≠ .committed) :
    after.domain = ledger.domain := by
  cases step with
  | commit _ _ _ _ _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd rfl notCommitted
  | rejectMalformed _ _ _ => rfl
  | rejectAuthentication _ _ _ _ => rfl
  | duplicate _ _ _ _ _ => rfl
  | rejectAuthority _ _ _ _ _ _ => rfl
  | rejectLifecycle _ _ _ _ _ _ _ => rfl
  | rejectRevision _ _ _ _ _ _ _ _ => rfl
  | rejectLease _ _ _ _ _ _ _ _ _ => rfl

/-- **A reserved identity only ever produces a duplicate write.** Once `(caller,
    idempotencyKey)` is reserved, an authenticated resubmission cannot reach authority,
    lifecycle, revision, lease, or mutation — every later-gate constructor requires a
    fresh identity. -/
theorem dispatch_reserved_identity_only_duplicates {policy : DispatchPolicy σ}
    {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after)
    {envelope originalId} (decoded : policy.decode raw = some envelope)
    (authed : policy.authenticates ledger.domain envelope = true)
    (reservedAlready : ledger.reserved envelope.identity = some originalId) :
    ∃ record, after.writes id = some record ∧ record.outcome = .duplicate originalId :=
  (dispatch_duplicate_never_mutates step decoded authed reservedAlready).2.2

/-- **A committed write passed every gate in order.** Extracting §8.5's fixed sequence:
    decode succeeded, the caller authenticated, the identity was unreserved, authority,
    lifecycle, and revision all admitted, and the lease gate passed before mutation ran. -/
theorem dispatch_commit_passed_every_gate {policy : DispatchPolicy σ}
    {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after)
    {record} (stored : after.writes id = some record) (committed : record.outcome = .committed) :
    ∃ envelope, policy.decode raw = some envelope ∧
      policy.authenticates ledger.domain envelope = true ∧
      ledger.reserved envelope.identity = none ∧
      policy.authorizes ledger.domain envelope = true ∧
      policy.lifecycleAdmits ledger.domain envelope = true ∧
      policy.revisionMatches ledger.domain envelope = true ∧
      leaseGateBool (policy.leaseRequirement envelope.command) (policy.leases ledger.domain)
        envelope.lease now = true ∧
      after.domain = policy.mutate ledger.domain envelope := by
  cases step with
  | commit _ _ decoded authed fresh authorized lifecycle revision lease =>
      exact ⟨_, decoded, authed, fresh, authorized, lifecycle, revision, lease, rfl⟩
  | rejectMalformed _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | rejectAuthentication _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | duplicate _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | rejectAuthority _ _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | rejectLifecycle _ _ _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | rejectRevision _ _ _ _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)
  | rejectLease _ _ _ _ _ _ _ _ _ =>
      simp only [DispatcherLedger.appendWrite, tableSet_self] at stored
      have eq := Option.some.inj stored
      subst eq
      exact absurd committed (by simp)

/-! ## Executable dispatch semantics

`dispatchExec` is the computable mirror of `DispatchStep`, proven sound and complete
below — the `leaseStepExec` pattern applied to the dispatcher: every gate is a `Bool`
decision, so the differential oracle's verdict carries the relation's meaning. -/

def dispatchExec (policy : DispatchPolicy σ) (ledger : DispatcherLedger σ)
    (id : WriteRecordId) (audit : AuditId) (raw : RawEnvelope) (now : Time) :
    Option (DispatcherLedger σ) :=
  match ledger.writes id with
  | some _ => none
  | none =>
    match ledger.audits audit with
    | some _ => none
    | none =>
      match policy.decode raw with
      | none =>
          some (ledger.appendWrite ⟨id, ledger.actor, raw.digest, none, none, now,
            .rejectedMalformed, audit⟩ none ledger.domain)
      | some envelope =>
          match policy.authenticates ledger.domain envelope with
          | false =>
              some (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
                some envelope.command, now, .rejectedAuthentication, audit⟩
                (some envelope.identity) ledger.domain)
          | true =>
              match ledger.reserved envelope.identity with
              | some originalId =>
                  some (ledger.appendWrite ⟨id, ledger.actor, raw.digest, some envelope.caller,
                    some envelope.command, now, .duplicate originalId, audit⟩ none ledger.domain)
              | none =>
                  match policy.authorizes ledger.domain envelope with
                  | false =>
                      some (ledger.appendWrite ⟨id, ledger.actor, raw.digest,
                        some envelope.caller, some envelope.command, now, .rejectedAuthority,
                        audit⟩ (some envelope.identity) ledger.domain)
                  | true =>
                      match policy.lifecycleAdmits ledger.domain envelope with
                      | false =>
                          some (ledger.appendWrite ⟨id, ledger.actor, raw.digest,
                            some envelope.caller, some envelope.command, now,
                            .rejectedLifecycle, audit⟩ (some envelope.identity) ledger.domain)
                      | true =>
                          match policy.revisionMatches ledger.domain envelope with
                          | false =>
                              some (ledger.appendWrite ⟨id, ledger.actor, raw.digest,
                                some envelope.caller, some envelope.command, now,
                                .rejectedRevision, audit⟩ (some envelope.identity) ledger.domain)
                          | true =>
                              match leaseGateBool (policy.leaseRequirement envelope.command)
                                  (policy.leases ledger.domain) envelope.lease now with
                              | false =>
                                  some (ledger.appendWrite ⟨id, ledger.actor, raw.digest,
                                    some envelope.caller, some envelope.command, now,
                                    .rejectedLease, audit⟩ (some envelope.identity)
                                    ledger.domain)
                              | true =>
                                  some (ledger.appendWrite ⟨id, ledger.actor, raw.digest,
                                    some envelope.caller, some envelope.command, now,
                                    .committed, audit⟩ (some envelope.identity)
                                    (policy.mutate ledger.domain envelope))

theorem dispatchExec_sound {policy : DispatchPolicy σ} {ledger after id audit raw now}
    (executed : dispatchExec policy ledger id audit raw now = some after) :
    DispatchStep policy ledger (.process id audit raw now) after := by
  unfold dispatchExec at executed
  split at executed
  next => exact absurd executed (by simp)
  next fresh =>
    split at executed
    next => exact absurd executed (by simp)
    next freshAudit =>
      split at executed
      next noDecode =>
          cases executed
          exact DispatchStep.rejectMalformed fresh freshAudit noDecode
      next decoded =>
          split at executed
          next notAuthed =>
              cases executed
              exact DispatchStep.rejectAuthentication fresh freshAudit decoded notAuthed
          next authed =>
              split at executed
              next dupFound =>
                  cases executed
                  exact DispatchStep.duplicate fresh freshAudit decoded authed dupFound
              next dupFresh =>
                  split at executed
                  next notAuthorized =>
                      cases executed
                      exact DispatchStep.rejectAuthority fresh freshAudit decoded authed
                        dupFresh notAuthorized
                  next authorized =>
                      split at executed
                      next notLifecycle =>
                          cases executed
                          exact DispatchStep.rejectLifecycle fresh freshAudit decoded authed
                            dupFresh authorized notLifecycle
                      next lifecycle =>
                          split at executed
                          next notRevision =>
                              cases executed
                              exact DispatchStep.rejectRevision fresh freshAudit decoded authed
                                dupFresh authorized lifecycle notRevision
                          next revision =>
                              split at executed
                              next notLease =>
                                  cases executed
                                  exact DispatchStep.rejectLease fresh freshAudit decoded authed
                                    dupFresh authorized lifecycle revision notLease
                              next lease =>
                                  cases executed
                                  exact DispatchStep.commit fresh freshAudit decoded authed
                                    dupFresh authorized lifecycle revision lease

theorem dispatchExec_complete {policy : DispatchPolicy σ} {ledger after id audit raw now}
    (step : DispatchStep policy ledger (.process id audit raw now) after) :
    dispatchExec policy ledger id audit raw now = some after := by
  unfold dispatchExec
  cases step with
  | rejectMalformed fresh freshAudit noDecode =>
      simp [fresh, freshAudit, noDecode]
  | rejectAuthentication fresh freshAudit decoded notAuthed =>
      simp [fresh, freshAudit, decoded, notAuthed]
  | duplicate fresh freshAudit decoded authed dupFound =>
      simp [fresh, freshAudit, decoded, authed, dupFound]
  | rejectAuthority fresh freshAudit decoded authed dupFresh notAuthorized =>
      simp [fresh, freshAudit, decoded, authed, dupFresh, notAuthorized]
  | rejectLifecycle fresh freshAudit decoded authed dupFresh authorized notLifecycle =>
      simp [fresh, freshAudit, decoded, authed, dupFresh, authorized, notLifecycle]
  | rejectRevision fresh freshAudit decoded authed dupFresh authorized lifecycle notRevision =>
      simp [fresh, freshAudit, decoded, authed, dupFresh, authorized, lifecycle, notRevision]
  | rejectLease fresh freshAudit decoded authed dupFresh authorized lifecycle revision notLease =>
      simp [fresh, freshAudit, decoded, authed, dupFresh, authorized, lifecycle, revision,
        notLease]
  | commit fresh freshAudit decoded authed dupFresh authorized lifecycle revision lease =>
      simp [fresh, freshAudit, decoded, authed, dupFresh, authorized, lifecycle, revision, lease]

end AgentCore
