import AgentCore.Composed

/-!
Component-shape nonclaim: the core can encode persisted approval intent and exact
approval-start transitions. This module does not claim an independent provider system
is represented or refined without an external implementation relation.
-/

namespace AgentCore.Representation.Gatekeeper

structure ComponentShape where
  request : AdmissionRequest
  approval : ApprovalId
  attempt : AttemptId

end AgentCore.Representation.Gatekeeper
