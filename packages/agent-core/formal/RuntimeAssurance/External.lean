import RuntimeAssurance.Fault

/-!
# External-service idempotency and acknowledgement ambiguity

A provider effect has two separate facts:

1. whether the provider applied the idempotency key; and
2. whether the caller learned that fact.

Conflating them is the classic retry bug. A lost acknowledgement does not show that the
provider did nothing, and it does not justify another application. The model represents one
provider key as one cell in `ExternalService.applied`. An identical replay is a no-op;
a replay whose key names different intent is rejected. `RemoteAcknowledgement.lost` is an
observation state only. It does not enter `commit`, so it cannot manufacture a second effect.

This is an abstract service contract, not a claim about any concrete provider. The mapping
from a deployed provider to this contract is precisely `Premise.providerIdempotency`, and
`Fault.providerAppliedOneKeyTwice` refutes that premise. `Fault.remoteAcknowledgementLost` is
inside the model: a lost acknowledgement creates ambiguity, not an assumed provider success
or a duplicate effect.
-/

namespace RuntimeAssurance

open AgentCore (tableSet)

structure ExternalRequest where
  key : Nat
  intent : Nat
  deriving DecidableEq, Repr

/-- What the service can decide for one request. -/
inductive ExternalDecision where
  | apply
  | replay
  | reject
  deriving DecidableEq, Repr

/-- What the caller learned after sending. `lost` says only that the acknowledgement did not
arrive. It deliberately says nothing about whether the service applied the request. -/
inductive RemoteAcknowledgement where
  | acknowledged
  | lost
  deriving DecidableEq, Repr

/-- The provider's abstract idempotency table. One key maps to one exact intent. -/
structure ExternalService where
  applied : Nat → Option Nat

/-- The empty provider has applied no key. -/
def ExternalService.empty : ExternalService := { applied := fun _ => none }

/-- Decide before applying. A repeated key with identical intent replays; a repeated key with
other intent rejects instead of silently changing the meaning of an idempotency key. -/
def ExternalService.decision (service : ExternalService) (request : ExternalRequest) :
    ExternalDecision :=
  match service.applied request.key with
  | none => .apply
  | some intent => if intent = request.intent then .replay else .reject

/-- The only service-state transition. `replay` and `reject` leave the table unchanged. -/
def ExternalService.commit (service : ExternalService) (request : ExternalRequest) :
    ExternalService :=
  match service.decision request with
  | .apply => { service with applied := tableSet service.applied request.key request.intent }
  | .replay => service
  | .reject => service

/-- The observation a caller retains after sending. Its acknowledgement is deliberately not
an input to the provider transition. -/
structure ExternalObservation where
  service : ExternalService
  request : ExternalRequest
  acknowledgement : RemoteAcknowledgement

/-- The committed provider state behind this observation. -/
def ExternalObservation.committed (observation : ExternalObservation) : ExternalService :=
  observation.service.commit observation.request

/-- A first application records the exact key and intent. -/
theorem first_apply_records_exact_intent {service : ExternalService} {request : ExternalRequest}
    (unseen : service.applied request.key = none) :
    (service.commit request).applied request.key = some request.intent := by
  simp [ExternalService.commit, ExternalService.decision, unseen, AgentCore.tableSet_self]

/-- An identical retry never changes provider state. This is the idempotency property the
abstract relation gives the caller before any deployment premise enters. -/
theorem identical_replay_is_noop {service : ExternalService} {key intent : Nat}
    (applied : service.applied key = some intent) :
    service.commit ⟨key, intent⟩ = service := by
  simp [ExternalService.commit, ExternalService.decision, applied]

/-- A key collision with different intent rejects and leaves provider state unchanged. -/
theorem conflicting_replay_is_rejected {service : ExternalService} {key stored intent : Nat}
    (applied : service.applied key = some stored) (different : stored ≠ intent) :
    service.decision ⟨key, intent⟩ = .reject ∧ service.commit ⟨key, intent⟩ = service := by
  simp [ExternalService.decision, ExternalService.commit, applied, different]

/-- Lost acknowledgement is ambiguity, not a second provider transition. The two observations
share the same `service` and `request`, and the committed state is definitionally identical.
A reconciler needs provider evidence to decide which state it is looking at; it must not infer
one from the missing acknowledgement. -/
theorem acknowledgement_loss_is_not_a_second_effect {service : ExternalService}
    {request : ExternalRequest} :
    ExternalObservation.committed ⟨service, request, .lost⟩ =
      ExternalObservation.committed ⟨service, request, .acknowledged⟩ := rfl

/-- The model already admits acknowledgement loss as an observation state. It therefore refutes
no premise; deployment evidence cannot turn a missing acknowledgement into a Lean axiom. -/
theorem remote_acknowledgement_loss_is_within_model :
    Fault.remoteAcknowledgementLost.consequence = .withinModel :=
  acknowledgement_loss_is_within_model

end RuntimeAssurance
