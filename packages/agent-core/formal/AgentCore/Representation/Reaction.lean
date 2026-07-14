import AgentCore.Composed

/-!
Component-shape nonclaim: source reservations, authenticated target projections, and
terminal deliveries are available primitives. No external reaction service is claimed
to refine them without independent premises.
-/

namespace AgentCore.Representation.Reaction

structure ComponentShape where
  reservation : ReservationId
  projection : ProjectionId

end AgentCore.Representation.Reaction
