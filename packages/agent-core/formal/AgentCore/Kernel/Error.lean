/-
The kernel's refusal channel (SPEC §1.6, §8.3).

`packages/agent-core/src/errors.ts` closes the runtime taxonomy with two channels and
nothing else: a domain refusal is an `AgentCoreError` carrying one code of a closed union,
and a constructor shape violation is a `TypeError`. The kernel keeps both channels and
keeps them apart, because they are answered differently — a shape violation says the caller
built a value that never existed, a refusal says a legal caller asked a legal question and
the answer is no.

What is modelled: the channel and, for a refusal, the exact code. What is not: the message
text. A message is diagnostic prose that the SPEC never fixes, and a theorem stated over
prose would be a theorem about wording. Every kernel theorem about a refusal therefore
names the code, which is the part the SPEC and the taxonomy both fix.
-/

namespace AgentCore.Kernel

/-- The closed `AgentCoreErrorCode` union, in the order `src/errors.ts` lists it. -/
inductive ErrorCode where
  | actorClosed
  | actorStaleCallback
  | assuranceDuplicateEvidence
  | assuranceInvalidClaim
  | assuranceObservationRefused
  | assuranceUnknownFault
  | assuranceUnknownPremise
  | authorityDenied
  | bindingInvalid
  | codecInvalid
  | codecUnknownMajor
  | contentInvalidRange
  | contentNotFound
  | environmentClosedSession
  | environmentInvalidSession
  | environmentStaleSession
  | facetInactive
  | invocationInvalid
  | leaseInvalid
  | operationInvalidInput
  | operationInvalidOutput
  | operationMissing
  | planCycle
  | planDuplicateDependency
  | planDuplicateTask
  | planForeignDeclaration
  | planUnknownDependency
  | planUnknownTask
  | protocolDuplicate
  | protocolInvalidEnvelope
  | protocolInvalidState
  | protocolRevisionConflict
  | runInvalidState
  | runModelInputUnrebuildable
  | schemaUnreadable
  | slateInvalidVersion
  | slateUnpublished
  | subscriptionInvalid
  | turnInvalidState
  | turnModelInputUnaccounted
  | turnModelInputUndurable
  deriving DecidableEq, Repr

/-- The wire text of a code: what `AgentCoreError.code` holds at runtime. -/
def ErrorCode.wire : ErrorCode → String
  | .actorClosed => "actor.closed"
  | .actorStaleCallback => "actor.stale-callback"
  | .assuranceDuplicateEvidence => "assurance.duplicate-evidence"
  | .assuranceInvalidClaim => "assurance.invalid-claim"
  | .assuranceObservationRefused => "assurance.observation-refused"
  | .assuranceUnknownFault => "assurance.unknown-fault"
  | .assuranceUnknownPremise => "assurance.unknown-premise"
  | .authorityDenied => "authority.denied"
  | .bindingInvalid => "binding.invalid"
  | .codecInvalid => "codec.invalid"
  | .codecUnknownMajor => "codec.unknown-major"
  | .contentInvalidRange => "content.invalid-range"
  | .contentNotFound => "content.not-found"
  | .environmentClosedSession => "environment.closed-session"
  | .environmentInvalidSession => "environment.invalid-session"
  | .environmentStaleSession => "environment.stale-session"
  | .facetInactive => "facet.inactive"
  | .invocationInvalid => "invocation.invalid"
  | .leaseInvalid => "lease.invalid"
  | .operationInvalidInput => "operation.invalid-input"
  | .operationInvalidOutput => "operation.invalid-output"
  | .operationMissing => "operation.missing"
  | .planCycle => "plan.cycle"
  | .planDuplicateDependency => "plan.duplicate-dependency"
  | .planDuplicateTask => "plan.duplicate-task"
  | .planForeignDeclaration => "plan.foreign-declaration"
  | .planUnknownDependency => "plan.unknown-dependency"
  | .planUnknownTask => "plan.unknown-task"
  | .protocolDuplicate => "protocol.duplicate"
  | .protocolInvalidEnvelope => "protocol.invalid-envelope"
  | .protocolInvalidState => "protocol.invalid-state"
  | .protocolRevisionConflict => "protocol.revision-conflict"
  | .runInvalidState => "run.invalid-state"
  | .runModelInputUnrebuildable => "run.model-input-unrebuildable"
  | .schemaUnreadable => "schema.unreadable"
  | .slateInvalidVersion => "slate.invalid-version"
  | .slateUnpublished => "slate.unpublished"
  | .subscriptionInvalid => "subscription.invalid"
  | .turnInvalidState => "turn.invalid-state"
  | .turnModelInputUnaccounted => "turn.model-input-unaccounted"
  | .turnModelInputUndurable => "turn.model-input-undurable"

/-- Every code, in taxonomy order. -/
def ErrorCode.all : List ErrorCode :=
  [.actorClosed, .actorStaleCallback, .assuranceDuplicateEvidence, .assuranceInvalidClaim,
   .assuranceObservationRefused, .assuranceUnknownFault, .assuranceUnknownPremise,
   .authorityDenied, .bindingInvalid, .codecInvalid, .codecUnknownMajor,
   .contentInvalidRange, .contentNotFound, .environmentClosedSession,
   .environmentInvalidSession, .environmentStaleSession, .facetInactive, .invocationInvalid,
   .leaseInvalid, .operationInvalidInput, .operationInvalidOutput, .operationMissing,
   .planCycle, .planDuplicateDependency, .planDuplicateTask, .planForeignDeclaration,
   .planUnknownDependency, .planUnknownTask, .protocolDuplicate, .protocolInvalidEnvelope,
   .protocolInvalidState, .protocolRevisionConflict, .runInvalidState,
   .runModelInputUnrebuildable, .schemaUnreadable, .slateInvalidVersion, .slateUnpublished,
   .subscriptionInvalid, .turnInvalidState, .turnModelInputUnaccounted,
   .turnModelInputUndurable]

/-- **The enumeration is complete.** No code of the union is missing from `all`, so a
theorem quantified over `all` is a theorem about the whole taxonomy. -/
theorem ErrorCode.mem_all (code : ErrorCode) : code ∈ ErrorCode.all := by
  cases code <;> decide

/-- **Codes are distinguishable on the wire.** Two different members never carry the same
text, so a caller that branches on `error.code` branches on the kernel's own decision. -/
theorem ErrorCode.wire_nodup : (ErrorCode.all.map ErrorCode.wire).Nodup := by decide

/-- One failure, as the runtime distinguishes them: a refusal carrying a stable code, or a
shape violation naming the subject whose invariant the caller broke. -/
inductive Fault where
  /-- `AgentCoreError` with one code of the closed union. -/
  | refusal (code : ErrorCode)
  /-- `TypeError`: the value could not be constructed at all. -/
  | shape (subject : String)
  deriving DecidableEq, Repr

/-- Every kernel decision is total: an answer or one of the two failures. -/
abbrev Outcome (α : Type) := Except Fault α

/-- Refuse with a stable code. -/
def refuse (code : ErrorCode) : Outcome α := .error (.refusal code)

/-- Refuse to construct: the caller's value violates the named subject's shape. -/
def unshaped (subject : String) : Outcome α := .error (.shape subject)

/-- The outcome refused with exactly this code. -/
def Outcome.RefusedWith (code : ErrorCode) (outcome : Outcome α) : Prop :=
  outcome = .error (.refusal code)

theorem refuse_refusedWith (code : ErrorCode) :
    (refuse code : Outcome α).RefusedWith code := rfl

theorem Outcome.refusedWith_ne_ok {code : ErrorCode} {outcome : Outcome α} {value : α}
    (refused : outcome.RefusedWith code) : outcome ≠ .ok value := by
  rw [refused]
  simp

/-- A refusal names one code, so two refusal claims about one outcome agree. -/
theorem Outcome.refusedWith_unique {left right : ErrorCode} {outcome : Outcome α}
    (leftRefused : outcome.RefusedWith left) (rightRefused : outcome.RefusedWith right) :
    left = right := by
  rw [leftRefused] at rightRefused
  simpa [Outcome.RefusedWith] using rightRefused

end AgentCore.Kernel
