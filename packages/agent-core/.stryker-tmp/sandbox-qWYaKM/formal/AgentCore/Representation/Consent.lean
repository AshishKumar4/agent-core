import AgentCore.Composed

/-!
Component-shape nonclaim: device consent may use canonical Grant/Binding authority and
holder watermarks. No concrete device transport refinement is claimed here.
-/

namespace AgentCore.Representation.Consent

structure ComponentShape where
  principal : PrincipalId
  header : InvocationHeader
  scope : Scope

end AgentCore.Representation.Consent
